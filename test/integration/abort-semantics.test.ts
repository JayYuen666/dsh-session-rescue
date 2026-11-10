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
import type { MessageId } from "@deepseek-ai/dsh-llm";
import { brandString } from "@deepseek-ai/dsh-brand";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { startMockLlmServer } from "@deepseek-ai/dsh-llm-mock-server";
import type { MockLlmBehavior, MockLlmServer } from "@deepseek-ai/dsh-llm-mock-server";

import plugin from "../../host.ts";
import { performHostReask } from "../../lib/reask-host.ts";

const RESCUE_KIND = "plugin:session-rescue";
const POLL_STEP_MS = 20;
const IDLE_LABEL = "status 回到 idle";
const OLD_QUEUED = "old-queued";

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
  // 装配中途任一步抛错时，已建出的 server / ctx 必须就地回收，否则 afterEach
  // 看 rig === undefined 什么都不撤，悬挂的 socket 会污染后续用例。
  let ctx: Context | undefined;
  try {
    ctx = new Context();
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
    // 这份 config 刻意不写 `as never`：cordis 的 config 参数是开放对象，改名后的键
    // （resumeCooldownXXX 一类）加不加 cast 都不会被 tsc 拦住；但数值写成字符串会红，
    // 那份判据只有不加 cast 才拿得到。
    await ctx.plugin(plugin, {
      // 请求级阶梯在本层关掉（requestRetryMax: 0）：这几条钉的是回合级救援路径，
      // 而限流失败现在会被阶梯在回合内先救活（那是 agent-loop.test.ts 的用例）。
      requestRetryMax: 0,
      resumeDelayMs: 1000,
      resumeCooldownMs: 5000,
      continueDelayMs: 500,
      continueCooldownMs: 5000,
      unfinishedDelayMs: 1000,
      unfinishedCooldownMs: 5000,
    });
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
    // `turn/end` 的 reason.kind 是唯一权威来源，不猜宿主的事件顺序，也不碰
    // `session.snapshotEvents()`（官方已标 @deprecated，新调用是禁的）。
    ctx.on("session/event", (_session: unknown, event: unknown) => {
      const record = event as {
        type?: string;
        data?: { turn?: number; reason?: { kind?: string } };
      };
      if (record.type === "turn/end") {
        turnEnds.push({ turn: record.data?.turn, reasonKind: record.data?.reason?.kind });
      }
    });
    return { ctx, agent, server, errors, turnEnds };
  } catch (error: unknown) {
    if (ctx !== undefined) {
      await ctx.fiber.dispose();
    }
    await server.close();
    throw error;
  }
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

/** 等一个条件在真事件流里成立；超时抛点名错误，而不是让调用方的
 *  `expected false to be true` 藏掉「哪个环节没等到」。 */
async function waitFor(predicate: () => boolean, deadlineAt: number, label: string): Promise<void> {
  if (predicate()) {
    return;
  }
  if (Date.now() >= deadlineAt) {
    throw new Error(`等待超时（${label}）：时限内未成立`);
  }
  await sleep(POLL_STEP_MS);
  return waitFor(predicate, deadlineAt, label);
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

/** 请求体里的用户文本（按出现顺序）：用来钉「重问排在已排队回合之前」。 */
function userTexts(record: { body: unknown }): string[] {
  const face = record.body as { messages?: { role?: unknown; content?: unknown }[] } | undefined;
  const messages = Array.isArray(face?.messages) ? face.messages : [];
  return messages.flatMap((message) => {
    if (message.role !== "user" || !Array.isArray(message.content)) {
      return [];
    }
    return message.content.flatMap((block) => {
      if (typeof block !== "object" || block === null) {
        return [];
      }
      const { text } = block as { text?: unknown };
      return typeof text === "string" ? [text] : [];
    });
  });
}

/** stall 序列下的用户中止：请求进到流中段时 cancel，等到回合统一处理。
 *  两条用例共用这段最时序敏感的编排，官方 cancel 语义一变只改这一处。 */
async function abortDuringStall(text: string): Promise<Rig> {
  const current = await boot(["stall", "rate_limit", "success"]);
  rig = current;
  const { agent, server } = current;
  send(agent, text);
  // 等这一轮真的进到模型请求里（server 侧收到请求 = 回合已开、正在读流）。
  await waitFor(() => server.requests.length > 0, within(15_000), "模型请求到达");
  // 官方 `agent.cancel()` 不返回 promise（取消是同步登记的，收尾走事件）。
  agent.cancel({ kind: "user" });
  await waitFor(() => agent.status === "idle", within(15_000), IDLE_LABEL);
  return current;
}

/** 在跑回合里按给定顺序处理「重问 + 停止」，返回收敛后的装配。
 *  客户端 `stopAndReask` 的顺序判据（先 cancel 再入队）就钉在这里：宿主只重放
 *  cancel 之后到达的唤醒，先入队的那条停在 inbox 里没有驱动再唤醒它。 */
async function stopWithQueuedReask(order: "queue-then-cancel" | "cancel-then-queue"): Promise<Rig> {
  const current = await boot(["stall", "success"]);
  rig = current;
  const { agent, server } = current;
  send(agent, "first");
  await waitFor(() => server.requests.length > 0, within(15_000), "模型请求到达");
  const reask = createUserMessage({
    content: [{ type: "text", text: "reask" }],
    source: { kind: "user" },
  });
  if (order === "queue-then-cancel") {
    agent.followup(reask);
    agent.cancel({ kind: "user" }, { keepInbox: true });
  } else {
    agent.cancel({ kind: "user" }, { keepInbox: true });
    agent.followup(reask);
  }
  await waitFor(() => agent.status === "idle", within(15_000), IDLE_LABEL);
  return current;
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
    const { agent, errors, turnEnds } = await abortDuringStall("hold the connection open");

    // ① 中止不产出 agent/error：本包若在这里判中止，就是在读一份不存在的记录。
    expect(errors).toStrictEqual([]);
    // ② 也没有任何救援消息（既不为中止轮补跑，也不把它读成截断/未完成）。
    expect(rescueMessages(agent)).toBe(0);
    // ③ 终态确实落了盘，且恰好一次、kind 是本包认的那两个中止值之一：
    // 一次多余的 turn/end 就是救援轮偷偷多跑了一轮。
    expect(turnEnds).toHaveLength(1);
    expect(["aborted", "interrupted"]).toContain(turnEnds[0]?.reasonKind);
    // 统一处理的就是被中止的那一轮。
    expect(turnEnds[0]?.turn).toBe(1);
  }, 60_000);

  it("中止之后再来一次真瞬时失败 ⇒ 照常续跑（中止没有偷走配额）", async () => {
    const { agent } = await abortDuringStall("hold then abort");

    // 第二次请求走 rate_limit：真瞬时失败 ⇒ 本包必须还敢补一条。
    // 若中止被读成「消耗掉了一次机会」的形状（或 aborted 终态被当成截断），这里就收不到。
    send(agent, "now fail transiently");
    await waitFor(() => rescueMessages(agent) >= 1, within(20_000), "救援注入到达");
    await agent.whenIdle();
    expect(rescueMessages(agent)).toBe(1);
  }, 60_000);

  it("先入队再 cancel ⇒ 重问停在 inbox，没有驱动再唤醒它", async () => {
    const { agent, server } = await stopWithQueuedReask("queue-then-cancel");
    // 这正是客户端旧顺序的实测形状：停止收敛后模型只请求过一次。
    expect(server.requests).toHaveLength(1);
    expect(
      agent.inbox.nextTurn.map((message) => {
        const [block] = message.content;
        return block?.type === "text" ? block.text : undefined;
      }),
    ).toStrictEqual(["reask"]);
  }, 60_000);

  it("cancel 后再入队 ⇒ 唤醒在 abort 收敛后重放，重问真的发出", async () => {
    const { agent, server } = await stopWithQueuedReask("cancel-then-queue");
    expect(server.requests.length).toBeGreaterThanOrEqual(2);
    expect(agent.inbox.nextTurn).toHaveLength(0);
  }, 60_000);

  it("cancel 收敛后用 steer ⇒ 重问排在已有排队回合之前同批送达", async () => {
    const current = await boot(["stall", "success"]);
    rig = current;
    const { agent, server } = current;
    send(agent, "first");
    await waitFor(() => server.requests.length > 0, within(15_000), "模型请求到达");
    // 先排一条旧消息，再停；旧消息留在 next-turn。
    send(agent, OLD_QUEUED);
    agent.cancel({ kind: "user" }, { keepInbox: true });
    await waitFor(() => agent.status === "idle", within(15_000), IDLE_LABEL);
    // 客户端在确认 idle 后走 steer：重问进 next-step，先于旧排队回合被 claim。
    agent.steer(
      createUserMessage({
        content: [{ type: "text", text: "reask" }],
        source: { kind: "user" },
      }),
    );
    await waitFor(() => server.requests.length >= 2, within(15_000), "重问请求到达");
    await agent.whenIdle();
    expect(server.requests).toHaveLength(2);
    const texts = userTexts(server.requests[1]!);
    const reaskAt = texts.indexOf("reask");
    expect(reaskAt).toBeGreaterThanOrEqual(0);
    expect(texts.indexOf(OLD_QUEUED)).toBeGreaterThan(reaskAt);
  }, 60_000);

  it("host 侧 performHostReask：prepend 后唤醒，重问排在旧排队回合之前且不留空唤醒", async () => {
    const current = await boot(["stall", "success"]);
    rig = current;
    const { agent, server } = current;
    send(agent, "first");
    await waitFor(() => server.requests.length > 0, within(15_000), "模型请求到达");
    send(agent, OLD_QUEUED);
    let seq = 0;
    expect(
      performHostReask(agent, "reask", () => {
        seq += 1;
        return brandString<MessageId>(`host-reask-${String(seq)}`);
      }),
    ).toStrictEqual({ ok: true });
    await waitFor(() => server.requests.length >= 3, within(15_000), "重问与旧排队回合各自到达");
    await agent.whenIdle();
    // prepend 让重问独占下一轮；旧的 next-turn 仍按自己的回合排在其后。
    expect(server.requests).toHaveLength(3);
    const reaskTurn = userTexts(server.requests[1]!);
    expect(reaskTurn).toContain("reask");
    expect(reaskTurn).not.toContain(OLD_QUEUED);
    expect(userTexts(server.requests[2]!)).toContain(OLD_QUEUED);
    expect(agent.inbox.nextTurn).toHaveLength(0);
  }, 60_000);
});
