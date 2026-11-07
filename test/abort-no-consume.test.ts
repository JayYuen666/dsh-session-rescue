import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { applyRescue, schemaDefaults, volatileFieldNames } from "./config-refs.ts";

// 用户主动中止/打断的回合绝不能烧掉 maxResumes/maxContinues 配额。
//
// 判定位置（按宿主事件流核实过）：中止信号在事件流里是 turn/end
// reason.kind='aborted'（'interrupted' 同视），而 harness 的 agent-loop 在
// `catch` 里 emit('agent/error')、在 `finally` 里才 append('turn/end')，且被
// abort 的回合在那段 catch 里直接 rethrow、**根本不发 agent/error**
// （core/agent-loop/src/agent.ts 的 `private async turn()`：aborted 一支只赋
// turnEnds 就抛出，走 throwError 的那一支才 emit）。所以 abort 保护只能落在
// agent/status 侧（此刻 turn/end 已就位）：原先在 agent/error 侧扫 turn/end 的那段
// 判定永远空扫，是死代码，已删。

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
/** 0.1.7 的 settings 宿主服务（installed dsh-settings/lib/types/index.d.ts）：
 *  `register`/`get`/`installSection` 已被宿主移除（命名空间改按 profile 条目 id
 *  隐式注册），只剩 describe(:96) / mutate(:114) / configure(:80) 三件。 */
interface MockSettings {
  describe: () => readonly { ns: string; value: unknown }[];
  mutate: (ns: string, ops: unknown[]) => Promise<void>;
  configure: (presentation: { auto?: boolean }, owner?: unknown) => () => void;
}
interface MockInjectCtx {
  effect: (factory: () => (() => void) | undefined) => void;
  get: (name: string) => unknown;
  /** cordis 的注入子上下文同样带着被注入服务的读取接口（settings.configure 走这条路：
   *  apply 里 `svc.inject(['settings'], child => child.effect(() => child.settings
   *  .configure({ auto: false }, svc.fiber)))`）。缺这个成员，替身在激活时就少了
   *  宿主真正会调的那一手。 */
  settings: MockSettings;
  reflect: { provide: (name: string, service: unknown) => () => void };
}

interface MockCtx {
  handlers: Record<string, (payload: unknown) => void>;
  timers: TimerEntry[];
  /** apply 各层 effect 交回的卸载函数（宿主在插件卸载时逐个调用）。 */
  disposers: (() => void)[];
  scopeValue: Record<string, unknown>;
  service: (name: string) => unknown;
  agentsService: {
    rootsList: MockAgent[];
    byId: Map<string, MockAgent>;
    roots: () => { id: string }[];
    get: (id: string) => MockAgent | undefined;
  };
}

function createCtx(): MockCtx {
  const provided: Record<string, unknown> = {};
  // 字段清单不手写：内置默认从导出的 Config schema 现读（config-refs 的原则——
  // 手写清单在 schema 增删后读到的只是 undefined，功能静默关闭而测试照绿）。
  // 这里只把三个冷却覆写为 0：冷却闸门会把注入挡在窗口里，tick() 就永远等不到触发。
  // 覆写键的名字要逐枚核过 schema 里真有这一位：拼错的键既读不到（`readField` 按 schema
  // 的 key 取用），也不会让任何现有断言变红——症状是注入被默认冷却挡住，而不是"点错了名"。
  const defaults = schemaDefaults();
  const cooldownOverrides: Record<string, number> = {
    resumeCooldownMs: 0,
    continueCooldownMs: 0,
    unfinishedCooldownMs: 0,
  };
  for (const key of Object.keys(cooldownOverrides)) {
    assert.ok(key in defaults, `冷却覆写点名了 schema 里不存在的字段：${key}`);
  }
  const scopeValue: Record<string, unknown> = { ...defaults, ...cooldownOverrides };
  // 测试替身里没有宿主装载期那一步（宿主按 `.default()` 把 volatile 字段填满），所以这里判的是
  // **取值**而不是键在不在：`key in scopeValue` 永远成立——名单与内置默认同出一个 schema，
  // 展开之后每个字段名都必然在位，漏配与拼错都拦不住（实测把覆写名改成不存在的
  // `resumeCooldownM`，六条用例仍全绿）。取值落到 undefined 才是本文件真正会静默失效的形。
  for (const key of volatileFieldNames()) {
    assert.notEqual(scopeValue[key], undefined, `volatile 字段 ${key} 在装配处取不到值`);
  }
  const ctx: MockCtx = {
    handlers: {},
    timers: [],
    disposers: [],
    service: (name: string) => provided[name],
    scopeValue,
    agentsService: {
      rootsList: [],
      byId: new Map(),
      roots() {
        return this.rootsList;
      },
      get(id: string) {
        return this.byId.get(id);
      },
    },
  };
  // apply 的宿主契约守卫点名 settings 上要被调用的每个方法（describe/mutate，
  // 0.1.7 已无 register/get），替身因此必须给全——缺一个就在 apply 里急停。
  // describe 恒回 []：locale 条目没被投影 → host 注入文案走中文默认。
  const settings: MockSettings = {
    describe: () => [],
    mutate: async (): Promise<void> => undefined,
    configure: () => (): void => {
      void 0;
    },
  };
  const timer = {
    timeout(fn: () => void, ms: number) {
      const entry: TimerEntry = { fn, ms, cancelled: false, fired: false };
      ctx.timers.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  };
  Object.assign(provided, {
    agents: ctx.agentsService,
    settings,
    timer,
  });
  // 0.1.7：apply 第二参是 volatile 引用（按 scopeValue 现读，引用不变、值可变）。
  applyRescue(
    {
      settings,
      timer,
      fiber: { id: "abort-no-consume-fiber" },
      on: (event: string, handler: (payload: unknown) => void) => {
        ctx.handlers[event] = handler;
      },
      get: (name: string) => provided[name],
      effect: (factory: () => (() => void) | undefined) => {
        const disposer = factory();
        if (disposer) {
          ctx.disposers.push(disposer);
        }
      },
      // cordis `ctx.inject` 替身：依赖缺一就地红（替身静默跳过会让缺服务的路径
      // 溜到后续断言上，失败点远离成因）。sessionProjections 例外：mock 刻意不提供
      // 它——本文件钉的就是投影缺席时的回退扫描路径（host.ts 不把它写进插件级 inject，
      // 没装投影包的 profile 靠这个缺席走回退）。其余依赖缺一就是替身欠账，必须红。
      inject: (deps: string[], activate: (child: MockInjectCtx) => void) => {
        const missing = deps.filter(
          (dep) => dep !== "sessionProjections" && provided[dep] === undefined,
        );
        assert.deepEqual(missing, [], `inject 依赖缺失，替身无法激活：${missing.join(", ")}`);
        activate({
          effect: (factory) => {
            const disposer = factory();
            if (disposer) {
              ctx.disposers.push(disposer);
            }
          },
          get: (name: string) => provided[name],
          settings,
          reflect: {
            provide(name: string, service: unknown) {
              provided[name] = service;
              return () => {
                Reflect.deleteProperty(provided, name);
              };
            },
          },
        });
      },
    },
    () => ctx.scopeValue,
  );
  return ctx;
}

function makeAgent(ctx: MockCtx, id = "s1"): MockAgent {
  const evs: unknown[] = [];
  const agent: MockAgent = {
    id,
    options: { provider: "tokenrouter" },
    status: "idle",
    inbox: { nextTurn: [], nextStep: [] },
    session: { id, snapshotEvents: () => evs, evs },
    followup(message) {
      agent.followupCalls.push(message);
    },
    followupCalls: [],
  };
  ctx.agentsService.rootsList.push(agent);
  ctx.agentsService.byId.set(id, agent);
  return agent;
}

function turnEnd(turn: number, kind: string): unknown {
  return { type: "turn/end", seq: turn * 10, time: turn * 10, data: { turn, reason: { kind } } };
}

function countsOf(ctx: MockCtx): Record<string, number> {
  const service = ctx.service("sessionRescue") as {
    state: () => { sessions: Record<string, { count: number }> };
  };
  const st = service.state();
  return Object.fromEntries(Object.entries(st.sessions).map(([key, value]) => [key, value.count]));
}

/**
 * 一轮 tick 只触发这一轮已经武装的定时器。回调里新排的那一要等下一轮——直接遍历
 * `ctx.timers` 时，push 进去的条目会被同一个 for 循环顺带处理掉，「同一轮里二次武装」
 * 就成了测试替身独有的行为，与宿主的 timer 语义相反。
 */
function tick(ctx: MockCtx): void {
  // 先快照再触发：fn 内部新 push 的定时器属下一轮，不该在同一轮里被顺带触发。
  const snapshot = [...ctx.timers];
  for (const entry of snapshot) {
    if (!entry.fired && !entry.cancelled) {
      entry.fired = true;
      entry.fn();
    }
  }
}

describe("用户中止的回合不消耗续跑/继续配额", () => {
  let ctx: MockCtx;

  /** 取 agent/status 处理器；apply 没注册时直接红，避免 `?.()` 让用例永远通过。 */
  function idleHandler(context: MockCtx): (payload: unknown) => void {
    const handler = context.handlers["agent/status"];
    assert.ok(handler, "apply 必须注册 agent/status 处理器，否则本用例恒绿");
    return handler;
  }

  beforeEach(() => {
    ctx = createCtx();
  });

  it("aborted 回合的 idle 事件不重置也不消耗配额（counts 原样保留）", () => {
    const agent = makeAgent(ctx);
    agent.session.evs?.push(turnEnd(1, "error"));
    ctx.handlers["agent/error"]?.({
      agent,
      turn: 1,
      error: { failure: { code: "RATE_LIMIT", message: "x" } },
    });
    tick(ctx);
    assert.deepEqual(countsOf(ctx), { s1: 1 });
    // 武装延迟必须是 resume 那一档：误用 continue/unfinished 的延迟同样能进后续断言。
    assert.equal(ctx.timers[0]?.ms, ctx.scopeValue["resumeDelayMs"], "武装延迟取 resumeDelayMs");
    // 用户 abort turn 2 → idle：既不调度新待办，也不重置已有 count
    agent.session.evs?.push(turnEnd(2, "aborted"));
    idleHandler(ctx)({ agent, status: "idle" });
    assert.equal(ctx.timers.length, 1, "aborted idle 不得新增定时器");
    assert.deepEqual(countsOf(ctx), { s1: 1 }, "aborted 不得重置也不得消耗");
    // 直接钉住「没有注入」：首轮 error 已注入过一次，abort 之后不得出现第二次。
    tick(ctx);
    assert.equal(agent.followupCalls.length, 1, "aborted 回合不得再次注入");
  });

  it("interrupted 的 idle 事件同样既不调度也不重置配额", () => {
    const agent = makeAgent(ctx);
    agent.session.evs?.push(turnEnd(1, "error"));
    ctx.handlers["agent/error"]?.({
      agent,
      turn: 1,
      error: { failure: { code: "RATE_LIMIT", message: "x" } },
    });
    tick(ctx);
    agent.session.evs?.push(turnEnd(2, "interrupted"));
    idleHandler(ctx)({ agent, status: "idle" });
    assert.equal(ctx.timers.length, 1);
    assert.deepEqual(countsOf(ctx), { s1: 1 });
    tick(ctx);
    assert.equal(agent.followupCalls.length, 1, "interrupted 回合同样不得二次注入");
  });

  it("aborted 回合带着未闭合 todo 与待发送 inbox → idle 也不按 unfinished 补跑", () => {
    const agent = makeAgent(ctx);
    agent.session.evs?.push(turnEnd(1, "error"));
    ctx.handlers["agent/error"]?.({
      agent,
      turn: 1,
      error: { failure: { code: "RATE_LIMIT", message: "x" } },
    });
    tick(ctx);
    assert.equal(ctx.timers.length, 1, "基线：首轮 error 已武装一个待办");
    // turn 2：本回合写过清单且未闭合，inbox 也有下一轮可投 —— 完成态走到的 unfinished
    // 分支在这里全部满足；aborted 判定必须在它之前把整条路关死。
    agent.session.evs?.push({ type: "turn/start", seq: 20, time: 20, data: { turn: 2 } });
    agent.session.evs?.push({
      type: "todo/write",
      seq: 21,
      time: 21,
      data: { todos: [{ title: "a", status: "pending" }] },
    });
    agent.session.evs?.push(turnEnd(2, "aborted"));
    agent.inbox = { nextTurn: [{}], nextStep: [] };
    idleHandler(ctx)({ agent, status: "idle" });
    assert.equal(ctx.timers.length, 1, "aborted 回合不得被当成 unfinished 的补跑时机");
    tick(ctx);
    assert.equal(agent.followupCalls.length, 1, "不得出现第二次注入");
  });

  it("tick 只触发本轮已武装的定时器：回调里新排的那一等下一轮", () => {
    // 直接遍历数组时，回调里 push 进来的定时器会被同一个循环顺带处理掉——「同一轮里二次触发」
    // 就成了替身独有的行为，与宿主 timer 的语义相反，而 scheduleInjection 的回调正是会再排一发的形状。
    const order: string[] = [];
    ctx.timers.push({
      fn: () => {
        order.push("first");
        ctx.timers.push({
          fn: () => {
            order.push("nested");
          },
          ms: 5,
          cancelled: false,
          fired: false,
        });
      },
      ms: 1,
      cancelled: false,
      fired: false,
    });
    tick(ctx);
    assert.deepEqual(order, ["first"], "同一轮不得触发刚登记的那一枚");
    tick(ctx);
    assert.deepEqual(order, ["first", "nested"], "下一轮才轮到它");
  });

  it("插件卸载：effect 的清理函数要撤掉在途的调度待办", () => {
    const agent = makeAgent(ctx);
    agent.session.evs?.push(turnEnd(1, "error"));
    ctx.handlers["agent/error"]?.({
      agent,
      turn: 1,
      error: { failure: { code: "RATE_LIMIT", message: "x" } },
    });
    assert.equal(ctx.timers.length, 1, "基线：在途待办已武装");
    assert.ok(ctx.disposers.length > 0, "apply 的 effect 必须交回清理函数");
    for (const disposer of ctx.disposers) {
      disposer();
    }
    assert.ok(
      ctx.timers.every((entry) => entry.cancelled),
      "卸载后在途待办全部撤销，不再唤醒注入",
    );
    tick(ctx);
    assert.equal(agent.followupCalls.length, 0, "卸载后不得注入");
  });

  it("倒计时内用户开新轮并 abort → fire 时按 newer-turn 否决，不补发不计数", () => {
    const agent = makeAgent(ctx);
    agent.session.evs?.push(turnEnd(1, "error"));
    ctx.handlers["agent/error"]?.({
      agent,
      turn: 1,
      error: { failure: { code: "RATE_LIMIT", message: "x" } },
    });
    assert.equal(ctx.timers.length, 1, "瞬时失败已武装一个待办");
    // 用户在倒计时内亲手开了 turn 2 又停掉它：turn/start 2 已写到磁盘即代表"人在干活"。
    agent.session.evs?.push({ type: "turn/start", seq: 20, time: 20, data: { turn: 2 } });
    agent.session.evs?.push(turnEnd(2, "aborted"));
    tick(ctx);
    assert.equal(agent.followupCalls.length, 0, "用户接手的回合不得被自动注入打断");
    assert.deepEqual(countsOf(ctx), { s1: 0 }, "被否决的注入不消耗配额");
  });

  it("对照：普通 error 回合仍照常调度（abort 判定不误伤正常路径）", () => {
    const agent = makeAgent(ctx);
    agent.session.evs?.push(turnEnd(2, "error"));
    ctx.handlers["agent/error"]?.({
      agent,
      turn: 2,
      error: { failure: { code: "RATE_LIMIT", message: "x" } },
    });
    assert.equal(ctx.timers.length, 1);
    tick(ctx);
    assert.equal(agent.followupCalls.length, 1, "武装的待办真的注入");
    assert.deepEqual(countsOf(ctx), { s1: 1 }, "注入消耗配额");
  });
});
