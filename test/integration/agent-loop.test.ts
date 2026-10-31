// 真实 agent-loop 集成：真 AgentLoop + 真 Session + 真投影注册表 + 真 DeepSeek HTTP/SSE
// 适配器 + 官方 dsh-llm-mock-server 的故障脚本，插件走正常 `ctx.plugin` 装配。
//
// 这一层钉的是「插件对宿主事件流的想象是否为真」：单测里的事件序列是手搓字面量，
// 顺序、载荷、终态落盘时机都由测试作者决定；这里全部由真 agent-loop 决定。
// 官方 mock server 的 behavior 就是真报文（429/5xx/断流/max_tokens/配额…），
// 所以「瞬时失败 → 自动续跑 → 这一轮真跑成功」是本机上真发生过的事。
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
/** 观测字段名：provider 给了再来时刻时会在场。 */
const RETRY_AFTER_FIELD = "providerRetryAfterMs";
/** 本层断言用到的最小轮询间隔（毫秒）。 */
const POLL_STEP_MS = 20;

/** 适配器条目：官方包交回 `{ name, inject, apply, Config }` 四件（没有 default 导出，
 *  官方用法就是把这四位拼成插件对象），这里显式拼而不引通配命名空间。 */
const DeepSeekAdapter = {
  name: deepSeekName,
  inject: deepSeekInject,
  Config: deepSeekConfig,
  apply: applyDeepSeek,
};

/** exactOptionalPropertyTypes：交回 undefined 与「没有这一位」是两件事，如实写出来。 */
interface ObservedFailure {
  code?: string | undefined;
  status?: number | undefined;
  message?: string | undefined;
  [RETRY_AFTER_FIELD]?: number | undefined;
}

/** 一次真失败的观测面。不整体留 `agent/error` 载荷：那里的 `agent` 是 cordis 代理，
 *  整体序列化会撞上「cannot get property toJSON without inject」。 */
interface ObservedError {
  turn: number | undefined;
  step: number | undefined;
  name: string | undefined;
  message: string | undefined;
  failure: ObservedFailure;
}

interface Rig {
  ctx: Context;
  agent: Agent;
  server: MockLlmServer;
  failures: ObservedError[];
}

let rig: Rig | undefined;

/** 失败面投影：交回的不是对象时每一位都读成 undefined，于是断言侧不必区分
 *  「没有失败面」与「失败面缺某一位」。 */
function observedFailure(raw: unknown): ObservedFailure {
  const face =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : undefined;
  const retryAfter = face?.[RETRY_AFTER_FIELD];
  return {
    code: typeof face?.["code"] === "string" ? face["code"] : undefined,
    status: typeof face?.["status"] === "number" ? face["status"] : undefined,
    message: typeof face?.["message"] === "string" ? face["message"] : undefined,
    providerRetryAfterMs: typeof retryAfter === "number" ? retryAfter : undefined,
  };
}

/** 起一份真装配：真服务栈 + 真故障脚本，插件延迟压到 schema 允许的最小档。
 * @param options.withAdapterPolicy - false 时**不给**适配器配 retryPolicy，
 *  用来观测宿主在这一位上究竟交回什么。 */
async function boot(
  sequence: readonly MockLlmBehavior[],
  options: {
    config?: Record<string, unknown>;
    successText?: string;
    withAdapterPolicy?: boolean;
  } = {},
): Promise<Rig> {
  vi.stubEnv("DEEPSEEK_API_KEY", "mock-key");
  const server = await startMockLlmServer({
    sequence,
    apiKey: "mock-key",
    successText: options.successText ?? "recovered answer",
  });
  const ctx = new Context();
  try {
    // settings 用记账替身（真 SettingsForms 要 loader+profileContext，属另一层的装配面）；
    // 其余宿主服务全是真身。
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
      ...(options.withAdapterPolicy === false
        ? {}
        : {
            // 适配器自带重试压到零次：这几条装配要测的是回合级续跑/续写，
            // 不是请求级退避（请求级另有不配策略的那一条）。
            retryPolicy: {
              mode: "normal",
              maxRetries: 0,
              backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
            },
          }),
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
        ...options.config,
      } as never,
    );
    const agent = await ctx.agentLoop.create(
      brandString<SessionId>(`rescue-${sequence.join("-")}`),
      {
        provider: "deepseek-official",
        model: "mock-model",
      },
    );
    const failures: ObservedError[] = [];
    ctx.on("agent/error", (payload: { turn?: number; step?: number; error?: unknown }) => {
      const { error } = payload;
      const face = error as { name?: unknown; message?: unknown; failure?: unknown } | null;
      failures.push({
        turn: payload.turn,
        step: payload.step,
        name: typeof face?.name === "string" ? face.name : undefined,
        message: typeof face?.message === "string" ? face.message : undefined,
        failure: observedFailure(face?.failure),
      });
    });
    return { ctx, agent, server, failures };
  } catch (error) {
    // 装配中途失败时 rig 还没赋值，afterEach 拿不到 server/ctx：在这里就地释放，
    // 否则端口与调度器会带进同进程的后续用例。
    await ctx.fiber.dispose().catch(() => null);
    await server.close().catch(() => null);
    throw error;
  }
}

/** 在插件之前挂一个 `agent/request-error` 观察者：cordis 首个注册者最外层。
 *  这里只记录宿主交回的 `retryPolicy` 位，然后 next() 原样放行，不参与决策。 */
function probeRequestError(ctx: Context, sink: { policy: unknown }[]): void {
  const scoped = ctx as unknown as {
    on: (
      event: string,
      fn: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>,
    ) => unknown;
  };
  scoped.on("agent/request-error", async (payload: unknown, next: () => Promise<unknown>) => {
    const face = payload as { retryPolicy?: unknown } | null;
    sink.push({ policy: face?.retryPolicy });
    return next();
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

/** 等一个条件在真事件流里成立：轮询宿主状态而不是猜时间，递归而不是循环内 await。 */
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

describe("真 AgentLoop 下的自动续跑", () => {
  afterEach(async () => {
    const current = rig;
    rig = undefined;
    if (current !== undefined) {
      await current.ctx.fiber.dispose();
      await current.server.close();
    }
    vi.unstubAllEnvs();
  });

  it("限流失败后自动补一条救援消息，下一轮真跑成功", async () => {
    rig = await boot(["rate_limit", "success"]);
    const { agent } = rig;
    await send(agent, "first task");
    // 回合失败后插件armed 定时器（本处取 schema 下限 1000ms）；等它 fire 并跑完第二轮。
    await expect(waitFor(() => rescueMessages(agent).length > 0, within(6000))).resolves.toBe(true);
    await agent.whenIdle();
    expect(rig.server.requests).toHaveLength(2);
    expect(agent.status).toBe("idle");
    // 官方适配器交回的限流面（单测里的形状以此为证）：provider 给 Retry-After 时
    // `failure.providerRetryAfterMs` 也在场，本包的请求级退避就认它。
    expect(rig.failures).toHaveLength(1);
    expect(rig.failures[0]?.name).toBe("LlmError");
    expect(rig.failures[0]?.turn).toBe(1);
    expect(rig.failures[0]?.step).toBe(1);
    expect(rig.failures[0]?.failure.code).toBe("RATE_LIMIT");
    expect(rig.failures[0]?.failure.status).toBe(429);
    expect(rig.failures[0]?.failure.message).toBeTypeOf("string");
    expect(rig.failures[0]?.failure.providerRetryAfterMs).toBeTypeOf("number");
  }, 60_000);

  it("max_tokens 截断后自动续写", async () => {
    rig = await boot(["max_tokens", "success"]);
    const { agent } = rig;
    await send(agent, "write a long essay");
    await expect(waitFor(() => rescueMessages(agent).length > 0, within(6000))).resolves.toBe(true);
    await agent.whenIdle();
    // 截断**不是** agent/error：终态是 turn/end 的 max-tokens reason，
    // 续写因此由 agent/status→idle 那侧发起（本用例证明这条链在真宿主上是通的）。
    expect(rig.failures).toHaveLength(0);
  }, 60_000);

  it("配额耗尽（quota_exceeded）是永久失败，绝不注入", async () => {
    rig = await boot(["quota_exceeded", "success"]);
    const { agent } = rig;
    await send(agent, "budget-burning task");
    // 真宿主交出来的失败面：code 由适配器归一（llm-deepseek/src/transport.ts:30 的
    // `isQuotaExceededError(detail) || status === 402`），单测里那几枚
    // `code:"insufficient_quota"` 的字面量并不是宿主真实交回的形。
    expect(rig.failures).toHaveLength(1);
    expect(rig.failures[0]?.name).toBe("LlmError");
    expect(rig.failures[0]?.failure.code).toBe("QUOTA");
    expect(rig.failures[0]?.failure.status).toBe(429);
    expect(rig.failures[0]?.failure.message).toBe("mock insufficient quota");
    // 判据：QUOTA 是官方码表里「额度到了」的机器码，重试不可能变好；429 只是它的
    // HTTP 外衣（provider 用同一个状态码表达余额耗尽与分钟限速），所以必须由 code 路由。
    await expect(waitFor(() => rescueMessages(agent).length > 0, within(3000))).resolves.toBe(
      false,
    );
    expect(rig.server.requests).toHaveLength(1);
  }, 60_000);

  it("真 deepseek 适配器总会解析出一份重试策略 ⇒ 本包的请求级阶梯让位", async () => {
    // 探针事实：完全不配 retryPolicy 时适配器仍按 `resolveRetryPolicy(undefined)` 交回
    // 一份默认策略（mode:normal / maxRetries:5 / 码表含 RATE_LIMIT），于是 host.ts 的
    // 「宿主已解析出策略 ⇒ 重试归官方 llm-retry」这条判据成立。两条推论只有真宿主
    // 能给：本包阶梯不是这个适配器的兜底路径（那条路只有单测能造），而 profile 若没装
    // dsh-llm-retry，一次 429 会零次重发直接终态。
    rig = await boot(["rate_limit", "success"], { withAdapterPolicy: false });
    const { agent } = rig;
    const observed: { policy: unknown }[] = [];
    probeRequestError(rig.ctx, observed);
    await send(agent, "single shot task");
    await agent.whenIdle();
    expect(observed).toHaveLength(1);
    expect(observed[0]?.policy).toBeTypeOf("object");
    expect(rig.server.requests).toHaveLength(1);
  }, 60_000);
});
