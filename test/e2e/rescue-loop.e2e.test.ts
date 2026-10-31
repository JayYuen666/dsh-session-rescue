// 端到端：真 AgentLoop + 官方 dsh-llm-mock-server 上的**完整救援旅程**。
// 装配手法与 test/integration/agent-loop.test.ts 同源（那边的 rig 是本层的样板），
// 分工不同：集成层钉单条假设（一次失败→一次注入→一次恢复），本层钉多回合与跨会话——
// 救援链中段再失败要靠链式例外跨过冷却、双会话的配额互不串台、配额型永久失败之后
// 用户手动再发一轮不受污染。这些只有真装配能证。
// mock server 的剧本是**全局按请求消耗**的（无按会话剧本这一档），因此跨会话场景
// 用「顺序发送」把消耗次序钉死，再按请求体里的用户文本归属会话。
import { afterEach, describe, expect, it, vi } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";
import { Context } from "@deepseek-ai/cordis";
import TimerPlugin from "@deepseek-ai/cordis-plugin-timer";
import { mountAgentLoopTestDependencies } from "@deepseek-ai/dsh-agent-loop-testkit";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import {
  apply as applyDeepSeek,
  Config as deepSeekConfig,
  inject as deepSeekInject,
  name as deepSeekName,
} from "@deepseek-ai/dsh-llm-deepseek-api-key";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { brandString } from "@deepseek-ai/dsh-brand";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { startMockLlmServer } from "@deepseek-ai/dsh-llm-mock-server";
import type { MockLlmBehavior, MockLlmServer } from "@deepseek-ai/dsh-llm-mock-server";

import plugin from "../../host.ts";

/** 注入消息的 source.kind（期望值自持，与被测常量分头写）。 */
const RESCUE_KIND = "plugin:session-rescue";
/** 本层断言用到的最小轮询间隔（毫秒）。 */
const POLL_STEP_MS = 20;

const DeepSeekAdapter = {
  name: deepSeekName,
  inject: deepSeekInject,
  Config: deepSeekConfig,
  apply: applyDeepSeek,
};

interface Rig {
  ctx: Context;
  server: MockLlmServer;
}

let rig: Rig | undefined;

/** 起一份真装配。调度档位全部压到 schema 下限，让旅程在秒级跑完。 */
async function boot(sequence: readonly MockLlmBehavior[]): Promise<Rig> {
  vi.stubEnv("DEEPSEEK_API_KEY", "mock-key");
  const server = await startMockLlmServer({
    sequence,
    apiKey: "mock-key",
    successText: "recovered answer",
  });
  const ctx = new Context();
  try {
    ctx.provide("settings", {
      describe: () => [],
      mutate: async (): Promise<void> => undefined,
      configure: () => (): void => {
        void 0;
      },
    });
    await ctx.plugin(TimerPlugin);
    await mountAgentLoopTestDependencies(ctx);
    await ctx.plugin(DeepSeekAdapter, {
      baseURL: server.baseURL,
      // 适配器自带重试压到零次：旅程要测的是回合级救援链，不是请求级退避。
      retryPolicy: {
        mode: "normal",
        maxRetries: 0,
        backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      },
    });
    await ctx.plugin(AgentLoop, { agents: [] });
    await ctx.plugin(
      plugin as never,
      {
        resumeDelayMs: 1000,
        resumeCooldownMs: 5000,
        continueDelayMs: 500,
        continueCooldownMs: 5000,
        unfinishedDelayMs: 1000,
        unfinishedCooldownMs: 5000,
        // 链式重调度也压到下限：救援链中段再失败时，下一轮注入在秒级到达。
        chainResumeDelayMs: 1000,
      } as never,
    );
    return { ctx, server };
  } catch (error) {
    await ctx.fiber.dispose().catch(() => null);
    await server.close().catch(() => null);
    throw error;
  }
}

async function openAgent(ctx: Context, sessionId: string): Promise<Agent> {
  return ctx.agentLoop.create(brandString<SessionId>(sessionId), {
    provider: "deepseek-official",
    model: "mock-model",
  });
}

/** 发一条用户消息并等本轮 settles（真 followup + 真 whenIdle）。 */
async function send(agent: Agent, text: string): Promise<void> {
  const idle = agent.whenIdle();
  agent.followup(
    createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }),
  );
  await idle;
}

/** 会话日志里由本插件注入的那几条消息。 */
function rescueMessages(agent: Agent): readonly unknown[] {
  return agent.session
    .deriveMessages()
    .filter(
      (message) =>
        message.role === "user" &&
        (message as { source?: { kind?: string } }).source?.kind === RESCUE_KIND,
    );
}

/** 双会话场景里两个会话各自唯一的用户文本（剧本消耗次序与归属判据都指着它）。 */
const EXHAUSTED_TASK = "budget gone session";
const TRANSIENT_TASK = "will recover session";

/** 请求体里**最后一条**用户文本（会话归属判据：每个会话的用户文本唯一）。 */
function lastUserText(record: { body: unknown }): string | undefined {
  const face = record.body as { messages?: { role?: unknown; content?: unknown }[] } | undefined;
  const messages = Array.isArray(face?.messages) ? face.messages : [];
  const last = messages.at(-1);
  const content = last?.role === "user" ? last.content : undefined;
  let joined = "";
  if (Array.isArray(content)) {
    joined = content
      .map((block) =>
        typeof block === "object" && block !== null
          ? (block as { text?: unknown }).text
          : undefined,
      )
      .filter((piece): piece is string => typeof piece === "string")
      .join("");
  } else if (typeof content === "string") {
    joined = content;
  }
  return joined.length > 0 ? joined : undefined;
}

/** 等一个条件在真事件流里成立：轮询宿主状态而不是猜时间。 */
async function waitFor(predicate: () => boolean, deadlineAt: number): Promise<boolean> {
  if (predicate()) {
    return true;
  }
  if (Date.now() >= deadlineAt) {
    return predicate();
  }
  await sleep(POLL_STEP_MS);
  return waitFor(predicate, deadlineAt);
}

function within(ms: number): number {
  return Date.now() + ms;
}

describe("完整救援旅程（真 AgentLoop × 多回合）", () => {
  afterEach(async () => {
    const current = rig;
    rig = undefined;
    if (current !== undefined) {
      await current.ctx.fiber.dispose();
      await current.server.close();
    }
    vi.unstubAllEnvs();
  });

  it("救援链中段再失败：链式例外跨过冷却，第三轮真跑成功", async () => {
    rig = await boot(["rate_limit", "rate_limit", "success"]);
    const { ctx, server } = rig;
    const agent = await openAgent(ctx, "chain-journey");
    await send(agent, "flaky window task");
    // 第一轮失败 → 1s 注入 → 第二轮（链中段）再失败 → 链式例外跨过 5s 冷却再注入 → 第三轮成功。
    await expect(waitFor(() => rescueMessages(agent).length >= 2, within(30_000))).resolves.toBe(
      true,
    );
    await agent.whenIdle();
    expect(server.requests).toHaveLength(3);
    expect(agent.status).toBe("idle");
    expect(rescueMessages(agent)).toHaveLength(2);
  }, 120_000);

  it("双会话隔离：瞬时失败的会话自动恢复，配额耗尽的会话绝不注入且互不串台", async () => {
    // 剧本按「先 B 后 A 再 A 的恢复」排：顺序发送把消耗次序钉死，无竞态。
    rig = await boot(["quota_exceeded", "rate_limit", "success"]);
    const { ctx, server } = rig;
    const exhausted = await openAgent(ctx, "e2e-exhausted");
    const transient = await openAgent(ctx, "e2e-transient");
    await send(exhausted, EXHAUSTED_TASK);
    await send(transient, TRANSIENT_TASK);
    // 瞬时失败侧：一次失败 → 一次注入 → 恢复（第三条剧本被 A 的救援轮消费）。
    await expect(waitFor(() => rescueMessages(transient).length > 0, within(15_000))).resolves.toBe(
      true,
    );
    await transient.whenIdle();
    // 配额侧：QUOTA 是永久失败，等过注入窗口也必须零注入。
    await expect(waitFor(() => rescueMessages(exhausted).length > 0, within(3000))).resolves.toBe(
      false,
    );
    expect(exhausted.status).toBe("idle");
    expect(rescueMessages(exhausted)).toHaveLength(0);
    expect(rescueMessages(transient)).toHaveLength(1);
    // 归属核验：三条请求按体里的用户文本分属两会话，互不串台。第三条是本插件的
    // 救援注入——实测形状是「引用原任务文本 + 追加救援指令」，按包含判归属。
    const owners = server.requests.map((record) => lastUserText(record));
    expect(owners[0]).toBe(EXHAUSTED_TASK);
    expect(owners[1]).toBe(TRANSIENT_TASK);
    expect(owners[2]).toContain(TRANSIENT_TASK);
    expect(owners[2]).not.toContain(EXHAUSTED_TASK);
  }, 120_000);

  it("配额失败之后用户手动再发一轮：插件不干预、不污染，真跑成功", async () => {
    rig = await boot(["quota_exceeded", "success"]);
    const { ctx, server } = rig;
    const agent = await openAgent(ctx, "manual-retry");
    await send(agent, "first attempt");
    await expect(waitFor(() => rescueMessages(agent).length > 0, within(3000))).resolves.toBe(
      false,
    );
    // 手动第二发：插件对这条用户发起的轮次没有任何注入或拦截。
    await send(agent, "user retries manually");
    await agent.whenIdle();
    expect(server.requests).toHaveLength(2);
    expect(agent.status).toBe("idle");
    expect(rescueMessages(agent)).toHaveLength(0);
  }, 120_000);
});
