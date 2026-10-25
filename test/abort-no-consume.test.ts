import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { applyRescue } from "./config-refs.ts";

// E5：用户主动中止/打断的回合绝不能烧掉 maxResumes/maxContinues 配额。
//
// 判定位置（item 10 核实后修正）：中止信号在事件流里是 turn/end
// reason.kind='aborted'（'interrupted' 同视），而 harness 的 agent-loop 在
// `catch` 里 emit('agent/error')、在 `finally` 里才 append('turn/end')，且被
// abort 的回合直接 rethrow、**根本不发 agent/error**（core/agent-loop/src/agent.ts
// :322-341）。所以 abort 保护只能落在 agent/status 侧（此刻 turn/end 已就位）：
// 原先在 agent/error 侧扫 turn/end 的那段判定永远空扫，是死代码，已删。

const STATE = "/_dsh/session-rescue/state";

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
/** 0.1.7 的 settings 服务面（installed dsh-settings/lib/types/index.d.ts）：
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
  /** cordis 的注入子上下文同样带着被注入服务的读面（settings.configure 走这条路：
   *  apply 里 `svc.inject(['settings'], child => child.effect(() => child.settings
   *  .configure({ auto: false }, svc.fiber)))`）。缺这个成员，替身在激活时就少了
   *  宿主真正会调的那一手。 */
  settings: MockSettings;
}

interface MockCtx {
  handlers: Record<string, (payload: unknown) => void>;
  timers: TimerEntry[];
  routes: Map<string, { handler: (req: IncomingMessage, res: ServerResponse) => void }>;
  scopeValue: Record<string, unknown>;
  agentsService: {
    rootsList: MockAgent[];
    byId: Map<string, MockAgent>;
    roots: () => { id: string }[];
    get: (id: string) => MockAgent | undefined;
  };
}

function createCtx(): MockCtx {
  const ctx: MockCtx = {
    handlers: {},
    timers: [],
    routes: new Map(),
    scopeValue: {
      enabled: true,
      providerExcludes: [],
      resumeDelayMs: 10_000,
      resumeCooldownMs: 0,
      maxResumes: 3,
      chainResumeDelayMs: 60_000,
      continueDelayMs: 3000,
      continueCooldownMs: 0,
      maxContinues: 3,
      resumeOnOpenTodos: true,
      unfinishedDelayMs: 5000,
      unfinishedCooldownMs: 0,
      maxUnfinished: 2,
    },
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
  const webServer = {
    register(route: {
      path: string;
      handler: (req: IncomingMessage, res: ServerResponse) => void;
    }) {
      ctx.routes.set(route.path, route);
      return () => {
        ctx.routes.delete(route.path);
      };
    },
  };
  const provided: Record<string, unknown> = {
    agents: ctx.agentsService,
    settings,
    timer,
    webServer,
  };
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
        factory();
      },
      // cordis `ctx.inject` 替身：依赖齐了才激活（本测试恒齐），子 effect 立即执行。
      inject: (deps: string[], activate: (child: MockInjectCtx) => void) => {
        const ready = deps.every((dep) => provided[dep] !== undefined);
        if (ready) {
          activate({
            effect: (factory) => void factory(),
            get: (name: string) => provided[name],
            settings,
          });
        }
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
  let body = "";
  ctx.routes.get(STATE)?.handler(
    { method: "GET", url: STATE, headers: {} } as unknown as IncomingMessage,
    {
      writeHead() {
        void 0;
      },
      setHeader() {
        void 0;
      },
      end: (chunk?: string) => {
        body = chunk ?? "";
      },
    } as unknown as ServerResponse,
  );
  const st = JSON.parse(body) as { sessions: Record<string, { count: number }> };
  return Object.fromEntries(Object.entries(st.sessions).map(([key, value]) => [key, value.count]));
}

function tick(ctx: MockCtx): void {
  for (const entry of ctx.timers) {
    if (!entry.fired && !entry.cancelled) {
      entry.fired = true;
      entry.fn();
    }
  }
}

describe("用户中止的回合不消耗续跑/继续配额", () => {
  let ctx: MockCtx;
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
    // 用户 abort turn 2 → idle：既不调度新待办，也不重置已有 count
    agent.session.evs?.push(turnEnd(2, "aborted"));
    ctx.handlers["agent/status"]?.({ agent, status: "idle" });
    assert.equal(ctx.timers.length, 1, "aborted idle 不得新增定时器");
    assert.deepEqual(countsOf(ctx), { s1: 1 }, "aborted 不得重置也不得消耗");
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
    ctx.handlers["agent/status"]?.({ agent, status: "idle" });
    assert.equal(ctx.timers.length, 1);
    assert.deepEqual(countsOf(ctx), { s1: 1 });
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
    // 用户在倒计时内亲手开了 turn 2 又停掉它：turn/start 2 已落盘即代表"人在干活"。
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
  });
});
