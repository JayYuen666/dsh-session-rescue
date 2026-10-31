// 投影 ≡ 扫描的属性面：turn-facts 的全部价值就在「增量折叠的当前态」与「整串日志的同步
// 扫描」逐项同解（单测 test/turn-facts.test.ts 钉的是作者手写的十几串日志）。这一层把
// 输入面换成**随机事件流**：轮次号乱序/重复/缺字段、终态缺号、消息没有 source、source
// 是数字、todo 载荷不是数组、ask_user_question 缺 turn……崩溃恢复与宿主版本漂移给出的
// 就是这类形状，而它们恰是「采信条件」该守住的地方。
//
// 断言的是三条读法各自的可采信承诺，不是「两边一定相等」：
//   - 不可采信时必须**交回 undefined**（让 host 回退扫描），而不是给出一个自信的错答案；
//   - 交回了值，就必须与扫描逐项同解；
//   - 折叠本身对任意输入全性、且折出来的态过自己的 stateSchema（形状漂了这里先红，
//     而不是等 host 在 stateOf 上读到坏值）。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import fc from "fast-check";
import { reviewLastTurn } from "../../lib/turn-review.ts";
import {
  asFacts,
  hasNewerTurn,
  reviewFromFacts,
  scanNewerTurn,
  scanOpenerKind,
  turnOpenerKind,
} from "../../lib/turn-facts.ts";
import { foldEvents } from "../turn-facts-fold.ts";

/** 轮次号取值：正常档 + 边界（0、相邻、跳跃）+ 缺失/非数字的脏形状。 */
const turnNoArbitrary = fc.oneof(
  fc.integer({ min: 0, max: 12 }),
  fc.integer({ min: -3, max: 3 }),
  fc.constant(undefined),
  fc.constant(1.5),
  fc.constant(Number.NaN),
);

const sourceArbitrary = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.constant({ kind: "goal" }),
  fc.constant({ kind: "schedule" }),
  fc.constant({ kind: "plugin:session-rescue" }),
  fc.constant({ kind: "user" }),
  fc.constant({ kind: 7 }),
  fc.constant({}),
  fc.string(),
);

const reasonArbitrary = fc.oneof(
  fc.constant(undefined),
  fc.constantFrom("completed", "error", "max-tokens", "aborted", "interrupted", "blocked"),
  fc.string(),
);

/** todo 项：状态可以是任意串（`completed` 之外都算未闭合）。 */
const todoItemArbitrary = fc.record(
  {
    content: fc.string(),
    status: fc.oneof(fc.constant("pending"), fc.constant("completed"), fc.string()),
  },
  { requiredKeys: [] },
);

const todosPayloadArbitrary = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.constant("todos"),
  fc.constant([]),
  fc.array(todoItemArbitrary, { maxLength: 4, size: "max" }),
);

/** 各事件的 `data` 面（一层就到位，避免 `max-nested-calls`；也更容易看出测的是哪几位）。 */
const startDataArbitrary = fc.record({ turn: turnNoArbitrary }, { requiredKeys: [] });
const endReasonArbitrary = fc.record({ kind: reasonArbitrary }, { requiredKeys: [] });
const endDataArbitrary = fc.record(
  { turn: turnNoArbitrary, reason: endReasonArbitrary },
  { requiredKeys: [] },
);
const userDataArbitrary = fc.record(
  { role: fc.constant("user"), content: fc.constant([]), source: sourceArbitrary },
  { requiredKeys: [] },
);
const toolDataArbitrary = fc.record(
  {
    turn: turnNoArbitrary,
    name: fc.oneof(fc.constant("ask_user_question"), fc.constant("bash"), fc.constant(undefined)),
  },
  { requiredKeys: [] },
);
const todoDataArbitrary = fc.record({ todos: todosPayloadArbitrary }, { requiredKeys: [] });

/** 一条会话事件（只带本模块会读的字段；多余的噪声事件也要有，折叠的 default 分支才有人走）。 */
const eventArbitrary = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({ type: fc.constant("turn/start"), data: startDataArbitrary }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ type: fc.constant("turn/end"), data: endDataArbitrary }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ type: fc.constant("user/message"), data: userDataArbitrary }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ type: fc.constant("tool/call"), data: toolDataArbitrary }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ type: fc.constant("todo/write"), data: todoDataArbitrary }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ type: fc.string(), data: fc.record({}, { requiredKeys: [] }) }),
  },
  { weight: 1, arbitrary: fc.record({ type: fc.constant("turn/end") }) },
  { weight: 1, arbitrary: fc.constant({ type: "user/message" }) },
);

// `size: "max"`：fast-check 默认按 baseSize 抽长度，`maxLength` 只是上界（实测 40 的上界
// 默认只到个位数），而折叠语义要在**长序列**上才成立。
const eventsArbitrary = fc.array(eventArbitrary, { maxLength: 40, size: "max" });

/** 事件表里出现过的最大轮次号上界（断言遍历的号码范围据此定，不写死）。 */
function maxTurnOf(events: readonly unknown[]): number {
  let max = 3;
  for (const event of events) {
    const { data } = event as { data?: Record<string, unknown> };
    const turn = data?.["turn"];
    if (typeof turn === "number" && Number.isFinite(turn)) {
      max = Math.max(max, Math.trunc(turn) + 2);
    }
  }
  return Math.min(max, 40);
}

describe("回合事实投影 ≡ 同步扫描（随机日志）", () => {
  it("折叠全性：任意事件流都不抛，且折出的态过自己的 stateSchema", () => {
    fc.assert(
      fc.property(eventsArbitrary, (events) => {
        const state = foldEvents(events);
        // 形状漂移（多一位/少一位/类型换掉）必须在这里红：host 侧 asFacts 拒收就等于
        // 三类判定整批回退全量扫描——功能不坏，但 O(1) 读的说法就没了。
        const reparsed = asFacts(structuredClone(state));
        assert.deepEqual(
          reparsed.status === "facts" ? reparsed.facts : reparsed,
          state,
          "折叠态必须能被自己的 schema 原样接住",
        );
      }),
      { numRuns: 800 },
    );
  });

  it("折叠是纯函数：同一串事件折两次得到同一个值", () => {
    fc.assert(
      fc.property(eventsArbitrary, (events) => {
        assert.deepEqual(foldEvents(events), foldEvents(events), "同串同值");
      }),
      { numRuns: 300 },
    );
  });

  it("newer-turn veto：投影位与倒扫逐项同解（无需可采信前提）", () => {
    fc.assert(
      fc.property(eventsArbitrary, (events) => {
        const state = foldEvents(events);
        const maxTurn = maxTurnOf(events);
        for (let turn = 0; turn <= maxTurn; turn += 1) {
          assert.equal(
            hasNewerTurn(state, turn),
            scanNewerTurn(events, turn),
            `newer-turn(${turn}) 两侧必须同解`,
          );
        }
      }),
      { numRuns: 800 },
    );
  });

  it("opener 身份：投影给出值时必须与顺扫同解；给不出值必须是「不在窗口」", () => {
    fc.assert(
      fc.property(eventsArbitrary, (events) => {
        const state = foldEvents(events);
        const maxTurn = maxTurnOf(events);
        for (let turn = 0; turn <= maxTurn; turn += 1) {
          const projected = turnOpenerKind(state, turn);
          if (projected === undefined) {
            assert.equal(
              state.openers.some((row) => row.turn === turn),
              false,
              `只有该回合不在表里才交回 undefined（turn=${turn}）`,
            );
          } else {
            assert.equal(projected, scanOpenerKind(events, turn), `opener(${turn}) 两侧必须同解`);
          }
        }
      }),
      { numRuns: 800 },
    );
  });

  it("回合复盘：可采信时与 reviewLastTurn 逐项同解；不可采信只可能是那条 end 对不上它的 start", () => {
    fc.assert(
      fc.property(eventsArbitrary, (events) => {
        const state = foldEvents(events);
        const projected = reviewFromFacts(state);
        if (projected === undefined) {
          assert.ok(
            state.end !== null && !state.end.aligned,
            "只有最后一条 end 对不上它的 start 时才交回 undefined",
          );
          return;
        }
        assert.deepEqual(projected, reviewLastTurn(events), "复盘两侧必须逐项同解");
      }),
      { numRuns: 1200 },
    );
  });

  it("latestTurnStart 单调：前缀的最大值不会超过全量的最大值", () => {
    fc.assert(
      fc.property(eventsArbitrary, fc.nat({ max: 40 }), (events, cut) => {
        const prefix = events.slice(0, cut % (events.length + 1));
        const head = foldEvents(prefix).latestTurnStart;
        const full = foldEvents(events).latestTurnStart;
        if (head === null) {
          return;
        }
        // 全量日志里连一个可数的 turn/start.turn 都没有时（前缀却有）——不可能：前缀是子集。
        assert.ok(full !== null, "前缀读到过 turn/start ⇒ 全量也必读得到");
        assert.ok(full >= head, `单调：${String(full)} >= ${String(head)}`);
      }),
      { numRuns: 500 },
    );
  });
});
