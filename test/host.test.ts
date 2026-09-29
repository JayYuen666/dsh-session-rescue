import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import plugin from "../host.ts";
// 投影替身按读点现折会话事件流（真注册表增量折叠，同串事件同值）。折叠口在测试树，
// 折的是生产那份 rescueFactsProjection 单元——替身与生产共用同一套 init/apply。
import { RESCUE_FACTS_KEY, rescueFactsProjection } from "../lib/turn-facts.ts";
import { foldEvents } from "./turn-facts-fold.ts";
import { applyRescue, patchEntryId, schemaDefaults, volatileFormOf } from "./config-refs.ts";
import type { ConfigureCall, SchemaNode } from "./config-refs.ts";

const STATE = "/_dsh/session-rescue/state";
const CANCEL = "/_dsh/session-rescue/cancel";
const TOGGLE = "/_dsh/session-rescue/toggle";
const RESUME = "/_dsh/session-rescue/resume";

// 宿主事件名与回合终态 kind：替身造事件流（type/kind）与 ctx.fire 的触发位都取这几条，
// 同串在测试里抄几十遍，拼错一次就是一条永远测不到东西的绿用例。
const TURN_START_EVENT = "turn/start";
const USER_MESSAGE_EVENT = "user/message";
const AGENT_ERROR_EVENT = "agent/error";
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

// ── 轻量宿主替身：只实现本插件用到的服务面（settings/timer/agents/webServer）
//    与 cordis ctx 面（on/effect/get）。类型上以真实 cordis Context 接收。 ──

interface TimerEntry {
  fn: () => void;
  ms: number;
  cancelled: boolean;
  fired: boolean;
}

interface TestRoute {
  kind: string;
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void;
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
  reads: { session: unknown; key: string }[];
  foldOverride: { value: ((evs: readonly unknown[]) => unknown) | undefined };
  register: (definition: unknown) => void;
  stateOf: (session: { evs: unknown[] }, key: string) => unknown;
}

interface MockCtx {
  handlers: Record<string, (payload: unknown) => void>;
  timers: TimerEntry[];
  effects: (() => void)[];
  /** 投影注册表替身（默认**不在**宿主服务表里 ⇒ 注入不激活 ⇒ 三类判定走回退扫描；
   *  用例经 setService("sessionProjections", ctx.projections) 把它装上）。 */
  projections: MockProjections;
  /** ctx.inject 子 fiber 上登记的释放器（路由注册即在此，先卸后装可断言）。 */
  childEffects: (() => void)[];
  routes: Map<string, TestRoute>;
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
  piAiDescribeValue: { ns: string; value: unknown }[] | undefined;
  /** settings.mutate 调用记录（retry-policy 路由的写入断言面）。 */
  mutations: { ns: string; ops: unknown[] }[];
  /** settings.configure 调用记录（页面策略：{ auto:false } + owner=fiber 的断言面）。 */
  configureCalls: { presentation: { auto?: boolean }; owner: unknown }[];
  /** 本插件 fiber（configure 的 owner 必须是它）。 */
  fiber: { id: string };
  /** 可注入的 mutate 实现（测试拒绝路径用）。 */
  mutateImpl?: (ns: string, ops: unknown[]) => Promise<void>;
  /** 可注入的 register 实现（测试注册抛错路径用）。 */
  registerImpl?: (route: TestRoute) => () => void;
  timer: { timeout: (fn: () => void, ms: number) => () => void };
  on: (event: string, handler: (payload: unknown) => void) => void;
  get: (name: string) => unknown;
  effect: (factory: () => (() => void) | undefined) => void;
  /** cordis `ctx.inject` 替身：依赖齐了才激活回调，setService 变化时先卸后装。 */
  inject: (deps: string[], activate: (child: MockInjectCtx) => void) => void;
  /** 变更宿主服务表（模拟 webServer 后装载 / 重启换实例）。 */
  setService: (name: string, service: unknown) => void;
  fire: (event: string, payload: unknown) => void;
  tick: () => void;
  disposeEffects: () => void;
}

function createMockCtx(): MockCtx {
  const handlers: Record<string, (payload: unknown) => void> = {};
  const timers: TimerEntry[] = [];
  const effects: (() => void)[] = [];
  const routes = new Map<string, TestRoute>();
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
  const webServer = {
    register(route: TestRoute) {
      if (holder.ctx?.registerImpl) {
        return holder.ctx.registerImpl(route);
      }
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  };
  // 宿主服务表：cordis `ctx.get` 是无 inject 语义的存储读，这里用同一张表替身。
  // 用 Map 而非 Record：setService(name, undefined) 要能摘掉一个服务（模拟
  // webServer 卸载），而 Record 的动态 delete 既慢又会被 lint 拒绝。
  const provided = new Map<string, unknown>([
    ["agents", agentsService],
    ["settings", settingsService],
    ["timer", timerService],
    ["webServer", webServer],
  ]);
  const injections: { deps: string[]; activate: (child: MockInjectCtx) => void }[] = [];
  const childEffects: (() => void)[] = [];
  // 投影注册表替身（见 MockProjections）。
  const registered: unknown[] = [];
  const reads: { session: unknown; key: string }[] = [];
  const foldOverride: { value: ((evs: readonly unknown[]) => unknown) | undefined } = {
    value: undefined,
  };
  const projections: MockProjections = {
    registered,
    reads,
    foldOverride,
    // 官方 register 交回的 disposer 随调用 fiber 回收，host 侧从不接它（注册本身就是
    // effect），故替身只需记住"谁注册了"。
    register(definition) {
      registered.push(definition);
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
    routes,
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

function makeRes(): {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
  writeHead: (code: number, headers?: Record<string, unknown>) => void;
  setHeader: (key: string, val: unknown) => void;
  end: (body?: string) => void;
} {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    writeHead(code, headers) {
      this.statusCode = code;
      if (headers) {
        Object.assign(this.headers, headers);
      }
    },
    setHeader(key, val) {
      this.headers[key.toLowerCase()] = val;
    },
    end(body) {
      if (body !== undefined) {
        this.body = body;
      }
    },
  };
}

async function callRoute(
  ctx: MockCtx,
  path: string,
  opts: { method?: string; url?: string | null; headers?: Record<string, string> } = {},
): Promise<ReturnType<typeof makeRes>> {
  const route = ctx.routes.get(path);
  assert.ok(route, `route ${path} must be registered`);
  const res = makeRes();
  route.handler(
    {
      method: opts.method ?? "GET",
      url: opts.url ?? path,
      headers: opts.headers ?? {},
    } as IncomingMessage,
    res as unknown as ServerResponse,
  );
  return res;
}

/** 走真实 apply：第二参是**行 config**（组合包层/用户层行的 `config:`），0.1.7 由
 *  cordis 在装载期把它合进 schema 默认（显式 undefined 不覆盖，等价于旧的 compact()），
 *  再交 volatile 引用进来——这里复刻的就是那一步合并。 */
function applyPlugin(ctx: MockCtx, rowConfig?: Record<string, unknown>): void {
  // mock ctx 是 host 服务面的结构替身，与真实 cordis Context 仅接口上兼容。
  if (rowConfig !== undefined) {
    ctx.scope.set(
      Object.fromEntries(Object.entries(rowConfig).filter(([, value]) => value !== undefined)),
    );
  }
  applyRescue(ctx, () => ctx.scope.get());
}

/** 直接调用 resume 路由（挂起快照恢复端点）。 */
function callPauseRoute(
  ctx: MockCtx,
  headers: Record<string, string> = {},
): { status?: number; body?: unknown } {
  const route = ctx.routes.get(RESUME)!;
  const res: { status?: number; body?: unknown } = {};
  route.handler(
    { method: "POST", url: RESUME, headers } as unknown as never,
    {
      writeHead(code: number) {
        res.status = code;
      },
      end(chunk?: string) {
        res.body = chunk === undefined || chunk === "" ? null : JSON.parse(chunk);
      },
    } as never,
  );
  return res;
}

/** 同步读 state 路由下发的 csrf（apply 期常量；POST 辅助用）。 */
function csrfOf(ctx: MockCtx): string {
  const route = ctx.routes.get(STATE)!;
  let body = "";
  route.handler(
    { method: "GET", url: STATE, headers: {} } as unknown as never,
    {
      writeHead() {
        void 0;
      },
      setHeader() {
        void 0;
      },
      end(chunk?: string) {
        body = chunk ?? "";
      },
    } as never,
  );
  // 形状里 `csrf?: unknown` 是可选位，读出来完全可能没有这一位；旧写法先 `as string`
  // 把类型面改窄、再靠 `?? ""` 兜底，等于让类型说谎（no-unnecessary-condition 报的正是
  // 这对自相矛盾）。改宽成 `string | undefined`，守卫原样保留。
  return ((JSON.parse(body) as { csrf?: unknown }).csrf as string | undefined) ?? "";
}

/** 给 POST 请求配上有效 csrf（可叠加额外头，如 sec-fetch-site）。 */
function withCsrf(ctx: MockCtx, extra: Record<string, string> = {}): Record<string, string> {
  return { ...extra, "x-rescue-csrf": csrfOf(ctx) };
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
  it("Config schema 逐字段默认 = 0.1.6 交给 settings.register 的那份内置底座", () => {
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
    ctx.scope.set({ providerExcludes: ["baidu-token-plan"] });
    const agent = makeAgent("s1", "baidu-token-plan");
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 1, { code: "RATE_LIMIT", message: "x" }));
    assert.equal(ctx.timers.length, 0);
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
    await callRoute(ctx, TOGGLE, {
      method: "POST",
      url: `${TOGGLE}?sessionId=s1`,
      headers: withCsrf(ctx),
    });
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
    const res = await callRoute(ctx, STATE);
    assert.equal(
      (JSON.parse(res.body) as { sessions: Record<string, { count: number }> }).sessions["s1"]
        ?.count,
      1,
    );
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
    const res = await callRoute(ctx, STATE);
    assert.equal(
      (JSON.parse(res.body) as { sessions: Record<string, { count: number }> }).sessions["s1"]
        ?.count,
      3,
    );
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

describe("webServer 路由", () => {
  let ctx: MockCtx;
  beforeEach(() => {
    ctx = createMockCtx();
    applyPlugin(ctx);
  });

  it("GET state：返回调度与开关状态", async () => {
    const agent = makeAgent("s1", "tokenrouter");
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 3, { code: "RATE_LIMIT", message: "x" }));
    const res = await callRoute(ctx, STATE);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as {
      ok: boolean;
      sessions: Record<
        string,
        { pending: { turn: number; remainingMs: number } | null; disabled: boolean }
      >;
    };
    assert.equal(body.ok, true);
    assert.equal(body.sessions["s1"]?.pending?.turn, 3);
    assert.equal(typeof body.sessions["s1"].pending.remainingMs, "number");
    assert.equal(body.sessions["s1"].disabled, false);
  });

  it("state 拒绝非 GET", async () => {
    const res = await callRoute(ctx, STATE, { method: "POST" });
    assert.equal(res.statusCode, 405);
  });

  it("POST cancel：取消待办并释放定时器", async () => {
    const agent = makeAgent("s1", "tokenrouter");
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 3, { code: "RATE_LIMIT", message: "x" }));
    const res = await callRoute(ctx, CANCEL, {
      method: "POST",
      url: `${CANCEL}?sessionId=s1`,
      headers: withCsrf(ctx),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true, cancelled: true, turn: 3 });
    assert.equal(ctx.timers[0]?.cancelled, true);
    ctx.tick();
    assert.equal(agent.followupCalls.length, 0);
  });

  it("cancel 缺 sessionId → 400", async () => {
    const res = await callRoute(ctx, CANCEL, {
      method: "POST",
      url: CANCEL,
      headers: withCsrf(ctx),
    });
    assert.equal(res.statusCode, 400);
  });

  it("跨域 cancel → 403（纵深防御：持有效 csrf 仍被 sec-fetch-site 拦截）", async () => {
    const res = await callRoute(ctx, CANCEL, {
      method: "POST",
      url: `${CANCEL}?sessionId=s1`,
      headers: withCsrf(ctx, { "sec-fetch-site": "cross-site" }),
    });
    assert.equal(res.statusCode, 403);
  });

  // 无 token 的 mutating POST 必须 403（当前 host 无 csrf 实现，
  // 这些测试在修复前应失败——先红后绿）。
  it("POST cancel 无 csrf → 403", async () => {
    const res = await callRoute(ctx, CANCEL, { method: "POST", url: `${CANCEL}?sessionId=s1` });
    assert.equal(res.statusCode, 403);
    assert.equal((JSON.parse(res.body) as { ok: boolean }).ok, false);
  });

  it("POST toggle 无 csrf → 403", async () => {
    const res = await callRoute(ctx, TOGGLE, { method: "POST", url: `${TOGGLE}?sessionId=s1` });
    assert.equal(res.statusCode, 403);
    assert.equal((JSON.parse(res.body) as { ok: boolean }).ok, false);
  });

  it("POST resume 无 csrf → 403", () => {
    // 默认空头
    const res = callPauseRoute(ctx);
    assert.equal(res.status, 403);
    assert.equal((res.body as { ok: boolean }).ok, false);
  });

  it("POST cancel 持错误 csrf → 403", async () => {
    const res = await callRoute(ctx, CANCEL, {
      method: "POST",
      url: `${CANCEL}?sessionId=s1`,
      headers: { "x-rescue-csrf": "wrong-token" },
    });
    assert.equal(res.statusCode, 403);
    assert.equal((JSON.parse(res.body) as { ok: boolean }).ok, false);
  });

  it("GET state 下发非空 csrf；回填后 cancel 通过", async () => {
    const token = csrfOf(ctx);
    assert.equal(typeof token, "string");
    assert.ok(token.length > 0, "state 必须下发非空 csrf");
    const agent = makeAgent("s1", "tokenrouter");
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 3, { code: "RATE_LIMIT", message: "x" }));
    const res = await callRoute(ctx, CANCEL, {
      method: "POST",
      url: `${CANCEL}?sessionId=s1`,
      headers: { "x-rescue-csrf": token },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true, cancelled: true, turn: 3 });
  });

  it("POST toggle：翻转会话开关；开启时同时解除待办", async () => {
    const agent = makeAgent("s1", "tokenrouter");
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 3, { code: "RATE_LIMIT", message: "x" }));
    let res = await callRoute(ctx, TOGGLE, {
      method: "POST",
      url: `${TOGGLE}?sessionId=s1`,
      headers: withCsrf(ctx),
    });
    assert.deepEqual(JSON.parse(res.body), { ok: true, disabled: true });
    // 关闭即解除待办
    assert.equal(ctx.timers[0]?.cancelled, true);
    res = await callRoute(ctx, TOGGLE, {
      method: "POST",
      url: `${TOGGLE}?sessionId=s1`,
      headers: withCsrf(ctx),
    });
    assert.deepEqual(JSON.parse(res.body), { ok: true, disabled: false });
    const stateRes = await callRoute(ctx, STATE);
    const st = JSON.parse(stateRes.body) as { sessions: Record<string, { disabled: boolean }> };
    assert.equal(st.sessions["s1"]?.disabled, false);
  });
});

describe("生命周期", () => {
  it("effect 清理时释放所有待办定时器并注销路由", () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    const agent = makeAgent("s1", "tokenrouter");
    register(ctx, agent);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 1, { code: "RATE_LIMIT", message: "x" }));
    // state/cancel/toggle/resume + retry-providers/retry-policy 六条 webServer 路由
    // （resume（旧名 pause，后更名）为 0.1.2-alpha.2 连接感知新增；retry-* 为官方 llm-retry
    // 策略配置通道，读 llm-pi-ai namespace + settings.mutate 落盘）
    assert.equal(ctx.routes.size, 6);
    ctx.disposeEffects();
    assert.equal(ctx.timers[0]?.cancelled, true);
    assert.equal(ctx.routes.size, 0);
  });
});

describe("连接感知（connection/reset 恢复挂起的续跑，0.1.2-alpha.2）", () => {
  it("resume 路由存在；无挂起待办时调用返回 restored=0", () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    const resumeNotify = ctx.routes.get(RESUME);
    assert.ok(resumeNotify, "resume route registered");
    const res: { status?: number; body?: unknown } = {};
    resumeNotify.handler(
      {
        method: "POST",
        url: RESUME,
        headers: withCsrf(ctx),
      } as unknown as never,
      {
        writeHead(code: number) {
          res.status = code;
        },
        end(chunk?: string) {
          res.body = chunk === undefined || chunk === "" ? null : JSON.parse(chunk);
        },
      } as never,
    );
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, restored: 0 });
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
    const resumeNotify = ctx.routes.get(RESUME)!;
    const res: { status?: number; body?: unknown } = {};
    resumeNotify.handler(
      {
        method: "POST",
        url: RESUME,
        headers: withCsrf(ctx),
      } as unknown as never,
      {
        writeHead(code: number) {
          res.status = code;
        },
        end(chunk?: string) {
          res.body = chunk === undefined || chunk === "" ? null : JSON.parse(chunk);
        },
      } as never,
    );
    assert.equal(res.status, 200);
    assert.equal((res.body as { restored?: number }).restored, 1, "one pending restored");
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
  it("挂起后 state 可见 suspended 待办（可取消横幅的数据源）", async () => {
    const { ctx } = suspendCtx();
    const res = await callRoute(ctx, STATE);
    const st = JSON.parse(res.body) as {
      sessions: Record<
        string,
        {
          pending: {
            suspended?: boolean;
            kind?: string;
            turn?: number;
            remainingMs?: number;
          } | null;
        }
      >;
    };
    assert.equal(st.sessions["s1"]?.pending?.suspended, true);
    assert.equal(st.sessions["s1"].pending.kind, "resume");
    assert.equal(st.sessions["s1"].pending.turn, 1);
    assert.equal(typeof st.sessions["s1"].pending.remainingMs, "number");
  });

  it("取消挂起待办：resume 不再恢复（restored=0，无新定时器，不补发）", async () => {
    const { ctx, agent } = suspendCtx();
    const cancelRes = await callRoute(ctx, CANCEL, {
      method: "POST",
      url: `${CANCEL}?sessionId=s1`,
      headers: withCsrf(ctx),
    });
    assert.deepEqual(JSON.parse(cancelRes.body), { ok: true, cancelled: true, turn: 1 });
    const res = callPauseRoute(ctx, withCsrf(ctx));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, restored: 0 });
    assert.equal(ctx.timers.length, 1, "no re-armed timer after cancel");
    assert.equal(agent.followupCalls.length, 0);
  });

  it("toggle 关闭清除挂起待办：resume 恢复数为 0", async () => {
    const { ctx } = suspendCtx();
    await callRoute(ctx, TOGGLE, {
      method: "POST",
      url: `${TOGGLE}?sessionId=s1`,
      headers: withCsrf(ctx),
    });
    const res = callPauseRoute(ctx, withCsrf(ctx));
    assert.deepEqual(res.body, { ok: true, restored: 0 });
    assert.equal(ctx.timers.length, 1, "no re-armed timer after toggle-off");
  });

  it("恢复受全局 enabled 闸门：插件关闭后 resume 丢弃挂起待办", async () => {
    const { ctx } = suspendCtx();
    ctx.scope.set({ enabled: false });
    const res = callPauseRoute(ctx, withCsrf(ctx));
    // restored 读的是挂起时快照数（1），但快照被丢弃：无新定时器、state 不再显示
    assert.equal((res.body as { restored?: number }).restored, 1);
    assert.equal(ctx.timers.length, 1, "suspended snapshot dropped, not re-armed");
    const stState = await callRoute(ctx, STATE);
    const st = JSON.parse(stState.body) as {
      sessions: Record<string, { pending: { suspended?: boolean } | null }>;
    };
    assert.equal(st.sessions["s1"]?.pending?.suspended, undefined);
  });

  it("挂起快照上限裁剪：超过 MAX_SUSPENDED 时淘汰最旧", async () => {
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
    const capState = await callRoute(ctx, STATE);
    const st = JSON.parse(capState.body) as {
      sessions: Record<string, { pending: { suspended?: boolean } | null }>;
    };
    let suspended = 0;
    for (const rec of Object.values(st.sessions)) {
      if (rec.pending?.suspended === true) {
        suspended += 1;
      }
    }
    assert.equal(suspended, 64);
    assert.equal(st.sessions["s000"]?.pending?.suspended, undefined, "oldest snapshot evicted");
    assert.equal(st.sessions["s064"]?.pending?.suspended, true);
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

  it("goal 驱动的回合 → 抑制（交 goal 轮次机制，不双重注入）", () => {
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
    assert.equal(ctx.timers.length, 0);
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
    callPauseRoute(ctx, withCsrf(ctx));
    // 直接走 toggle 路由关闭本会话
    const route = ctx.routes.get(TOGGLE)!;
    const res = makeRes();
    route.handler(
      {
        method: "POST",
        url: `${TOGGLE}?sessionId=s1&disabled=true`,
        headers: withCsrf(ctx),
      } as IncomingMessage,
      res as unknown as ServerResponse,
    );
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

  it("state 路由 pending 携带 kind=unfinished", async () => {
    const agent = agentWith(7, "completed", OPEN);
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    const res = await callRoute(ctx, STATE);
    const st = JSON.parse(res.body) as {
      sessions: Record<string, { pending: { kind: string } | null }>;
    };
    assert.equal(st.sessions["s1"]?.pending?.kind, "unfinished");
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

  it("state 路由 pending 携带 kind=continue", async () => {
    const agent = turnEndAgent(5, MAX_TOKENS_REASON);
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    const res = await callRoute(ctx, STATE);
    const st = JSON.parse(res.body) as {
      sessions: Record<string, { pending: { kind: string } | null }>;
    };
    assert.equal(st.sessions["s1"]?.pending?.kind, "continue");
  });

  it("enabled=false 时不调度", () => {
    ctx.scope.set({ enabled: false });
    const agent = turnEndAgent(5, MAX_TOKENS_REASON);
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 0);
  });
});

// ── agent/request-error：请求级 429 自动重试（用户裁决：
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

  /** 顺序触发 n 次 request-error：每次都要等上一次结算完（退避名额现在在
   *  「真的重发」时才占用，见 item 7）。写成递归而非 for+await，避开
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

// ── 429 重试策略配置通道（llm-pi-ai retryPolicy 读写路由）───────────────────
describe("retry-providers / retry-policy 路由 - 官方 llm-retry 策略读写", () => {
  let ctx: MockCtx;
  beforeEach(() => {
    ctx = createMockCtx();
    applyPlugin(ctx);
  });

  const PROVIDERS_PATH = "/_dsh/session-rescue/retry-providers";
  const POLICY_PATH = "/_dsh/session-rescue/retry-policy";

  /** POST body 路由辅助：shared `readBody` 用 for-await 收流，故 req 替身实现
   *  AsyncIterable（真实 IncomingMessage 亦然），并可注入流错误/分块。 */
  async function postJson(
    box: MockCtx,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
    opts: { chunks?: (string | Buffer)[]; streamError?: Error } = {},
  ): Promise<ReturnType<typeof makeRes>> {
    const route = box.routes.get(path);
    assert.ok(route, `route ${path} must be registered`);
    const res = makeRes();
    const chunks: (string | Buffer)[] = opts.chunks ?? [JSON.stringify(body)];
    const req = {
      method: "POST",
      url: path,
      headers,
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          async next(): Promise<IteratorResult<unknown>> {
            if (opts.streamError !== undefined) {
              throw opts.streamError;
            }
            if (index >= chunks.length) {
              return { done: true, value: undefined };
            }
            const value = chunks[index];
            index += 1;
            return { done: false, value };
          },
        };
      },
    };
    route.handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    await sleep(5);
    return res;
  }

  it("GET retry-providers：列出 llm-pi-ai providers 与当前策略摘要", async () => {
    const res = await callRoute(ctx, PROVIDERS_PATH);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as {
      ok: boolean;
      providers: { provider: string; mode: string; maxRetries: number; hasQuota: boolean }[];
    };
    assert.equal(body.ok, true);
    const found = body.providers.find((prof) => prof.provider === "sensenova");
    assert.ok(found, "sensenova 在列");
    assert.equal(found.mode, "normal");
    assert.equal(found.maxRetries, 12);
    assert.equal(found.hasQuota, true);
  });

  it("GET retry-providers：settings 服务缺失/不可读 → ok:false 不炸", async () => {
    ctx.piAiDescribeValue = undefined;
    const res = await callRoute(ctx, PROVIDERS_PATH);
    assert.equal(res.statusCode, 200);
    assert.equal((JSON.parse(res.body) as { ok: boolean }).ok, false);
  });

  it("POST retry-policy preset=enhanced → mutate set providers.<result>.retryPolicy（含 QUOTA）", async () => {
    const res = await postJson(
      ctx,
      POLICY_PATH,
      { provider: "xkiro", preset: "enhanced" },
      withCsrf(ctx),
    );
    assert.equal(res.statusCode, 200);
    assert.equal((JSON.parse(res.body) as { ok: boolean }).ok, true);
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

  it("POST preset=always → mutate set mode:always", async () => {
    await postJson(ctx, POLICY_PATH, { provider: "aihubmix", preset: "always" }, withCsrf(ctx));
    const op = ctx.mutations[0]?.ops[0] as { value: { mode: string } };
    assert.equal(op.value.mode, "always");
  });

  it("POST preset=default → mutate unset（回官方默认 5 次码表）", async () => {
    await postJson(ctx, POLICY_PATH, { provider: "tokenrouter", preset: "default" }, withCsrf(ctx));
    const op = ctx.mutations[0]?.ops[0] as { op: string; path: string[] };
    assert.equal(op.op, "unset");
    assert.deepEqual(op.path, ["providers", "tokenrouter", "retryPolicy"]);
  });

  it("POST preset=off → maxRetries:0（官方码表不得为空，用零次达成关闭）", async () => {
    await postJson(ctx, POLICY_PATH, { provider: "openrouter", preset: "off" }, withCsrf(ctx));
    const op = ctx.mutations[0]?.ops[0] as { value: { mode: string; maxRetries: number } };
    assert.equal(op.value.mode, "normal");
    assert.equal(op.value.maxRetries, 0);
  });

  it("POST 未知 preset / 缺 provider → 400", async () => {
    const r1 = await postJson(ctx, POLICY_PATH, { provider: "x", preset: "bogus" }, withCsrf(ctx));
    assert.equal(r1.statusCode, 400);
    const r2 = await postJson(ctx, POLICY_PATH, { preset: "enhanced" }, withCsrf(ctx));
    assert.equal(r2.statusCode, 400);
  });

  it("POST 无 csrf → 403（与 cancel/toggle 同一写安全面）", async () => {
    const res = await postJson(ctx, POLICY_PATH, { provider: "x", preset: "enhanced" });
    assert.equal(res.statusCode, 403);
    assert.equal(ctx.mutations.length, 0, "mutate 不得被调用");
  });

  it("POST 跨域 → 403", async () => {
    const res = await postJson(
      ctx,
      POLICY_PATH,
      { provider: "x", preset: "enhanced" },
      withCsrf(ctx, { "sec-fetch-site": "cross-site" }),
    );
    assert.equal(res.statusCode, 403);
  });

  it("mutate 抛错（settings 拒绝）→ 500 且错误可见", async () => {
    ctx.mutateImpl = async () => {
      throw new Error("settings-rejected: bogus route");
    };
    const res = await postJson(
      ctx,
      POLICY_PATH,
      { provider: "x", preset: "enhanced" },
      withCsrf(ctx),
    );
    assert.equal(res.statusCode, 500);
    const parsed = JSON.parse(res.body) as { error?: string };
    assert.ok((parsed.error ?? "").includes("settings-rejected"));
  });

  /** 让 mutate 抛出一个**受控的 unknown 载荷**（宿主/插件抛什么都可能），
   *  读回 500 响应里的 error 串。抛 unknown 而非 any：only-throw-error 允许。 */
  async function errorOfThrown(box: MockCtx, value: unknown): Promise<unknown> {
    const held: { value: unknown } = { value };
    box.mutateImpl = async (): Promise<void> => {
      throw held.value;
    };
    const res = await postJson(
      box,
      POLICY_PATH,
      { provider: "x", preset: "enhanced" },
      withCsrf(box),
    );
    assert.equal(res.statusCode, 500, "写通道失败一律 500");
    return (JSON.parse(res.body) as { error?: unknown }).error;
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

  it("POST body 是合法 JSON 但非对象（数组）→ 400，不当作 provider/preset", async () => {
    const notObject = "[1,2,3]";
    const res = await postJson(ctx, POLICY_PATH, {}, withCsrf(ctx), { chunks: [notObject] });
    assert.equal(res.statusCode, 400);
    assert.equal(ctx.mutations.length, 0, "坏 body 不落盘");
  });

  it("POST 的 preset 字段非字符串 → 400（类型闸门，不喂给 Map.get）", async () => {
    const res = await postJson(ctx, POLICY_PATH, {}, withCsrf(ctx), {
      chunks: ['{"provider":"x","preset":42}'],
    });
    assert.equal(res.statusCode, 400);
    const res2 = await postJson(ctx, POLICY_PATH, {}, withCsrf(ctx), {
      chunks: ['{"provider":7,"preset":"enhanced"}'],
    });
    assert.equal(res2.statusCode, 400);
  });

  it("GET retry-providers：profile 非对象的行直接丢弃，缺字段按官方默认投影", async () => {
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
    const res = await callRoute(ctx, PROVIDERS_PATH);
    const body = JSON.parse(res.body) as {
      providers: { provider: string; mode: string; maxRetries: number; hasQuota: boolean }[];
    };
    assert.deepEqual(
      body.providers.map((row) => row.provider),
      ["onlyAlways"],
      "非对象 profile 不进列表",
    );
    assert.equal(body.providers[0]?.mode, "always");
    assert.equal(body.providers[0].maxRetries, 5, "缺 maxRetries → 官方默认 5");
    assert.equal(body.providers[0].hasQuota, false, "缺码表 → 无 QUOTA");
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
  it("会话数超过 MAX_SESSIONS：挂起会话的记录被挤掉 → state 以零计数呈现快照", async () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    const kept = makeAgent("kept", "tokenrouter");
    kept.followup = () => {
      throw new Error(CARRIER_DOWN_MESSAGE);
    };
    register(ctx, kept);
    ctx.fire(AGENT_ERROR_EVENT, payload(kept, 4, { code: "RATE_LIMIT", message: "x" }));
    ctx.timers.at(-1)!.fn();
    // 把调度器的会话记录灌满（lib/resume-scheduler.ts MAX_SESSIONS=200）：
    // 挂起后的记录是空闲的（无待办、无定时器），按插入序最先被淘汰。
    for (let index = 0; index < 200; index += 1) {
      const filler = makeAgent(`filler-${String(index)}`, "tokenrouter");
      register(ctx, filler);
      ctx.fire(AGENT_ERROR_EVENT, payload(filler, 1, { code: "RATE_LIMIT", message: "x" }));
      ctx.tick();
    }
    const res = await callRoute(ctx, STATE);
    const st = JSON.parse(res.body) as {
      sessions: Record<
        string,
        {
          count: number;
          lastFireAt: number;
          disabled: boolean;
          pending: { suspended?: boolean; turn?: number; remainingMs?: number } | null;
        }
      >;
    };
    const keptRow = st.sessions["kept"];
    assert.ok(keptRow, "挂起会话仍在 state 里可见（断连窗口里 UI 能看见并可取消）");
    assert.equal(keptRow.pending?.suspended, true);
    assert.equal(keptRow.pending.turn, 4);
    assert.equal(typeof keptRow.pending.remainingMs, "number");
    assert.equal(keptRow.count, 0, "记录已淘汰 → 计数按 0 降级，不读到 undefined");
    assert.equal(keptRow.lastFireAt, 0);
    assert.equal(keptRow.disabled, false);
    assert.equal(st.sessions["filler-0"]?.pending, null, "已 fire 的填充会话正常报告");
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
    await callRoute(localCtx, TOGGLE, {
      method: "POST",
      url: `${TOGGLE}?sessionId=dx2`,
      headers: withCsrf(localCtx),
    });
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

  it("completed + 本回合未闭合清单 → 投影路径补跑，且不碰 snapshotEvents", () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    const agent = agentWithEvents(ctx, turnWithTodos(3, "completed", OPEN_LIST));
    const scans = countScans(agent);
    const projections = attach(ctx);
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

  it("goal 轮次驱动的失败回合 → 投影路径同样让路（不抢 goal-round-driver 的话）", () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    const agent = agentWithEvents(ctx, openedTurn(5, "goal"));
    const scans = countScans(agent);
    attach(ctx);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 5, { code: "RATE_LIMIT", message: "x" }));
    assert.equal(ctx.timers.length, 0);
    assert.equal(scans.value, 0);
  });

  it("rescue 开出的回合再失败 → 投影路径仍走链式例外（60s 跨出限流窗口）", () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    const agent = agentWithEvents(ctx, openedTurn(2, "user"));
    const scans = countScans(agent);
    attach(ctx);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 2, { code: "RATE_LIMIT", message: "x" }));
    ctx.tick();
    openRescueTurn(agent, 3);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 3, { code: "RATE_LIMIT", message: "x" }));
    assert.equal(ctx.timers.length, 2);
    assert.equal(ctx.timers[1]?.ms, 60_000);
    assert.equal(scans.value, 0);
  });

  it("失败轮之后开出新轮 → 投影路径在触发前否决（newer-turn veto）", () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    const agent = agentWithEvents(ctx, openedTurn(1, "user"));
    const scans = countScans(agent);
    attach(ctx);
    ctx.fire(AGENT_ERROR_EVENT, payload(agent, 1, { code: "RATE_LIMIT", message: "x" }));
    (agent.session.evs ?? []).push({ type: TURN_START_EVENT, seq: 9, time: 9, data: { turn: 2 } });
    ctx.tick();
    assert.equal(agent.followupCalls.length, 0);
    assert.equal(scans.value, 0, "veto 判定也只读投影");
  });

  it("stateOf 交出坏形状（key 未落地/宿主漂移）→ 回退扫描，判定不变", () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    const agent = agentWithEvents(ctx, turnWithTodos(3, "completed", OPEN_LIST));
    const scans = countScans(agent);
    const projections = attach(ctx);
    projections.foldOverride.value = () => ({});
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 1, "坏状态不改变判定，只是退回扫描读法");
    assert.ok(scans.value > 0, "回退路径确实读了全量日志");
  });

  it("end 对不上它的 start（折叠窗口只到半截日志）→ 复盘回退扫描", () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    const agent = agentWithEvents(ctx, turnWithTodos(3, "completed", OPEN_LIST));
    const scans = countScans(agent);
    const projections = attach(ctx);
    projections.foldOverride.value = (evs) => {
      const state = foldEvents(evs);
      return { ...state, end: { ...state.end, aligned: false } };
    };
    ctx.fire(AGENT_STATUS_EVENT, { agent, status: "idle" });
    assert.equal(ctx.timers.length, 1);
    assert.ok(scans.value > 0);
  });

  it("opener 被窗口淘汰 → opener 判定回退扫描，链式例外照常生效", () => {
    const ctx = createMockCtx();
    applyPlugin(ctx);
    const agent = agentWithEvents(ctx, openedTurn(2, "user"));
    const projections = attach(ctx);
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
