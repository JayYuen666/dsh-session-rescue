// 线格式与渲染决策的属性面：`/state` 的响应体与 dock 的渲染判据是本包唯一两处
// 「把外部数据变成界面」的地方。它们必须对**任意** JSON 全性、且不会因为一个坏字段
// 把整张表的原型换掉（`__proto__` 那条已在单测里钉过具体形状，这里跑随机形态）。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import fc from "fast-check";
import { decideDockState, parseStateBody } from "../../lib/dock-state.ts";
import type {
  DockActionSignals,
  RescueSessionState,
  RescueStateBody,
} from "../../lib/dock-state.ts";
import { backoffMs, nextPollMs } from "../../src/client-entry.ts";

/** 退避上限（与 src/client-entry.ts 的 DEAD_POLL_CEILING_MS 同值；判据自持，不导入被测常量）。 */
const BACKOFF_CEILING_MS = 30_000;
const SLOW_POLL_MS = 5000;

/** 任意 JSON 值（含深层对象/数组/null/字符串/数字/布尔）。 */
const jsonArbitrary = fc.jsonValue();

/** 会话表的一条 wire 行：四位全都可以是任意 JSON。 */
const wireEntryArbitrary = fc.record(
  {
    count: jsonArbitrary,
    lastFireAt: jsonArbitrary,
    pending: jsonArbitrary,
    disabled: jsonArbitrary,
  },
  { requiredKeys: [] },
);

/** 一张 wire 会话表：随机键 + 随机行，另加一枚显式 `__proto__` 键保证原型那条路必走。
 *  `size: "max"` 让 `maxKeys` 真的参与抽样——默认的 baseSize 只会给到个位数键，
 *  多条目降级、坏行混好行这些形态就碰不到。 */
const wireSessionsArbitrary = fc.oneof(
  fc.dictionary(fc.string(), wireEntryArbitrary, { maxKeys: 6, size: "max" }),
  fc.dictionary(fc.string(), jsonArbitrary, { maxKeys: 6, size: "max" }),
  fc.constant({ __proto__: { count: 1, pending: null } }),
);

const NO_ACTIONS: DockActionSignals = {
  canStopReask: false,
  canEdit: false,
  canRetry: false,
  canContinue: false,
  editing: false,
  hostActionFailed: false,
};

function actionsOf(flags: boolean[]): DockActionSignals {
  return {
    canStopReask: flags[0] === true,
    canEdit: flags[1] === true,
    canRetry: flags[2] === true,
    canContinue: flags[3] === true,
    editing: flags[4] === true,
    hostActionFailed: flags[5] === true,
  };
}

/** 把一张 wire 表包成完整响应体再解析（返回 null = 解析器判它无效）。 */
function parseWireSessions(sessions: unknown): RescueStateBody | null {
  return parseStateBody({ ok: true, sessions });
}

/** 一条已解析会话行的类型面（本层要撞的就是「坏形状有没有被降级干净」）。 */
function assertEntryShape(entry: RescueSessionState): void {
  assert.equal(typeof entry.count, "number");
  assert.ok(!Number.isNaN(entry.count), "count 不得是 NaN（渲染会写出 NaN 次）");
  assert.equal(typeof entry.lastFireAt, "number");
  const { pending } = entry;
  if (pending !== null) {
    // pending 只认「四位齐全且类型正确」的形状：坏 pending 一律降级为 null，否则 dock
    // 会拿着 undefined 的 remainingMs 渲染出 NaN 秒倒计时。
    assert.equal(typeof pending.turn, "number");
    assert.equal(typeof pending.kind, "string");
    assert.equal(typeof pending.fireAt, "number");
    assert.equal(typeof pending.remainingMs, "number");
  }
}

describe("/state 载荷解析（任意 JSON）", () => {
  it("全性：任意输入要么 null、要么一份形状完好的快照，且绝不抛", () => {
    const bodyArbitrary = fc.record(
      { ok: jsonArbitrary, sessions: jsonArbitrary },
      { requiredKeys: [] },
    );
    const inputArbitrary = fc.oneof(jsonArbitrary, bodyArbitrary, fc.array(jsonArbitrary));
    fc.assert(
      fc.property(inputArbitrary, (raw) => {
        const parsed = parseStateBody(raw as never);
        if (parsed === null) {
          return;
        }
        assert.equal(parsed.ok, true, "非 null 必须是 ok:true");
        for (const [id, entry] of Object.entries(parsed.sessions ?? {})) {
          assert.equal(typeof id, "string");
          assertEntryShape(entry);
        }
      }),
      { numRuns: 2000 },
    );
  });

  it("原型污染防线：任意表形下 sessions 的原型都是 Object.prototype", () => {
    // 恶意/畸形载荷里 `"__proto__": {...}` 是真实会遇到的形状（日志聚合、别家插件写的
    // 中间层）。按条目构造表就碰不到原型 setter——这条随机跑的是「换 N 种坏值都不破」。
    fc.assert(
      fc.property(wireSessionsArbitrary, (sessions) => {
        const table = parseWireSessions(sessions)?.sessions;
        if (table === undefined) {
          return;
        }
        assert.equal(Object.getPrototypeOf(table), Object.prototype);
        assert.equal(Object.getPrototypeOf({}), Object.prototype, "全局原型未被换掉");
      }),
      { numRuns: 800 },
    );
  });

  it("计数降级：非数字落回 0，但不被擅自取整", () => {
    fc.assert(
      fc.property(wireSessionsArbitrary, (sessions) => {
        const parsed = parseWireSessions(sessions);
        // 判据收在「是个数、且不是 NaN」：解析器承诺的是「非数字落回 0」，它没承诺取整，
        // 也不该被断言取整（`5e-324` 那样的正当数字不是缺陷——本层第一版就在这里误判过）。
        for (const entry of Object.values(parsed?.sessions ?? {})) {
          assertEntryShape(entry);
        }
        // 无效载荷也要留下一次断言：`{ok:true}` 之外的表形都该被整体拒收，
        // 而不是半张表进快照。
        assert.ok(parsed === null || parsed.ok, "解析结果要么 null、要么 ok:true");
      }),
      { numRuns: 500 },
    );
  });
});

describe("轮询档位与退避（数值面）", () => {
  it("退避随连跳单调不减、且有上限；0/1 跳都交回原档", () => {
    const baseArbitrary = fc.integer({ min: 1, max: BACKOFF_CEILING_MS });
    const streaksArbitrary = fc.array(fc.integer({ min: 0, max: 40 }), {
      minLength: 2,
      maxLength: 12,
      size: "max",
    });
    fc.assert(
      fc.property(baseArbitrary, streaksArbitrary, (base, streaksRaw) => {
        // 单调性是对**连跳数**说的，不是对调用到达顺序说的：先升序再比。
        const streaks = [0, 1, ...streaksRaw].toSorted((left, right) => left - right);
        let previous = backoffMs(base, streaks[0] ?? 0);
        for (const streak of streaks) {
          const next = backoffMs(base, streak);
          assert.ok(next >= base, `退避不得低于原档（streak=${String(streak)}）`);
          assert.ok(next >= previous, "连跳越多间隔不得变短");
          previous = next;
        }
        assert.ok(previous <= BACKOFF_CEILING_MS, `必须封顶（得到 ${String(previous)}）`);
      }),
      { numRuns: 500 },
    );
  });

  it("上限是无条件的：原档本身就比上限大时也压回上限", () => {
    assert.equal(backoffMs(31_000, 9), BACKOFF_CEILING_MS);
  });

  it("快照里没有 pending 就永远是慢档", () => {
    const rowArbitrary = fc.record(
      { count: fc.nat({ max: 5 }), lastFireAt: fc.nat(), pending: fc.constant(null) },
      { requiredKeys: ["count", "lastFireAt", "pending"] },
    );
    fc.assert(
      fc.property(fc.array(rowArbitrary, { maxLength: 5, size: "max" }), (entries) => {
        const wire: Record<string, unknown> = {};
        for (const [index, entry] of entries.entries()) {
          wire[`s${String(index)}`] = entry;
        }
        // 走真实解析路径再喂档位判定：`nextPollMs` 的入参是解析后的快照类型，
        // 直接塞未解析的表只是在测一个不存在的调用形状。
        const parsed = parseWireSessions(wire);
        assert.notEqual(parsed, null);
        assert.equal(nextPollMs(parsed), SLOW_POLL_MS, "无 pending ⇒ 慢档");
      }),
      { numRuns: 200 },
    );
  });
});

describe("dock 渲染决策（信号组合）", () => {
  it("hasContent 恰等于「有区块要渲染」；toggle=unknown 恰等于「快照不在场」", () => {
    const flagsArbitrary = fc.array(fc.boolean(), { minLength: 6, maxLength: 6 });
    const rescueArbitrary = fc.oneof(fc.constant(null), fc.constant({ ok: true } as const));
    fc.assert(
      fc.property(flagsArbitrary, rescueArbitrary, (flags, rescue) => {
        const actions = actionsOf(flags);
        const decision = decideDockState(actions, rescue, "s1");
        const anyBlock =
          decision.pending !== null ||
          decision.showToggleRow ||
          actions.canStopReask ||
          actions.canEdit ||
          actions.canRetry ||
          actions.canContinue ||
          actions.editing ||
          actions.hostActionFailed;
        assert.equal(decision.hasContent, anyBlock, "hasContent 必须恰等于「有区块要渲染」");
        // 快照未就绪时 toggle 只能是中性态、开关行只能是隐藏（把「还没同步到」显示成
        // 「已关闭」是旧缺陷，动作位也不该把开关行带出来）。
        assert.equal(decision.toggle === "unknown", rescue === null);
        assert.equal(decision.showToggleRow, rescue !== null);
        assert.equal(decision.rescueKnown, rescue !== null);
      }),
      { numRuns: 100 },
    );
  });

  it("无信号且无快照 ⇒ 容器隐藏（组件仍常驻，这条只判容器）", () => {
    const decision = decideDockState(NO_ACTIONS, null, "s1");
    assert.equal(decision.hasContent, false);
    assert.equal(decision.showToggleRow, false);
  });
});
