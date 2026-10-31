import { describe, it, beforeEach } from "vitest";
import { logged } from "./setup-logs.ts";
import assert from "node:assert/strict";
import plugin, { RESCUE_REMOTE_NAMESPACE, SessionRescueRemoteService } from "../host.ts";
import { Context } from "@deepseek-ai/cordis";
// 投影替身按读点现折会话事件流（真注册表增量折叠，同串事件同值）。折叠口在测试树，
// 折的是生产那份 rescueFactsProjection 单元——替身与生产共用同一套 init/apply。
import { RESCUE_FACTS_KEY, rescueFactsProjection } from "../lib/turn-facts.ts";
import { foldEvents } from "./turn-facts-fold.ts";
import {
  applyRescue,
  patchEntryId,
  schemaDefaults,
  secretBearingFields,
  volatileFormOf,
} from "./config-refs.ts";
import type { ConfigureCall, SchemaNode } from "./config-refs.ts";

// 宿主事件名与回合终态 kind：替身造事件流（type/kind）与 ctx.fire 的触发位都取这几条，
// 同串在测试里抄几十遍，拼错一次就是一条永远测不到东西的绿用例。
const TURN_START_EVENT = "turn/start";
const USER_MESSAGE_EVENT = "user/message";
const AGENT_ERROR_EVENT = "agent/error";
/** 设置文档变更事件名：locale 偏好缓存据此失效，宿主按命名空间逐条推送。 */
const SETTINGS_UPDATED = "settings/document-updated";
/** 本包的 locale 命名空间（官方 client-locale 那条设置行投影出来的 ns）。 */
const LOCALE_NS = "locale";
const AGENT_STATUS_EVENT = "agent/status";
const MAX_TOKENS_REASON = "max-tokens";

/** rescue 注入消息的 source.kind。测试侧按**期望值**自持这份串（不从 host.ts 导入，
 *  否则断言退化成拿被测常量比自己）。 */
const RESCUE_MESSAGE_SOURCE_KIND = "plugin:session-rescue";

/** 替身运输层故意抛错的消息：断言它出现在日志里，才证明错误没被静默吞掉。 */
const CARRIER_DOWN_MESSAGE = "carrier down";

/** sensenova 429 的真实配额文案（短形 / 全形都取自线上样本，改写就测不到那条分类判据）。 */
const QUOTA_EXCEEDED_TEXT = "Allocated quota exceeded";
const QUOTA_EXCEEDED_FULL_TEXT = "Allocated quota exceeded, please increase your quota limit.";

// ── 轻量宿主替身：只实现本插件用到的服务面（settings/timer/agents）
//    与 cordis ctx 面（on/effect/get）。类型上以真实 cordis Context 接收。 ──

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
  session: { id: string; snapshotEvents: () => unknown[]; evs?: unknown[] };
  followup: (message: unknown) => void;
  followupCalls: unknown[];
}

interface MockInjectCtx {
  effect: (factory: () => (() => void) | undefined) => void;
  get: (name: string) => unknown;
  reflect: MockCtx["reflect"] | undefined;
  /** cordis 的注入子上下文同样带着依赖服务的读面（本包用它调 settings.configure）。 */
  settings: MockCtx["settings"];
  /** 投影注册表（按 unknown 收——真身只在 host.ts 的守卫面里被点名）。 */
  sessionProjections?: unknown;
}

/**
 * `ctx.sessionProjections` 替身：`register` 收下单元，`stateOf` 按该会话当前的
 * `evs` 现折一份状态。真注册表是**增量**折叠，同一串事件下折叠结果与 `foldEvents`
 * 逐字同值（等价面见 test/turn-facts.test.ts），故这里按读点现折即可。
 * `foldOverride` 让用例交出坏形状/不可采信的状态，用来钉回退扫描那一条支。
 */
interface MockProjections {
  registered: unknown[];
  /** 官方 `register` 交回的那条 disposer 被跑过的单元清单
   *  （session-projection/lib/types/index.d.ts:159 的 `(): () => void`）。 */
  disposed: unknown[];
  reads: { session: unknown; key: string }[];
  foldOverride: { value: ((evs: readonly unknown[]) => unknown) | undefined };
  register: (definition: unknown) => () => void;
  stateOf: (session: { evs: unknown[] }, key: string) => unknown;
}

interface MockCtx {
  handlers: Record<string, (payload: unknown) => void>;
  timers: TimerEntry[];
  effects: (() => void)[];
  /** 投影注册表替身（默认**不在**宿主服务表里 ⇒ 注入不激活 ⇒ 三类判定走回退扫描；
   *  用例经 setService("sessionProjections", ctx.projections) 把它装上）。 */
  projections: MockProjections;
  /** ctx.inject 子 fiber 上登记的释放器（先卸后装可断言）。 */
  childEffects: (() => void)[];
  /** 设置活值表（= 0.1.7 交进 apply 的那些 volatile 引用背后的那份值）：
   *  用例经 `set()` 写一次即等价于「用户在设置卡上改了一项」。 */
  scope: {
    get: () => Record<string, unknown>;
    set: (patch: Record<string, unknown>) => void;
  };
  agentsService: {
    rootsList: MockAgent[];
    byId: Map<string, MockAgent>;
    roots: () => { id: string }[];
    get: (id: string) => MockAgent | undefined;
  };
  /** 0.1.7 的 settings 服务面：`register`/`get`/`installSection` 已被宿主移除，
   *  只剩 describe（跨命名空间读）+ mutate（路径级写入）+ configure（页面策略）。 */
  settings: {
    describe: () => { ns: string; value: unknown }[];
    mutate: (ns: string, ops: unknown[]) => Promise<void>;
    configure: (presentation: { auto?: boolean }, owner?: unknown) => () => void;
  };
  /** 官方 locale 命名空间里的偏好（undefined = 该条目未被投影 → host 文案走中文）。 */
  localePreference: string | undefined;
  /** llm-pi-ai describe() 的返回值（retry-providers 路由的数据源）；undefined = 服务不可读。 */
  piAiDescribeValue: { ns: string; value: unknown; revision?: number }[] | undefined;
  /** settings.mutate 调用记录（retry-policy 路由的写入断言面）。 */
  mutations: { ns: string; ops: unknown[] }[];
  /** settings.configure 调用记录（页面策略：{ auto:false } + owner=fiber 的断言面）。 */
  configureCalls: { presentation: { auto?: boolean }; owner: unknown }[];
  /** 本插件 fiber（configure 的 owner 必须是它）。 */
  fiber: { id: string };
  /** 可注入的 mutate 实现（测试拒绝路径用）。 */
  mutateImpl?: (ns: string, ops: unknown[]) => Promise<void>;
  timer: { timeout: (fn: () => void, ms: number) => () => void };
  on: (event: string, handler: (payload: unknown) => void) => void;
  get: (name: string) => unknown;
  /** 官方服务注册口（Typert Remote 服务构造时用）。 */
  reflect: { provide: (name: string, service: unknown) => () => void };
  effect: (factory: () => (() => void) | undefined) => void;
  /** cordis `ctx.inject` 替身：依赖齐了才激活回调，setService 变化时先卸后装。 */
  inject: (deps: string[], activate: (child: MockInjectCtx) => void) => void;
  /** 变更宿主服务表（模拟可选服务后装载 / 重启换实例）。 */
  setService: (name: string, service: unknown) => void;
  fire: (event: string, payload: unknown) => void;
  tick: () => void;
  disposeEffects: () => void;
}

function createMockCtx(): MockCtx {
  const handlers: Record<string, (payload: unknown) => void> = {};
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
  // 服务替身经 holder 间接引用最终 ctx（避免 no-use-before-define；也不触发
  // prefer-const / init-declarations），与 round-1 结构一致。
  const holder: { ctx: MockCtx | null } = { ctx: null };
  const settingsService = {
    // 0.1.7 唯一的跨命名空间读：locale 偏好与 llm-pi-ai 都从这张表单投影里挑。
    // localePreference 未设 = 官方 client-locale 那条目没被投影 → 行不存在 → 中文默认。
    describe(): { ns: string; value: unknown }[] {
      const rows = holder.ctx?.piAiDescribeValue ?? [];
      const preference = holder.ctx?.localePreference;
      return preference === undefined ? rows : [...rows, { ns: "locale", value: { preference } }];
    },
    async mutate(ns: string, ops: unknown[]): Promise<void> {
      if (holder.ctx?.mutateImpl) {
        return holder.ctx.mutateImpl(ns, ops);
      }
      holder.ctx?.mutations.push({ ns, ops: [...ops] });
    },
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
  // 宿主服务表：cordis `ctx.get` 是无 inject 语义的存储读，这里用同一张表替身。
  // 用 Map 而非 Record：setService(name, undefined) 要能摘掉一个服务（模拟
  // 可选服务卸载），而 Record 的动态 delete 既慢又会被 lint 拒绝。
  const provided = new Map<string, unknown>([
    ["agents", agentsService],
    ["settings", settingsService],
    ["timer", timerService],
  ]);
  const injections: { deps: string[]; activate: (child: MockInjectCtx) => void }[] = [];
  const childEffects: (() => void)[] = [];
  // 投影注册表替身（见 MockProjections）。
  const registered: unknown[] = [];
  const disposed: unknown[] = [];
  const reads: { session: unknown; key: string }[] = [];
  const foldOverride: { value: ((evs: readonly unknown[]) => unknown) | undefined } = {
    value: undefined,
  };
  const projections: MockProjections = {
    registered,
    disposed,
    reads,
    foldOverride,
    // 官方 register 的返回是**这条注册自己的 disposer**（index.d.ts:159）：本包现在接住它
    // 并挂进 effect 的释放链，所以替身必须把它交回去——早先那份 `=> void` 的替身
    // 让「卸载时释放注册」这条支根本没有用例能测。
    register(definition) {
      registered.push(definition);
      return () => {
        disposed.push(definition);
      };
    },
    stateOf(session, key) {
      reads.push({ session, key });
      const fold = foldOverride.value ?? foldEvents;
      return fold(session.evs);
    },
  };
  /** 依赖到位才激活回调；已激活的先卸后装（对齐 cordis registry 的 inject 语义）。 */
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
      settings: settingsService,
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
    projections,
    scope,
    agentsService,
    settings: settingsService,
    fiber: { id: "session-rescue-fiber" },
    configureCalls: [],
    localePreference: undefined,
    piAiDescribeValue: [
      {
        ns: "llm-pi-ai",
        value: {
          providers: {
            sensenova: {
              retryPolicy: {
                mode: "normal",
                maxRetries: 12,
                retryableCodes: [
                  "EMPTY_RESPONSE",
                  "RATE_LIMIT",
                  "SERVER",
                  "TIMEOUT",
                  "TRANSPORT",
                  "QUOTA",
                ],
              },
            },
            xkiro: {},
            aihubmix: {},
            // 白名单闸门（见 test/host-contract.test.ts）之后，POST 的 provider 必须是
            // pi-ai 已声明的那几个；这几条用例测的是 preset→ops 的映射与写侧失败面，
            // 不是拒收面，所以把用例里出现的名字都在这份 fixture 里声明出来。
            tokenrouter: {},
            openrouter: {},
            x: {},
          },
        },
      },
    ],
    mutations: [],
    timer: timerService,
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
  return ctx;
}

/** 假件把注入记在 followupCalls[0]，注入正文取其首条 text。 */
function injectTextOf(agent: MockAgent): string {
  const call = agent.followupCalls[0] as { content: { text: string }[] };
  return call.content[0]?.text ?? "";
}

/** 排除名单用例共用的线路名（本文件多处引用，收常量）。 */
const EXCLUDED_PROVIDER = "baidu-token-plan";

/** 「会话还没记录过选择」：官方 `current()` 交回 undefined 的那一态。 */
const NO_RECORDED_SELECTION: { readonly provider: string } | undefined = undefined;

function makeAgent(
  id: string,
  provider?: string,
  opts: Partial<Pick<MockAgent, "status" | "inbox" | "session">> = {},
): MockAgent {
  const followupCalls: unknown[] = [];
  const evs: unknown[] =
    (opts.session as { snapshotEvents?: () => unknown[] } | undefined)?.snapshotEvents?.() ?? [];
  const agent: MockAgent = {
    id,
    options: provider === undefined ? {} : { provider },
    status: opts.status ?? "idle",
    inbox: { nextTurn: opts.inbox?.nextTurn ?? [], nextStep: opts.inbox?.nextStep ?? [] },
    session: { id, snapshotEvents: () => evs, evs },
    followup(msg) {
      followupCalls.push(msg);
    },
    followupCalls,
  };
  return agent;
}

function register(ctx: MockCtx, agent: MockAgent): void {
  ctx.agentsService.rootsList.push(agent);
  ctx.agentsService.byId.set(agent.id, agent);
}

/** 事件流推进：rescue fire 开出新轮（首条消息来自 session-rescue）。 */
function openRescueTurn(agent: MockAgent, turn: number): void {
  (agent.session.evs ?? []).push({
    type: TURN_START_EVENT,
    seq: 3 + turn,
    time: 3 + turn,
    data: { turn },
  });
  (agent.session.evs ?? []).push({
    type: USER_MESSAGE_EVENT,
    seq: 100 + turn,
    time: 100 + turn,
    data: {
      role: "user",
      content: [{ type: "text", text: "[自动续跑]…" }],
      source: { kind: RESCUE_MESSAGE_SOURCE_KIND },
    },
  });
}

function payload(agent: MockAgent, turn: number, failure: unknown): Record<string, unknown> {
  const err = failure === undefined || failure === null ? null : { failure };
  return { agent, turn, step: 1, error: err };
}

/** 走一次「agent/error → 自动续跑注入」，回注入正文。两个 locale 缓存用例共用这一条：
 *  会话 id 是唯一的自由度（换会话避开冷却/配额），其余路径完全同形。 */
function runRescueInjectText(ctx: MockCtx, sessionId: string): string {
  const agent = makeAgent(sessionId, "tokenrouter");
  register(ctx, agent);
  ctx.fire(AGENT_ERROR_EVENT, payload(agent, 2, { code: "SERVER", message: "boom" }));
  ctx.tick();
  return injectTextOf(agent);
}

/** 走真实 apply：第二参是**行 config**（组合包层/用户层行的 `config:`），0.1.7 由
 *  cordis 在装载期把它合进 schema 默认（显式 undefined 不覆盖，等价于旧的 compact()），
 *  再交 volatile 引用进来——这里复刻的就是那一步合并。 */
/** 注册结果在 `await` 之后才交出读口（两版原始返回值都是函数，判别只能在 await 之后），
 *  所以投影用例要等一拍再判定。 */
const settle = (): Promise<unknown> => {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  setImmediate(resolve);
  return promise;
};

function applyPlugin(ctx: MockCtx, rowConfig?: Record<string, unknown>): void {
  // mock ctx 是 host 服务面的结构替身，与真实 cordis Context 仅接口上兼容。
  if (rowConfig !== undefined) {
    ctx.scope.set(
      Object.fromEntries(Object.entries(rowConfig).filter(([, value]) => value !== undefined)),
    );
  }
  applyRescue(ctx, () => ctx.scope.get());
}

// ── 官方 Typert Remote 读面 ──────────────────────────────────────────────
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

/** waterfall 的 next 占位（request-error 用例共用；模块级满足 scoping 规则）。 */
const nextNoop = async (): Promise<undefined> => undefined;

// ── 回合事件构造器（纯函数，不捕获外部作用域）─────────────────────────────

function evCall(turn: number, callId: string, name: string): unknown {
  return {
    type: "tool/call",
    seq: 1,
    time: 1,
    data: { turn, step: 1, callId, name, arguments: "{}" },
  };
}
function evResult(turn: number, callId: string): unknown {
  return {
    type: "tool/result",
    seq: 2,
    time: 2,
    data: { turn, step: 1, message: { source: { kind: "tool", callId } } },
  };
}
function evTodo(todos: unknown): unknown {
  // 清单写入载荷只有 { todos }（清单类型契约），不带 turn。
  return { type: "todo/write", seq: 3, time: 3, data: { todos } };
}
/** 最短的"本回合自己写过清单"事件流：turn/start → todo/write → turn/end。 */
function turnWithTodos(turn: number, kind: string, todos: unknown): unknown[] {
  return [
    { type: TURN_START_EVENT, seq: 0, time: 0, data: { turn } },
    evTodo(todos),
    { type: "turn/end", seq: 4, time: 4, data: { turn, reason: { kind } } },
  ];
}
function evTurnEnd(turn: number, kind: string): unknown {
  return { type: "turn/end", seq: turn * 10, time: turn * 10, data: { turn, reason: { kind } } };
}

/** 整表替换事件流（mock 的 evs 由 makeAgent 恒提供）。 */
function replaceAllEvents(agent: { session: { evs?: unknown[] } }, events: unknown): void {
  const { evs } = agent.session;
  if (evs === undefined) {
    throw new Error("mock session.evs missing");
  }
  evs.length = 0;
  evs.push(events);
}

describe("settings 隐式注册（0.1.7：命名空间 = profile 条目 id）", () => {
  it("config schema 逐字段默认 = 0.1.6 交给 settings.register 的那份内置底座", () => {
    // 0.1.7 删了 settings.register(ns, schema, { base })：命名空间 = profile 条目 id，
    // 默认值改由 schema 自己带（cordis 装载期按同一份 schema 填默认、再把 volatile 字段
    // 包成引用交进 apply）。所以"底座"这层断言原样搬到这里，逐字段对齐——已批准的
    // 延迟/冷却/配额值一项都不能变（变一项就是改调度语义）。
    const ctx = createMockCtx();
    applyPlugin(ctx);
    assert.deepEqual(schemaDefaults(), {
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
      // 字段化的请求级重试三值：默认与旧模块常量同值（5 次 / 该阶梯 / 30s 封顶），
      // 行为冻结。手写字面值而不引常量——引常量就成了自证，常量改了该先红。
      requestRetryMax: 5,
      requestRetryBackoffMs: [2000, 5000, 10_000, 20_000, 30_000],
      requestRetryBackoffCapMs: 30_000,
    });
    // 命名空间由条目 id 决定（本包不再自己声明 ns）：卡片 namespace 与它必须同串。
    assert.equal(patchEntryId(), "session-rescue");
  });

  it("页面策略：settings.configure({ auto: false }) 恰好一次且 owner 是本插件 fiber", () => {
    // 本包自带设置卡片，得让宿主别再自动生成一份自动表单页；owner 缺省是 settings
    // 服务自己的 fiber —— 传错就等于给别人的页面定了策略。
    const ctx = createMockCtx();
    applyPlugin(ctx);
    const calls: ConfigureCall[] = ctx.configureCalls;
    assert.equal(calls.length, 1, "本包应只登记一次页面策略");
    assert.deepEqual(calls[0]?.presentation, { auto: false });
    assert.equal(calls[0].owner, ctx.fiber);
  });
});

describe("agent/error 闸门", () => {
  let ctx: MockCtx;
  beforeEach(() => {
    ctx = createMockCtx();
    applyPlugin(ctx);
  });

  it("enabled=false → 不调度", () => {
    ctx.scope.set({ enabled: false });
    const agent = makeAgent("s1", "tokenrouter");
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 1, { code: "RATE_LIMIT", message: "x" }));
    assert.equal(ctx.timers.length, 0);
  });

  it("provider 在 excludes → 不调度", () => {
    ctx.scope.set({ providerExcludes: [EXCLUDED_PROVIDER] });
    const agent = makeAgent("s1", EXCLUDED_PROVIDER);
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 1, { code: "RATE_LIMIT", message: "x" }));
    assert.equal(ctx.timers.length, 0);
  });

  it("触发时读会话活线：它在 excludes ⇒ 到点也不发", () => {
    ctx.scope.set({ providerExcludes: [EXCLUDED_PROVIDER], resumeDelayMs: 7000 });
    const agent = makeAgent("s1", "tokenrouter");
    Object.assign(agent, { model: { current: () => ({ provider: EXCLUDED_PROVIDER }) } });
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 2, { code: "RATE_LIMIT", message: "x" }));
    assert.equal(ctx.timers.length, 1, "先按瞬时失败武装");
    ctx.tick();
    assert.equal(agent.followupCalls.length, 0, "到点读的是会话活线，它在排除名单里");
  });

  it("触发时会话没记录过选择 ⇒ 回落 options.provider，照常发", () => {
    ctx.scope.set({ providerExcludes: [EXCLUDED_PROVIDER], resumeDelayMs: 7000 });
    const agent = makeAgent("s1", "tokenrouter");
    Object.assign(agent, { model: { current: () => NO_RECORDED_SELECTION } });
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 2, { code: "RATE_LIMIT", message: "x" }));
    ctx.tick();
    assert.equal(agent.followupCalls.length, 1, "options 那条不在排除名单，照常续跑");
  });

  it("永久失败（上下文超长）→ 不调度", () => {
    const agent = makeAgent("s1", "tokenrouter");
    register(ctx, agent);
    ctx.fire(
      AGENT_ERROR_EVENT,
      payload(agent, 1, { code: "CONTEXT_WINDOW_EXCEEDED", message: "too long" }),
    );
    assert.equal(ctx.timers.length, 0);
  });

  it("QUOTA 无限流证据 → 不调度", () => {
    const agent = makeAgent("s1", "tokenrouter");
    register(ctx, agent);
    ctx.fire(
      AGENT_ERROR_EVENT,
      payload(agent, 1, { code: "QUOTA", message: "Insufficient quota" }),
    );
    assert.equal(ctx.timers.length, 0);
  });

  it("非根会话（子代理）→ 不调度", () => {
    const agent = makeAgent("child1", "tokenrouter");
    // 可被 get 到，但不在 roots()
    ctx.agentsService.byId.set(agent.id, agent);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 1, { code: "RATE_LIMIT", message: "x" }));
    assert.equal(ctx.timers.length, 0);
  });

  it("该会话已被 toggle 关闭 → 不调度", async () => {
    const agent = makeAgent("s1", "tokenrouter");
    register(ctx, agent);
    remoteOf(ctx).toggle({ sessionId: "s1" });
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 1, { code: "RATE_LIMIT", message: "x" }));
    assert.equal(ctx.timers.length, 0);
  });
});

describe("调度与触发", () => {
  let ctx: MockCtx;
  beforeEach(() => {
    ctx = createMockCtx();
    applyPlugin(ctx);
  });

  it("瞬时失败 → 按配置延时调度", () => {
    ctx.scope.set({ resumeDelayMs: 7000 });
    const agent = makeAgent("s1", "tokenrouter");
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 2, { code: "RATE_LIMIT", message: "x" }));
    assert.equal(ctx.timers.length, 1);
    assert.equal(ctx.timers[0]?.ms, 7000);
  });

  it("触发时校验通过 → 发送已批准续跑文案，count+1", async () => {
    const agent = makeAgent("s1", "tokenrouter");
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 2, { code: "SERVER", message: "boom" }));
    ctx.tick();
    assert.equal(agent.followupCalls.length, 1);
    const msg = agent.followupCalls[0] as {
      role: string;
      content: { text: string }[];
      source: unknown;
    };
    assert.equal(msg.role, "user");
    assert.ok(msg.content[0]?.text.startsWith("[自动续跑]") === true);
    assert.deepEqual(msg.source, { kind: RESCUE_MESSAGE_SOURCE_KIND });
    const body = remoteOf(ctx).state();
    assert.equal((body.sessions["s1"] as { count: number }).count, 1);
  });

  it("注入 source 必须是 producer-owned kind（不得回退到 'plugin'）", () => {
    // 0.1.7 的 V4 准入（session-format-v3-to-v4/src/message-sources.ts）对每个
    // 持久消息位拒收退役包装 `{ kind: 'plugin', plugin }`，抛
    // "format v4 message requires a producer-owned source kind" —— 一条这样的
    // 续跑消息会直接把整个会话的落盘拒绝掉。
    const agent = makeAgent("s1", "tokenrouter");
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 2, { code: "SERVER", message: "boom" }));
    ctx.tick();
    assert.equal(agent.followupCalls.length, 1);
    const { source } = agent.followupCalls[0] as { source: Record<string, unknown> };
    assert.notEqual(source["kind"], "plugin");
    assert.equal(typeof source["kind"], "string");
    assert.ok(
      String(source["kind"]).startsWith(RESCUE_MESSAGE_SOURCE_KIND),
      "kind 须是本插件的 producer-owned 串（与读回侧 openedBySource 同一身份）",
    );
    assert.equal(source["plugin"], undefined, "退役包装的 plugin 字段不得再出现");
  });

  it("locale 偏好读一次即缓存：重复判定不重复 describe，推送失效信号后才重读", () => {
    // 注入正文经 runtime.localeMessages() 取，而跨命名空间读只剩 describe() 一条路
    // （它对每个活跃条目都要 schema.toJSON() + JSON.stringify 算 revision）。
    ctx.localePreference = "zh-CN";
    let describeCalls = 0;
    const base = ctx.settings.describe;
    ctx.settings.describe = (): { ns: string; value: unknown }[] => {
      describeCalls += 1;
      return base();
    };

    assert.match(runRescueInjectText(ctx, "s-warm"), /一/u, "首次判定取到中文");
    const warm = describeCalls;
    assert.ok(warm > 0, "首次判定读了 describe");

    // 缓存已捂热：换一个会话再走同一路，不该再读。
    assert.match(runRescueInjectText(ctx, "s-next"), /一/u, "第二个会话仍走缓存");
    assert.equal(describeCalls, warm, "缓存捂热后不再读 describe()");

    ctx.fire(SETTINGS_UPDATED, "llm-pi-ai");
    assert.match(runRescueInjectText(ctx, "s-other-ns"), /一/u, "别的命名空间变更后仍走缓存");
    assert.equal(describeCalls, warm, "别的命名空间变更不误伤本包的缓存");

    // 宿主推 locale 失效 → 下一趟重读一次；描述符此刻还是 zh-CN。
    ctx.fire(SETTINGS_UPDATED, LOCALE_NS);
    assert.match(
      runRescueInjectText(ctx, "s-invalidated"),
      /一/u,
      "失效后重读到的是当时的描述符（仍中文）",
    );
    assert.equal(describeCalls, warm + 1, "locale 失效后重读一次");

    // 描述符真变了，宿主再推一次 → 文案跟着换语言。
    ctx.localePreference = "en-US";
    ctx.fire(SETTINGS_UPDATED, LOCALE_NS);
    assert.doesNotMatch(
      runRescueInjectText(ctx, "s-switched"),
      /[一-鿿]/u,
      "重读后注入正文换成英文",
    );
    assert.equal(describeCalls, warm + 2, "换语言那趟又读了一次");
  });

  it("缺席不缓存：locale 条目迟到时每趟都重读，语言不会被永久钉死", () => {
    // localePreference 未设 = 官方 client-locale 那条目没被投影 → find 取不到行。
    // 缓存一次缺席会把语言跟随永久钉死成中文，故缺席期间每趟都重读。
    let describeCalls = 0;
    const base = ctx.settings.describe;
    ctx.settings.describe = (): { ns: string; value: unknown }[] => {
      describeCalls += 1;
      return base();
    };
    assert.match(runRescueInjectText(ctx, "s-absent-1"), /一/u, "缺席时走中文");
    const afterFirst = describeCalls;
    assert.ok(afterFirst > 0, "缺席的那一趟读了 describe");
    assert.match(runRescueInjectText(ctx, "s-absent-2"), /一/u, "缺席时第二次仍走中文");
    assert.ok(describeCalls > afterFirst, "缺席不缓存：第二趟又读了一次");

    ctx.localePreference = "en-US";
    assert.doesNotMatch(
      runRescueInjectText(ctx, "s-arrives"),
      /[一-鿿]/u,
      "条目到位后立即跟上语言",
    );
  });

  it("英文偏好下走同一条调度路径 → 注入正文取自 en 字典", () => {
    // 与上一条同一路径，只把官方 locale 偏好切成 en-US：注入段的语言由
    // hostMessages 选表决定，调度器与纯函数都不读设置。
    ctx.localePreference = "en-US";
    const agent = makeAgent("s1", "tokenrouter");
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 2, { code: "SERVER", message: "boom" }));
    ctx.tick();
    assert.equal(agent.followupCalls.length, 1);
    const msg = agent.followupCalls[0] as { content: { text: string }[] };
    const text = msg.content[0]?.text ?? "";
    assert.ok(text.startsWith("[auto-resume]"), "英文续跑正文");
    assert.doesNotMatch(text, /[一-鿿]/u, "注入段不得混进中文");
  });

  it("待办期间第二次失败不重复调度", () => {
    const agent = makeAgent("s1", "tokenrouter");
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 2, { code: "RATE_LIMIT", message: "x" }));
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 2, { code: "RATE_LIMIT", message: "x" }));
    assert.equal(ctx.timers.length, 1);
  });
});

describe("链式例外（rescue 开出的回合再失败）", () => {
  let ctx: MockCtx;
  beforeEach(() => {
    ctx = createMockCtx();
    applyPlugin(ctx);
  });

  // 重建真实事故形态（本会话 turn 3→turn 4）：
  // turn N 由用户消息开启 → 失败 → rescue fire → turn N+1 由 rescue 开启 → 再失败（被冷却吞掉的正是这次）
  function rescueOpenedAgent(firstTurn = 2): MockAgent {
    const agent = makeAgent("s1", "tokenrouter", {
      session: {
        id: "s1",
        snapshotEvents: () => [
          { type: TURN_START_EVENT, seq: 1, time: 1, data: { turn: firstTurn } },
          {
            type: USER_MESSAGE_EVENT,
            seq: 2,
            time: 2,
            data: {
              role: "user",
              content: [{ type: "text", text: "用户消息" }],
              source: { kind: "user", rpcId: "r1" },
            },
          },
        ],
      },
    });
    register(ctx, agent);
    return agent;
  }

  // 事件流推进：rescue fire 开出新轮（首条消息来自 session-rescue）
  // （模块级函数，见上方定义处）

  it("失败轮由 rescue 消息开启 → 冷却旁路，延迟取 chainResumeDelayMs", () => {
    const agent = rescueOpenedAgent(2);
    // 第一次失败（turn 2，非 rescue 开启，普通路径）
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 2, { code: "RATE_LIMIT", message: "x" }));
    // fire → lastFireAt 设置，冷却开始
    ctx.tick();
    assert.equal(agent.followupCalls.length, 1);
    // rescue 消息开出了 turn 3（事件流推进）
    openRescueTurn(agent, 3);
    // turn 3（rescue 开出）再失败 → 链式例外：不被冷却吞掉
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 3, { code: "RATE_LIMIT", message: "x" }));
    // 有新定时器，且延迟 = max(10000, 60000) = 60000
    assert.equal(ctx.timers.length, 2);
    assert.equal(ctx.timers[1]?.ms, 60_000);
  });

  it("失败轮由用户消息开启 → 冷却照常拦截（链式判定不误伤）", () => {
    const agent = makeAgent("s1", "tokenrouter", {
      session: {
        id: "s1",
        snapshotEvents: () => [
          { type: TURN_START_EVENT, seq: 1, time: 1, data: { turn: 2 } },
          {
            type: USER_MESSAGE_EVENT,
            seq: 2,
            time: 2,
            data: {
              role: "user",
              content: [{ type: "text", text: "hi" }],
              source: { kind: "user", rpcId: "r1" },
            },
          },
        ],
      },
    });
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 2, { code: "RATE_LIMIT", message: "x" }));
    // fire → 冷却开始
    ctx.tick();
    // 用户手动开新轮 turn 3（普通 user 消息）→ 再失败
    (agent.session.evs ?? []).push({ type: TURN_START_EVENT, seq: 3, time: 3, data: { turn: 3 } });
    (agent.session.evs ?? []).push({
      type: USER_MESSAGE_EVENT,
      seq: 4,
      time: 4,
      data: {
        role: "user",
        content: [{ type: "text", text: "手动" }],
        source: { kind: "user", rpcId: "r2" },
      },
    });
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 3, { code: "RATE_LIMIT", message: "x" }));
    // 普通失败在冷却内 → 被拦截，无新定时器
    assert.equal(ctx.timers.length, 1);
  });

  it("max-tokens continue 不走链式：自身冷却生效（rescue-opened 轮也不旁路）", () => {
    const agent = rescueOpenedAgent(2);
    // 先让 turn 2 以 max-tokens 结束 → 调度并 fire 一次 continue，建立它自己的冷却戳
    (agent.session.evs ?? []).push({
      type: "turn/end",
      seq: 40,
      time: 40,
      data: { turn: 2, reason: { kind: MAX_TOKENS_REASON } },
    });
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 1, "首个 continue 应调度");
    ctx.tick();
    // rescue 消息开出的 turn 3 又截断：continue 路径不带 chainDelayMs，
    // 必须被 continue 自身 60s 冷却拦住（若链式旁路误接入就会被放行）。
    openRescueTurn(agent, 3);
    (agent.session.evs ?? []).push({
      type: "turn/end",
      seq: 50,
      time: 50,
      data: { turn: 3, reason: { kind: MAX_TOKENS_REASON } },
    });
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 1, "continue 不走链式：仍被自身冷却拦截");
  });

  it("跨 kind 冷却互不干扰：resume fire 之后同刻的 continue 照常调度", () => {
    const agent = makeAgent("s1", "tokenrouter");
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 1, { code: "RATE_LIMIT", message: "x" }));
    // resume fire → 只写下 resume 自己的冷却时间戳
    ctx.tick();
    (agent.session.evs ?? []).push({
      type: "turn/end",
      seq: 9,
      time: 9,
      data: { turn: 1, reason: { kind: MAX_TOKENS_REASON } },
    });
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 2, "continue 不得被 resume 的冷却跨 kind 误拦");
    assert.equal(ctx.timers[1]?.ms, 3000);
  });

  it("链式 fire 成功后 count+1，仍受 maxResumes 上限保护", async () => {
    const agent = rescueOpenedAgent(10);
    for (let i = 0; i < 3; i += 1) {
      ctx.fire(AGENT_ERROR_EVENT, payload(agent, 10 + i, { code: "RATE_LIMIT", message: "x" }));
      ctx.tick();
      // rescue fire 开出新轮（事件流推进）
      openRescueTurn(agent, 11 + i);
    }
    // 3 次全 fire（链式旁路冷却）→ 达到 maxResumes=3
    const body = remoteOf(ctx).state();
    assert.equal((body.sessions["s1"] as { count: number }).count, 3);
    // 第 4 次链式失败 → max-resumes 拦截，无新定时器
    openRescueTurn(agent, 99);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 99, { code: "RATE_LIMIT", message: "x" }));
    assert.equal(ctx.timers.length, 3);
  });
});

describe("触发前校验否决", () => {
  let ctx: MockCtx;
  beforeEach(() => {
    ctx = createMockCtx();
    applyPlugin(ctx);
  });

  it("agent 已不存在 → 否决", () => {
    const agent = makeAgent("s1", "tokenrouter");
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 1, { code: "RATE_LIMIT", message: "x" }));
    // 会话被移除
    ctx.agentsService.byId.delete("s1");
    ctx.tick();
    assert.equal(agent.followupCalls.length, 0);
  });

  it("触发时 agent 正在运行 → 否决", () => {
    const agent = makeAgent("s1", "tokenrouter");
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 1, { code: "RATE_LIMIT", message: "x" }));
    // 用户在倒计时内手动继续
    agent.status = "running";
    ctx.tick();
    assert.equal(agent.followupCalls.length, 0);
  });

  it("触发时 inbox 有待处理消息 → 否决", () => {
    const agent = makeAgent("s1", "tokenrouter");
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 1, { code: "RATE_LIMIT", message: "x" }));
    agent.inbox = { nextTurn: [{ id: "queued" }], nextStep: [] };
    ctx.tick();
    assert.equal(agent.followupCalls.length, 0);
  });

  it("失败轮之后已有新轮开启 → 否决", () => {
    const agent = makeAgent("s1", "tokenrouter", {
      session: {
        id: "s1",
        snapshotEvents: () => [{ type: TURN_START_EVENT, seq: 0, time: 0, data: { turn: 1 } }],
      },
    });
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 1, { code: "RATE_LIMIT", message: "x" }));
    (agent.session.evs ?? []).push({ type: TURN_START_EVENT, seq: 5, time: 1, data: { turn: 2 } });
    ctx.tick();
    assert.equal(agent.followupCalls.length, 0);
  });

  it("否决不进冷却：下一次失败仍可调度", () => {
    const agent = makeAgent("s1", "tokenrouter");
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 1, { code: "RATE_LIMIT", message: "x" }));
    agent.status = "running";
    ctx.tick();
    agent.status = "idle";
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 1, { code: "RATE_LIMIT", message: "x" }));
    // 第二次被接受（新定时器）
    assert.equal(ctx.timers.length, 2);
  });
});

describe("remote 读面的业务结果", () => {
  let ctx: MockCtx;
  beforeEach(() => {
    ctx = createMockCtx();
    applyPlugin(ctx);
  });

  it("state：返回调度与开关状态", () => {
    const agent = makeAgent("s1", "tokenrouter");
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 3, { code: "RATE_LIMIT", message: "x" }));
    const body = remoteOf(ctx).state();
    const session = body.sessions["s1"] as {
      pending: { turn: number; remainingMs: number } | null;
      disabled: boolean;
    };
    assert.equal(session.pending?.turn, 3);
    assert.equal(typeof session.pending.remainingMs, "number");
    assert.equal(session.disabled, false);
  });

  it("cancel：取消待办并释放定时器", () => {
    const agent = makeAgent("s1", "tokenrouter");
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 3, { code: "RATE_LIMIT", message: "x" }));
    assert.deepEqual(remoteOf(ctx).cancel({ sessionId: "s1" }), {
      ok: true,
      cancelled: true,
      turn: 3,
    });
    assert.equal(ctx.timers[0]?.cancelled, true);
    ctx.tick();
    assert.equal(agent.followupCalls.length, 0);
  });

  it("cancel 缺 sessionId → 400", () => {
    assert.equal(remoteOf(ctx).cancel({ sessionId: "" })["status"], 400);
  });

  it("toggle：翻转会话开关；关闭时同时解除待办", () => {
    const agent = makeAgent("s1", "tokenrouter");
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 3, { code: "RATE_LIMIT", message: "x" }));
    assert.deepEqual(remoteOf(ctx).toggle({ sessionId: "s1" }), { ok: true, disabled: true });
    // 关闭即解除待办
    assert.equal(ctx.timers[0]?.cancelled, true);
    const disabledState = remoteOf(ctx).state();
    assert.equal((disabledState.sessions["s1"] as { disabled: boolean }).disabled, true);
    assert.deepEqual(remoteOf(ctx).toggle({ sessionId: "s1" }), { ok: true, disabled: false });
    const st = remoteOf(ctx).state();
    assert.equal((st.sessions["s1"] as { disabled: boolean }).disabled, false);
  });
});

describe("生命周期", () => {
  it("effect 清理时释放所有待办定时器", () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    const agent = makeAgent("s1", "tokenrouter");
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 1, { code: "RATE_LIMIT", message: "x" }));
    ctx.disposeEffects();
    assert.equal(ctx.timers[0]?.cancelled, true);
  });
});

describe("连接感知（connection/reset 恢复挂起的续跑，0.1.2-alpha.2）", () => {
  it("无挂起待办时 resume 返回 restored=0", () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    assert.deepEqual(remoteOf(ctx).resume(), { ok: true, restored: 0 });
  });

  it("fire 发送抛错时挂起待办；调用 resume 后按剩余时间重新武装并补发", () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    const rescueAgent: MockAgent = makeAgent("s1", "tokenrouter");
    // followup 抛错模拟断连发送失败
    rescueAgent.followup = () => {
      throw new Error(CARRIER_DOWN_MESSAGE);
    };
    register(ctx, rescueAgent);
    ctx.fire(AGENT_ERROR_EVENT, payload(rescueAgent, 1, { code: "RATE_LIMIT", message: "x" }));
    assert.equal(ctx.timers.length, 1, "scheduled one timer");
    // 触发定时器 → followup 抛错 → 挂起进 suspendedSnapshots
    ctx.timers[0]!.fn();
    assert.equal(rescueAgent.followupCalls.length, 0, "no message sent on carrier-down");
    // 恢复：改为不抛错的 followup，再调 resume → 重新武装 → 触发 → 补发成功
    rescueAgent.followup = (message) => {
      rescueAgent.followupCalls.push(message);
    };
    assert.deepEqual(remoteOf(ctx).resume(), { ok: true, restored: 1 });
    assert.equal(ctx.timers.length, 2, "re-armed agent timer after reconnect");
    ctx.timers[1]!.fn();
    assert.equal(rescueAgent.followupCalls.length, 1, "auto-resume message sent after reconnect");
  });
});

function suspendCtx(): { ctx: MockCtx; agent: MockAgent } {
  const ctx = createMockCtx();
  applyPlugin(ctx);
  const agent = makeAgent("s1", "tokenrouter");
  agent.followup = () => {
    throw new Error(CARRIER_DOWN_MESSAGE);
  };
  register(ctx, agent);
  ctx.fire(AGENT_ERROR_EVENT, payload(agent, 1, { code: "RATE_LIMIT", message: "x" }));
  // fire → followup 抛错 → 挂起
  ctx.timers[0]!.fn();
  return { ctx, agent };
}

describe("挂起快照生命周期（可见/可取消/开关闸门/上限，审查修正）", () => {
  it("挂起后 state 可见 suspended 待办（可取消横幅的数据源）", () => {
    const { ctx } = suspendCtx();
    const st = remoteOf(ctx).state();
    const { pending } = st.sessions["s1"] as { pending: Record<string, unknown> };
    assert.equal(pending["suspended"], true);
    assert.equal(pending["kind"], "resume");
    assert.equal(pending["turn"], 1);
    assert.equal(typeof pending["remainingMs"], "number");
  });

  it("取消挂起待办：resume 不再恢复（restored=0，无新定时器，不补发）", () => {
    const { ctx, agent } = suspendCtx();
    assert.deepEqual(remoteOf(ctx).cancel({ sessionId: "s1" }), {
      ok: true,
      cancelled: true,
      turn: 1,
    });
    assert.deepEqual(remoteOf(ctx).resume(), { ok: true, restored: 0 });
    assert.equal(ctx.timers.length, 1, "no re-armed timer after cancel");
    assert.equal(agent.followupCalls.length, 0);
  });

  it("toggle 关闭清除挂起待办：resume 恢复数为 0", () => {
    const { ctx } = suspendCtx();
    remoteOf(ctx).toggle({ sessionId: "s1" });
    assert.deepEqual(remoteOf(ctx).resume(), { ok: true, restored: 0 });
    assert.equal(ctx.timers.length, 1, "no re-armed timer after toggle-off");
  });

  it("恢复受全局 enabled 闸门：插件关闭后 resume 丢弃挂起待办", () => {
    const { ctx } = suspendCtx();
    ctx.scope.set({ enabled: false });
    const res = remoteOf(ctx).resume();
    // restored 读的是挂起时快照数（1），但快照被丢弃：无新定时器、state 不再显示
    assert.equal(res.restored, 1);
    assert.equal(ctx.timers.length, 1, "suspended snapshot dropped, not re-armed");
    const st = remoteOf(ctx).state();
    const { pending } = st.sessions["s1"] as { pending: Record<string, unknown> | null };
    assert.equal(pending?.["suspended"], undefined);
  });

  it("挂起快照上限裁剪：超过 MAX_SUSPENDED 时淘汰最旧", () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    for (let i = 0; i < 65; i += 1) {
      const agent = makeAgent(`s${String(i).padStart(3, "0")}`, "tokenrouter");
      agent.followup = () => {
        throw new Error(CARRIER_DOWN_MESSAGE);
      };
      register(ctx, agent);
      ctx.fire(AGENT_ERROR_EVENT, payload(agent, 1, { code: "RATE_LIMIT", message: "x" }));
      ctx.timers.at(-1)!.fn();
    }
    const st = remoteOf(ctx).state();
    let suspended = 0;
    for (const rec of Object.values(st.sessions)) {
      const { pending } = rec as { pending: { suspended?: boolean } | null };
      if (pending?.suspended === true) {
        suspended += 1;
      }
    }
    assert.equal(suspended, 64);
    const oldest = (st.sessions["s000"] as { pending: Record<string, unknown> | null }).pending;
    assert.equal(oldest?.["suspended"], undefined, "oldest snapshot evicted");
    const newest = (st.sessions["s064"] as { pending: Record<string, unknown> | null }).pending;
    assert.equal(newest?.["suspended"], true);
  });
});

describe("completed 回合：todo 未闭合自动补跑（unfinished）", () => {
  let ctx: MockCtx;
  beforeEach(() => {
    ctx = createMockCtx();
    ctx.scope.set({ unfinishedDelayMs: 5000, unfinishedCooldownMs: 60_000, maxUnfinished: 2 });
    applyPlugin(ctx);
  });

  function agentWith(turn: number, kind: string, todos: unknown): MockAgent {
    const agent = makeAgent("s1", "tokenrouter", {
      session: { id: "s1", snapshotEvents: () => turnWithTodos(turn, kind, todos) },
    });
    register(ctx, agent);
    return agent;
  }
  const OPEN = [
    { content: "a", status: "completed" },
    { content: "b", status: "in_progress" },
  ];
  const ALL_DONE = [{ content: "a", status: "completed" }];

  it("completed + 本回合清单含未完成 → 调度 unfinished 并发出补跑文案", () => {
    const agent = agentWith(7, "completed", OPEN);
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 1);
    assert.equal(ctx.timers[0]?.ms, 5000);
    ctx.tick();
    assert.equal(agent.followupCalls.length, 1);
    const msg = agent.followupCalls[0] as { content: { text: string }[] };
    assert.match(msg.content[0]?.text ?? "", /未完成|待办/u);
  });

  it("开关关闭时不补跑（默认行为可关）", () => {
    ctx.scope.set({ resumeOnOpenTodos: false });
    const agent = agentWith(7, "completed", OPEN);
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 0);
  });

  it("清单全完成 → 不补跑", () => {
    const agent = agentWith(7, "completed", ALL_DONE);
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 0);
  });

  it("无 todo/write → 不补跑（无从判断）", () => {
    const agent = makeAgent("s1", "tokenrouter", {
      session: {
        id: "s1",
        snapshotEvents: () => [
          { type: "turn/end", seq: 1, time: 1, data: { turn: 7, reason: { kind: "completed" } } },
        ],
      },
    });
    register(ctx, agent);
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 0);
  });

  it("清单是更早回合写的（陈旧）→ 不补跑", () => {
    const agent = makeAgent("s1", "tokenrouter", {
      session: {
        id: "s1",
        snapshotEvents: () => [
          { type: TURN_START_EVENT, seq: 0, time: 0, data: { turn: 6 } },
          evTodo(OPEN),
          { type: "turn/end", seq: 1, time: 1, data: { turn: 6, reason: { kind: "completed" } } },
          { type: TURN_START_EVENT, seq: 2, time: 2, data: { turn: 7 } },
          evCall(7, "c1", "bash"),
          evResult(7, "c1"),
          { type: "turn/end", seq: 3, time: 3, data: { turn: 7, reason: { kind: "completed" } } },
        ],
      },
    });
    register(ctx, agent);
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 0);
  });

  it("最后回合调用过 ask_user_question → 抑制（模型在等用户）", () => {
    const agent = makeAgent("s1", "tokenrouter", {
      session: {
        id: "s1",
        snapshotEvents: () => [
          { type: TURN_START_EVENT, seq: 0, time: 0, data: { turn: 7 } },
          evTodo(OPEN),
          evCall(7, "c1", "ask_user_question"),
          evResult(7, "c1"),
          { type: "turn/end", seq: 4, time: 4, data: { turn: 7, reason: { kind: "completed" } } },
        ],
      },
    });
    register(ctx, agent);
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 0);
  });

  it("goal 驱动的回合：排期照排，读不到停机位则在触发侧让路", () => {
    const agent = makeAgent("s1", "tokenrouter", {
      session: {
        id: "s1",
        snapshotEvents: () => [
          { type: TURN_START_EVENT, seq: 0, time: 0, data: { turn: 7 } },
          {
            type: USER_MESSAGE_EVENT,
            seq: 1,
            time: 1,
            data: {
              role: "user",
              content: [],
              source: { kind: "goal", goalId: "g1", revision: 1, round: 2 },
            },
          },
          evTodo(OPEN),
          { type: "turn/end", seq: 4, time: 4, data: { turn: 7, reason: { kind: "completed" } } },
        ],
      },
    });
    register(ctx, agent);
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    // 让路判据在触发侧（round driver 的 disarm 就发生在它自己的 agent/error 监听里，
    // 跨插件的监听先后不是契约）：这里 goals 服务不在位 ⇒ 证不了它停 ⇒ 不注入。
    assert.equal(ctx.timers.length, 1, "goal 轮也排期：不排期就没法在停机后接管");
    ctx.tick();
    assert.equal(agent.followupCalls.length, 0, "读不到停机位 ⇒ 维持让路");
  });

  it("schedule 驱动的回合 → 抑制（交官方定时任务，不双重注入）", () => {
    const agent = makeAgent("s-sched", "tokenrouter", {
      session: {
        id: "s-sched",
        snapshotEvents: () => [
          { type: TURN_START_EVENT, seq: 0, time: 0, data: { turn: 7 } },
          {
            type: USER_MESSAGE_EVENT,
            seq: 1,
            time: 1,
            data: { role: "user", content: [], source: { kind: "schedule" } },
          },
          evTodo(OPEN),
          { type: "turn/end", seq: 4, time: 4, data: { turn: 7, reason: { kind: "completed" } } },
        ],
      },
    });
    register(ctx, agent);
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 0, "Schedule 开的回合不该触发 auto-unfinished");
  });

  it("schedule 驱动且以 max-tokens 收尾的回合 → 也不触发 auto-continue", () => {
    const agent = makeAgent("s-sched-cont", "tokenrouter", {
      session: {
        id: "s-sched-cont",
        snapshotEvents: () => [
          { type: TURN_START_EVENT, seq: 0, time: 0, data: { turn: 4 } },
          {
            type: USER_MESSAGE_EVENT,
            seq: 1,
            time: 1,
            data: { role: "user", content: [], source: { kind: "schedule" } },
          },
          {
            type: "turn/end",
            seq: 4,
            time: 4,
            data: { turn: 4, reason: { kind: MAX_TOKENS_REASON } },
          },
        ],
      },
    });
    register(ctx, agent);
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 0, "Schedule 开的回合不该触发 auto-continue");
  });

  it("非 completed（error/aborted/max-tokens）→ 不走 unfinished 路径", () => {
    for (const kind of ["error", "aborted", MAX_TOKENS_REASON]) {
      const localCtx = createMockCtx();
      localCtx.scope.set({
        unfinishedDelayMs: 5000,
        unfinishedCooldownMs: 60_000,
        maxUnfinished: 2,
      });
      applyPlugin(localCtx);
      const agent = makeAgent("s1", "tokenrouter", {
        session: { id: "s1", snapshotEvents: () => turnWithTodos(7, kind, OPEN) },
      });
      register(localCtx, agent);
      localCtx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
      // max-tokens 走 continue 路径（1 个定时器，ms=continueDelayMs）；其它为 0
      const expected = kind === MAX_TOKENS_REASON ? 3000 : 0;
      assert.equal(localCtx.timers[0]?.ms ?? 0, expected, kind);
    }
  });

  it("enabled=false → 一律不补跑", () => {
    ctx.scope.set({ enabled: false });
    const agent = agentWith(7, "completed", OPEN);
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 0);
  });

  it("每会话开关关闭 → 不补跑", () => {
    const agent = agentWith(7, "completed", OPEN);
    remoteOf(ctx).resume();
    remoteOf(ctx).toggle({ sessionId: "s1" });
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 0);
  });

  it("补跑上限用尽后静默；清单闭合后配额恢复", () => {
    // 冷却置 0：本例只验次数闸门，不让真实时钟下的冷却干扰。
    ctx.scope.set({ unfinishedCooldownMs: 0 });
    const agent = makeAgent("s1", "tokenrouter", {
      session: { id: "s1", snapshotEvents: () => [] },
    });
    register(ctx, agent);
    const closedTurn = (turn: number, todos: unknown): void => {
      const ev = agent.session.evs ?? [];
      ev.length = 0;
      ev.push(
        { type: TURN_START_EVENT, seq: 1, time: 1, data: { turn } },
        { type: "todo/write", seq: 2, time: 2, data: { todos } },
        { type: "turn/end", seq: 3, time: 3, data: { turn, reason: { kind: "completed" } } },
      );
    };
    closedTurn(10, OPEN);
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 1, "第 1 次应调度");
    ctx.tick();
    closedTurn(11, OPEN);
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 2, "第 2 次应调度");
    ctx.tick();
    closedTurn(12, OPEN);
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 2, "第 3 次应被 maxUnfinished 拦住");
    // 清单闭合 → unfinished 配额恢复
    closedTurn(13, ALL_DONE);
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 2, "清单闭合不该补跑");
    closedTurn(14, OPEN);
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 3, "闭合恢复配额后应可再补跑");
  });

  it("state 的 pending 携带 kind=unfinished", () => {
    const agent = agentWith(7, "completed", OPEN);
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    const st = remoteOf(ctx).state();
    const { pending } = st.sessions["s1"] as { pending: { kind: string } | null };
    assert.equal(pending?.kind, "unfinished");
  });

  it("同一 idle 事件重复触发不产生两个待办（单待办不变量）", () => {
    const agent = agentWith(7, "completed", OPEN);
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 1);
  });
});

describe("completed 回合重置失败配额（A：长跑会话不得用完即哑）", () => {
  let ctx: MockCtx;
  beforeEach(() => {
    ctx = createMockCtx();
    applyPlugin(ctx);
  });

  it("瞬时失败 fire 满额后，一次 completed 回合即恢复续跑能力", async () => {
    // 冷却置 0：本例验的是"次数上限 + 成功重置"，冷却会掩盖次数闸门。
    ctx.scope.set({ resumeCooldownMs: 0 });
    const agent = makeAgent("s1", "tokenrouter", {
      session: { id: "s1", snapshotEvents: () => [] },
    });
    register(ctx, agent);
    // 打满 3 次 resume（每次 fire 后推进回合，避开 newer-turn 否决）
    for (let i = 1; i <= 3; i += 1) {
      replaceAllEvents(agent, evTurnEnd(i, "error"));
      ctx.fire(AGENT_ERROR_EVENT, {
        agent,
        turn: i,
        step: 1,
        error: { failure: { code: "RATE_LIMIT", message: "429" } },
      });
      ctx.tick();
    }
    assert.equal(ctx.timers.length, 3, "前置：应已 fire 满 3 次");
    // 第 4 次瞬时失败：修复前会被 max-resumes 静默拦掉
    replaceAllEvents(agent, evTurnEnd(4, "error"));
    ctx.fire(AGENT_ERROR_EVENT, {
      agent,
      turn: 4,
      step: 1,
      error: { failure: { code: "RATE_LIMIT", message: "429" } },
    });
    assert.equal(ctx.timers.length, 3, "满额后应无新定时器");
    // 一次成功回合 → 配额恢复
    replaceAllEvents(agent, evTurnEnd(5, "completed"));
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    replaceAllEvents(agent, evTurnEnd(6, "error"));
    ctx.fire(AGENT_ERROR_EVENT, {
      agent,
      turn: 6,
      step: 1,
      error: { failure: { code: "RATE_LIMIT", message: "429" } },
    });
    assert.equal(ctx.timers.length, 4, "成功回合后应能继续自动续跑");
  });
});

// ── 模型线路来源（计划四行矩阵）─────────────────────────────────────────
// 排期读会话活线（current()），失败归因与 pass 兑换读「本次失败请求的实际线路」
// （agent/request-error 的 provider）。两侧分开，才不会被旧 options 或下一步待选吞掉。
describe("模型线路来源：排期、归因与 pass 各用各的来源", () => {
  let ctx: MockCtx;
  const lessons: Record<string, unknown>[] = [];
  const passes: Record<string, unknown>[] = [];
  beforeEach(() => {
    ctx = createMockCtx();
    lessons.length = 0;
    passes.length = 0;
    ctx.setService("lessonLoop", {
      report: (input: Record<string, unknown>): void => {
        lessons.push(input);
      },
      pass: (input: Record<string, unknown>): { ok: boolean } => {
        passes.push(input);
        return { ok: true };
      },
    });
    applyPlugin(ctx);
  });

  /** 记一次「某条线路的请求失败了」：窗口内只有这条事件带得出实际线路。 */
  async function failRequest(agent: MockAgent, provider: string): Promise<void> {
    const handler = ctx.handlers["agent/request-error"] as unknown as (
      payload: unknown,
      next: () => Promise<unknown>,
    ) => Promise<unknown>;
    assert.ok(typeof handler === "function", "agent/request-error 监听器已注册");
    await handler(
      {
        agent,
        turn: 1,
        step: 1,
        provider,
        failure: { code: "CONTEXT_WINDOW_EXCEEDED", message: "too long" },
        retryPolicy: undefined,
        signal: undefined,
      },
      nextNoop,
    );
  }

  it("行1：options=A、活线 B 在排除表、请求 A 失败 → 排期按 B 阻断，归因仍是 A", async () => {
    ctx.scope.set({ providerExcludes: [EXCLUDED_PROVIDER], resumeDelayMs: 7000 });
    const agent = makeAgent("mx1", "tokenrouter");
    Object.assign(agent, { model: { current: () => ({ provider: EXCLUDED_PROVIDER }) } });
    register(ctx, agent);
    await failRequest(agent, "tokenrouter");
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 1, { code: "RATE_LIMIT", message: "x" }));
    assert.equal(ctx.timers.length, 1, "A 不在排除表，先按瞬时失败武装");
    ctx.tick();
    assert.equal(agent.followupCalls.length, 0, "到点读活线 B，它在排除表");
    assert.equal(lessons.length, 1);
    assert.match(String(lessons[0]?.["signature"]), /^tokenrouter\b/u, "失败归因是请求实际走的 A");
  });

  it("行2：options=A 在排除表、活线 B 不在、请求 B 失败 → 不被旧 options 阻断", async () => {
    ctx.scope.set({ providerExcludes: [EXCLUDED_PROVIDER], resumeDelayMs: 7000 });
    const agent = makeAgent("mx2", EXCLUDED_PROVIDER);
    Object.assign(agent, { model: { current: () => ({ provider: "tokenrouter" }) } });
    register(ctx, agent);
    await failRequest(agent, "tokenrouter");
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 1, { code: "RATE_LIMIT", message: "x" }));
    assert.equal(ctx.timers.length, 1, "归因按请求线路 B 判，不因旧 options 的 A 吞掉");
    ctx.tick();
    assert.equal(agent.followupCalls.length, 1, "B 不在排除表，照常续跑");
    assert.match(String(lessons[0]?.["signature"]), /^tokenrouter\b/u);
  });

  it("行3：失败记在 B、活线已是待选 C → 成功只兑 B 的记录", async () => {
    ctx.scope.set({ resumeDelayMs: 7000 });
    const agent = makeAgent("mx3", "alpha");
    Object.assign(agent, { model: { current: () => ({ provider: "pending-c" }) } });
    register(ctx, agent);
    await failRequest(agent, "beta");
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 1, { code: "RATE_LIMIT", message: "x" }));
    assert.equal(lessons.length, 1);
    replaceAllEvents(agent, evTurnEnd(2, "completed"));
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(passes.length, 1, "成功回合兑一条 pass");
    assert.match(String(passes[0]?.["signature"]), /^beta\b/u, "兑的是失败请求 B，不是待选 C");
  });

  it("行4：请求 B 正在重试 → 重试只按捕获的 B，不读活线选择", async () => {
    const agent = makeAgent("mx4", "alpha");
    let reads = 0;
    Object.assign(agent, {
      model: {
        current: () => {
          reads += 1;
          return { provider: "switched" };
        },
      },
    });
    register(ctx, agent);
    const handler = ctx.handlers["agent/request-error"] as unknown as (
      payload: unknown,
      next: () => Promise<unknown>,
    ) => Promise<unknown>;
    const action = handler(
      {
        agent,
        turn: 1,
        step: 1,
        provider: "beta",
        failure: { code: "QUOTA", message: QUOTA_EXCEEDED_FULL_TEXT, status: 429 },
        retryPolicy: undefined,
        signal: undefined,
      },
      nextNoop,
    );
    ctx.tick();
    assert.deepEqual(await action, { kind: "retry" });
    assert.equal(reads, 0, "重试途中不读活线，没有换到新选择的窗口");
  });
});

describe("max-tokens 自动继续（agent/status→idle 检测）", () => {
  let ctx: MockCtx;
  beforeEach(() => {
    ctx = createMockCtx();
    applyPlugin(ctx);
  });

  function turnEndAgent(turn: number, kind: string): MockAgent {
    const agent = makeAgent("s1", "tokenrouter", {
      session: {
        id: "s1",
        snapshotEvents: () => [
          { type: "turn/end", seq: 10, time: 0, data: { turn, reason: { kind } } },
        ],
      },
    });
    register(ctx, agent);
    return agent;
  }

  it("最后回合 max-tokens → 调度 continue", () => {
    const agent = turnEndAgent(5, MAX_TOKENS_REASON);
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 1);
    // continueDelayMs 默认 3000
    assert.equal(ctx.timers[0]?.ms, 3000);
  });

  it("最后回合完成 → 不调度", () => {
    const agent = turnEndAgent(5, "completed");
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 0);
  });

  it("最后回合 error → 不调度（瞬时失败走 agent/error 路径）", () => {
    const agent = turnEndAgent(5, "error");
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 0);
  });

  it("running 状态不触发；idle 触发后发送 CONTINUE_TEXT", () => {
    const agent = turnEndAgent(5, MAX_TOKENS_REASON);
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "running" });
    assert.equal(ctx.timers.length, 0);
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 1);
    ctx.tick();
    assert.equal(agent.followupCalls.length, 1);
    const msg = agent.followupCalls[0] as { content: { text: string }[] };
    assert.ok(msg.content[0]?.text.startsWith("请从截断处继续输出") === true);
  });

  it("state 的 pending 携带 kind=continue", () => {
    const agent = turnEndAgent(5, MAX_TOKENS_REASON);
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    const st = remoteOf(ctx).state();
    const { pending } = st.sessions["s1"] as { pending: { kind: string } | null };
    assert.equal(pending?.kind, "continue");
  });

  it("enabled=false 时不调度", () => {
    ctx.scope.set({ enabled: false });
    const agent = turnEndAgent(5, MAX_TOKENS_REASON);
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 0);
  });
});

// ── agent/request-error：请求级 429 自动重试（口径：
//    所有平台 429 限流都要自动重试、不打断模型运行；waterfall 返回
//    {kind:'retry'} 触发同回合重发，与 agent/error 回合级续跑互补） ──
const quotaEvt = (agentId: string): Record<string, unknown> => ({
  agent: makeAgent(agentId, "sensenova"),
  turn: 1,
  step: 1,
  provider: "sensenova",
  failure: { code: "QUOTA", message: QUOTA_EXCEEDED_TEXT },
  retryPolicy: undefined,
  signal: undefined,
});

describe("agent/request-error 请求级 429 重试", () => {
  let ctx: MockCtx;
  beforeEach(() => {
    ctx = createMockCtx();
    applyPlugin(ctx);
  });

  type REListener = (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>;
  const retryAction = { kind: "retry" } as const;

  /** 取 request-error 监听器（waterfall 形态：payload+next → Promise<action>）。 */
  function reListener(box: MockCtx): REListener {
    const handler = box.handlers["agent/request-error"] as unknown as REListener;
    assert.ok(typeof handler === "function", "agent/request-error 监听器已注册");
    return handler;
  }

  /** 触发一次 request-error 并推进退避定时器（mock 时钟）后取 action。
   *  监听器同步注册退避 timer（Promise executor 同步执行），tick 后 await。 */
  async function fire(evt: unknown): Promise<unknown> {
    const result = reListener(ctx)(evt, nextNoop);
    ctx.tick();
    return result;
  }

  /** 顺序触发 n 次 request-error：每次都要等上一次结算完（退避名额只在
   *  「真的重发」时才占用，先 ++ 再判 abort 会白烧一次配额）。写成递归而非 for+await，避开
   *  no-await-in-loop。 */
  async function fireSequence(box: MockCtx, evt: unknown, times: number): Promise<unknown[]> {
    const listener = box.handlers["agent/request-error"] as unknown as (
      payload: unknown,
      next: () => Promise<unknown>,
    ) => Promise<unknown>;
    const out: unknown[] = [];
    const step = async (remaining: number): Promise<void> => {
      if (remaining === 0) {
        return;
      }
      const result = listener(evt, nextNoop);
      box.tick();
      out.push(await result);
      return step(remaining - 1);
    };
    await step(times);
    return out;
  }

  it('429 failure → 返回 {kind:"retry"}（触发同回合自动重发，不打断模型）', async () => {
    const agent = makeAgent("re1", "sensenova");
    const act = await fire({
      agent,
      turn: 1,
      step: 1,
      provider: "sensenova",
      failure: {
        code: "QUOTA",
        message: QUOTA_EXCEEDED_FULL_TEXT,
        status: 429,
      },
      retryPolicy: undefined,
      signal: undefined,
    });
    assert.deepEqual(act, retryAction);
  });

  it("宿主已解析出 retryPolicy → 委托 next()，本包阶梯不参与（官方 llm-retry 优先）", async () => {
    // 两条链共用同一个 waterfall，先返回 {kind:'retry'} 的赢。不让位就等于把官方那套
    // （retryableCodes / providerRetryAfterMs / 抖动 / 持久化 llm/retry 事件）整体顶掉。
    const agent = makeAgent("re-policy", "sensenova");
    let delegated = false;
    const act = await reListener(ctx)(
      {
        agent,
        turn: 1,
        step: 1,
        provider: "sensenova",
        failure: { code: "QUOTA", message: QUOTA_EXCEEDED_FULL_TEXT, status: 429 },
        retryPolicy: {
          mode: "normal",
          maxRetries: 12,
          retryableCodes: ["QUOTA"],
          backoff: { initialDelayMs: 8000, maxDelayMs: 60_000, jitterRatio: 0.2 },
        },
        signal: undefined,
      },
      async () => {
        delegated = true;
        // 下游的终结结论：undefined = 不重试。
      },
    );
    assert.equal(delegated, true, "有 retryPolicy 时必须让位给下游");
    assert.equal(act, undefined, "本包不返回 retry 决策");
  });

  it("文本含 429 / rate limit / quota 且无 status 字段（pi-ai 丢 status 形态）→ retry", async () => {
    const agent = makeAgent("re2", "sensenova");
    const act1 = await fire({
      agent,
      turn: 1,
      step: 1,
      provider: "sensenova",
      failure: {
        code: "QUOTA",
        message: QUOTA_EXCEEDED_FULL_TEXT,
      },
      retryPolicy: undefined,
      signal: undefined,
    });
    assert.deepEqual(act1, retryAction, "quota 文本无 status 也要重试");
    const act2 = await fire({
      agent,
      turn: 1,
      step: 1,
      provider: "x",
      failure: {
        code: "RATE_LIMITED",
        message: "You've reached your weekly usage limit for your plan.",
      },
      retryPolicy: undefined,
      signal: undefined,
    });
    assert.deepEqual(act2, retryAction, "rate/usage limit 文本也要重试");
  });

  it("非 429（如认证/上下文超长）→ 委托 next，不重试", async () => {
    const agent = makeAgent("re3", "sensenova");
    let nextCalled = 0;
    const next = async (): Promise<undefined> => {
      nextCalled += 1;
    };
    const act = await (async () => {
      const result = reListener(ctx)(
        {
          agent,
          turn: 1,
          step: 1,
          provider: "sensenova",
          failure: { code: "AUTH", message: "unauthorized" },
          retryPolicy: undefined,
          signal: undefined,
        },
        next,
      );
      ctx.tick();
      return result;
    })();
    assert.equal(act, undefined, "非 429 返回 undefined");
    assert.equal(nextCalled, 1, "调用 next 委托下游");
  });

  it("同回合重试次数超上限（默认 5）→ 委托 next，不无限重发", async () => {
    const acts = await fireSequence(ctx, quotaEvt("re4"), 5);
    for (const [index, act] of acts.entries()) {
      assert.deepEqual(act, retryAction, `第 ${index + 1} 次仍重试`);
    }
    // 第 6 次：超过上限，委托 next（并把计数清空）
    const act6 = await fireSequence(ctx, quotaEvt("re4"), 1);
    assert.equal(act6[0], undefined, "超上限不再重试");
  });

  it("回合收口（status→idle）重置请求级重试计数：零星 429 不跨回合累加到永久失效", async () => {
    // 同一 agent 实例（计数键是 session.id）贯穿全程，才能验到"跨回合累加"。
    const agent = makeAgent("re-reset", "sensenova");
    const evt: Record<string, unknown> = { ...quotaEvt("re-reset"), agent };
    const useAgent = (): Record<string, unknown> => evt;
    const round1 = await fireSequence(ctx, useAgent(), 4);
    for (const [index, act] of round1.entries()) {
      assert.deepEqual(act, retryAction, `回合1第${index + 1}次重试`);
    }
    // 回合收口 → idle：重置该会话计数（旧实现从不重置 → 累加到 5 后第 6 次永久放行给 llm-retry）
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    const round2 = await fireSequence(ctx, useAgent(), 5);
    for (const [index, act] of round2.entries()) {
      assert.deepEqual(act, retryAction, `回合2第${index + 1}次仍重试（计数已重置）`);
    }
    const round3 = await fireSequence(ctx, useAgent(), 1);
    assert.equal(round3[0], undefined, "回合2第6次超上限委托 next");
  });

  it("退避：按尝试序取固定阶梯（2s/5s/10s/20s/30s），sleep 走宿主 timer（退避修复）", async () => {
    const agent = makeAgent("re-backoff", "sensenova");
    const listener = reListener(ctx);
    const delays: (number | undefined)[] = [];
    const results: unknown[] = [];
    const step = async (remaining: number): Promise<void> => {
      if (remaining === 0) {
        return;
      }
      const before = ctx.timers.length;
      const result = listener(
        {
          agent,
          turn: 1,
          step: 1,
          provider: "sensenova",
          failure: { code: "QUOTA", message: QUOTA_EXCEEDED_TEXT },
          retryPolicy: undefined,
          signal: undefined,
        },
        nextNoop,
      );
      // 本轮恰注册一个退避 timer；记录其延迟再放行
      assert.equal(ctx.timers.length, before + 1, `第 ${5 - remaining + 1} 次重试注册了退避 timer`);
      delays.push(ctx.timers[before]?.ms);
      const entry = ctx.timers[before];
      assert.ok(entry);
      entry.fired = true;
      entry.fn();
      results.push(await result);
      return step(remaining - 1);
    };
    await step(5);
    for (const [index, act] of results.entries()) {
      assert.deepEqual(act, retryAction, `第 ${index + 1} 次退避后放行`);
    }
    assert.deepEqual(delays, [2000, 5000, 10_000, 20_000, 30_000], "阶梯逐级拉长且封顶 30s");
  });

  it("退避等待中 signal 已中止 → 委托 next() 终结，不重发", async () => {
    const agent = makeAgent("re-abort", "sensenova");
    let nextCalled = 0;
    const next = async (): Promise<undefined> => {
      nextCalled += 1;
    };
    const controller = new AbortController();
    controller.abort();
    const result = reListener(ctx)(
      {
        agent,
        turn: 1,
        step: 1,
        provider: "sensenova",
        failure: { code: "QUOTA", message: QUOTA_EXCEEDED_TEXT },
        retryPolicy: undefined,
        signal: controller.signal,
      },
      next,
    );
    ctx.tick();
    assert.equal(await result, undefined, "已中止不返回 retry");
    assert.equal(nextCalled, 1, "委托 next");
  });

  it("enabled=false 时不重试，委托 next", async () => {
    ctx.scope.set({ enabled: false });
    const agent = makeAgent("re5", "sensenova");
    let nextCalled = 0;
    const next = async (): Promise<undefined> => {
      nextCalled += 1;
    };
    const act = await (async () => {
      const result = reListener(ctx)(
        {
          agent,
          turn: 1,
          step: 1,
          provider: "sensenova",
          failure: { code: "QUOTA", message: QUOTA_EXCEEDED_TEXT, status: 429 },
          retryPolicy: undefined,
          signal: undefined,
        },
        next,
      );
      ctx.tick();
      return result;
    })();
    assert.equal(act, undefined, "disabled 委托");
    assert.equal(nextCalled, 1);
  });
});

// ── 429 重试策略配置通道（llm-pi-ai retryPolicy 读面）─────────────────────
describe("retry-providers / retry-policy 读面 - 官方 llm-retry 策略读写", () => {
  let ctx: MockCtx;
  beforeEach(() => {
    ctx = createMockCtx();
    applyPlugin(ctx);
  });

  it("retryProviders：列出 llm-pi-ai providers 与当前策略摘要", () => {
    const body = remoteOf(ctx).retryProviders();
    assert.equal(body["ok"], true);
    const providers = body["providers"] as {
      provider: string;
      mode: string;
      maxRetries: number;
      hasQuota: boolean;
    }[];
    const found = providers.find((prof) => prof.provider === "sensenova");
    assert.ok(found, "sensenova 在列");
    assert.equal(found.mode, "normal");
    assert.equal(found.maxRetries, 12);
    assert.equal(found.hasQuota, true);
  });

  it("retryProviders：settings 服务缺失/不可读 → ok:false 不炸", () => {
    ctx.piAiDescribeValue = undefined;
    const body = remoteOf(ctx).retryProviders();
    assert.equal(body["ok"], false);
    assert.equal(body["status"], 503);
  });

  it("preset=enhanced → mutate set providers.<result>.retryPolicy（含 QUOTA）", async () => {
    const body = await remoteOf(ctx).retryPolicy({ provider: "xkiro", preset: "enhanced" });
    assert.equal(body["ok"], true);
    const [mut] = ctx.mutations;
    assert.ok(mut, "mutate 被调用");
    assert.equal(mut.ns, "llm-pi-ai");
    const op = mut.ops[0] as {
      op: string;
      path: string[];
      value: { mode: string; maxRetries: number; retryableCodes: string[] };
    };
    assert.equal(op.op, "set");
    assert.deepEqual(op.path, ["providers", "xkiro", "retryPolicy"]);
    assert.equal(op.value.mode, "normal");
    assert.equal(op.value.maxRetries, 12);
    assert.ok(
      op.value.retryableCodes.includes("QUOTA"),
      "enhanced 必含 QUOTA（429+quota 归码 QUOTA 的兜底）",
    );
  });

  it("preset=always → mutate set mode:always", async () => {
    await remoteOf(ctx).retryPolicy({ provider: "aihubmix", preset: "always" });
    const op = ctx.mutations[0]?.ops[0] as { value: { mode: string } };
    assert.equal(op.value.mode, "always");
  });

  it("preset=default → mutate unset（回官方默认 5 次码表）", async () => {
    await remoteOf(ctx).retryPolicy({ provider: "tokenrouter", preset: "default" });
    const op = ctx.mutations[0]?.ops[0] as { op: string; path: string[] };
    assert.equal(op.op, "unset");
    assert.deepEqual(op.path, ["providers", "tokenrouter", "retryPolicy"]);
  });

  it("preset=off → maxRetries:0（官方码表不得为空，用零次达成关闭）", async () => {
    await remoteOf(ctx).retryPolicy({ provider: "openrouter", preset: "off" });
    const op = ctx.mutations[0]?.ops[0] as { value: { mode: string; maxRetries: number } };
    assert.equal(op.value.mode, "normal");
    assert.equal(op.value.maxRetries, 0);
  });

  it("未知 preset / 缺 provider / 非对象入参 → 400", async () => {
    const bogus = await remoteOf(ctx).retryPolicy({ provider: "x", preset: "bogus" });
    assert.equal(bogus["status"], 400);
    const missing = await remoteOf(ctx).retryPolicy({ provider: "", preset: "enhanced" });
    assert.equal(missing["status"], 400);
    const nonObject = await remoteOf(ctx).retryPolicy(null as never);
    assert.equal(nonObject["status"], 400);
  });

  it("mutate 抛错（settings 拒绝）→ 500 且错误可见", async () => {
    ctx.mutateImpl = async () => {
      throw new Error("settings-rejected: bogus route");
    };
    const body = await remoteOf(ctx).retryPolicy({ provider: "x", preset: "enhanced" });
    assert.equal(body["status"], 500);
    assert.ok(String(body["error"]).includes("settings-rejected"));
  });

  /** 让 mutate 抛出一个**受控的 unknown 载荷**（宿主/插件抛什么都可能），
   *  读回 500 结果里的 error 串。抛 unknown 而非 any：only-throw-error 允许。 */
  async function errorOfThrown(box: MockCtx, value: unknown): Promise<unknown> {
    box.mutateImpl = async (): Promise<void> => {
      throw value;
    };
    const body = await remoteOf(box).retryPolicy({ provider: "x", preset: "enhanced" });
    assert.equal(body["status"], 500, "写通道失败一律 500");
    return body["error"];
  }

  it("mutate 抛非 Error 载荷 → errorText/stringifyValue 逐类型降级，绝不产出 [object Object]", async () => {
    // 无 message 的对象：走 stringifyValue 的 object 出口（空串），而不是
    // `String({})` 的 "[object Object]"。
    assert.equal(await errorOfThrown(ctx, { message: 42 }), "");
    // null / undefined：空串。
    assert.equal(await errorOfThrown(ctx, null), "");
    assert.equal(await errorOfThrown(ctx, undefined), "");
    // 原始标量：各自的字符串形态。
    assert.equal(await errorOfThrown(ctx, true), "true");
    assert.equal(await errorOfThrown(ctx, 10n), "10");
    assert.equal(await errorOfThrown(ctx, 429), "429");
    assert.equal(await errorOfThrown(ctx, "plain text"), "plain text");
    // 带 message 的对象：原样取 message。
    assert.equal(await errorOfThrown(ctx, { message: "has-message" }), "has-message");
  });

  it("retryProviders：profile 非对象的行直接丢弃，缺字段按官方默认投影", () => {
    ctx.piAiDescribeValue = [
      {
        ns: "llm-pi-ai",
        value: {
          providers: {
            broken: null,
            alsoBroken: "xkiro",
            onlyAlways: { retryPolicy: { mode: "always" } },
          },
        },
      },
    ];
    const body = remoteOf(ctx).retryProviders();
    const providers = body["providers"] as {
      provider: string;
      mode: string;
      maxRetries: number;
      hasQuota: boolean;
    }[];
    assert.deepEqual(
      providers.map((row) => row.provider),
      ["onlyAlways"],
      "非对象 profile 不进列表",
    );
    assert.equal(providers[0]?.mode, "always");
    assert.equal(providers[0].maxRetries, 5, "缺 maxRetries → 官方默认 5");
    assert.equal(providers[0].hasQuota, false, "缺码表 → 无 QUOTA");
  });
});
// ── 行级 config（0.1.7：cordis 按导出 Config schema 校验行 config、填 .default() 后
//    把 volatile 引用交进 apply；旧的「合进 base 再交给 settings.register」那一步没了）──
function firstTimerAfterTransient(ctx: MockCtx): TimerEntry | undefined {
  const agent = makeAgent("s1", "tokenrouter");
  register(ctx, agent);
  ctx.fire(AGENT_ERROR_EVENT, payload(agent, 2, { code: "RATE_LIMIT", message: "x" }));
  return ctx.timers[0];
}

describe("session-rescue 行级 config", () => {
  /** 一次瞬时失败后的调度结果（未调度 = undefined）。 */

  it("行 config 覆盖 schema 默认，且真的走到调度那一步", () => {
    const ctx = createMockCtx();
    applyPlugin(ctx, { resumeDelayMs: 7000 });
    // enabled 没出现在行 config → 仍按 schema 默认 true 注入（未提供字段保持默认）。
    assert.equal(firstTimerAfterTransient(ctx)?.ms, 7000, "行 config 的 resumeDelayMs 生效");
  });

  it("行 config 关掉 enabled → 三类注入一律不调度", () => {
    const ctx = createMockCtx();
    applyPlugin(ctx, { enabled: false });
    assert.equal(firstTimerAfterTransient(ctx), undefined);
    assert.equal(ctx.timers.length, 0);
  });

  it("行 config 显式 undefined 的字段不得掩掉 schema 默认", () => {
    const ctx = createMockCtx();
    applyPlugin(ctx, { resumeDelayMs: undefined, maxUnfinished: undefined });
    assert.equal(firstTimerAfterTransient(ctx)?.ms, 10_000, "显式 undefined → 取默认 10s");
  });
});

// ── agent/disposed 会话状态清理（泄漏审计加固）───────────────────────────
/** request-error 载荷构造器（describe 外的常量：不捕获父作用域，避免 lint 重建）。 */
const retryEvt = (agent: unknown): unknown => ({
  agent,
  turn: 1,
  step: 1,
  provider: "sensenova",
  failure: {
    code: "QUOTA",
    message: QUOTA_EXCEEDED_FULL_TEXT,
    status: 429,
  },
  retryPolicy: undefined,
  signal: undefined,
});

/** 契约急停用例的占位方法：这些面只用于让 isHostCtx 的「对象在但方法缺」形态
 *  成立，急停发生在任何调用之前——抛错体既满足 no-empty-function，也证明
 *  「契约未过就绝不会用到它们」。 */
const unreachableMethod = (): never => {
  throw new Error("宿主契约急停前不得被调用");
};

function coreHost(): Record<string, unknown> {
  return {
    get: unreachableMethod,
    effect: unreachableMethod,
    inject: unreachableMethod,
    on: unreachableMethod,
    fiber: { id: "fiber-under-test" },
    timer: { timeout: unreachableMethod },
    settings: {
      describe: unreachableMethod,
      mutate: unreachableMethod,
      configure: unreachableMethod,
    },
  };
}

describe("宿主契约急停（isHostCtx / hasMethods 点名每个要被调用的方法）", () => {
  const contractError = /host context contract violated/u;
  /** 守卫不过时 apply 绝不会碰第二参（config 只在事件里经 settingsOf 读），
   *  故这里给占位空对象即可——真正被考察的是 ctx 面。 */
  const uncheckedConfig = {} as never;
  /** 除被考察那一面外全部齐备的宿主 ctx：其它项不得替被考察项挡下急停。 */

  it("ctx 不是对象 → 抛错，不在半路上炸", () => {
    assert.throws(() => {
      plugin.apply(null as never, uncheckedConfig);
    }, contractError);
    assert.throws(() => {
      plugin.apply("nope" as never, uncheckedConfig);
    }, contractError);
  });

  it("缺 get/effect/inject/on 任一 → 抛错", () => {
    assert.throws(() => {
      plugin.apply({} as never, uncheckedConfig);
    }, contractError);
    assert.throws(() => {
      plugin.apply(
        {
          get: unreachableMethod,
          effect: unreachableMethod,
          inject: unreachableMethod,
        } as never,
        uncheckedConfig,
      );
    }, contractError);
  });

  it("fiber 缺席/非对象 → 抛错（configure 的 owner 不能是 undefined）", () => {
    assert.throws(() => {
      plugin.apply({ ...coreHost(), fiber: undefined } as never, uncheckedConfig);
    }, contractError);
    assert.throws(() => {
      plugin.apply({ ...coreHost(), fiber: 7 } as never, uncheckedConfig);
    }, contractError);
  });

  it("timer / settings 面不完整（对象在但方法缺、或整个服务面非对象）→ 抛错", () => {
    assert.throws(() => {
      plugin.apply({ ...coreHost(), timer: null } as never, uncheckedConfig);
    }, contractError);
    assert.throws(() => {
      plugin.apply({ ...coreHost(), timer: { timeout: 42 } } as never, uncheckedConfig);
    }, contractError);
    // 0.1.7 的 settings 面只探 describe（跨命名空间读）+ mutate（retry-policy 落盘）：
    // 缺任一即急停，两条各自必须是充分条件。
    assert.throws(() => {
      plugin.apply({ ...coreHost(), settings: {} } as never, uncheckedConfig);
    }, contractError);
    assert.throws(() => {
      plugin.apply(
        { ...coreHost(), settings: { mutate: unreachableMethod } } as never,
        uncheckedConfig,
      );
    }, contractError);
    assert.throws(() => {
      plugin.apply(
        { ...coreHost(), settings: { describe: unreachableMethod } } as never,
        uncheckedConfig,
      );
    }, contractError);
    // ⚠ 反向锁：0.1.7 已移除 settings.register/settings.get —— 真宿主不会再提供它们，
    // 把它们当硬前置会让每一条真宿主都急停（设置面连同三类注入一起静默失效）。
    // 故"只有新面"的 ctx 必须放行。
    const good = createMockCtx();
    assert.doesNotThrow(() => {
      applyPlugin(good);
    });
  });
});

// ── 0.1.7 隐式注册验收：volatileForm(Config) 的字段集 = 设置卡的可编辑字段集 ──
//
// 为什么本包**特别**需要这一条：三类注入的延迟/冷却/配额全从 Config 读，而 0.1.7 的
// 命名空间与可编辑字段都是**从 schema 反推**的——漏写一个 `.volatile()` 不报错，只会
// 让那一项从设置卡上**静默消失**（宿主 describe() 只投影 volatileForm 的结果），用户
// 再也改不到它；全漏则整条被跳过（settings/src/index.ts:308-309）、写入抛
// `has no volatile fields`（:386）= 设置卡直接失效。这类退化在本包其它用例里全绿
// （读侧照用 mock 的活值表），只有拿宿主同一个判据回头看 schema 才拦得住。
//
// ⚠ 它能拦住：字段级 volatile 漏标/多标、字段名漂移、条目 id 与 schema 不同源。
// 它**拦不住**的（仍靠真实宿主启动或人工核对）：profile 里实际装配出来的条目 id
// （本包 cordis.patch.yml 只是它的来源），以及"cordis 真把这份 Config 挂上了 runtime"。
describe("0.1.7 隐式注册验收（volatile 字段投影）", () => {
  /** session-rescue 条目该能编辑的十三项：三类注入各自的开关/延迟/冷却/配额 +
   *  provider 排除表，一项都不该漏（漏一项 = 那项语义在设置卡上永远改不到）。 */
  const EDITABLE = [
    "chainResumeDelayMs",
    "continueCooldownMs",
    "continueDelayMs",
    "enabled",
    "maxContinues",
    "maxResumes",
    "maxUnfinished",
    "providerExcludes",
    "resumeCooldownMs",
    "resumeDelayMs",
    "resumeOnOpenTodos",
    "unfinishedCooldownMs",
    "unfinishedDelayMs",
  ];

  it("volatileForm(Config) 的字段集恰为 session-rescue 条目的十三项可编辑字段", () => {
    const form = volatileFormOf(plugin.Config as unknown as SchemaNode);
    assert.ok(form !== null, "没有任何 volatile 字段 → 宿主 describe() 整条跳过本条目");
    assert.deepEqual(form.toSorted(), EDITABLE, "投影字段集与设置卡预期可编辑项不一致");
  });
});

describe("state 路由：调度器记录被淘汰后挂起快照仍如实可见", () => {
  it("本包 Config 不含 secret 字段 ⇒ 桩件读 raw meta.default 与宿主 plainSchema 同解", () => {
    // 见 test/config-refs.ts 的 secretBearingFields：宿主对 meta.role==="secret"
    // 会抹掉 default/required，本桩件不抹。今天没有这类字段，所以两条路同解。
    assert.deepEqual(secretBearingFields(), []);
  });

  it("会话数超过 MAX_SESSIONS：挂起中的记录不被挤掉，配额随挂起保留", async () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    const kept = makeAgent("kept", "tokenrouter");
    kept.followup = () => {
      throw new Error(CARRIER_DOWN_MESSAGE);
    };
    register(ctx, kept);
    ctx.fire(AGENT_ERROR_EVENT, payload(kept, 4, { code: "RATE_LIMIT", message: "x" }));
    ctx.timers.at(-1)!.fn();
    // 把调度器的会话记录灌满（lib/resume-scheduler.ts MAX_SESSIONS=200）。
    // 挂起中的记录**不参与淘汰**：它欠着一次补发，counts 还是有效的防失控闸门，
    // 被淘汰后由 restorePending 重建会拿到一枚全 0 的新记录（长跑 daemon 上每满
    // 200 个会话就把 maxResumes 复位一次）。被淘汰的应是已 settle 的空闲记录。
    for (let index = 0; index < 200; index += 1) {
      const filler = makeAgent(`filler-${String(index)}`, "tokenrouter");
      register(ctx, filler);
      ctx.fire(AGENT_ERROR_EVENT, payload(filler, 1, { code: "RATE_LIMIT", message: "x" }));
      ctx.tick();
    }
    const st = remoteOf(ctx).state();
    const keptRow = st.sessions["kept"] as {
      count: number;
      lastFireAt: number;
      disabled: boolean;
      pending: { suspended?: boolean; turn?: number; remainingMs?: number } | null;
    };
    assert.ok(
      Object.hasOwn(st.sessions, "kept"),
      "挂起会话仍在 state 里可见（断连窗口里 UI 能看见并可取消）",
    );
    assert.equal(keptRow.pending?.suspended, true);
    assert.equal(keptRow.pending.turn, 4);
    assert.equal(typeof keptRow.pending.remainingMs, "number");
    // 这一发从未真正 fire（followup 抛错才挂起的），所以计数为 0 是**真值**而不是
    // 「记录被淘汰后降级」——两者的可观测差别在下面这两行：挂起中的记录还在表里，
    // 被挤掉的是已 settle 的空闲记录。（配额跨淘汰保留由 test/resume-scheduler.test.ts
    // 「填满台账后恢复挂起待办」那条直接钉。）
    assert.equal(keptRow.count, 0);
    assert.equal(keptRow.lastFireAt, 0);
    assert.equal(keptRow.disabled, false);
    assert.ok(
      Object.hasOwn(st.sessions, "kept"),
      "挂起中的记录不得被淘汰：它欠着一次补发，counts 也是有效的防失控闸门",
    );
    assert.equal(st.sessions["filler-0"], undefined, "被挤掉的是已 settle 的空闲记录");
    assert.equal(
      (st.sessions["filler-199"] as { count: number }).count,
      1,
      "最新那位仍报告真实的 fire 次数",
    );
  });
});

describe("agent/disposed 清理 requestRetryCounts 与 disabledSessions", () => {
  it("会话 dispose 后请求级重试计数清零（重新进入重试而非判耗尽）", async () => {
    const localCtx = createMockCtx();
    applyPlugin(localCtx);
    const agent = makeAgent("dx1", "sensenova");
    const listener = localCtx.handlers["agent/request-error"] as unknown as (
      result: unknown,
      next: () => Promise<unknown>,
    ) => Promise<unknown>;
    const results: unknown[] = [];
    const step = async (remaining: number): Promise<void> => {
      if (remaining === 0) {
        return;
      }
      const result = listener(retryEvt(agent), async () => "NEXT");
      localCtx.tick();
      results.push(await result);
      return step(remaining - 1);
    };
    // 5 次重试（REQUEST_RETRY_MAX），计数逐次累加到 5
    await step(5);
    for (const act of results) {
      assert.deepEqual(act, { kind: "retry" });
    }
    // 第 6 次：计数耗尽 → 委托 next（返回 'NEXT'，不发 retry）
    await step(1);
    assert.equal(results[5], "NEXT");
    // agent/disposed → 计数清零；同会话再次失败回到重试路径（若未清理则仍是耗尽）
    localCtx.handlers["agent/disposed"]?.({ agent });
    await step(1);
    assert.deepEqual(results[6], { kind: "retry" });
  });

  it("会话 dispose 后每会话开关清除（同 id 回到全局默认，可再调度）", async () => {
    const localCtx = createMockCtx();
    applyPlugin(localCtx);
    const agent = makeAgent("dx2", "tokenrouter");
    register(localCtx, agent);
    remoteOf(localCtx).toggle({ sessionId: "dx2" });
    localCtx.fire(AGENT_ERROR_EVENT, payload(agent, 1, { code: "RATE_LIMIT", message: "x" }));
    assert.equal(localCtx.timers.length, 0, "toggle 关闭期间不调度");
    localCtx.handlers["agent/disposed"]?.({ agent });
    localCtx.fire(AGENT_ERROR_EVENT, payload(agent, 1, { code: "RATE_LIMIT", message: "x" }));
    assert.equal(localCtx.timers.length, 1, "dispose 清理开关后同 id 新会话恢复调度");
  });
});

// ── 投影读路径 ───────────────────────────────────────────────────────────────
// 三类判定（agent/status 的回合复盘 / agent/error 的 goal 与链式 opener / 触发前的
// newer-turn veto）此前每次都要全量倒扫会话日志；主路径改走 ctx.sessionProjections 的
// 增量折叠（stateOf 同步水位读）。本块钉四件事：
//   ① 注册表缺席时单元从不注册（= 回退扫描，本文件其余用例正是那条路径的既有断言）；
//   ② 注册表在位时判定只读投影，**一次 snapshotEvents 都不发生**；
//   ③ 判定结果与迁移前逐项相同（同一串事件、同一套断言值）；
//   ④ 投影交出不可采信的状态时确实回退扫描（而不是给出自信的错答案）。

/** 把投影注册表装上（= 该 profile 装了 dsh-session-projection）并返回替身。 */
function attach(ctx: MockCtx): MockProjections {
  ctx.setService("sessionProjections", ctx.projections);
  return ctx.projections;
}

/** 给 agent 的 snapshotEvents 套一层计数：投影路径应读到 0 次，回退路径 >0 次。 */
function countScans(agent: MockAgent): { value: number } {
  const counter = { value: 0 };
  const inner = agent.session.snapshotEvents;
  agent.session.snapshotEvents = () => {
    counter.value += 1;
    return inner();
  };
  return counter;
}

/** 一条由 `kind` 消息开启、尚未收口的回合（agent/error 时刻的日志形态）。 */
function openedTurn(turnNo: number, kind: string): unknown[] {
  return [
    { type: TURN_START_EVENT, seq: 1, time: 1, data: { turn: turnNo } },
    {
      type: USER_MESSAGE_EVENT,
      seq: 2,
      time: 2,
      data: { role: "user", content: [], source: { kind } },
    },
  ];
}

/** 换成带计数的 snapshotEvents 并登记为根会话（本块用例的共同前置）。 */
function agentWithEvents(ctx: MockCtx, events: unknown[]): MockAgent {
  const agent = makeAgent("s1", "tokenrouter", {
    session: { id: "s1", snapshotEvents: () => events },
  });
  register(ctx, agent);
  return agent;
}

const OPEN_LIST = [{ content: "a", status: "in_progress" }];

describe("投影读路径（注册表在位时不再全量扫描）", () => {
  it("注册表缺席 → 从不注册单元，也不读 stateOf（回退扫描）", () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    const agent = agentWithEvents(ctx, turnWithTodos(3, "completed", OPEN_LIST));
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.deepEqual(ctx.projections.registered, []);
    assert.equal(ctx.projections.reads.length, 0, "读口从未装上 ⇒ 从不走 stateOf");
    assert.equal(ctx.timers.length, 1, "无投影也照常兜底（这一条即迁移前的全部行为）");
  });

  it("注册表到位 → 注册本包单元（同一个对象引用）", () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    assert.deepEqual(attach(ctx).registered, [rescueFactsProjection]);
  });

  it("卸载注入子 fiber → 交回官方 disposer 并停掉投影读", async () => {
    // 官方把注册描述成 effect：`register` 交回的 disposer 随调用 fiber 回收
    // （session-projection/lib/types/index.d.ts:150-159）。disposer 不接、读口不清，
    // fiber 卸载后读口仍指向一个已注销的键。
    const ctx = createMockCtx();
    applyPlugin(ctx);
    const projections = attach(ctx);
    await settle();
    const agent = agentWithEvents(ctx, turnWithTodos(3, "completed", OPEN_LIST));
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(projections.reads.length, 1, "装载期内经投影读，而不是全量扫描");
    ctx.disposeEffects();
    assert.deepEqual(projections.disposed, [rescueFactsProjection], "官方 disposer 必须被跑过");
    const before = projections.reads.length;
    const timersBefore = ctx.timers.length;
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(projections.reads.length, before, "卸载后读口必须已清空，不再走 stateOf");
    assert.equal(ctx.timers.length, timersBefore + 1, "读口清空后由回退扫描兜底，功能不塌");
  });

  it("completed + 本回合未闭合清单 → 投影路径补跑，且不碰 snapshotEvents", async () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    const agent = agentWithEvents(ctx, turnWithTodos(3, "completed", OPEN_LIST));
    const scans = countScans(agent);
    const projections = attach(ctx);
    await settle();
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 1);
    assert.equal(ctx.timers[0]?.ms, 5000, "unfinished 延迟与回退路径同值");
    assert.equal(scans.value, 0, "主路径不再读弃用面");
    assert.deepEqual(projections.reads.at(-1), {
      session: agent.session,
      key: RESCUE_FACTS_KEY,
    });
    ctx.tick();
    assert.equal(agent.followupCalls.length, 1, "注入照常发出");
  });

  it("goal 轮次驱动的失败回合：触发侧判停机位，且判定全在投影上（不读全量日志）", async () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    const agent = agentWithEvents(ctx, openedTurn(5, "goal"));
    const scans = countScans(agent);
    attach(ctx);
    await settle();
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 5, { code: "RATE_LIMIT", message: "x" }));
    // 排期侧不再判 goal：让路/接管要到触发侧读 round driver 自己的停机位。
    assert.equal(ctx.timers.length, 1, "排期发生");
    ctx.tick();
    assert.equal(agent.followupCalls.length, 0, "goals 服务不在位 ⇒ 证不了停机 ⇒ 让路");
    assert.equal(scans.value, 0, "opener 与 newer-turn 两位判定都读投影");
  });

  it("goal 轮 + 投影路径 + driver 已停机 → 接管注入", async () => {
    const ctx = createMockCtx();
    ctx.setService("goals", { get: () => ({ phase: "active", activation: "disarmed" }) });
    applyPlugin(ctx);
    const agent = agentWithEvents(ctx, openedTurn(5, "goal"));
    const scans = countScans(agent);
    attach(ctx);
    await settle();
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 5, { code: "RATE_LIMIT", message: "x" }));
    ctx.tick();
    assert.equal(agent.followupCalls.length, 1, "round driver 只 disarm 不重试 ⇒ 本包接管");
    assert.equal(scans.value, 0, "接管路径同样不读全量日志");
  });

  it("schedule 轮次驱动的失败回合 → 投影路径同样让路（不抢官方定时任务的话）", () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    const agent = agentWithEvents(ctx, openedTurn(5, "schedule"));
    attach(ctx);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 5, { code: "RATE_LIMIT", message: "x" }));
    assert.equal(ctx.timers.length, 0);
  });

  it("rescue 开出的回合再失败 → 投影路径仍走链式例外（60s 跨出限流窗口）", async () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    const agent = agentWithEvents(ctx, openedTurn(2, "user"));
    const scans = countScans(agent);
    attach(ctx);
    await settle();
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 2, { code: "RATE_LIMIT", message: "x" }));
    ctx.tick();
    openRescueTurn(agent, 3);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 3, { code: "RATE_LIMIT", message: "x" }));
    assert.equal(ctx.timers.length, 2);
    assert.equal(ctx.timers[1]?.ms, 60_000);
    assert.equal(scans.value, 0);
  });

  it("失败轮之后开出新轮 → 投影路径在触发前否决（newer-turn veto）", async () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    const agent = agentWithEvents(ctx, openedTurn(1, "user"));
    const scans = countScans(agent);
    attach(ctx);
    await settle();
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 1, { code: "RATE_LIMIT", message: "x" }));
    (agent.session.evs ?? []).push({ type: TURN_START_EVENT, seq: 9, time: 9, data: { turn: 2 } });
    ctx.tick();
    assert.equal(agent.followupCalls.length, 0);
    assert.equal(scans.value, 0, "veto 判定也只读投影");
  });

  it("stateOf 交出坏形状（key 未落地/宿主漂移）→ 回退扫描，判定不变", async () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    const agent = agentWithEvents(ctx, turnWithTodos(3, "completed", OPEN_LIST));
    const scans = countScans(agent);
    const projections = attach(ctx);
    // 读口要等 register 的微任务落地才发布；不 await 的话 events 仍是 undefined，
    // 走的是「本来就没投影」那条回退，坏形状这条支一次都没跑到。
    await settle();
    projections.foldOverride.value = () => ({});
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 1, "坏状态不改变判定，只是退回扫描读法");
    assert.ok(scans.value > 0, "回退路径确实读了全量日志");
    assert.ok(projections.reads.length > 0, "确实经 stateOf 读过一次投影");
  });

  it("end 对不上它的 start（折叠窗口只到半截日志）→ 复盘回退扫描", async () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    const agent = agentWithEvents(ctx, turnWithTodos(3, "completed", OPEN_LIST));
    const scans = countScans(agent);
    const projections = attach(ctx);
    await settle();
    projections.foldOverride.value = (evs) => {
      const state = foldEvents(evs);
      return { ...state, end: { ...state.end, aligned: false } };
    };
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 1);
    assert.ok(scans.value > 0);
  });

  it("opener 被窗口淘汰 → opener 判定回退扫描，链式例外照常生效", async () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    const agent = agentWithEvents(ctx, openedTurn(2, "user"));
    const projections = attach(ctx);
    await settle();
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 2, { code: "RATE_LIMIT", message: "x" }));
    ctx.tick();
    openRescueTurn(agent, 3);
    // 抹掉 opener 表 ⇒ turnOpenerKind 交回 undefined ⇒ host 走 scanOpenerKind
    projections.foldOverride.value = (evs) => ({ ...foldEvents(evs), openers: [] });
    const scans = countScans(agent);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 3, { code: "RATE_LIMIT", message: "x" }));
    assert.equal(ctx.timers[1]?.ms, 60_000, "回退扫描给出同一个链式判定");
    assert.ok(scans.value > 0);
  });
});

describe("官方 Typert Remote 读面", () => {
  it("state/cancel/toggle/resume：与 HTTP 路由同一份运行时", () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    const remote = remoteOf(ctx);
    assert.deepEqual(remote.state().sessions, {});
    const agent = makeAgent("s1", "tokenrouter");
    ctx.agentsService.rootsList.push(agent);
    ctx.agentsService.byId.set("s1", agent);
    agent.session.evs?.push(evTurnEnd(1, "error"));
    ctx.fire("agent/error", {
      agent,
      turn: 1,
      error: { failure: { code: "RATE_LIMIT", message: "x" } },
    });
    ctx.tick();
    assert.deepEqual(Object.keys(remote.state().sessions), ["s1"]);
    const cancelled = remote.cancel({ sessionId: "s1" });
    assert.equal(cancelled["ok"], true);
    assert.equal(remote.cancel({ sessionId: "" })["status"], 400);
    assert.equal(remote.toggle({ sessionId: "s1" })["disabled"], true);
    assert.equal(remote.toggle({ sessionId: "s1" })["disabled"], false);
    assert.equal(remote.toggle({ sessionId: "" })["status"], 400);
    assert.equal(remote.cancel(null as never)["status"], 400);
    assert.equal(remote.toggle(null as never)["status"], 400);
    assert.equal(remote.cancel({ sessionId: 42 } as never)["status"], 400);
    assert.equal(remote.toggle({ sessionId: 42 } as never)["status"], 400);
    assert.deepEqual(remote.resume(), { ok: true, restored: 0 });
  });

  it("toggle 台账满且全是活会话 ⇒ 409", () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    const remote = remoteOf(ctx);
    for (let index = 0; index < 200; index += 1) {
      const agent = makeAgent(`live-${String(index)}`, "tokenrouter");
      ctx.agentsService.rootsList.push(agent);
      ctx.agentsService.byId.set(agent.id, agent);
    }
    for (let index = 0; index < 200; index += 1) {
      remote.toggle({ sessionId: `live-${String(index)}` });
    }
    const refused = remote.toggle({ sessionId: "extra" });
    assert.equal(refused["ok"], false);
    assert.equal(refused["status"], 409);
  });

  it("cancel 交回被裁掉的挂起待办", () => {
    const runtime = {
      scheduler: {
        cancel: () => ({ cancelled: true }),
        releaseSuspended: () => {
          void 0;
        },
      },
      disabledSessions: new Set<string>(),
      suspendedSnapshots: { value: [{ sessionId: "s1", pending: { turn: 7 } }] },
    } as never;
    const service = new SessionRescueRemoteService(new Context(), runtime);
    assert.deepEqual(service.cancel({ sessionId: "s1" }), {
      ok: true,
      cancelled: true,
      turn: 7,
    });
  });

  it("retryProviders 与 retryPolicy：成功、未知输入、冲突与写失败", async () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    const remote = remoteOf(ctx);
    const listed = remote.retryProviders();
    assert.equal(listed["ok"], true);
    assert.ok(Array.isArray(listed["providers"]));
    ctx.piAiDescribeValue = [];
    const unavailable = remote.retryProviders();
    assert.equal(unavailable["status"], 503);
    ctx.piAiDescribeValue = [
      {
        ns: "llm-pi-ai",
        value: {
          providers: {
            sensenova: {
              retryPolicy: { mode: "always", maxRetries: 3, retryableCodes: ["QUOTA"] },
            },
            loose: { retryPolicy: { mode: 42, maxRetries: "x", retryableCodes: "nope" } },
          },
        },
      },
    ];
    const shaped = remote.retryProviders();
    assert.equal(shaped["ok"], true);
    const ok = await remote.retryPolicy({ provider: "sensenova", preset: "enhanced" });
    assert.equal(ok["ok"], true);
    assert.equal(ctx.mutations.length, 1);
    const reset = await remote.retryPolicy({ provider: "sensenova", preset: "default" });
    assert.equal(reset["ok"], true);
    ctx.piAiDescribeValue = [
      {
        ns: "llm-pi-ai",
        value: { providers: { sensenova: {} } },
        revision: 3,
      },
    ];
    const revisioned = await remote.retryPolicy({ provider: "sensenova", preset: "enhanced" });
    assert.equal(revisioned["ok"], true);
    const missing = await remote.retryPolicy({ provider: "", preset: "" });
    assert.equal(missing["status"], 400);
    const badPreset = await remote.retryPolicy({ provider: "sensenova", preset: "nope" });
    assert.equal(badPreset["status"], 400);
    const badProvider = await remote.retryPolicy({ provider: "nope", preset: "enhanced" });
    assert.equal(badProvider["status"], 400);
    ctx.mutateImpl = async () => {
      throw Object.assign(new Error("conflict"), { code: "SETTINGS_CONFLICT" });
    };
    const conflict = await remote.retryPolicy({ provider: "sensenova", preset: "enhanced" });
    assert.equal(conflict["status"], 409);
    ctx.mutateImpl = async () => {
      throw new Error("write failed");
    };
    const failed = await remote.retryPolicy({ provider: "sensenova", preset: "enhanced" });
    assert.equal(failed["status"], 500);
    const malformed = await remote.retryPolicy(null as never);
    assert.equal(malformed["status"], 400);
  });
});

function capacityWarnCount(): number {
  return logged().filter((row) => row.text.includes("scheduler at capacity")).length;
}

describe("调度器容量饱和的可观测性（capacity skip 升级 warn）", () => {
  let ctx: MockCtx;
  const MAX_SESSIONS = 200;
  beforeEach(() => {
    ctx = createMockCtx();
    applyPlugin(ctx);
  });

  it("200 条 pending 占满调度器 → 新会话 skip(capacity) 升级 warn（去重）→ 释放一条后回落再武装", () => {
    // 饱和的正确形态：200 个会话在延迟窗口内同时失败（fire 不 tick）→ 200 条 pending
    // + 已武装定时器 → 全部不可淘汰。挂起路径不饱和：挂起快照自身有上限，裁剪最旧时
    // releaseSuspended 把记录落回空闲（实测，见 pushSuspended）。
    for (let index = 0; index < MAX_SESSIONS; index += 1) {
      const sessionId = `s-${String(index)}`;
      const agent = makeAgent(sessionId, "tokenrouter");
      register(ctx, agent);
      ctx.fire(AGENT_ERROR_EVENT, payload(agent, 1, { code: "RATE_LIMIT", message: "x" }));
    }
    const stateCount = Object.keys(
      (remoteOf(ctx).state() as { sessions: Record<string, unknown> }).sessions,
    ).length;
    assert.equal(stateCount, 200, "前置：200 条 pending 记录全部在册");

    const baseline = capacityWarnCount();

    // 新会话瞬时失败：capacity skip → 第一次 warn。
    const overflow = makeAgent("overflow", "tokenrouter");
    register(ctx, overflow);
    ctx.fire(AGENT_ERROR_EVENT, payload(overflow, 1, { code: "RATE_LIMIT", message: "x" }));
    const afterFirst = capacityWarnCount();
    assert.equal(afterFirst, baseline + 1, "饱和 skip 必须升 warn");

    // 再来一条：去重位生效，不刷第二条。
    const overflow2 = makeAgent("overflow-2", "tokenrouter");
    register(ctx, overflow2);
    ctx.fire(AGENT_ERROR_EVENT, payload(overflow2, 1, { code: "RATE_LIMIT", message: "x" }));
    assert.equal(capacityWarnCount(), afterFirst, "饱和期间 warn 必须去重");

    // 释放一条：s-0 的定时器到点且 followup 成功（不挂起）→ 该记录回到可淘汰态。
    ctx.timers[0]!.fn();
    assert.ok(
      logged().some((row) => row.text.includes("s-0: auto-resume message sent")),
      "前置：s-0 的注入成功送出",
    );

    // 回落再武装：新会话淘汰空闲的 s-0 后 schedule 成功 → 去重位清零；
    // 此刻 200 条又满（199 pending + 新会话）→ 再 skip → warn 重新出现。
    const overflow3 = makeAgent("overflow-3", "tokenrouter");
    register(ctx, overflow3);
    ctx.fire(AGENT_ERROR_EVENT, payload(overflow3, 1, { code: "RATE_LIMIT", message: "x" }));
    assert.equal(capacityWarnCount(), afterFirst, "回落本身不应告警");
    const overflow4 = makeAgent("overflow-4", "tokenrouter");
    register(ctx, overflow4);
    ctx.fire(AGENT_ERROR_EVENT, payload(overflow4, 1, { code: "RATE_LIMIT", message: "x" }));
    assert.equal(capacityWarnCount(), afterFirst + 1, "回落后 warn 必须重新武装");
  });
});
