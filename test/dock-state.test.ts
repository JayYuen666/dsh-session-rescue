// dock-state.test.ts —— dock 区域渲染决策纯函数单测（竞态修复 + 动作位可见性）。
// 覆盖四件事：首帧快照未就绪 / 会话未在快照中 / disabled 状态 /
// hasContent 多源合并（实时动作位在快照缺失时仍要显形）。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { decideDockState, parseStateBody } from "../lib/dock-state.ts";
import type { DockActionSignals, RescueStateBody, RescueSessionState } from "../lib/dock-state.ts";

/** 全部信号位关（hero 空态：会话未开始）。 */
const NO_ACTIONS: DockActionSignals = {
  canStopReask: false,
  hostActionFailed: false,
  sessionStarted: false,
};

/** 只亮一位（其余全关）：hasContent 归属判定用。 */
function oneAction(key: keyof DockActionSignals): DockActionSignals {
  return { ...NO_ACTIONS, [key]: true };
}

/** 会话已开始（转录非空或回合在跑）的动作位。 */
const STARTED: DockActionSignals = { ...NO_ACTIONS, sessionStarted: true };

const sessionId = "s1";

/** 造一个 host 快照（sessions 只含给定会话）。 */
function mkRescue(sessions: Record<string, RescueSessionState> = {}): RescueStateBody {
  return { ok: true, sessions };
}
const session = (overrides: Partial<RescueSessionState> = {}): RescueSessionState => ({
  count: 0,
  lastFireAt: 0,
  pending: null,
  ...overrides,
});
const pending = { turn: 1, kind: "resume", fireAt: Date.now() + 30_000, remainingMs: 30_000 };

describe("decideDockState：快照未就绪（首帧 rescue=null）", () => {
  it('rescueKnown=false、toggle=unknown、不显示开关行（不再默认"开启"）', () => {
    const decision = decideDockState(NO_ACTIONS, null, sessionId);
    assert.equal(decision.rescueKnown, false);
    assert.equal(decision.toggle, "unknown");
    assert.equal(decision.showToggleRow, false);
    assert.equal(decision.hasContent, false);
  });

  it("快照未就绪但实时动作位在 → 区域仍显示内容", () => {
    const decisionStop = decideDockState(oneAction("canStopReask"), null, sessionId);
    assert.equal(decisionStop.hasContent, true, "停止重问按钮是实时状态，不该被轮询空窗吞掉");
  });
});

describe("decideDockState：会话未在快照中（从未调度续跑/未 toggle 过）", () => {
  it('快照就绪但该会话无记录 → toggle=on（未关闭 = 默认开启，不显示"—"误导）', () => {
    const decision = decideDockState(STARTED, mkRescue({}), sessionId);
    assert.equal(decision.rescueKnown, true);
    assert.equal(decision.toggle, "on", "host 快照只含调度/关闭过的会话；未记录即未关闭，默认开启");
    assert.equal(decision.showToggleRow, true, "快照已就绪，开关行可显示");
  });

  it("hero 空态（会话未开始）→ 开关行隐藏，即使快照已就绪", () => {
    // 一条消息都没发过的新会话不展示「本会话开关」：对零交互会话是噪音。
    const decision = decideDockState(NO_ACTIONS, mkRescue({}), sessionId);
    assert.equal(decision.rescueKnown, true);
    assert.equal(decision.toggle, "on", "三态判定不受影响，只是行不渲染");
    assert.equal(decision.showToggleRow, false, "未开始 ⇒ 开关行隐藏");
    assert.equal(decision.hasContent, false, "无 pending/动作位 ⇒ 容器整体隐藏");
  });

  it("开关行可见性只看会话已开始位，不看快照里有该会话的记录", () => {
    // 有记录（调度过/被关过）但转录为空（重启后恢复的会话视图）同样隐藏。
    const decision = decideDockState(
      NO_ACTIONS,
      mkRescue({ [sessionId]: session({ disabled: true }) }),
      sessionId,
    );
    assert.equal(decision.toggle, "off");
    assert.equal(decision.showToggleRow, false, "sessionStarted=false 压过一切显示条件");
  });
});

describe("decideDockState：disabled 状态", () => {
  it("disabled=true → toggle=off（已关闭）", () => {
    const decision = decideDockState(
      NO_ACTIONS,
      mkRescue({ [sessionId]: session({ disabled: true }) }),
      sessionId,
    );
    assert.equal(decision.toggle, "off");
  });

  it("disabled=false → toggle=on（开启）", () => {
    const decision = decideDockState(
      NO_ACTIONS,
      mkRescue({ [sessionId]: session({ disabled: false }) }),
      sessionId,
    );
    assert.equal(decision.toggle, "on");
  });
});

describe("decideDockState：pending 与 hasContent 合并", () => {
  it("pending 非空 → 快照就绪 + 区域有内容", () => {
    const decision = decideDockState(
      NO_ACTIONS,
      mkRescue({ [sessionId]: session({ pending }) }),
      sessionId,
    );
    // 字段一致即可：透传还是重建投影是实现细节，断言不该绑在对象同一性上。
    assert.deepEqual(decision.pending, pending);
    assert.equal(decision.hasContent, true);
  });

  it("非有限数值不落进快照：NaN 计数归零、NaN 的 pending 整条丢弃", () => {
    // `typeof === "number"` 放行 NaN/Infinity，而它们的下游是文案与倒计时（"NaN 次"、
    // "NaN 秒"）。载荷来自网关交回的对象，不保证已经过 JSON 解析，所以守卫要在投影处。
    const body = parseStateBody({
      ok: true,
      sessions: {
        [sessionId]: {
          count: Number.NaN,
          lastFireAt: Number.POSITIVE_INFINITY,
          pending: { turn: 1, kind: "resume", fireAt: 0, remainingMs: Number.NaN },
        },
      },
    });
    if (body?.sessions === undefined) {
      throw new Error("parseStateBody 应当接受这份形状正常的载荷");
    }
    const projected = body.sessions[sessionId];
    if (projected === undefined) {
      throw new Error("该会话应当被保留在投影里");
    }
    assert.equal(projected.count, 0, "NaN 计数按「读不到」归零");
    assert.equal(projected.lastFireAt, 0, "Infinity 同样归零");
    assert.equal(projected.pending, null, "remainingMs 为 NaN 的 pending 必须整条丢掉");
  });

  it("blocked 位：好形状投影，坏形状整位丢弃，缺位不写", () => {
    // blocked 是客户端升级提示的来源：坏形状宁可不提示，也不把坏值弹给用户。
    const good = parseStateBody({
      ok: true,
      sessions: {
        [sessionId]: {
          count: 0,
          lastFireAt: 0,
          pending: null,
          blocked: { kind: "resume", turn: 3 },
        },
      },
    });
    assert.deepEqual(good?.sessions?.[sessionId]?.blocked, { kind: "resume", turn: 3 });
    const bad = parseStateBody({
      ok: true,
      sessions: {
        [sessionId]: {
          count: 0,
          lastFireAt: 0,
          pending: null,
          blocked: { kind: 42, turn: "x" },
        },
      },
    });
    assert.equal(bad?.sessions?.[sessionId]?.blocked, undefined, "坏形状整位丢弃");
    const absent = parseStateBody({
      ok: true,
      sessions: { [sessionId]: { count: 0, lastFireAt: 0, pending: null } },
    });
    assert.equal(absent?.sessions?.[sessionId]?.blocked, undefined, "缺位不写");
  });

  it("sessions 形状损坏 → null（这一跳没读到有效快照），不是一份确信的空快照", () => {
    // 「读坏了」与「读到了，只是没有会话」必须分开：后者是确信的空快照（开关行照常
    // 显示、每个会话按没关过判 on），前者该让调用方退避。折成同一个值等于把读坏
    // 显示成一切正常。
    for (const broken of [[], "sessions", 42, true] as const) {
      assert.equal(
        parseStateBody({ ok: true, sessions: broken }),
        null,
        `sessions=${JSON.stringify(broken)} 是坏载荷，不能当成空快照`,
      );
    }
  });

  it("根级坏载荷 → null（ok 非 true / 缺位 / 入参非对象）", () => {
    // /state 读到 401 页、代理折返 HTML、网关给回错误 JSON 时，根级形状先崩：
    // 这些与「空快照」的区分由信封 schema 的 ok 字面量位承担，单测逐形钉死。
    assert.equal(parseStateBody({ ok: false }), null, "ok:false 不是成功信封");
    assert.equal(parseStateBody({}), null, "ok 缺位同样不是成功信封");
    assert.equal(parseStateBody({ ok: "true" }), null, "字符串 true 不等于字面量 true");
    assert.equal(parseStateBody(null as never), null, "null 入参");
    assert.equal(parseStateBody([1, 2] as never), null, "数组不是记录");
    assert.equal(parseStateBody(42 as never), null, "数字不是记录");
    assert.equal(parseStateBody("ok" as never), null, "字符串不是记录");
  });

  it("sessions 缺位 → 一份就绪但没有会话的快照（更早版本的载荷）", () => {
    const body = parseStateBody({ ok: true });
    assert.notEqual(body, null);
    if (body === null) {
      throw new Error("ok:true 的载荷应当解析成一份就绪快照");
    }
    assert.equal(body.ok, true);
    assert.equal(body.sessions, undefined, "缺位不补一张空表：补了就无法与「真的没有会话」区分");
    // 旧载荷的下游语义一并钉住：就绪快照 + 会话已开始 ⇒ 开关行在场、按没关过判 on、
    // 区域有内容（showToggleRow 进 hasContent）。这一组默认值是本模块最容易漂移的地方。
    const decision = decideDockState(STARTED, body, sessionId);
    assert.equal(decision.rescueKnown, true);
    assert.equal(decision.showToggleRow, true);
    assert.equal(decision.toggle, "on");
    assert.equal(decision.hasContent, true, "开关行在场 ⇒ 区域有内容");
  });

  it("快照空窗 + 无 pending，但任一实时位亮 → 容器必须显形", () => {
    // 实时位的可用性只取决于实时 view，与快照在不在场无关。旧判据漏算实时位：
    // 容器 hidden，而容器里那行内容本该在——用户看到的就是「有话要说却整块消失」，
    // 尤其是 /state 一直读不通的那种部署。canStopReask 在「快照未就绪」一节单独亮过，
    // 这里补齐 hostActionFailed。
    for (const key of ["hostActionFailed"] as const) {
      const decision = decideDockState(oneAction(key), null, sessionId);
      assert.equal(decision.hasContent, true, `${key} 一位亮 ⇒ 区域有内容`);
      assert.equal(decision.showToggleRow, false, "开关行仍按快照在场与否判，不因动作位而变");
    }
  });
});
