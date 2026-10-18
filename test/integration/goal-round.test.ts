// 真 goal + 真 goal-round-driver 下的接管集成：官方 goal 服务与官方轮次驱动都是**真身**，
// 失败报文来自官方 dsh-llm-mock-server，插件走 `ctx.plugin` 正常装配。
//
// 这一层要钉两件事，而它们都只能靠真实现钉住：
//   ① round driver 在 `agent/error` 上**只 disarm、绝不自动重试**（其 lib/index.js 里那行
//      `ctx.on("agent/error", … disarm …)`，README 的「No abnormal auto-retry」）——
//      「goal 轮一律让路」因此等于把这条失败回合丢给「没人管」；
//   ② 本包的接管判据读的就是那一位停机状态，且读的是**官方服务交回的真实形状**
//      （`ctx.goals.get(agent)` 的 `phase` / `activation` 两位），不是本包猜的枚举。
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
import { GoalService } from "@deepseek-ai/dsh-goal";
import {
  apply as applyGoalRoundDriver,
  inject as goalRoundDriverInject,
  name as goalRoundDriverName,
} from "@deepseek-ai/dsh-goal-round-driver";
import { brandString } from "@deepseek-ai/dsh-brand";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { startMockLlmServer } from "@deepseek-ai/dsh-llm-mock-server";
import type { MockLlmBehavior, MockLlmServer } from "@deepseek-ai/dsh-llm-mock-server";

import plugin from "../../host.ts";

/** 本包注入消息的 source.kind（期望值自持，不从 host.ts 导入）。 */
const RESCUE_KIND = "plugin:session-rescue";
/** 官方 round driver 开轮时的 source.kind。 */
const GOAL_KIND = "goal";
/** goal 的轮次上限：给到足够大，免得把「配额用尽」误读成「driver 停了」。 */
const MAX_GOAL_ROUNDS = 5;
/** 观测轮询的最小步长（毫秒）。 */
const POLL_STEP_MS = 20;
/** 真会话 id（幻影品牌串：构造口只有官方 `brandString`）。 */
const GOAL_SESSION_ID = "rescue-goal";

/** 官方包交回 `{ name, inject, apply }` 三件（无 default 导出），按官方用法显式拼装配对象。 */
const GoalRoundDriver = {
  name: goalRoundDriverName,
  inject: goalRoundDriverInject,
  apply: applyGoalRoundDriver,
};

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
  /** 真宿主交回的失败轮次号（`agent/error` 载荷里那一位）。 */
  failedTurns: number[];
}

let rig: Rig | undefined;

/** 起一份真装配：goal 服务 + 真 round driver + 真 agent-loop + mock 故障脚本。 */
async function boot(sequence: readonly MockLlmBehavior[]): Promise<Rig> {
  vi.stubEnv("DEEPSEEK_API_KEY", "mock-key");
  const server = await startMockLlmServer({ sequence, apiKey: "mock-key" });
  const ctx = new Context();
  // settings 用记账替身（真 SettingsForms 要 loader+profileContext，属装配面的另一层）；
  // goal 服务、round driver、agent-loop、llm 适配器全是真身。
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
    // 适配器自带重试压到零次：本层要观测的是回合级的让路/接管，不是请求级退避。
    retryPolicy: {
      mode: "normal",
      maxRetries: 0,
      backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
    },
  });
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(GoalService, { defaultMaxGoalRounds: MAX_GOAL_ROUNDS });
  await ctx.plugin(GoalRoundDriver);
  await ctx.plugin(
    plugin as never,
    {
      // 全部取 schema 允许的最小档：集成层等的是真定时器。
      resumeDelayMs: 1000,
      resumeCooldownMs: 5000,
      continueDelayMs: 500,
      continueCooldownMs: 5000,
      unfinishedDelayMs: 1000,
      unfinishedCooldownMs: 5000,
    } as never,
  );
  const agent = await ctx.agentLoop.create(brandString<SessionId>(GOAL_SESSION_ID), {
    provider: "deepseek-official",
    model: "mock-model",
  });
  const failedTurns: number[] = [];
  ctx.on("agent/error", (payload: { turn?: number }) => {
    failedTurns.push(payload.turn ?? -1);
  });
  return { ctx, agent, server, failedTurns };
}

/** 会话日志里按 source.kind 数用户消息：goal 轮与本包救援各自的条数。 */
function kindCount(agent: Agent, kind: string): number {
  return agent.session
    .deriveMessages()
    .filter(
      (message) =>
        message.role === "user" &&
        (message as { source?: { kind?: string } }).source?.kind === kind,
    ).length;
}

/** 等一个条件在真事件流里成立（轮询宿主状态，不靠猜时长；递归而非循环以避开 lint 的
 *  `no-await-in-loop`——这里要的正是「一轮只 await 一次」的串行等待）。 */
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

/** 从现在起 ms 毫秒后的时刻（集成层的等待都按可计算时限，不写死等满）。 */
function within(ms: number): number {
  return Date.now() + ms;
}

describe("真 goal + 真 round driver 下的接管", () => {
  afterEach(async () => {
    const current = rig;
    rig = undefined;
    if (current !== undefined) {
      await current.ctx.fiber.dispose();
      await current.server.close();
    }
    vi.unstubAllEnvs();
  });

  it("goal 轮被限流打掉的瞬间：driver 只 disarm，本包接管补发一条", async () => {
    rig = await boot(["rate_limit", "success"]);
    const { ctx, agent } = rig;
    const created = ctx.goals.create(agent, {
      objective: "把报告写完并核对一遍数据",
      maxGoalRounds: MAX_GOAL_ROUNDS,
    });
    // 官方语义的起点：create 即 armed，driver 会自己开第一轮。
    expect(created.activation).toBe("armed");
    expect(created.phase).toBe("active");

    // driver 开轮 → 真请求 → mock 交回 429 → agent/error → driver disarm。
    await expect(waitFor(() => kindCount(agent, GOAL_KIND) > 0, within(30_000))).resolves.toBe(
      true,
    );
    await expect(waitFor(() => rig!.failedTurns.length > 0, within(30_000))).resolves.toBe(true);
    await expect(
      waitFor(() => ctx.goals.get(agent)?.activation === "disarmed", within(30_000)),
    ).resolves.toBe(true);

    // 接管判据的两位都取到官方真实值：phase 仍是 active（durable 生命周期没变），
    // 只有进程本地的 activation 翻了——这正是「driver 放弃自动续跑」的唯一可观测量。
    const view = ctx.goals.get(agent);
    expect(view?.phase).toBe("active");
    expect(view?.activation).toBe("disarmed");

    // 本包在 delay 之后补发**恰好一条**救援消息，且带着自己的 kind（不冒充 goal 轮）。
    await expect(waitFor(() => kindCount(agent, RESCUE_KIND) > 0, within(30_000))).resolves.toBe(
      true,
    );
    await agent.whenIdle();
    expect(kindCount(agent, RESCUE_KIND)).toBe(1);
    expect(kindCount(agent, GOAL_KIND)).toBe(1);
    // driver 没有第二十一手：它 disarm 之后就不再开轮（轮次计数停在 1）。
    expect(ctx.goals.get(agent)?.roundsStarted).toBe(1);
    // 真报文数：goal 那一轮 + 救援那一轮。
    expect(rig.server.requests).toHaveLength(2);
    expect(agent.status).toBe("idle");
  }, 60_000);

  it("人在窗口里 resume ⇒ 同一条会话上只留下一个续跑者（driver）", async () => {
    // 这一条钉的是**系统级保证**，不是 goal 闸门本身：resume 之后 driver 会立刻把下一轮
    // 排进 inbox，而本包的触发前校验先看 inbox（`inbox-pending`），所以真装配里挡下注入的
    // 常常是那一位而不是 goal 闸门——两道门谁先命中取决于监听时序，本层不去假定它。
    // `goal-armed` 那一支的判据本身由单测钉住（test/host-contract.test.ts 的五位判定）。
    rig = await boot(["rate_limit", "success", "success"]);
    const { ctx, agent } = rig;
    const created = ctx.goals.create(agent, {
      objective: "把报告写完并核对一遍数据",
      maxGoalRounds: MAX_GOAL_ROUNDS,
    });
    await expect(waitFor(() => rig!.failedTurns.length > 0, within(30_000))).resolves.toBe(true);
    await expect(
      waitFor(() => ctx.goals.get(agent)?.activation === "disarmed", within(30_000)),
    ).resolves.toBe(true);

    // 本包的判读在触发侧（delay 之后）：窗口里人手动 resume ⇒ activation 回到 armed。
    const resumed = ctx.goals.resume(agent, { id: created.id, revision: created.revision });
    expect(resumed.activation).toBe("armed");

    // 给足超过 delay 的时间：不注入必须是真的没注入，而不是还没轮到。不等 whenIdle——
    // driver 会一轮接一轮跑到 mock 脚本用尽，那之后的 disarm 与本条判据无关（本条只问：
    // driver 还在续跑的这一段里，本包有没有插话）。
    await sleep(2500);
    expect(kindCount(agent, RESCUE_KIND), "救援一条都不发：续跑归 driver").toBe(0);
    // driver 自己把下一轮开起来了——这正是让路要保住的那一侧。
    expect(kindCount(agent, GOAL_KIND)).toBeGreaterThanOrEqual(2);
  }, 60_000);
});
