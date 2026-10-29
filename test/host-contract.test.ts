// host.ts 契约补充：现有 host.test.ts 之外的缺口面（服务缺失降级、路由
// 方法守卫/body 上限、用户中止不消耗配额、等待中 abort、重连恢复各分支、
// 总线沉淀容错、请求级重试计数耗尽重置、瞬时失败→成功兑 pass 的「已遵守」观测）。
import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import plugin, { RESCUE_REMOTE_NAMESPACE, transientSignatureOf } from "../host.ts";
import { applyRescue, configDict, volatileFormOf } from "./config-refs.ts";
import { loggedText } from "./setup-logs.ts";
import type { SchemaNode } from "./config-refs.ts";

// 宿主事件名、回合终态 kind 与总线沉淀分类：替身造事件流与断言期望值都取这几条。
// 这些都是测试作者自持的**期望值**（不从 host.ts 导入，否则断言就是拿被测常量比自己）。
const TURN_START_EVENT = "turn/start";
const USER_MESSAGE_EVENT = "user/message";
const AGENT_ERROR_EVENT = "agent/error";
const AGENT_STATUS_EVENT = "agent/status";
const MAX_TOKENS_REASON = "max-tokens";
const TRANSIENT_LESSON_CATEGORY = "transient-failure";

/** 总线抛错支线的会话 id：dispose/pass 那几条用例按它查台账。 */
const PASS_DISPOSE_SESSION_ID = "pass-dispose";

/** 替身运输层故意抛错的消息：断言它出现在日志里，才证明错误没被静默吞掉。 */
const CARRIER_DOWN_MESSAGE = "carrier down";
/** llm-pi-ai 那条 describe 里已声明的 provider（retry-policy 白名单的唯一合法值）。 */
const KNOWN_PROVIDER = "sensenova";
/** 真适配器交回的限流载荷形状（集成层实测的字段面），多处用例共用。 */
const RATE_LIMIT_MESSAGE = "rate limit exceeded";

interface TimerEntry {
  fn: () => void;
  ms: number;
  cancelled: boolean;
  fired: boolean;
}

interface MockAgent {
  id: string;
  options?: { provider?: string } | null;
  status?: string;
  inbox?: { nextTurn?: unknown[]; nextStep?: unknown[] };
  session: {
    id: string;
    snapshotEvents: () => unknown[];
    evs?: unknown[];
    /** lesson-loop 的 project 由 cwd 推导（report/pass 必须同源，见 pass 用例）。 */
    header?: { cwd?: unknown };
  };
  followup: (message: unknown) => void;
  followupCalls: unknown[];
}

interface LessonReport {
  input: Record<string, unknown>;
}

interface LessonPass {
  input: Record<string, unknown>;
}

interface MockInjectCtx {
  effect: (factory: () => (() => void) | undefined) => void;
  get: (name: string) => unknown;
  /** cordis 的注入子上下文同样带着被注入服务的读面（settings.configure 走这条路）。 */
  settings: MockCtx["settings"];
  /** 真 cordis 把被注入的服务也挂在子 ctx 的属性上，插件读的就是
   *  `child.sessionProjections` 与注册口，替身必须照样交出去。 */
  sessionProjections?: unknown;
  reflect: MockCtx["reflect"] | undefined;
}

interface MockCtx {
  handlers: Record<string, (payload: unknown, next?: unknown) => unknown>;
  timers: TimerEntry[];
  effects: (() => void)[];
  /** ctx.inject 子 fiber 上登记的释放器（先卸后装可断言）。 */
  childEffects: (() => void)[];
  scope: { get: () => Record<string, unknown>; set: (patch: Record<string, unknown>) => void };
  /** 本插件 fiber：settings.configure 的 owner 必须是它。 */
  fiber: { id: string };
  /** 页面策略登记记录（{ auto:false } + owner 的断言面）。 */
  configureCalls: { presentation: { auto?: boolean }; owner: unknown }[];
  agents?: {
    rootsList: MockAgent[];
    byId: Map<string, MockAgent>;
    roots: () => { id: string }[];
    get: (id: string) => MockAgent | undefined;
  };
  lessonLoop?: {
    /** 返回值按 unknown 收：lesson-loop 落库已异步（report 返回 Promise），声明成
     *  `=> void` 会让"调用方丢弃 Promise"通过类型检查——正是这次静默失败的根因。 */
    report: (input: LessonReport["input"]) => unknown;
    pass: (input: LessonPass["input"]) => unknown;
  };
  lessonReports: LessonReport["input"][];
  /** 总线 pass 调用记录（「已遵守」观测的断言面）。 */
  lessonPasses: LessonPass["input"][];
  piAiDescribeImpl?: () => unknown;
  /** `llm-pi-ai` 行的 revision；undefined = 该行没带出 revision 字段（CAS 无从取值）。 */
  piAiRevision?: number;
  /** 让 mutate 抛 SettingsConflictError，模拟读到 revision 之后别处又改了同一段。 */
  mutateConflict?: boolean;
  /** 0.1.7 的 settings 服务面：`register`/`get`/`installSection` 已被宿主移除
   *  （命名空间改按 profile 条目 id 隐式注册），只剩 describe / mutate / configure。 */
  settings: {
    describe: () => unknown;
    mutate: (ns: string, ops: unknown[], expectedRevision?: number) => Promise<void>;
    configure: (presentation: { auto?: boolean }, owner?: unknown) => () => void;
  };
  /** 每次 mutate 的完整入参（含 CAS 的 expectedRevision），用于断言覆盖写有没有带版本。 */
  mutations: { ns: string; ops: unknown[]; expectedRevision: number | undefined }[];
  timer: { timeout: (fn: () => void, ms: number) => () => void };
  on: (event: string, handler: (payload: unknown, next?: unknown) => unknown) => void;
  get: (name: string) => unknown;
  /** 官方服务注册口（Typert Remote 服务构造时用）。 */
  reflect: { provide: (name: string, service: unknown) => () => void };
  effect: (factory: () => (() => void) | undefined) => void;
  /** cordis `ctx.inject` 替身：依赖齐了才激活回调，服务变化时先卸后装。 */
  inject: (deps: string[], activate: (child: MockInjectCtx) => void) => void;
  /** 变更宿主服务表（模拟可选服务后装载 / 重启换实例）。 */
  setService: (name: string, service: unknown) => void;
  fire: (event: string, payload: unknown) => void;
  fireWaterfall: (
    event: string,
    payload: unknown,
    next: () => Promise<unknown>,
  ) => Promise<unknown>;
  tick: () => void;
  disposeEffects: () => void;
}

function createCtx(
  opts: {
    agents?: boolean;
    lessonLoop?: boolean;
    describeThrows?: boolean;
    /** 官方 locale 命名空间里的偏好（undefined = 该命名空间未注册 → host 走中文）。 */
    locale?: string;
    /** `llm-pi-ai` 行的 revision（undefined = 该行没带出 revision 字段，CAS 无从取值）。 */
    piAiRevision?: number;
    /** 让 mutate 抛 SettingsConflictError，模拟读到 revision 之后别处又改了同一段。 */
    mutateConflict?: boolean;
  } = {},
): MockCtx {
  const handlers: Record<string, (payload: unknown, next?: unknown) => unknown> = {};
  const timers: TimerEntry[] = [];
  const effects: (() => void)[] = [];
  let configValue: Record<string, unknown> = {
    enabled: true,
    providerExcludes: [],
    resumeDelayMs: 10_000,
    resumeCooldownMs: 120_000,
    maxResumes: 3,
    chainResumeDelayMs: 60_000,
    continueDelayMs: 3000,
    continueCooldownMs: 60_000,
    maxContinues: 3,
    resumeOnOpenTodos: true,
    unfinishedDelayMs: 5000,
    unfinishedCooldownMs: 120_000,
    maxUnfinished: 2,
  };
  const scope: MockCtx["scope"] = {
    get: () => configValue,
    set(patch) {
      configValue = { ...configValue, ...patch };
    },
  };
  const holder: { ctx: MockCtx | null } = { ctx: null };
  const mutations: { ns: string; ops: unknown[]; expectedRevision: number | undefined }[] = [];
  const settings = {
    // 0.1.7 唯一的跨命名空间读：locale 偏好与 llm-pi-ai 都从这张 describe 表单里挑。
    // opts.locale 未设 = 官方 client-locale 那条目没被投影 → 该行不存在 → 中文默认。
    describe(): unknown {
      if (opts.describeThrows === true) {
        throw new Error("settings describe down");
      }
      const rows: { ns: string; value: unknown; revision: number | undefined }[] = [
        {
          ns: "llm-pi-ai",
          revision: opts.piAiRevision,
          value: {
            providers: {
              sensenova: {
                retryPolicy: { mode: "normal", maxRetries: 5, retryableCodes: ["RATE_LIMIT"] },
              },
            },
          },
        },
      ];
      return opts.locale === undefined
        ? rows
        : [...rows, { ns: "locale", value: { preference: opts.locale } }];
    },
    async mutate(ns: string, ops: unknown[], expectedRevision?: number): Promise<void> {
      if (opts.mutateConflict === true) {
        // 官方 SettingsConflictError 的机器码那一对（code + name），宿主按值判。
        throw Object.assign(new Error("revision moved"), { code: "SETTINGS_CONFLICT" });
      }
      mutations.push({ ns, ops, expectedRevision });
    },
    // 页面策略（本包自带设置卡片 → auto:false）；owner 必须是本插件 fiber。
    configure(presentation: { auto?: boolean }, owner?: unknown): () => void {
      holder.ctx?.configureCalls.push({ presentation, owner });
      return (): void => {
        void 0;
      };
    },
  };
  const timerService = {
    timeout(fn: () => void, ms: number) {
      const entry: TimerEntry = { fn, ms, cancelled: false, fired: false };
      timers.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  };
  const agentsService = {
    rootsList: [] as MockAgent[],
    byId: new Map<string, MockAgent>(),
    roots() {
      return this.rootsList;
    },
    get(id: string) {
      return this.byId.get(id);
    },
  };
  // 宿主服务表（cordis `ctx.get` 的无 inject 存储读替身）：Map 形态，
  // setService(name, undefined) 才是真的「服务下线」（Record 动态 delete 被 lint 拒）。
  const lessonReports: LessonReport["input"][] = [];
  const lessonPasses: LessonPass["input"][] = [];
  const lessonLoop = {
    report(input: LessonReport["input"]) {
      if (holder.ctx?.lessonLoop?.report === lessonLoop.report) {
        lessonReports.push(input);
      }
      holder.ctx?.lessonReports.push(input);
    },
    pass(input: LessonPass["input"]) {
      holder.ctx?.lessonPasses.push(input);
      return { ok: true };
    },
  };
  const provided = new Map<string, unknown>([
    ["settings", settings],
    ["timer", timerService],
  ]);
  if (opts.agents !== false) {
    provided.set("agents", agentsService);
  }
  if (opts.lessonLoop === true) {
    provided.set("lessonLoop", lessonLoop);
  }
  const injections: { deps: string[]; activate: (child: MockInjectCtx) => void }[] = [];
  const childEffects: (() => void)[] = [];
  /** 依赖到位才激活；已激活的先卸后装（对齐 cordis registry 的 inject 语义）。 */
  const activateInjection = (injection: {
    deps: string[];
    activate: (child: MockInjectCtx) => void;
  }): void => {
    if (!injection.deps.every((dep) => provided.get(dep) !== undefined)) {
      return;
    }
    injection.activate({
      effect(factory) {
        const disposer = factory();
        if (typeof disposer === "function") {
          childEffects.push(disposer);
        }
      },
      get: (name: string) => provided.get(name),
      // 注入子上下文同样能读到被注入的那个服务（configure 就走这条路）。
      reflect: holder.ctx?.reflect,
      settings,
      sessionProjections: provided.get("sessionProjections"),
    });
  };
  const runInjections = (): void => {
    for (const dispose of childEffects.splice(0)) {
      dispose();
    }
    for (const injection of injections) {
      activateInjection(injection);
    }
  };
  const ctx: MockCtx = {
    handlers,
    timers,
    effects,
    childEffects,
    scope,
    settings,
    fiber: { id: "session-rescue-fiber" },
    configureCalls: [],
    mutations,
    lessonReports,
    lessonPasses,
    timer: timerService,
    agents: agentsService,
    lessonLoop,
    on(event, handler) {
      handlers[event] = handler;
    },
    get(name) {
      return provided.get(name);
    },
    reflect: {
      provide(name: string, service: unknown) {
        provided.set(name, service);
        return () => {
          provided.delete(name);
        };
      },
    },
    effect(factory) {
      const disposer = factory();
      if (typeof disposer === "function") {
        effects.push(disposer);
      }
    },
    inject(deps, activate) {
      // 新建一个子 fiber：只激活**它自己**（cordis 不会因别人注册而重跑已激活的
      // 子 fiber）。服务变更导致的先卸后装走 setService → runInjections。
      const injection = { deps, activate };
      injections.push(injection);
      activateInjection(injection);
    },
    setService(name, service) {
      if (service === undefined) {
        provided.delete(name);
      } else {
        provided.set(name, service);
      }
      runInjections();
    },
    fire(event, data) {
      handlers[event]?.(data);
    },
    async fireWaterfall(event, data, next) {
      const handler = handlers[event] as
        | ((payload: unknown, nextFn: () => Promise<unknown>) => Promise<unknown>)
        | undefined;
      return handler?.(data, next);
    },
    tick() {
      for (const entry of timers) {
        if (!entry.fired && !entry.cancelled) {
          entry.fired = true;
          entry.fn();
        }
      }
    },
    disposeEffects() {
      for (const disposer of effects) {
        disposer();
      }
      for (const disposer of childEffects.splice(0)) {
        disposer();
      }
    },
  };
  holder.ctx = ctx;
  void lessonLoop;
  return ctx;
}

function makeAgent(id: string, provider?: string, events: unknown[] = []): MockAgent {
  const followupCalls: unknown[] = [];
  const agent: MockAgent = {
    id,
    options: provider === undefined ? {} : { provider },
    status: "idle",
    inbox: { nextTurn: [], nextStep: [] },
    session: { id, snapshotEvents: () => events, evs: events },
    followup(msg) {
      followupCalls.push(msg);
    },
    followupCalls,
  };
  return agent;
}

function register(ctx: MockCtx, agent: MockAgent): MockAgent {
  ctx.agents?.rootsList.push(agent);
  ctx.agents?.byId.set(agent.id, agent);
  return agent;
}

/** 一个 goal 轮次驱动的完整回合事件流（turn/start → goal 开的 user/message →
 *  turn/end(reason=endKind)）：三类注入的让路判定都以此为输入。 */
function goalEvents(turn: number, endKind: string): unknown[] {
  return [
    { type: TURN_START_EVENT, seq: 1, time: 1, data: { turn } },
    {
      type: USER_MESSAGE_EVENT,
      seq: 2,
      time: 2,
      data: { role: "user", content: [], source: { kind: "goal", goalId: "g1", round: 2 } },
    },
    { type: "turn/end", seq: 3, time: 3, data: { turn, reason: { kind: endKind } } },
  ];
}

/** 取 request-error 监听器（waterfall 形态）。 */
function listenerOf(
  ctx: MockCtx,
): (payload: unknown, next: () => Promise<unknown>) => Promise<unknown> {
  return ctx.handlers["agent/request-error"] as unknown as (
    payload: unknown,
    next: () => Promise<unknown>,
  ) => Promise<unknown>;
}

function errorPayload(agent: MockAgent, turn: number, failure: unknown): Record<string, unknown> {
  return { agent, turn, step: 1, error: failure === null ? null : { failure } };
}

/** 注册结果在 `await` 之后才交出读口（两版原始返回值都是函数，判别只能在 await 之后），
 *  所以投影用例要等一拍再判定。 */
const settle = (): Promise<unknown> => {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  setImmediate(resolve);
  return promise;
};

function applyPlugin(ctx: MockCtx): void {
  // 0.1.7：apply 的第二参是 volatile 引用（引用不变、值可变），故按 ctx 的活值表
  // 现读——用例之后 `ctx.scope.set(...)` 依然能被插件读到（等价于设置卡写了一次）。
  applyRescue(ctx, () => ctx.scope.get());
}

interface RescueRemote {
  state: () => { ok: true; sessions: Record<string, unknown> };
  cancel: (request: { sessionId: string }) => Record<string, unknown>;
  toggle: (request: { sessionId: string }) => Record<string, unknown>;
  resume: () => { ok: true; restored: number };
  retryProviders: () => Record<string, unknown>;
  retryPolicy: (request: { provider: string; preset: string }) => Promise<Record<string, unknown>>;
}

function remoteOf(ctx: MockCtx): RescueRemote {
  const service: unknown = ctx.get(RESCUE_REMOTE_NAMESPACE);
  assert.ok(service !== undefined, "Remote 读面没注册到上下文");
  return service as RescueRemote;
}

/** 装一枚只读五位状态的 goals 替身（本包只用 `get(agent)` 那一位）。
 *  模块级而不是 describe 内闭包：它不捕获任何父作用域变量。 */
function ctxWithGoal(view: unknown): MockCtx {
  const ctx = createCtx();
  ctx.setService("goals", {
    get: (): unknown => view,
  });
  applyPlugin(ctx);
  return ctx;
}

/** 排一次 goal 轮失败并立刻触发，返回该 agent 的注入次数与定时器数。 */
function fireGoalFailure(view: unknown, turn = 7): { injections: number; timers: number } {
  const ctx = ctxWithGoal(view);
  const agent = makeAgent("s1", "x", goalEvents(turn, "error"));
  register(ctx, agent);
  ctx.fire(AGENT_ERROR_EVENT, errorPayload(agent, turn, { code: "RATE_LIMIT", message: "x" }));
  const timers = ctx.timers.length;
  ctx.tick();
  return { injections: agent.followupCalls.length, timers };
}

const nextNoop = async (): Promise<undefined> => undefined;

/** Config schema 的 `~standard.validate`：真实宿主装载期走的就是这一条（cordis
 *  fiber.ts resolveConfig）。用它证明「数值下限」闸门在 schema 层，而不是插件代码里
 *  随手一处 `||` 兜底——后者是本次要删掉的死分支。 */
function rowValid(row: Record<string, unknown>): boolean {
  const schema = plugin as unknown as {
    Config: { "~standard": { validate: (value: unknown) => { issues?: unknown } } };
  };
  return schema.Config["~standard"].validate(row).issues === undefined;
}

/** 连发 times 次 429（每次让退避定时器立刻到点），收集 waterfall 结局。
 *  用递归而不是 for + await：重试计数按会话累加，必须严格串行（同 host.test.ts
 *  的 step 写法），而本包 lint 不许 await-in-loop。 */
async function fireRateLimits(ctx: MockCtx, agent: MockAgent, times: number): Promise<unknown[]> {
  const listener = listenerOf(ctx);
  const outcomes: unknown[] = [];
  const step = async (remaining: number): Promise<void> => {
    if (remaining === 0) {
      return;
    }
    const pending = listener(
      { agent, turn: 1, failure: { code: "RATE_LIMIT", message: "slow down" }, signal: undefined },
      async (): Promise<string> => "NEXT",
    );
    ctx.tick();
    outcomes.push(await pending);
    return step(remaining - 1);
  };
  await step(times);
  return outcomes;
}

/** 造一个挂起快照（followup 抛错 → fire → suspendedSnapshots 有记录）。 */
function suspendAgent(ctx: MockCtx, agent: MockAgent): void {
  agent.followup = () => {
    throw new Error(CARRIER_DOWN_MESSAGE);
  };
  register(ctx, agent);
  ctx.fire(AGENT_ERROR_EVENT, errorPayload(agent, 1, { code: "RATE_LIMIT", message: "x" }));
  // timer 由 scheduleInjection 追加到数组末尾；取最新（本 agent 触发的那枚）
  const latest = ctx.timers.at(-1);
  assert.ok(latest, "suspendAgent 期待调度出定时器");
  latest.fn();
}

describe("宿主服务缺失降级", () => {
  it("agents 服务缺失：agent/error 与 status 静默不炸", () => {
    const ctx = createCtx({ agents: false });
    applyPlugin(ctx);
    ctx.fire(
      AGENT_ERROR_EVENT,
      errorPayload(makeAgent("s1", "x"), 1, { code: "RATE_LIMIT", message: "x" }),
    );
    ctx.fire(AGENT_STATUS_EVENT, { agent: makeAgent("s1", "x"), status: "idle" });
    assert.equal(ctx.timers.length, 0);
  });

  it("lessonLoop 缺失：瞬时失败照常调度（总线可选，不阻断）", () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    const agent = makeAgent("s1", "x");
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, errorPayload(agent, 1, { code: "RATE_LIMIT", message: "x" }));
    assert.equal(ctx.timers.length, 1);
  });

  it("lessonLoop.report 抛错：静默降级不阻断调度", () => {
    const ctx = createCtx({ lessonLoop: true });
    ctx.lessonLoop!.report = () => {
      throw new Error("bus down");
    };
    applyPlugin(ctx);
    const agent = makeAgent("s1", "x");
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, errorPayload(agent, 1, { code: "SERVER", message: "boom" }));
    assert.equal(ctx.timers.length, 1);
  });
});

describe("载荷边界（防御式）", () => {
  let ctx: MockCtx;
  beforeEach(() => {
    ctx = createCtx();
    applyPlugin(ctx);
  });

  it("agent/error 无 agent → 不炸", () => {
    ctx.fire(AGENT_ERROR_EVENT, { turn: 1 });
    assert.equal(ctx.timers.length, 0);
  });

  it("agent/status payload 空 / status 非 idle → 不处理", () => {
    ctx.fire(AGENT_STATUS_EVENT, null);
    ctx.fire(AGENT_STATUS_EVENT, {});
    ctx.fire(AGENT_STATUS_EVENT, { agent: makeAgent("s1"), status: "running" });
    assert.equal(ctx.timers.length, 0);
  });

  it("agent/status idle 但事件流无回合（lastTurn null）→ 不处理", () => {
    const agent = makeAgent("s1", "x");
    register(ctx, agent);
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 0);
  });

  it("request-error 无 agent / 无 session / failure 非对象 → 委托 next", async () => {
    const listener = ctx.handlers["agent/request-error"] as unknown as (
      payload: unknown,
      next: () => Promise<unknown>,
    ) => Promise<unknown>;
    let called = 0;
    const next = async (): Promise<undefined> => {
      called += 1;
    };
    assert.equal(await listener({ turn: 1 }, next), undefined);
    assert.equal(await listener({ agent: { id: "a" } }, next), undefined);
    assert.equal(await listener({ agent: makeAgent("a"), failure: "rate limit" }, next), undefined);
    assert.equal(called, 3);
  });

  it("agent/disposed 无会话 id → 静默", () => {
    const disposed = ctx.handlers["agent/disposed"];
    if (typeof disposed !== "function") {
      assert.fail("apply 必须挂上 agent/disposed 处理器");
    }
    // 「静默」的可判形态：三条取不到会话 id 的载荷都不抛，且一条定时器也不排（零副作用）。
    assert.doesNotThrow(() => disposed({}));
    assert.doesNotThrow(() => disposed({ agent: {} }));
    assert.doesNotThrow(() => disposed({ agent: { session: { id: "" } } }));
    assert.equal(ctx.timers.length, 0, "无会话 id 的 disposed 不得产生任何副作用");
  });

  it("failureText 的 status 分支：瞬时失败 reportLesson detail 含 status", () => {
    const ctx2 = createCtx({ lessonLoop: true });
    applyPlugin(ctx2);
    const agent = makeAgent("s1", "x");
    register(ctx2, agent);
    ctx2.fire(AGENT_ERROR_EVENT, errorPayload(agent, 1, { code: "E", status: 429 }));
    const [report] = ctx2.lessonReports;
    assert.ok(report, "总线收到报告");
    assert.equal(report["category"], TRANSIENT_LESSON_CATEGORY);
    assert.ok(String(report["detail"]).includes("status=429"), "detail 保留 status");
  });
});

describe("用户中止/打断的回合不消耗配额，判定只在 agent/status 侧", () => {
  // 为什么 agent/error 侧**没有**中止判定（源码为证）：
  //   packages/core/agent-loop/src/agent.ts 的 turn() 里 `catch` 先
  //   `throwError(error)` → emit('agent/error')，`finally` 才
  //   `session.append('turn/end', …)`；且 signal.aborted 分支直接 rethrow、
  //   **根本不** emit agent/error。所以"在 error 处扫该轮 turn/end 是否 aborted"
  //   永远扫不到——那是死代码，已删（原 turnEndedAborted）。
  it("agent/error 时该轮 turn/end 尚未落盘：即便日志里有 aborted 记录也不再 veto（回归护栏）", () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    const agent = makeAgent("s1", "x", [
      { type: TURN_START_EVENT, seq: 1, time: 1, data: { turn: 1 } },
      { type: "turn/end", seq: 2, time: 2, data: { turn: 1, reason: { kind: "aborted" } } },
    ]);
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, errorPayload(agent, 1, { code: "RATE_LIMIT", message: "x" }));
    // 瞬时失败 + 根会话 + 未关闭 → 照常调度（不再依赖那段死判定）。
    assert.equal(ctx.timers.length, 1);
  });

  it("真实 abort 路径：被中止的回合不发 agent/error，配额由 status 侧保住", () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    const agent = makeAgent("s1", "x", [
      { type: TURN_START_EVENT, seq: 1, time: 1, data: { turn: 1 } },
      { type: "turn/end", seq: 2, time: 2, data: { turn: 1, reason: { kind: "aborted" } } },
    ]);
    register(ctx, agent);
    // 中止回合只走 agent/status（reason.kind=aborted）→ 不调度、不重置、不计数。
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 0);
    const st = remoteOf(ctx).state();
    const { counts } = st.sessions["s1"] as { counts?: { resume?: number } };
    // 中止回合既不产生调度记录也不增计数（配额原样保留给下一次真实失败）。
    assert.equal(counts?.resume ?? 0, 0, "中止回合不烧 maxResumes 配额");
  });

  it("agent/status：lastReasonKind interrupted 同理不处理", () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    const agent = makeAgent("s1", "x", [
      { type: "turn/end", seq: 1, time: 1, data: { turn: 2, reason: { kind: "interrupted" } } },
    ]);
    register(ctx, agent);
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 0);
  });

  it("goal 轮次的让路判据在触发侧：排期照排，读不到停机位就不接管", () => {
    // 官方 goal-round-driver 在 `agent/error` / max-tokens 上**只 disarm、绝不自动重试**
    // （其 README「No abnormal auto-retry」），所以「一律让路」等于这条失败回合永久没人管。
    // 判据因此挪到触发侧现读 driver 自己的停机位；这里 goals 服务不在位 ⇒ 无从证明它已停机
    // ⇒ 保守让路（与让路判据迁移前同解：一条都不注入）。
    const resumeCtx = createCtx();
    applyPlugin(resumeCtx);
    const resumeAgent = makeAgent("s1", "x", goalEvents(7, "error"));
    register(resumeCtx, resumeAgent);
    resumeCtx.fire(
      AGENT_ERROR_EVENT,
      errorPayload(resumeAgent, 7, { code: "RATE_LIMIT", message: "x" }),
    );
    assert.equal(resumeCtx.timers.length, 1, "goal 轮失败照样排期——让路与否要等停机位");
    resumeCtx.tick();
    assert.equal(resumeAgent.followupCalls.length, 0, "读不到停机位 ⇒ 不注入");
    assert.match(loggedText(), /vetoed at fire time \(goal-service-unavailable\)/u);

    // continue：max-tokens 截断落在 goal 轮上
    const continueCtx = createCtx();
    applyPlugin(continueCtx);
    const continueAgent = makeAgent("s1", "x", goalEvents(8, MAX_TOKENS_REASON));
    register(continueCtx, continueAgent);
    continueCtx.fire(AGENT_STATUS_EVENT, { agent: continueAgent, status: "idle" });
    assert.equal(continueCtx.timers.length, 1, "截断也排期，判据同样在触发侧");
    continueCtx.tick();
    assert.equal(continueAgent.followupCalls.length, 0, "goal 轮截断未证明停机 ⇒ 不补发续写");

    // unfinished：既有行为（completed + 未闭合清单）保持不变，只是判据换了位置
    const unfinishedCtx = createCtx();
    applyPlugin(unfinishedCtx);
    const unfinishedAgent = makeAgent("s1", "x", [
      ...goalEvents(9, "completed").slice(0, 2),
      {
        type: "todo/write",
        seq: 3,
        time: 3,
        data: { todos: [{ content: "a", status: "pending" }] },
      },
      { type: "turn/end", seq: 4, time: 4, data: { turn: 9, reason: { kind: "completed" } } },
    ]);
    register(unfinishedCtx, unfinishedAgent);
    unfinishedCtx.fire(AGENT_STATUS_EVENT, { agent: unfinishedAgent, status: "idle" });
    assert.equal(unfinishedCtx.timers.length, 1);
    unfinishedCtx.tick();
    assert.equal(unfinishedAgent.followupCalls.length, 0, "goal 轮不补跑未闭合清单（未证明停机）");
  });
});

// ── goal 停机后接管（官方 round driver 只 disarm 不重试）────────────────────
describe("goal 停机后接管", () => {
  it("active + disarmed：driver 已放弃自动续跑 ⇒ 接管这条失败回合", () => {
    const { injections, timers } = fireGoalFailure({ phase: "active", activation: "disarmed" });
    assert.equal(timers, 1, "排期发生");
    assert.equal(injections, 1, "接管：补发一条救援消息");
    assert.doesNotMatch(loggedText(), /vetoed at fire time/u);
  });

  it("active + armed：driver 还在 driving ⇒ 让路（人在窗口里 resume 过）", () => {
    const { injections } = fireGoalFailure({ phase: "active", activation: "armed" });
    assert.equal(injections, 0);
    assert.match(loggedText(), /vetoed at fire time \(goal-armed\)/u);
  });

  it("paused / blocked / complete 都是人或生命周期明确停过 ⇒ 让路", () => {
    for (const phase of ["paused", "blocked", "complete"]) {
      const { injections } = fireGoalFailure({ phase, activation: "disarmed" });
      assert.equal(injections, 0, `${phase} 不接管`);
      assert.match(
        loggedText(),
        new RegExp(`vetoed at fire time \\(goal-${phase}\\)`, "u"),
        `${phase} 的否决理由带着相位本身`,
      );
    }
  });

  it("无 current goal（get 交回 undefined）⇒ 无从判断 ⇒ 让路", () => {
    const { injections } = fireGoalFailure(undefined);
    assert.equal(injections, 0);
    assert.match(loggedText(), /vetoed at fire time \(goal-absent\)/u);
  });

  it("goals 服务在位但没有 `get` 那一位 ⇒ 同样按读不到处理", () => {
    // 名字撞上别人的服务、或宿主换了面：`ctx.get("goals")` 交回的不是本包认的那个形状。
    // 走能力探测而不是直接调用，缺位时与「服务不在位」同一理由，不去赌 TypeError 被 catch 兜住。
    const ctx = createCtx();
    ctx.setService("goals", {});
    applyPlugin(ctx);
    const agent = makeAgent("s1", "x", goalEvents(7, "error"));
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, errorPayload(agent, 7, { code: "RATE_LIMIT", message: "x" }));
    assert.equal(ctx.timers.length, 1);
    ctx.tick();
    assert.equal(agent.followupCalls.length, 0);
    assert.match(loggedText(), /vetoed at fire time \(goal-service-unavailable\)/u);
  });

  it("get() 抛错（agent 不是注册表里的在位实例）⇒ 让路而不是把定时器炸掉", () => {
    const ctx = createCtx();
    ctx.setService("goals", {
      get(): never {
        throw new Error("goal agent not live");
      },
    });
    applyPlugin(ctx);
    const agent = makeAgent("s1", "x", goalEvents(7, "error"));
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, errorPayload(agent, 7, { code: "RATE_LIMIT", message: "x" }));
    assert.equal(ctx.timers.length, 1);
    assert.doesNotThrow((): void => {
      ctx.tick();
    });
    assert.equal(agent.followupCalls.length, 0, "读不到状态就不接管");
    assert.match(loggedText(), /vetoed at fire time \(goal-state-unreadable\)/u);
  });

  it("坏形状（phase/activation 缺位或不是官方那两位）⇒ 一律按读不到处理", () => {
    // 接管的前提是**证明** driver 停了：`activation` 不是官方 'armed'/'disarmed' 之一时，
    // 「不是 armed」推不出「disarmed」，这一位与其余保守支同向。
    for (const view of [
      {},
      { phase: 7, activation: "armed" },
      { phase: "active" },
      { phase: "active", activation: null },
      { phase: "active", activation: "unknown-state" },
    ]) {
      const { injections } = fireGoalFailure(view);
      assert.equal(injections, 0, `${JSON.stringify(view)} 不构成接管依据`);
    }
    assert.match(loggedText(), /vetoed at fire time \(goal-activation-unknown\)/u);
  });

  it("闸门只对 goal 轮生效：普通失败回合在 goal armed 的会话里照样接管", () => {
    // 反例防线：若把「会话有 armed goal」当成全局否决，装了 goal 的 profile 里所有
    // 非 goal 轮次的瞬时失败都会静默不续跑——那才是把本包功能锁死。
    const ctx = ctxWithGoal({ phase: "active", activation: "armed" });
    const agent = makeAgent("s1", "x", [
      { type: TURN_START_EVENT, seq: 1, time: 1, data: { turn: 4 } },
      {
        type: USER_MESSAGE_EVENT,
        seq: 2,
        time: 2,
        data: { role: "user", content: [], source: { kind: "user" } },
      },
    ]);
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, errorPayload(agent, 4, { code: "RATE_LIMIT", message: "x" }));
    ctx.tick();
    assert.equal(agent.followupCalls.length, 1, "非 goal 轮不受 goal 闸门影响");
  });

  it("goal 轮截断（continue）同样按停机位判，而不是排期侧一律让路", () => {
    const ctx = ctxWithGoal({ phase: "active", activation: "disarmed" });
    const agent = makeAgent("s1", "x", goalEvents(8, MAX_TOKENS_REASON));
    register(ctx, agent);
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 1);
    ctx.tick();
    assert.equal(agent.followupCalls.length, 1, "driver 已停机的截断轮 ⇒ 接管续写");
  });
});

// ── 宿主载荷里的坏数字形状：轮次号只收安全整数 ────────────────────────────
describe("payload.turn 的坏数字形状", () => {
  it("轮次号是 NaN 或小数时落回 0，且不毒化调度器的旧轮水位", async () => {
    // 水位比较是 `turn <= lastHandledTurn`：任何数与 NaN 比都判 false。NaN 一旦写进
    // lastHandledTurn，那条会话的「旧轮重放」闸门从此永久失效——重放的旧回合既能复位
    // 配额又能再排一次注入，而日志里一个字都不会提。
    const ctx = createCtx();
    applyPlugin(ctx);
    const agent = register(ctx, makeAgent("s1", "x", []));
    ctx.fire(
      AGENT_ERROR_EVENT,
      errorPayload(agent, Number.NaN, { code: "RATE_LIMIT", message: "x" }),
    );
    assert.equal(ctx.timers.length, 1, "坏轮次号不拦排期：失败本身是真瞬时");
    const body = remoteOf(ctx).state();
    const { pending } = body.sessions["s1"] as { pending: { turn: number } | null };
    assert.equal(pending?.turn, 0, "坏形状落到 0");

    // 紧随其后的真实截断轮照常处理：证明那个 NaN 从没进过水位。
    const truncated = makeAgent("s2", "x", [
      { type: TURN_START_EVENT, seq: 1, time: 1, data: { turn: 4 } },
      {
        type: USER_MESSAGE_EVENT,
        seq: 2,
        time: 2,
        data: { role: "user", content: [], source: { kind: "user" } },
      },
      { type: "turn/end", seq: 3, time: 3, data: { turn: 4, reason: { kind: MAX_TOKENS_REASON } } },
    ]);
    register(ctx, truncated);
    ctx.fire(AGENT_STATUS_EVENT, { agent: truncated, status: "idle" });
    assert.equal(ctx.timers.length, 2);
    ctx.tick();
    assert.equal(truncated.followupCalls.length, 1, "旧轮闸门未被上一轮的坏号关掉");
  });

  it("事件里的 NaN 轮次号按「不带号」折叠：复盘读不到终态，就不做旧轮判定", () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    const agent = register(
      ctx,
      makeAgent("s3", "x", [
        { type: TURN_START_EVENT, seq: 1, time: 1, data: { turn: 3 } },
        {
          type: USER_MESSAGE_EVENT,
          seq: 2,
          time: 2,
          data: { role: "user", content: [], source: { kind: "user" } },
        },
        {
          type: "turn/end",
          seq: 3,
          time: 3,
          data: { turn: Number.NaN, reason: { kind: "error" } },
        },
      ]),
    );
    // 那条 end 的号是 NaN ⇒ 与「缺 turn 字段」同解 ⇒ 最后一条可信终态不存在：
    // 截断续写不能凭一条读不出号的事件排期。
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 0, "读不出轮次号就不做该轮的判定");
  });
});

describe("请求级 429 重试边界", () => {
  it("等待中 signal 中止（onAbort 监听路径）→ 委托 next 不重发", async () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    const listener = ctx.handlers["agent/request-error"] as unknown as (
      payload: unknown,
      next: () => Promise<unknown>,
    ) => Promise<unknown>;
    const controller = new AbortController();
    let nextCalled = 0;
    const next = async (): Promise<undefined> => {
      nextCalled += 1;
    };
    const result = listener(
      {
        agent: makeAgent("abort1", "sensenova"),
        turn: 1,
        failure: { code: "QUOTA", message: "Allocated quota exceeded", status: 429 },
        signal: controller.signal,
      },
      next,
    );
    assert.equal(ctx.timers.length, 1, "注册了退避定时器");
    // 定时器到点前中止 → onAbort 触发
    controller.abort();
    assert.equal(await result, undefined);
    assert.equal(nextCalled, 1);
  });

  it("超上限后计数清空：同一会话下一批失败重新从头重试", async () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    const listener = ctx.handlers["agent/request-error"] as unknown as (
      payload: unknown,
      next: () => Promise<unknown>,
    ) => Promise<unknown>;
    const fire = async (): Promise<unknown> => {
      const result = listener(
        {
          agent: makeAgent("cnt1", "sensenova"),
          turn: 1,
          failure: { code: "QUOTA", message: "Allocated quota exceeded" },
          signal: undefined,
        },
        nextNoop,
      );
      ctx.tick();
      return result;
    };
    // 顺序 5 次重试：退避阶梯依赖前一次结果，逐一断言（no-await-in-loop 禁止循环内 await）
    assert.deepEqual(await fire(), { kind: "retry" }, "第 1 次重试");
    assert.deepEqual(await fire(), { kind: "retry" }, "第 2 次重试");
    assert.deepEqual(await fire(), { kind: "retry" }, "第 3 次重试");
    assert.deepEqual(await fire(), { kind: "retry" }, "第 4 次重试");
    assert.deepEqual(await fire(), { kind: "retry" }, "第 5 次重试");
    assert.equal(await fire(), undefined, "第 6 次超上限委托 next（计数清空）");
    assert.deepEqual(await fire(), { kind: "retry" }, "清空后重新计数可再重试");
  });
});

describe("观察性兜底：疑似限流被判永久", () => {
  it("permanent + looksRateLimitish → console.error + 总线沉淀 unclassified-failure", () => {
    const ctx = createCtx({ lessonLoop: true });
    applyPlugin(ctx);
    const agent = makeAgent("s1", "x");
    register(ctx, agent);
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      ctx.fire(
        AGENT_ERROR_EVENT,
        errorPayload(agent, 1, { code: "AUTH", message: "quota exceeded but auth invalid" }),
      );
    } finally {
      console.error = origError;
    }
    assert.ok(
      errors.some((errorText) => errorText.includes("looks rate-limit-ish")),
      "观察性日志打出",
    );
    const [report] = ctx.lessonReports;
    assert.equal(report?.["category"], "unclassified-failure");
  });
});

describe("链式配置边界", () => {
  it("chainResumeDelayMs=0 在 schema 层就被拒（min(1000)），插件侧不再有 || 兜底", () => {
    // 旧写法是 `cfg.chainResumeDelayMs || CHAIN_RESUME_DELAY_MS_DEFAULT`，把 0 当「未配置」
    // 回落 60s。真实 cordis 从不把 0 交进来：行 config 与设置卡写侧都过同一份 schema，
    // min(1000) 先拒 ⇒ 右支不可达（审查记档 P2「死分支」）。闸门留在 schema，一处生效。
    assert.equal(rowValid({ chainResumeDelayMs: 0 }), false, "0 不该过校验");
    assert.equal(rowValid({ chainResumeDelayMs: 1000 }), true);
    const ctx = createCtx();
    ctx.scope.set({ chainResumeDelayMs: 1000 });
    applyPlugin(ctx);
    const agent = makeAgent("s1", "x", [
      { type: TURN_START_EVENT, seq: 1, time: 1, data: { turn: 2 } },
      {
        type: USER_MESSAGE_EVENT,
        seq: 2,
        time: 2,
        data: { role: "user", content: [], source: { kind: "plugin:session-rescue" } },
      },
    ]);
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, errorPayload(agent, 2, { code: "RATE_LIMIT", message: "x" }));
    // 链式延迟参与 max(resumeDelayMs=10s, chain=1s) → 取 10s。旧写法会把 1000 当「未配置」
    // 整值替换成 60s，这里若回到 60_000 就是那条兜底复活了。
    assert.equal(ctx.timers[0]?.ms, 10_000, "配置值原样参与 max，不再被 60s 默认替换");
  });
});

describe("remote 写面的业务结果", () => {
  let ctx: MockCtx;
  beforeEach(() => {
    ctx = createCtx();
    applyPlugin(ctx);
  });

  it("cancel 无待办 → {ok:true, cancelled:false}", () => {
    assert.deepEqual(remoteOf(ctx).cancel({ sessionId: "ghost" }), {
      ok: true,
      cancelled: false,
      reason: "no-pending",
    });
  });

  // 写的是**另一个条目**（llm-pi-ai）的 providers.<p>.retryPolicy，所以覆盖写必须
  // 带 CAS：不带 expectedRevision 时，用户在设置页同时改该 provider 会被这里静默抹掉。
  it("retry-policy 带 llm-pi-ai 当前 revision 写入（CAS，不盲覆盖）", async () => {
    const casCtx = createCtx({ piAiRevision: 7 });
    applyPlugin(casCtx);
    const body = await remoteOf(casCtx).retryPolicy({
      provider: "sensenova",
      preset: "enhanced",
    });
    assert.equal(body["ok"], true);
    assert.equal(casCtx.mutations.length, 1);
    assert.equal(casCtx.mutations[0]?.ns, "llm-pi-ai");
    assert.equal(casCtx.mutations[0].expectedRevision, 7, "必须把读到的 revision 交给宿主");
  });

  it("该条目没投影出 revision ⇒ 不凭空造版本号（交宿主自己判条目在不在）", async () => {
    const noRevCtx = createCtx();
    applyPlugin(noRevCtx);
    const body = await remoteOf(noRevCtx).retryPolicy({
      provider: "sensenova",
      preset: "enhanced",
    });
    assert.equal(body["ok"], true);
    assert.equal(noRevCtx.mutations[0]?.expectedRevision, undefined);
  });

  it("别处已改过该段 → 409 且不做第二次写", async () => {
    const conflictCtx = createCtx({ piAiRevision: 7, mutateConflict: true });
    applyPlugin(conflictCtx);
    const body = await remoteOf(conflictCtx).retryPolicy({
      provider: "sensenova",
      preset: "enhanced",
    });
    // 冲突不是服务端故障：回 409 让卡片提示刷新后重试。
    assert.equal(body["status"], 409);
    assert.equal(
      conflictCtx.mutations.length,
      0,
      "被拒的写不记成功，也不重试第二次（重试=替对方背书）",
    );
  });

  it("retry-policy 原型键 preset 不得绕过 400 闸门", async () => {
    const presets = ["constructor", "toString", "__proto__", "hasOwnProperty"];
    const results = await Promise.all(
      presets.map((preset) => remoteOf(ctx).retryPolicy({ provider: KNOWN_PROVIDER, preset })),
    );
    for (const [index, body] of results.entries()) {
      assert.equal(
        body["status"],
        400,
        `${String(presets[index])} 必须 400，而不是把 undefined 写进 settings`,
      );
    }
    assert.equal(ctx.mutations.length, 0, "原型键不得落盘");
  });

  it("retryProviders：settings.describe 抛错 → 降级 ok:false", () => {
    const ctx2 = createCtx({ describeThrows: true });
    applyPlugin(ctx2);
    const body = remoteOf(ctx2).retryProviders();
    assert.equal(body["ok"], false);
  });
});

describe("state 读面：禁用会话补记录与挂起并入", () => {
  it("toggle 关闭的无记录会话在 state 中显示 disabled", () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    remoteOf(ctx).toggle({ sessionId: "never-seen" });
    const st = remoteOf(ctx).state();
    const session = st.sessions["never-seen"] as {
      disabled: boolean;
      count: number;
      pending: unknown;
    };
    assert.equal(session.disabled, true);
    assert.equal(session.count, 0);
    assert.equal(session.pending, null);
  });

  it("dropSuspended 只移除目标会话：取消其一，另一挂起保留并可恢复", () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    const a1 = makeAgent("sa", "x");
    const a2 = makeAgent("sb", "x");
    suspendAgent(ctx, a1);
    suspendAgent(ctx, a2);
    remoteOf(ctx).cancel({ sessionId: "sa" });
    assert.equal(remoteOf(ctx).resume().restored, 1, "仅恢复未取消的挂起");
    assert.equal(ctx.timers.length, 3, "恢复重新武装一个定时器");
  });
});

describe("resumeAfterReconnect 分支", () => {
  it("会话被 toggle 关闭 → 挂起快照丢弃不补发", () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    const agent = makeAgent("s1", "x");
    suspendAgent(ctx, agent);
    remoteOf(ctx).toggle({ sessionId: "s1" });
    // toggle 关闭即 dropSuspended（修正）：挂起快照已被清除，
    // 恢复通知无快照可恢复，自然不重新武装。
    assert.equal(remoteOf(ctx).resume().restored, 0, "快照已在 toggle 关闭时清除");
    assert.equal(ctx.timers.length, 1, "丢弃后不重新武装");
  });

  it("恢复后 re-fire 前校验否决（agent 非 idle）→ settle skipped", () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    const agent = makeAgent("s1", "x");
    suspendAgent(ctx, agent);
    // 恢复前用户手动开始干活
    agent.status = "running";
    assert.equal(remoteOf(ctx).resume().restored, 1);
    ctx.timers.at(-1)!.fn();
    assert.equal(agent.followupCalls.length, 0, "恢复后否决不补发");
  });

  it("恢复后 re-fire 再次发送失败 → 再次挂起等待下次重连", () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    const agent = makeAgent("s1", "x");
    suspendAgent(ctx, agent);
    // 恢复（followup 仍抛错）
    assert.equal(remoteOf(ctx).resume().restored, 1);
    ctx.timers.at(-1)!.fn();
    // 再次挂起：state 仍显示 suspended
    const st = remoteOf(ctx).state();
    const { pending } = st.sessions["s1"] as { pending: { suspended?: boolean } | null };
    assert.equal(pending?.suspended, true, "再失败保留挂起");
  });
});

// ── 审计修复回归：退避正确性 / 载荷防御 ───────────────────────────────────
const evt = (extra: Record<string, unknown>): unknown => ({
  agent: makeAgent("ra2", "sensenova"),
  turn: 1,
  failure: { code: "RATE_LIMIT", message: "slow down", ...extra },
  signal: undefined,
});

describe("请求级退避正确性", () => {
  it("provider Retry-After 生效：退避取提供方时长而非固定阶梯", async () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    const result = listenerOf(ctx)(
      {
        agent: makeAgent("ra1", "sensenova"),
        turn: 1,
        failure: { code: "RATE_LIMIT", message: "slow down", providerRetryAfterMs: 4000 },
        signal: undefined,
      },
      nextNoop,
    );
    assert.equal(ctx.timers.at(-1)?.ms, 4000, "服从 Retry-After，而不是阶梯的 2000");
    ctx.tick();
    assert.deepEqual(await result, { kind: "retry" });
  });

  it("限流响应的 Retry-After 超过本插件封顶 → 等不起就不重试：委托 next 且不占重试名额", async () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    let nextCalled = 0;
    const next = async (): Promise<undefined> => {
      nextCalled += 1;
    };
    const listener = listenerOf(ctx);
    assert.equal(
      await listener(evt({ providerRetryAfterMs: 120_000 }), next),
      undefined,
      "120s 超出 30s 封顶 → 交回官方 llm-retry",
    );
    assert.equal(nextCalled, 1);
    assert.equal(ctx.timers.length, 0, "没有等待就不该注册退避定时器");
    // 名额未被占用：同一会话下一次普通 429 仍从阶梯第一档开始重试
    const ordinary = listener(evt({}), next);
    assert.equal(ctx.timers.at(-1)?.ms, 2000, "阶梯从头开始（retry 名额未消耗）");
    ctx.tick();
    assert.deepEqual(await ordinary, { kind: "retry" });
  });

  it("插件卸载时仍在退避 → sleep 结算为中止、委托 next（定时器不再唤醒）", async () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    let nextCalled = 0;
    const next = async (): Promise<undefined> => {
      nextCalled += 1;
    };
    const agent = makeAgent("unload1", "sensenova");
    const listener = listenerOf(ctx);
    const pending = listener(
      { agent, turn: 1, failure: { code: "RATE_LIMIT", message: "slow down" }, signal: undefined },
      next,
    );
    assert.equal(ctx.timers.length, 1, "退避 sleep 已挂宿主定时器");
    ctx.disposeEffects();
    assert.equal(await pending, undefined, "卸载即中止，不再重发");
    assert.equal(nextCalled, 1);
    // 卸载后即便定时器被人为再次唤醒也不影响已结算的 promise
    ctx.timers[0]!.fired = false;
    ctx.tick();
    assert.deepEqual(
      ctx.timers.map((entry) => entry.cancelled),
      [true],
    );
  });

  it("agent/error 的 error 是普通 Error（非 LlmError、无 .failure）→ 不炸、不调度", () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    const agent = makeAgent("plain-error", "sensenova");
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, { agent, turn: 3, error: new Error("socket hang up") });
    assert.equal(ctx.timers.length, 0, "无 failure 载荷 = 无法判定瞬时，保守不续跑");
  });

  it("agent/error 的 error 为 undefined → 同样不调度（载荷缺失面）", () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    const agent = makeAgent("no-error", "sensenova");
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, { agent, turn: 3 });
    assert.equal(ctx.timers.length, 0);
  });
});

// ── 事件流 / inbox 坏形状（守卫投影面）、provider 降级、恢复竞态 ──────────

/** 捕获 console.info/error/warn（宿主侧可观测性判定的断言面）。 */
function captureConsole(): {
  infos: string[];
  errors: string[];
  warns: string[];
  restore: () => void;
} {
  const infos: string[] = [];
  const errors: string[] = [];
  const warns: string[] = [];
  const origInfo = console.info;
  const origError = console.error;
  const origWarn = console.warn;
  console.info = (...args: unknown[]) => {
    infos.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  };
  return {
    infos,
    errors,
    warns,
    restore() {
      console.info = origInfo;
      console.error = origError;
      console.warn = origWarn;
    },
  };
}

/** 换掉 agent 的 session 面（跨版本宿主可能给出不合类型的会话对象）。 */
function withSession(agent: MockAgent, session: Record<string, unknown>): MockAgent {
  Object.assign(agent, { session });
  return agent;
}

/**
 * 未处理拒绝探针：装一枚 process 级监听，把漏网的 rejection 收进数组。
 * `stop` 必须进 finally——vitest 的 worker 进程被所有用例共用，残留监听会把
 * 别人的 rejection 也算到本用例头上。
 */
function rejectionProbe(): { reasons: unknown[]; stop: () => void } {
  const reasons: unknown[] = [];
  const record = (reason: unknown): void => {
    reasons.push(reason);
  };
  process.on("unhandledRejection", record);
  return {
    reasons,
    stop() {
      process.off("unhandledRejection", record);
    },
  };
}

/** 取最新一枚定时器（断言存在，不用非空断言）。 */
function latestTimer(ctx: MockCtx): TimerEntry {
  const entry = ctx.timers.at(-1);
  assert.ok(entry, "期待已武装的定时器");
  return entry;
}

/** 触发最新一枚定时器（fire 时刻的模拟入口）。 */
function fireLatest(ctx: MockCtx): void {
  latestTimer(ctx).fn();
}

describe("事件流与 inbox 的坏形状（逐项守卫，不抛错也不误发）", () => {
  it("snapshotEvents 非函数 / 返回非数组 → readEvents 空表（三类注入一律不判）", () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    const noReader = register(ctx, withSession(makeAgent("no-reader", "x"), { id: "no-reader" }));
    const badReturn = register(
      ctx,
      withSession(makeAgent("bad-return", "x"), {
        id: "bad-return",
        snapshotEvents: () => "not-an-array",
      }),
    );
    ctx.fire(AGENT_STATUS_EVENT, { agent: noReader, status: "idle" });
    ctx.fire(AGENT_STATUS_EVENT, { agent: badReturn, status: "idle" });
    assert.equal(ctx.timers.length, 0, "读不到事件流 → 无从判定，宁缺勿滥");
    assert.equal(noReader.followupCalls.length + badReturn.followupCalls.length, 0);
  });

  it("session.id 非字符串：跳过计数清理，调度器按 invalid-session 拒绝注入", () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    const weird = register(
      ctx,
      withSession(makeAgent("weird-sid", "x"), {
        id: 42,
        snapshotEvents: () => [
          {
            type: "turn/end",
            seq: 1,
            time: 1,
            data: { turn: 9, reason: { kind: MAX_TOKENS_REASON } },
          },
        ],
      }),
    );
    const logs = captureConsole();
    try {
      ctx.fire(AGENT_STATUS_EVENT, { agent: weird, status: "idle" });
    } finally {
      logs.restore();
    }
    assert.equal(ctx.timers.length, 0, "非字符串会话 id → 绝不注入");
    assert.ok(
      logs.infos.some((line) => line.includes("skipped (invalid-session)")),
      "调度器明确报 invalid-session",
    );
  });

  it("事件条目非对象 / 无 type / turn 非数字 / source 非对象：全部跳过，判定不误入链式", () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    const agent = register(
      ctx,
      makeAgent("junk", "x", [
        999,
        { type: TURN_START_EVENT, seq: 1, time: 1, data: { turn: 1 } },
        { type: USER_MESSAGE_EVENT, seq: 2, time: 2, data: { source: "not-a-record" } },
        { type: TURN_START_EVENT, seq: 3, time: 3, data: { turn: "2" } },
        { type: TURN_START_EVENT, seq: 4, time: 4, data: {} },
        { type: "turn/end", seq: 5, time: 5, data: { turn: 1, reason: { kind: "error" } } },
      ]),
    );
    ctx.fire(AGENT_ERROR_EVENT, errorPayload(agent, 1, { code: "RATE_LIMIT", message: "429" }));
    assert.equal(ctx.timers.length, 1, "坏条目不影响调度");
    assert.equal(
      ctx.timers[0]?.ms,
      10_000,
      "opener source 非对象 → 不判链式（不走 chainResumeDelayMs）",
    );
    ctx.tick();
    assert.equal(agent.followupCalls.length, 1, "坏 turn 编号不会被误判成 newer-turn");
  });

  it("inbox 三侧：整个面缺席 / 只有 nextStep / nextTurn 为空数组", () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    const noInbox = register(ctx, makeAgent("i-none", "x"));
    ctx.fire(AGENT_ERROR_EVENT, errorPayload(noInbox, 1, { code: "RATE_LIMIT", message: "x" }));
    delete noInbox.inbox;
    ctx.tick();
    assert.equal(noInbox.followupCalls.length, 1, "inbox 缺席 ≠ 有待办");

    const onlyStep = register(ctx, makeAgent("i-step", "x"));
    ctx.fire(AGENT_ERROR_EVENT, errorPayload(onlyStep, 1, { code: "RATE_LIMIT", message: "x" }));
    onlyStep.inbox = { nextStep: [{ id: "queued" }] };
    ctx.tick();
    assert.equal(onlyStep.followupCalls.length, 0, "nextStep 有待办 → 否决");

    const onlyTurn = register(ctx, makeAgent("i-turn", "x"));
    ctx.fire(AGENT_ERROR_EVENT, errorPayload(onlyTurn, 1, { code: "RATE_LIMIT", message: "x" }));
    onlyTurn.inbox = { nextTurn: [] };
    ctx.tick();
    assert.equal(onlyTurn.followupCalls.length, 1, "两个队列都在且为空 → 放行");
  });

  it("agent/status：idle 但载荷无 agent（或 agent 为 null）→ 静默返回", () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    ctx.fire(AGENT_STATUS_EVENT, { status: "idle" });
    ctx.fire(AGENT_STATUS_EVENT, { status: "idle", agent: null });
    assert.equal(ctx.timers.length, 0);
  });
});

describe("provider 缺席 / 载荷缺字段时的降级（绝不打 undefined）", () => {
  it("agent.options 为 null：瞬时失败签名走 unknown", () => {
    const ctx = createCtx({ lessonLoop: true });
    applyPlugin(ctx);
    const agent = register(ctx, makeAgent("noprov", "x"));
    agent.options = null;
    ctx.fire(AGENT_ERROR_EVENT, errorPayload(agent, 2, { code: "RATE_LIMIT", message: "429" }));
    const [report] = ctx.lessonReports;
    assert.ok(report);
    assert.equal(report["category"], TRANSIENT_LESSON_CATEGORY);
    assert.equal(report["signature"], "unknown code RATE_LIMIT");
  });

  it("agent.options 为 null：疑似限流被判永久 → 日志 (?) + 签名 unknown", () => {
    const ctx = createCtx({ lessonLoop: true });
    applyPlugin(ctx);
    const agent = register(ctx, makeAgent("noprov2", "x"));
    agent.options = null;
    const logs = captureConsole();
    try {
      ctx.fire(
        AGENT_ERROR_EVENT,
        errorPayload(agent, 1, { code: "AUTH", message: "quota exceeded, auth invalid" }),
      );
    } finally {
      logs.restore();
    }
    assert.ok(
      logs.errors.some((line) => line.includes("(?)") && !line.includes("undefined")),
      "占位而非 undefined",
    );
    const [report] = ctx.lessonReports;
    assert.equal(report?.["signature"], "unknown");
  });

  it("failure 无 code（只有 status/message）：detail 不掺 undefined 片段", () => {
    const ctx = createCtx({ lessonLoop: true });
    applyPlugin(ctx);
    const agent = register(ctx, makeAgent("nocode", "x"));
    ctx.fire(
      AGENT_ERROR_EVENT,
      errorPayload(agent, 1, { status: 503, message: "upstream unavailable" }),
    );
    const [report] = ctx.lessonReports;
    assert.equal(report?.["detail"], "status=503 upstream unavailable");
  });

  it("agent/error 载荷缺 turn → 按回合 0 沉淀与调度，state 也报 0 号回合", async () => {
    const ctx = createCtx({ lessonLoop: true });
    applyPlugin(ctx);
    const agent = register(ctx, makeAgent("noturn", "x"));
    ctx.fire(AGENT_ERROR_EVENT, {
      agent,
      error: { failure: { code: "RATE_LIMIT", message: "x" } },
    });
    const [report] = ctx.lessonReports;
    assert.equal(report?.["turn"], 0);
    assert.equal(ctx.timers.length, 1);
    const st = remoteOf(ctx).state();
    const { pending } = st.sessions["noturn"] as { pending: { turn?: number } | null };
    assert.equal(pending?.turn, 0);
  });

  it("max-tokens 沉淀：无 provider → unknown，且不带 evidence 键（可选展开两侧）", () => {
    const ctx = createCtx({ lessonLoop: true });
    applyPlugin(ctx);
    const agent = register(
      ctx,
      makeAgent("mt", undefined, [
        {
          type: "turn/end",
          seq: 1,
          time: 1,
          data: { turn: 3, reason: { kind: MAX_TOKENS_REASON } },
        },
      ]),
    );
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    const [report] = ctx.lessonReports;
    assert.ok(report);
    assert.equal(report["category"], MAX_TOKENS_REASON);
    assert.equal("evidence" in report, false, "可选证据缺席时连键都不写");
    assert.equal(report["signature"], "unknown");
    assert.equal(report["turn"], 3);
  });

  it("lessonLoop.report 抛非 Error 载荷 → console.warn 可读，主流程不受影响", () => {
    const ctx = createCtx({ lessonLoop: true });
    const bus = ctx.lessonLoop;
    assert.ok(bus, "lessonLoop 服务已提供");
    const busError: unknown = "bus down as plain text";
    bus.report = (): void => {
      throw busError;
    };
    applyPlugin(ctx);
    const agent = register(ctx, makeAgent("bus2", "x"));
    const logs = captureConsole();
    let scheduled = 0;
    try {
      ctx.fire(AGENT_ERROR_EVENT, errorPayload(agent, 1, { code: "SERVER", message: "boom" }));
      scheduled = ctx.timers.length;
    } finally {
      logs.restore();
    }
    assert.equal(scheduled, 1, "总线故障不阻断续跑");
    assert.ok(
      logs.warns.some((line) => line.includes("bus down as plain text")),
      "降级日志仍可定位",
    );
  });

  it("lessonLoop.report 返回 rejected Promise：降级日志照记，且不产生未处理拒绝", async () => {
    const ctx = createCtx({ lessonLoop: true });
    const bus = ctx.lessonLoop;
    assert.ok(bus, "lessonLoop 服务已提供");
    bus.report = (): Promise<never> => Promise.reject(new Error("bus async down"));
    applyPlugin(ctx);
    const agent = register(ctx, makeAgent("bus-async", "x"));
    const logs = captureConsole();
    const probe = rejectionProbe();
    let scheduled = 0;
    try {
      ctx.fire(AGENT_ERROR_EVENT, errorPayload(agent, 1, { code: "SERVER", message: "boom" }));
      scheduled = ctx.timers.length;
      // rejection 回调是微任务、Node 的未处理拒绝判定在宏任务边界：跑一轮宏任务再断言。
      await sleep(0);
    } finally {
      logs.restore();
      probe.stop();
    }
    assert.equal(scheduled, 1, "总线异步故障同样不阻断续跑");
    assert.ok(
      logs.warns.some((line) => line.includes("lessonLoop report failed: bus async down")),
      "异步失败必须与同步抛错落进同一条日志（否则被静默吞掉）",
    );
    assert.deepEqual(probe.reasons, [], "rejection 必须被接住：漏出去会污染整个宿主进程");
  });
});

describe("fire 时刻的服务下线与恢复竞态", () => {
  it("agents 服务在倒计时期间下线：findAgent 返回 null → 按 agent-gone 否决", () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    const agent = register(ctx, makeAgent("gone-later", "x"));
    ctx.fire(AGENT_ERROR_EVENT, errorPayload(agent, 1, { code: "RATE_LIMIT", message: "x" }));
    ctx.setService("agents", undefined);
    ctx.tick();
    assert.equal(agent.followupCalls.length, 0, "服务读不到时宁可不发");
  });

  it("disposeAll 之后定时器仍被唤醒：无待办可挂 → 明确报错，不静默也不假装挂起", async () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    const agent = register(ctx, makeAgent("late-fire", "x"));
    agent.followup = () => {
      throw new Error(CARRIER_DOWN_MESSAGE);
    };
    ctx.fire(AGENT_ERROR_EVENT, errorPayload(agent, 1, { code: "RATE_LIMIT", message: "x" }));
    const armed = latestTimer(ctx);
    const remote = remoteOf(ctx);
    const logs = captureConsole();
    try {
      ctx.disposeEffects();
      armed.fn();
    } finally {
      logs.restore();
    }
    assert.equal(agent.followupCalls.length, 0);
    assert.ok(
      logs.errors.some(
        (line) =>
          line.includes("failed to send auto-resume") && line.includes(CARRIER_DOWN_MESSAGE),
      ),
      "调度器已无该会话记录：如实报错而非假装挂起",
    );
    const st = remote.state();
    const session = st.sessions["late-fire"] as
      | { pending: { suspended?: boolean } | null }
      | undefined;
    assert.equal(session?.pending?.suspended, undefined, "无快照可挂");
  });

  it("重连恢复后 re-fire 再次失败：仍按原 fireAt 挂起等下次重连", () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    const agent = register(ctx, makeAgent("refire", "x"));
    agent.followup = () => {
      throw new Error(CARRIER_DOWN_MESSAGE);
    };
    ctx.fire(AGENT_ERROR_EVENT, errorPayload(agent, 1, { code: "RATE_LIMIT", message: "x" }));
    fireLatest(ctx);
    assert.equal(remoteOf(ctx).resume().restored, 1);
    fireLatest(ctx);
    assert.equal(remoteOf(ctx).resume().restored, 1, "再挂起 → 下次重连仍可恢复");
  });

  it("disposeAll 之后重连补发的定时器仍被唤醒：同样明确报错而非静默挂起", () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    const agent = register(ctx, makeAgent("late-refire", "x"));
    agent.followup = () => {
      throw new Error(CARRIER_DOWN_MESSAGE);
    };
    ctx.fire(AGENT_ERROR_EVENT, errorPayload(agent, 1, { code: "RATE_LIMIT", message: "x" }));
    fireLatest(ctx);
    assert.equal(remoteOf(ctx).resume().restored, 1);
    const armed = latestTimer(ctx);
    const logs = captureConsole();
    try {
      ctx.disposeEffects();
      armed.fn();
    } finally {
      logs.restore();
    }
    assert.ok(
      logs.errors.some(
        (line) => line.includes("after reconnect") && line.includes(CARRIER_DOWN_MESSAGE),
      ),
      "重连补发失败的无待办形态可见",
    );
  });

  it("重连时该会话已有新待办：挂起快照不得覆盖已武装的续跑（restorePending 拒绝）", async () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    const agent = register(ctx, makeAgent("racingsame", "x"));
    agent.followup = () => {
      throw new Error(CARRIER_DOWN_MESSAGE);
    };
    ctx.fire(AGENT_ERROR_EVENT, errorPayload(agent, 1, { code: "RATE_LIMIT", message: "x" }));
    fireLatest(ctx);
    assert.equal(ctx.timers.length, 1, "挂起，未重新武装");
    agent.followup = (message: unknown) => {
      agent.followupCalls.push(message);
    };
    ctx.fire(AGENT_ERROR_EVENT, errorPayload(agent, 2, { code: "RATE_LIMIT", message: "x" }));
    assert.equal(ctx.timers.length, 2, "挂起期间又崩一次 → 已重新武装新待办");
    assert.equal(remoteOf(ctx).resume().restored, 1, "快照计数照报");
    assert.equal(ctx.timers.length, 2, "已有待办 → 不用旧快照覆盖，不追加第三枚定时器");
    fireLatest(ctx);
    assert.equal(agent.followupCalls.length, 1, "补发的仍是当前那次失败的待办");
    const st = remoteOf(ctx).state();
    const session = st.sessions["racingsame"] as {
      pending: { suspended?: boolean } | null;
      count?: number;
    };
    assert.equal(session.pending, null, "当前待办 fire 完即清空");
    assert.equal(session.count, 1, "旧快照被丢弃，只有当前这次计入配额");
  });
});

describe("退避等待的竞态结算（三来源只结算一次）", () => {
  it("宿主定时器同步回调：finish 先于 unregister 就位；卸载时二次结算幂等", async () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    let lateWakeups = 0;
    ctx.timer = {
      timeout(fn: () => void): () => void {
        fn();
        return (): void => {
          lateWakeups += 1;
        };
      },
    };
    let nextCalled = 0;
    const next = async (): Promise<undefined> => {
      nextCalled += 1;
    };
    const agent = register(ctx, makeAgent("synctimer", "sensenova"));
    const result = await listenerOf(ctx)(
      {
        agent,
        turn: 1,
        failure: { code: "RATE_LIMIT", message: "slow down" },
        signal: undefined,
      },
      next,
    );
    assert.deepEqual(result, { kind: "retry" }, "到点即重发（没被误判为中止）");
    assert.equal(nextCalled, 0);
    ctx.disposeEffects();
    assert.equal(nextCalled, 0, "释放器二次结算：幂等，不再委托 next");
    assert.equal(lateWakeups, 0);
  });

  it("限流响应的 Retry-After: 0 → 立刻重发且不注册退避定时器（delayMs>0 闸门两侧）", async () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    const agent = register(ctx, makeAgent("ra0", "sensenova"));
    const result = await listenerOf(ctx)(
      {
        agent,
        turn: 1,
        failure: { code: "RATE_LIMIT", message: "slow down", providerRetryAfterMs: 0 },
        signal: undefined,
      },
      nextNoop,
    );
    assert.deepEqual(result, { kind: "retry" });
    assert.equal(ctx.timers.length, 0, "零等待就不挂宿主定时器");
  });
});

describe("链式配置的运行时改值（设置卡实时生效）", () => {
  it("apply 之后改 chainResumeDelayMs → 下一次失败轮就取新值（引用现读，不被默认掩掉）", () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    // chainResumeDelayMs 是 volatile：设置卡写完后下一次读即生效，无须重载插件。
    // 旧断言写的是「设 0 回落 60s」，那个 0 如今在 schema min(1000) 处就被拒（见
    // 上面「链式配置边界」），这里改钉真正要在意的那件事：改值走的是现读而不是快照。
    ctx.scope.set({ chainResumeDelayMs: 90_000 });
    const agent = register(
      ctx,
      makeAgent("chain0", "x", [
        { type: TURN_START_EVENT, seq: 1, time: 1, data: { turn: 2 } },
        {
          type: USER_MESSAGE_EVENT,
          seq: 2,
          time: 2,
          data: { role: "user", content: [], source: { kind: "plugin:session-rescue" } },
        },
      ]),
    );
    ctx.fire(AGENT_ERROR_EVENT, errorPayload(agent, 2, { code: "RATE_LIMIT", message: "x" }));
    assert.equal(ctx.timers[0]?.ms, 90_000, "运行期改值即时生效");
  });
});

// ── 瞬时失败的「已遵守」观测：lesson-loop pass ─────────────────────────────
// 契约：pass 必须与对应的 report 落在同一张规则卡上（category + signature + 由 cwd
// 推导的 project），否则 lesson-loop 的分母里永远没有"已遵守"这一项，被度量的规则
// 只能报不可判定。以下用例逐条钉住这个不变量。

/** 一条 completed 回合的 turn/end：成功信号（onSuccess 与兑 pass 同源）的输入。 */
function completedEvents(turn: number): unknown[] {
  return [
    {
      type: "turn/end",
      seq: turn * 10,
      time: turn * 10,
      data: { turn, reason: { kind: "completed" } },
    },
  ];
}

/** 就地替换会话事件流（makeAgent 的 snapshotEvents 闭包读的是同一个数组）。 */
function setEvents(agent: MockAgent, events: unknown[]): void {
  const { evs } = agent.session;
  assert.ok(evs, "makeAgent 建的会话必带 evs 数组");
  evs.length = 0;
  evs.push(...events);
}

/** 一次瞬时失败（默认限流码）：登记待兑 pass 的入口动作。 */
function failOnce(ctx: MockCtx, agent: MockAgent, turn: number, code = "RATE_LIMIT"): void {
  ctx.fire(AGENT_ERROR_EVENT, errorPayload(agent, turn, { code, message: "x" }));
}

/** 装配一个带 cwd 的会话并让它吃下一次限流失败。 */
function failingAgent(ctx: MockCtx, id: string, provider: string, cwd = "/work/api"): MockAgent {
  const agent = register(ctx, makeAgent(id, provider));
  agent.session.header = { cwd };
  failOnce(ctx, agent, 1);
  return agent;
}

/** state 读面里某会话的 resume 计数（无记录 → -1）。 */
function resumeCount(ctx: MockCtx, sessionId: string): number {
  const st = remoteOf(ctx).state();
  const session = st.sessions[sessionId] as { counts?: { resume?: number } } | undefined;
  return session?.counts?.resume ?? -1;
}

/** 总线降级面的共同判据：续跑真 fire 过一次（计数 1）之后，completed 回合必须照常
 *  把配额重置回 0——lesson-loop 出任何问题都不许动这条主流程。 */
async function assertQuotaResetOnSuccess(ctx: MockCtx, agent: MockAgent): Promise<void> {
  fireLatest(ctx);
  assert.equal(resumeCount(ctx, agent.id), 1, "前置：续跑已 fire，计数应为 1");
  setEvents(agent, completedEvents(9));
  ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
  assert.equal(resumeCount(ctx, agent.id), 0, "成功信号照常重置配额（与总线无关）");
}

describe("瞬时失败→成功兑 pass：lesson-loop 的「已遵守」观测", () => {
  it("瞬时失败后同 provider 跑成功：恰好一条 pass，category/signature/cwd/sessionId 与 report 同源", async () => {
    const ctx = createCtx({ lessonLoop: true });
    applyPlugin(ctx);
    const agent = failingAgent(ctx, "pass-same", "tokenrouter");
    assert.equal(ctx.lessonPasses.length, 0, "只失败没成功时绝不宣称「已遵守」");
    setEvents(agent, completedEvents(2));
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.lessonPasses.length, 1, "恰好一条");
    const report = ctx.lessonReports.at(-1);
    assert.ok(report, "report 已沉淀");
    const pass = ctx.lessonPasses.at(-1);
    assert.ok(pass, "pass 已兑现");
    assert.equal(pass["category"], TRANSIENT_LESSON_CATEGORY);
    assert.equal(pass["category"], report["category"], "类别也必须同源");
    assert.equal(pass["signature"], report["signature"]);
    assert.equal(pass["cwd"], "/work/api", "project 由 cwd 推导，必须与 report 同一份");
    assert.equal(pass["cwd"], report["cwd"]);
    assert.equal(pass["sessionId"], "pass-same");
    assert.equal("turn" in pass, false, "pass 契约里没有 turn，不顺手多塞字段");
    assert.equal(resumeCount(ctx, "pass-same"), 0);
  });

  it("成功回合的 provider 与失败时不同：不兑 pass；同 provider 再成功才兑", () => {
    const ctx = createCtx({ lessonLoop: true });
    applyPlugin(ctx);
    const agent = failingAgent(ctx, "pass-other", "tokenrouter");
    agent.options = { provider: "baidu" };
    setEvents(agent, completedEvents(2));
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.lessonPasses.length, 0, "换路由后的成功不证明「退避重试」这条规则");
    agent.options = { provider: "tokenrouter" };
    setEvents(agent, completedEvents(3));
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.lessonPasses.length, 1, "记录仍在册，等真·同 provider 的成功");
    assert.equal(ctx.lessonPasses.at(-1)?.["signature"], "tokenrouter code RATE_LIMIT");
  });

  it("同一失败连报两次再成功：pass 只兑一条，且兑过的记录当场摘牌", () => {
    const ctx = createCtx({ lessonLoop: true });
    applyPlugin(ctx);
    const agent = failingAgent(ctx, "pass-dedupe", "tokenrouter");
    failOnce(ctx, agent, 2);
    setEvents(agent, completedEvents(3));
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.lessonPasses.length, 1, "两次失败只兑一条 pass");
    setEvents(agent, completedEvents(4));
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.lessonPasses.length, 1, "已兑现的教训不再重复上报");
  });

  it("同 provider 两类瞬时失败（限流/服务端）：各兑一条，签名互不合并", () => {
    const ctx = createCtx({ lessonLoop: true });
    applyPlugin(ctx);
    const agent = failingAgent(ctx, "pass-two", "tokenrouter");
    failOnce(ctx, agent, 2, "SERVER");
    setEvents(agent, completedEvents(3));
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.deepEqual(
      ctx.lessonPasses.map((x) => x["signature"]),
      ["tokenrouter code RATE_LIMIT", "tokenrouter code SERVER"],
    );
  });

  it("两条会话各自的失败：只由本会话的成功兑走，绝不跨会话串观测", () => {
    const ctx = createCtx({ lessonLoop: true });
    applyPlugin(ctx);
    const first = failingAgent(ctx, "pass-x", "tokenrouter");
    const second = failingAgent(ctx, "pass-y", "tokenrouter");
    setEvents(second, completedEvents(2));
    ctx.fire(AGENT_STATUS_EVENT, { agent: second, status: "idle" });
    assert.equal(ctx.lessonPasses.length, 1, "y 的成功只兑 y 自己的记录");
    assert.equal(ctx.lessonPasses.at(-1)?.["sessionId"], "pass-y");
    setEvents(second, completedEvents(3));
    ctx.fire(AGENT_STATUS_EVENT, { agent: second, status: "idle" });
    assert.equal(ctx.lessonPasses.length, 1, "y 不得替 x 兑，也不得自己再兑一次");
    setEvents(first, completedEvents(4));
    ctx.fire(AGENT_STATUS_EVENT, { agent: first, status: "idle" });
    assert.equal(ctx.lessonPasses.length, 2, "x 的记录仍在册，由 x 的成功兑走");
    assert.equal(ctx.lessonPasses.at(-1)?.["sessionId"], "pass-x");
  });

  it("会话 dispose 撤销未兑付记录：之后的成功回合不再兑", async () => {
    const ctx = createCtx({ lessonLoop: true });
    applyPlugin(ctx);
    const agent = failingAgent(ctx, PASS_DISPOSE_SESSION_ID, "tokenrouter");
    ctx.handlers["agent/disposed"]?.({ agent: { session: { id: PASS_DISPOSE_SESSION_ID } } });
    setEvents(agent, completedEvents(2));
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.lessonPasses.length, 0, "会话都没了，「已遵守」无从谈起");
    assert.equal(resumeCount(ctx, PASS_DISPOSE_SESSION_ID), 0, "dispose 只撤销台账，不动成功信号");
  });

  it("台账有界：第 65 条把最旧挤出，最旧那条不再兑、最新一条照常兑", () => {
    const ctx = createCtx({ lessonLoop: true });
    applyPlugin(ctx);
    const agent = register(ctx, makeAgent("pass-cap", "p1"));
    for (let i = 1; i <= 65; i += 1) {
      agent.options = { provider: `p${String(i)}` };
      failOnce(ctx, agent, i);
    }
    agent.options = { provider: "p1" };
    setEvents(agent, completedEvents(66));
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.lessonPasses.length, 0, "超上限的最旧记录已被裁掉");
    agent.options = { provider: "p65" };
    setEvents(agent, completedEvents(67));
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.lessonPasses.length, 1, "最新记录照常兑");
    assert.equal(ctx.lessonPasses.at(-1)?.["signature"], "p65 code RATE_LIMIT");
  });

  it("report 与 pass 的签名同源于 transientSignatureOf：任一侧改算式都会先炸这里", () => {
    const ctx = createCtx({ lessonLoop: true });
    applyPlugin(ctx);
    const agent = failingAgent(ctx, "pass-drift", "sens", "/work/drift");
    setEvents(agent, completedEvents(2));
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    const expected = transientSignatureOf("sens", "code RATE_LIMIT");
    assert.equal(expected, "sens code RATE_LIMIT");
    assert.equal(ctx.lessonReports.at(-1)?.["signature"], expected, "report 侧");
    assert.equal(ctx.lessonPasses.at(-1)?.["signature"], expected, "pass 侧");
    assert.equal(
      transientSignatureOf(undefined, "code SERVER"),
      "unknown code SERVER",
      "provider 缺席时与 report 同语义",
    );
  });

  it("lessonLoop 服务整个缺席：失败→成功全程不抛错，成功信号照常重置配额", async () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    const agent = failingAgent(ctx, "pass-nobus", "tokenrouter");
    assert.equal(ctx.timers.length, 1, "瞬时失败照常调度续跑");
    await assertQuotaResetOnSuccess(ctx, agent);
    assert.equal(ctx.lessonPasses.length, 0);
  });

  it("总线存在但无 pass 成员（跨版本总线）：静默跳过，不炸成功路径", async () => {
    const ctx = createCtx({ lessonLoop: true });
    applyPlugin(ctx);
    ctx.setService("lessonLoop", {
      report: (input: LessonReport["input"]) => {
        ctx.lessonReports.push(input);
      },
    });
    const agent = failingAgent(ctx, "pass-legacy", "tokenrouter");
    assert.ok(ctx.lessonReports.length > 0, "report 侧仍照常沉淀");
    await assertQuotaResetOnSuccess(ctx, agent);
    assert.equal(ctx.lessonPasses.length, 0);
  });

  it("bus.pass 抛错：只 warn 降级，且已摘牌的记录不补发第二次", async () => {
    const ctx = createCtx({ lessonLoop: true });
    let attempts = 0;
    ctx.lessonLoop!.pass = () => {
      attempts += 1;
      throw new Error("bus pass down");
    };
    applyPlugin(ctx);
    const agent = failingAgent(ctx, "pass-throw", "tokenrouter");
    const logs = captureConsole();
    try {
      await assertQuotaResetOnSuccess(ctx, agent);
      setEvents(agent, completedEvents(10));
      ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    } finally {
      logs.restore();
    }
    assert.equal(attempts, 1, "先摘牌后上报：抛错也不补发");
    assert.ok(
      logs.warns.some((line) => line.includes("lessonLoop pass failed: bus pass down")),
      "降级日志仍可定位",
    );
    assert.equal(agent.followupCalls.length, 1, "成功路径的注入行为未被改变");
  });

  it("bus.pass 抛非 Error 载荷：warn 仍可定位，成功路径一字不变", async () => {
    const ctx = createCtx({ lessonLoop: true });
    const busError: unknown = "bus pass down as plain text";
    ctx.lessonLoop!.pass = () => {
      throw busError;
    };
    applyPlugin(ctx);
    const agent = failingAgent(ctx, "pass-throw-plain", "tokenrouter");
    const logs = captureConsole();
    try {
      setEvents(agent, completedEvents(9));
      ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    } finally {
      logs.restore();
    }
    assert.ok(
      logs.warns.some((line) =>
        line.includes("lessonLoop pass failed: bus pass down as plain text"),
      ),
      "降级日志仍可定位",
    );
    assert.equal(resumeCount(ctx, "pass-throw-plain"), 0, "非 Error 载荷也不得影响成功信号");
  });

  it("bus.pass 返回 rejected Promise：warn 降级且不留未处理拒绝，已摘牌的不补发", async () => {
    const ctx = createCtx({ lessonLoop: true });
    let attempts = 0;
    ctx.lessonLoop!.pass = (): Promise<never> => {
      attempts += 1;
      return Promise.reject(new Error("bus pass async down"));
    };
    applyPlugin(ctx);
    const agent = failingAgent(ctx, "pass-async", "tokenrouter");
    const logs = captureConsole();
    const probe = rejectionProbe();
    try {
      setEvents(agent, completedEvents(9));
      ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
      // rejection 回调是微任务、Node 的未处理拒绝判定在宏任务边界：跑一轮宏任务再断言。
      await sleep(0);
    } finally {
      logs.restore();
      probe.stop();
    }
    assert.equal(attempts, 1, "先摘牌后上报：异步失败也不补发第二次");
    assert.ok(
      logs.warns.some((line) => line.includes("lessonLoop pass failed: bus pass async down")),
      "异步失败必须与同步抛错落进同一条 pass 降级日志",
    );
    assert.deepEqual(probe.reasons, [], "rejection 必须被接住：漏出去会污染整个宿主进程");
    assert.equal(resumeCount(ctx, "pass-async"), 0, "成功信号与总线无关");
  });

  it("bus.pass 返回 {ok:false}（总线自我拒绝）：不重发、不告警、不改行为", async () => {
    const ctx = createCtx({ lessonLoop: true });
    let attempts = 0;
    ctx.lessonLoop!.pass = () => {
      attempts += 1;
      return { ok: false };
    };
    applyPlugin(ctx);
    const agent = failingAgent(ctx, "pass-notok", "tokenrouter");
    const logs = captureConsole();
    try {
      await assertQuotaResetOnSuccess(ctx, agent);
      setEvents(agent, completedEvents(11));
      ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    } finally {
      logs.restore();
    }
    assert.equal(attempts, 1, "ok:false 不触发重发（本插件不据返回值判定）");
    assert.deepEqual(logs.warns, [], "契约内的拒绝不该刷告警");
    assert.equal(agent.followupCalls.length, 1);
  });
});

// ── 请求级重试的三个部署值进 entry config（默认＝现值、非 volatile 不占设置卡）────

describe("请求级重试部署值", () => {
  it("行 config 覆盖 requestRetryMax=2 → 第 3 次 429 就交回 llm-retry", async () => {
    const ctx = createCtx();
    ctx.scope.set({ requestRetryMax: 2 });
    applyPlugin(ctx);
    const agent = register(ctx, makeAgent("w4-max", "sensenova"));
    const outcomes = await fireRateLimits(ctx, agent, 3);
    assert.deepEqual(outcomes.slice(0, 2), [{ kind: "retry" }, { kind: "retry" }]);
    assert.equal(outcomes[2], "NEXT", "配置的 2 次名额用尽 → 委托官方 llm-retry");
  });

  it("行 config 覆盖退避阶梯 → 定时器按配置档位走，超出档位取末档", async () => {
    const ctx = createCtx();
    ctx.scope.set({ requestRetryBackoffMs: [111, 222] });
    applyPlugin(ctx);
    const agent = register(ctx, makeAgent("w4-ladder", "sensenova"));
    await fireRateLimits(ctx, agent, 3);
    assert.deepEqual(
      ctx.timers.map((timer) => timer.ms),
      [111, 222, 222],
    );
  });

  it("行 config 覆盖封顶 → Retry-After 超新封顶即委托 next；未覆盖仍按 30s 默认", async () => {
    const ctx = createCtx();
    ctx.scope.set({ requestRetryBackoffCapMs: 1000 });
    applyPlugin(ctx);
    const tight = register(ctx, makeAgent("w4-cap", "sensenova"));
    let nextCalled = 0;
    const result = await listenerOf(ctx)(
      {
        agent: tight,
        turn: 1,
        failure: { code: "RATE_LIMIT", message: "slow down", providerRetryAfterMs: 1500 },
        signal: undefined,
      },
      async (): Promise<undefined> => {
        nextCalled += 1;
      },
    );
    assert.equal(result, undefined);
    assert.equal(nextCalled, 1, "1500ms 超出配置的 1000ms 封顶");
    assert.equal(ctx.timers.length, 0, "等不起就不该挂定时器");
    // 未收紧时同一枚 1500ms 等得起：默认封顶仍是 schema 的 30s
    const roomy = createCtx();
    applyPlugin(roomy);
    const easy = register(roomy, makeAgent("w4-cap-default", "sensenova"));
    const roomyPending = listenerOf(roomy)(
      {
        agent: easy,
        turn: 1,
        failure: { code: "RATE_LIMIT", message: "slow down", providerRetryAfterMs: 1500 },
        signal: undefined,
      },
      nextNoop,
    );
    roomy.tick();
    assert.deepEqual(await roomyPending, { kind: "retry" });
    assert.equal(roomy.timers.at(-1)?.ms, 1500);
  });

  it("三项部署值不标 volatile ⇒ 设置表单仍是十三项", () => {
    const form = volatileFormOf(plugin.Config as unknown as SchemaNode);
    assert.equal(form?.length, 13, "部署值不进表单，表单字段集不变");
    for (const key of ["requestRetryMax", "requestRetryBackoffMs", "requestRetryBackoffCapMs"]) {
      assert.equal(configDict()[key]?.meta?.["volatile"], undefined, `${key} 不该是 volatile`);
    }
  });

  it("chainResumeDelayMs 的下限在 schema：0 不可表示 ⇒ 插件侧无须再兜底", () => {
    assert.equal(rowValid({ chainResumeDelayMs: 0 }), false, "min(1000) 挡住 0");
    assert.equal(rowValid({ chainResumeDelayMs: 1000 }), true);
  });
});

/** 造一条「截断收尾」的回合事件流（真宿主由 turn/start + turn/end 组成）。 */
function truncatedTurn(log: unknown[], turn: number): void {
  log.push(
    { type: TURN_START_EVENT, seq: turn * 2 - 1, time: turn, data: { turn } },
    {
      type: "turn/end",
      seq: turn * 2,
      time: turn,
      data: { turn, reason: { kind: MAX_TOKENS_REASON } },
    },
  );
}

describe("宿主交回形状的真实性", () => {
  it("agent/error 把真失败裹进 AggregateError 的 cause 时仍然续跑", () => {
    // 形状出处：agent-loop 在「步骤失败且待写工具结果也落不了盘」时抛
    // `new AggregateError([error, other], …, { cause: error })`
    // （packages/core/agent-loop/src/agent.ts:353 与 :496）——`.failure` 只在原失败上。
    // 只读 `error.failure` 的话，一次货真价实的 429 会被当成「没有失败面可分类」
    // 而一律判永久 → 该续跑的回合永不续跑。
    const ctx = createCtx();
    applyPlugin(ctx);
    const agent = register(ctx, makeAgent("agg-1", KNOWN_PROVIDER));
    const failure = { code: "RATE_LIMIT", message: RATE_LIMIT_MESSAGE };
    ctx.fire(AGENT_ERROR_EVENT, {
      agent,
      turn: 1,
      step: 1,
      error: {
        name: "AggregateError",
        message: "Step failed and its pending tool results could not be recorded",
        errors: [
          { name: "Error", message: "record failed" },
          { name: "LlmError", failure },
        ],
        cause: { name: "LlmError", failure },
      },
    });
    assert.equal(ctx.timers.length, 1, "裹了壳的 429 也必须排上续跑定时器");
    ctx.tick();
    assert.equal(agent.followupCalls.length, 1, "壳里的失败同样要发得出救援消息");
  });

  it("cause 的原失败优先于 errors 里的附带错误", () => {
    // 官方两处包壳都把原失败同时放进 errors[0] 与 cause，而 errors 里还躺着第二条
    // （落盘/结算失败）。先扫 errors 就有把附带错误当分类依据的风险。
    const ctx = createCtx();
    applyPlugin(ctx);
    const agent = register(ctx, makeAgent("agg-order", KNOWN_PROVIDER));
    ctx.fire(AGENT_ERROR_EVENT, {
      agent,
      turn: 1,
      step: 1,
      error: {
        name: "AggregateError",
        message: "wrapped",
        errors: [{ name: "LlmError", failure: { code: "INVALID_REQUEST", message: "bad" } }],
        cause: { name: "LlmError", failure: { code: "RATE_LIMIT", message: "slow down" } },
      },
    });
    assert.equal(ctx.timers.length, 1, "按 cause 的 RATE_LIMIT 判瞬时，而不是按 errors[0] 判永久");
  });

  it("cause 不带失败面时仍从 errors 里取（漂移兜底），且普通 Error 一律不注入", () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    const withErrors = register(ctx, makeAgent("agg-errors", KNOWN_PROVIDER));
    ctx.fire(AGENT_ERROR_EVENT, {
      agent: withErrors,
      turn: 1,
      step: 1,
      error: {
        name: "AggregateError",
        message: "wrapped",
        cause: "no failure here",
        errors: [
          { name: "Error", message: "record failed" },
          { name: "LlmError", failure: { code: "SERVER", message: "server error" } },
        ],
      },
    });
    assert.equal(ctx.timers.length, 1, "cause 读不到时，errors 里的失败面仍算数");

    const plain = register(ctx, makeAgent("agg-plain", KNOWN_PROVIDER));
    ctx.fire(AGENT_ERROR_EVENT, {
      agent: plain,
      turn: 1,
      step: 1,
      error: { name: "TypeError", message: "cannot read properties", cause: "string" },
    });
    assert.equal(ctx.timers.length, 1, "普通 Error 没有失败面：不排新的续跑");
    assert.deepEqual(plain.followupCalls, []);
  });

  it("排期之后关掉全局开关 ⇒ fire 时刻作废这次注入", () => {
    // 失败到 fire 之间隔着 resumeDelayMs（默认 10s，上限 300s），用户在设置卡上
    // 关掉本功能就发生在这段窗口里。只在排期侧判开关的话，已武装的定时器照样
    // 把一个「用户刚明确说不想要」的回合塞回模型。
    const ctx = createCtx();
    applyPlugin(ctx);
    const agent = register(ctx, makeAgent("gate-off", KNOWN_PROVIDER));
    ctx.fire(
      AGENT_ERROR_EVENT,
      errorPayload(agent, 1, { code: "RATE_LIMIT", message: RATE_LIMIT_MESSAGE }),
    );
    assert.equal(ctx.timers.length, 1);
    ctx.scope.set({ enabled: false });
    ctx.tick();
    assert.deepEqual(agent.followupCalls, [], "关掉之后不得再补发");
    assert.match(loggedText(), /vetoed at fire time \(plugin disabled\)/u);
  });

  it("排期之后把该 provider 加进排除名单 ⇒ fire 时刻同样作废；无 options 的会话照常", () => {
    const ctx = createCtx();
    applyPlugin(ctx);
    const agent = register(ctx, makeAgent("excl-1", KNOWN_PROVIDER));
    ctx.fire(
      AGENT_ERROR_EVENT,
      errorPayload(agent, 1, { code: "RATE_LIMIT", message: RATE_LIMIT_MESSAGE }),
    );
    assert.equal(ctx.timers.length, 1);
    ctx.scope.set({ providerExcludes: [KNOWN_PROVIDER] });
    ctx.tick();
    assert.deepEqual(agent.followupCalls, [], "排除名单生效于 fire 时刻");
    assert.match(loggedText(), /vetoed at fire time \(provider excluded\)/u);

    // 官方 `Agent.options` 可为 null（未配 provider 的会话）：读不到 provider 就是
    // 「不在名单里」，续跑照常，不得在这一道上炸。
    const bare = register(ctx, makeAgent("excl-2", KNOWN_PROVIDER));
    bare.options = null;
    ctx.fire(
      AGENT_ERROR_EVENT,
      errorPayload(bare, 1, { code: "RATE_LIMIT", message: RATE_LIMIT_MESSAGE }),
    );
    ctx.tick();
    assert.equal(bare.followupCalls.length, 1, "无 options 的会话按「不排除」处理");
  });

  it("同一轮的 status→idle 重复到达 ⇒ 只处理一次；换了轮才再处理", () => {
    // 真宿主在 `turn/start` 或 `turn/end` 落盘失败的支线上照样会发一次 status→idle,
    // 而读侧只能取「日志里最后一条 turn/end」。不挡就会拿上一轮的旧终态再走一遍：
    // `onSuccess` 把配额复位成「那一轮真跑成功了」，截断还会为同一轮再排一次续写。
    const ctx = createCtx();
    applyPlugin(ctx);
    const agent = register(ctx, makeAgent("wm-1", KNOWN_PROVIDER));
    const log = agent.session.evs;
    assert.ok(log, "替身会话要带可写的事件数组才能造终态");
    truncatedTurn(log, 5);
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 1, "第 5 轮的截断排上一次续写");
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 1, "同一轮的重复 idle 不得再排续写");
    assert.match(loggedText(), /stale turn review \(turn 5\) skipped/u);
    truncatedTurn(log, 6);
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.doesNotMatch(loggedText(), /stale turn review \(turn 6\)/u);
  });

  it("retry-policy 只接受 llm-pi-ai 已声明的 provider（路径段不来自请求体）", async () => {
    // 这一位会被拼进 `providers.<provider>.retryPolicy` 的路径，而宿主会替缺失的
    // 中间层建对象（官方 settings/src/index.ts:101-105）：不校验白名单就等于让
    // 请求体里的任意字符串在**别的条目**的持久配置里开一个新键，带换行的键还原样进日志。
    const ctx = createCtx();
    applyPlugin(ctx);
    const rejected = await remoteOf(ctx).retryPolicy({
      provider: "evil\n[session-rescue] fake",
      preset: "enhanced",
    });
    assert.equal(rejected["status"], 400);
    assert.equal(rejected["error"], "unknown provider");
    assert.equal(ctx.mutations.length, 0, "白名单之外的 provider 不落盘");
    const ok = await remoteOf(ctx).retryPolicy({
      provider: KNOWN_PROVIDER,
      preset: "enhanced",
    });
    assert.equal(ok["ok"], true);
    assert.equal(ctx.mutations.length, 1);
  });

  it("投影注册表 register 抛错时降级为扫描，而不是把整条 fiber 炸掉", async () => {
    // 真注册表在同键不同 stateVersion 时直接抛（session-projection/src/index.ts:281-285）。
    // 抛在 inject 回调里等于整个插件不再工作，与「注册表缺席就退回扫描」的既定
    // 降级承诺相反。
    const ctx = createCtx();
    let stateOfCalls = 0;
    ctx.setService("sessionProjections", {
      register(): () => void {
        throw new Error("projection stateVersion clash");
      },
      stateOf: () => {
        stateOfCalls += 1;
      },
    });
    applyPlugin(ctx);
    // 注册失败现在是异步到达的（注册本身要 await），等一拍再读日志。
    await settle();
    assert.match(loggedText(), /sessionProjections register failed, falling back to log scan/u);
    // 键没注册成功 ⇒ 读口压根不能装上：装了它每次判定都白走一趟「读不到→再回退扫描」。
    const agent = register(ctx, makeAgent("proj-throw", KNOWN_PROVIDER));
    ctx.fire(
      AGENT_ERROR_EVENT,
      errorPayload(agent, 1, { code: "RATE_LIMIT", message: RATE_LIMIT_MESSAGE }),
    );
    assert.equal(stateOfCalls, 0, "注册失败后不得经 stateOf 读投影");
    assert.equal(ctx.timers.length, 1, "注册表抛错不影响续跑主功能");
    ctx.tick();
    assert.equal(agent.followupCalls.length, 1);
    ctx.disposeEffects();
  });

  it("新协议：等待后按 handle 读，已弃用的 stateOf 一次都不碰", async () => {
    const ctx = createCtx();
    let handleReads = 0;
    let legacyReads = 0;
    let disposed = 0;
    ctx.setService("sessionProjections", {
      register: async () => ({
        stateOf: () => {
          handleReads += 1;
        },
        dispose: async () => {
          disposed += 1;
        },
      }),
      stateOf: () => {
        legacyReads += 1;
      },
    });
    applyPlugin(ctx);
    await settle();
    const agent = register(ctx, makeAgent("proj-handle", KNOWN_PROVIDER));
    ctx.fire(
      AGENT_ERROR_EVENT,
      errorPayload(agent, 1, { code: "RATE_LIMIT", message: RATE_LIMIT_MESSAGE }),
    );
    assert.equal(handleReads, 1, "读数走 handle.stateOf");
    assert.equal(legacyReads, 0, "新版宿主上不碰已弃用的 stateOf");
    ctx.disposeEffects();
    assert.equal(disposed, 1, "卸载释放这一次注册");
  });

  it.each([
    ["不是对象", 42],
    ["缺 stateOf", {}],
    ["缺 dispose", { stateOf: (): number => 0 }],
  ] as const)("注册交回第三种形状（%s）⇒ 不交出读口，回退扫描", async (_label, raw) => {
    const ctx = createCtx();
    let legacyReads = 0;
    ctx.setService("sessionProjections", {
      register: () => raw,
      stateOf: () => {
        legacyReads += 1;
      },
    });
    applyPlugin(ctx);
    await settle();
    const agent = register(ctx, makeAgent("proj-weird", KNOWN_PROVIDER));
    ctx.fire(
      AGENT_ERROR_EVENT,
      errorPayload(agent, 1, { code: "RATE_LIMIT", message: RATE_LIMIT_MESSAGE }),
    );
    assert.equal(legacyReads, 0, "失效读口一条都不许装上");
    assert.equal(ctx.timers.length, 1, "回退扫描照常续跑");
    ctx.disposeEffects();
  });

  it("等待期间卸载：注册迟到也不交出读口，当场释放", async () => {
    const ctx = createCtx();
    let disposed = 0;
    const gate = Promise.withResolvers<boolean>();
    ctx.setService("sessionProjections", {
      register: async () => {
        await gate.promise;
        return {
          stateOf: (): number => 0,
          dispose: async () => {
            disposed += 1;
          },
        };
      },
      stateOf: (): number => 0,
    });
    applyPlugin(ctx);
    await settle();
    ctx.disposeEffects();
    gate.resolve(true);
    await settle();
    assert.equal(disposed, 1, "迟到的那次注册必须当场释放");
  });

  it("toggle 台账有界：超过上限时只淘汰已不存在的会话", () => {
    // 这张表由 toggle 参数喂，而 `agent/disposed` 只清得掉真实存在过的会话 id。
    // 不设上限时，一个循环发随机 id 的本机客户端就能让它无限增长，且 state 每次
    // 轮询都把整张表投影进响应体（内存 + 响应双重放大）。
    const ctx = createCtx();
    applyPlugin(ctx);
    const ids = Array.from({ length: 201 }, (_unused, index) => `cap-${String(index)}`);
    for (const id of ids) {
      remoteOf(ctx).toggle({ sessionId: id });
    }
    const { sessions } = remoteOf(ctx).state();
    assert.equal(Object.keys(sessions).length, 200, "关闭位台账严格有界");
    assert.equal(sessions["cap-0"], undefined, "最旧的一位（已不存在的会话）被淘汰");
    assert.notEqual(sessions["cap-200"], undefined, "最新的一位必须记着");
  });

  it("台账满且每一位都还是活会话 ⇒ 409 拒收，绝不静默解掉别人的开关", () => {
    // 无脑淘汰最旧一位的代价是：那位用户仍关着的活会话位消失，state 里读不到它、
    // 卡片回弹成「开」，下一次瞬时失败就自动续跑了用户明确关掉的那条会话。
    const ctx = createCtx();
    applyPlugin(ctx);
    const liveIds = Array.from({ length: 200 }, (_unused, index) => `live-${String(index)}`);
    for (const id of liveIds) {
      register(ctx, makeAgent(id, KNOWN_PROVIDER));
    }
    for (const id of liveIds) {
      remoteOf(ctx).toggle({ sessionId: id });
    }
    const overflow = remoteOf(ctx).toggle({ sessionId: "live-overflow" });
    assert.equal(overflow["status"], 409, "没有可淘汰的死会话时拒收，而不是挤掉一位");
    const { sessions } = remoteOf(ctx).state();
    assert.equal(Object.keys(sessions).length, 200, "一位都没被挤掉");
    assert.equal(sessions["live-overflow"], undefined, "被拒的这次不记账");
  });

  it("providerRetryAfterMs 是 NaN 或负数时回落到固定阶梯，不跳过等待", async () => {
    // 官方在构造期就丢掉 <=0 / 非有限的这个字段（llm/src/adapter-failure.ts:76-78），
    // 所以这两枚都是漂移兜底面：NaN 连 `> cap` 比较都过不掉（NaN 与任何数比都是
    // false），既不配当延迟也不配当「等不起」的信号，只能走阶梯。
    const ctx = createCtx();
    applyPlugin(ctx);
    const agent = register(ctx, makeAgent("dirty-after", KNOWN_PROVIDER));
    const listener = listenerOf(ctx);
    const probe = async (value: number): Promise<void> => {
      const pending = listener(
        {
          agent,
          turn: 1,
          failure: { code: "RATE_LIMIT", message: "slow down", providerRetryAfterMs: value },
          signal: undefined,
        },
        nextNoop,
      );
      ctx.tick();
      assert.deepEqual(await pending, { kind: "retry" });
      const armed = ctx.timers.at(-1);
      assert.ok(armed !== undefined, "脏 Retry-After 也要排上退避");
      assert.equal(armed.ms, 2000, `阶梯第一档，而不是把 ${String(value)} 当延迟`);
    };
    await Promise.all([probe(Number.NaN), probe(-5000)]);
  });
});
