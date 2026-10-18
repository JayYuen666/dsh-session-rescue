// 真 AgentLoop 下的用户中止：钉住「abort 不 emit agent/error」这条宿主语义。
//
// 本包的「用户中止的回合不消耗配额」判定只落在 `agent/status→idle` 一侧，理由写在
// host.ts 文件头：harness 的 `turn()` 里 catch 先 emit `agent/error`、finally 才 append
// `turn/end`，而 signal.aborted 分支直接 rethrow、**根本不** emit。单测里这条是按注释
// 手搓的事件序列证的——真宿主给不给这一形，只有这一层能回答。
//
// 用 mock server 的 `stall`（请求挂起不返回）造一个「正在跑」的回合，再从官方
// `agent.cancel()` 打断它：这样中止发生在流读取的中段，与用户按停止键的真实时机一致。
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

const RESCUE_KIND = "plugin:session-rescue";
const POLL_STEP_MS = 20;

const DeepSeekAdapter = {
  name: deepSeekName,
  inject: deepSeekInject,
  Config: deepSeekConfig,
  apply: applyDeepSeek,
};

interface Rig {
  ctx: Context;
  agent: Agent;
  server: MockLlmServer;
  errors: { turn: number | undefined; name: string | undefined }[];
  turnEnds: { turn: number | undefined; reasonKind: string | undefined }[];
}

let rig: Rig | undefined;

/** 起一份真装配（与会话级用例同一栈，插件延迟压到最小档）。 */
async function boot(sequence: readonly MockLlmBehavior[]): Promise<Rig> {
  vi.stubEnv("DEEPSEEK_API_KEY", "mock-key");
  const server = await startMockLlmServer({ sequence, apiKey: "mock-key" });
  const ctx = new Context();
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
    } as never,
  );
  const agent = await ctx.agentLoop.create(brandString<SessionId>("rescue-abort"), {
    provider: "deepseek-official",
    model: "mock-model",
  });
  const errors: { turn: number | undefined; name: string | undefined }[] = [];
  ctx.on("agent/error", (payload: { turn?: number; error?: unknown }) => {
    const error = payload.error as { name?: string } | null;
    errors.push({ turn: payload.turn, name: error?.name });
  });
  const turnEnds: { turn: number | undefined; reasonKind: string | undefined }[] = [];
  // 终态从 `session/event` 上读（官方 goal-round-driver 也用这一位）：
  // `turn/end` 的 reason.kind 是唯一权威面，不猜宿主的事件顺序，也不碰
  // `session.snapshotEvents()`（官方已标 @deprecated，新调用是禁的）。
  ctx.on("session/event", (_session: unknown, event: unknown) => {
    const record = event as { type?: string; data?: { turn?: number; reason?: { kind?: string } } };
    if (record.type === "turn/end") {
      turnEnds.push({ turn: record.data?.turn, reasonKind: record.data?.reason?.kind });
    }
  });
  return { ctx, agent, server, errors, turnEnds };
}

/** 发一条用户消息（不等 idle：`stall` 那一轮不会自己结束）。 */
function send(agent: Agent, text: string): void {
  agent.followup(
    createUserMessage({
      content: [{ type: "text", text }],
      source: { kind: "user" },
    }),
  );
}

/** 等一个条件在真事件流里成立。 */
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

function rescueMessages(agent: Agent): number {
  return agent.session
    .deriveMessages()
    .filter(
      (message) =>
        message.role === "user" &&
        (message as { source?: { kind?: string } }).source?.kind === RESCUE_KIND,
    ).length;
}

describe("真宿主下的用户中止：不 emit agent/error，也不消耗续跑配额", () => {
  afterEach(async () => {
    const current = rig;
    rig = undefined;
    if (current !== undefined) {
      await current.ctx.fiber.dispose();
      await current.server.close();
    }
    vi.unstubAllEnvs();
  });

  it("stall 中被 cancel ⇒ 无 agent/error、无救援注入，终态记为 aborted/interrupted", async () => {
    rig = await boot(["stall", "rate_limit", "success"]);
    const { agent } = rig;
    send(agent, "hold the connection open");
    // 等这一轮真的进到模型请求里（server 侧收到请求 = 回合已开、正在读流）。
    await expect(waitFor(() => rig!.server.requests.length > 0, within(20_000))).resolves.toBe(
      true,
    );
    // 官方 `agent.cancel()` 不返回 promise（取消是同步登记的，收尾走事件）。
    agent.cancel({ kind: "user" });
    await expect(waitFor(() => agent.status === "idle", within(20_000))).resolves.toBe(true);

    // ① 中止不产出 agent/error：本包若在这里判中止，就是在读一份不存在的记录。
    expect(rig.errors).toStrictEqual([]);
    // ② 也没有任何救援消息（既不为中止轮补跑，也不把它读成截断/未完成）。
    expect(rescueMessages(agent)).toBe(0);
    // ③ 终态确实落了盘，且 kind 是本包认的那两个中止值之一。
    const kinds = rig.turnEnds.map((end) => end.reasonKind);
    expect(kinds).toContain("aborted");
  }, 60_000);

  it("中止之后再来一次真瞬时失败 ⇒ 照常续跑（中止没有偷走配额）", async () => {
    rig = await boot(["stall", "rate_limit", "success"]);
    const { agent } = rig;
    send(agent, "hold then abort");
    await expect(waitFor(() => rig!.server.requests.length > 0, within(20_000))).resolves.toBe(
      true,
    );
    // 官方 `agent.cancel()` 不返回 promise（取消是同步登记的，收尾走事件）。
    agent.cancel({ kind: "user" });
    await expect(waitFor(() => agent.status === "idle", within(20_000))).resolves.toBe(true);

    // 第二次请求走 rate_limit：真瞬时失败 ⇒ 本包必须还敢补一条。
    // 若中止被读成「消耗掉了一次机会」的形状（或 aborted 终态被当成截断），这里就收不到。
    send(agent, "now fail transiently");
    const rescued = await waitFor(() => rescueMessages(agent) >= 1, within(30_000));
    expect(rescued).toBe(true);
    await agent.whenIdle();
    expect(rescueMessages(agent)).toBe(1);
  }, 60_000);
});
