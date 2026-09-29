/**
 * 等价用例（投影的验收面）：同一串会话事件分别喂
 *   - 旧读法：host.ts 迁移前的三处全量扫描（现搬进 lib/turn-facts.ts 的 scan* 与既有
 *     lib/turn-review.ts 的 reviewLastTurn），与
 *   - 新读法：投影折叠（test/turn-facts-fold.ts 的 foldEvents，折的是生产那份
 *     rescueFactsProjection 单元）+ 读侧换算（reviewFromFacts / hasNewerTurn / turnOpenerKind）。
 * 逐项断言判定相同；投影不可采信处（end 对不上它的 start、opener 被窗口淘汰）只断言它
 * **交回 undefined**——那时 host.ts 走的是旧扫描，判定天然同解。
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { reviewLastTurn } from "../lib/turn-review.ts";
import {
  asFacts,
  hasNewerTurn,
  rescueFactsProjection,
  reviewFromFacts,
  scanNewerTurn,
  scanOpenerKind,
  turnOpenerKind,
} from "../lib/turn-facts.ts";
import type { RescueFacts } from "../lib/turn-facts.ts";
// 折叠口在测试树（替身与生产同走 rescueFactsProjection 的 init/apply，见该文件头部理由）。
import { foldEvents } from "./turn-facts-fold.ts";

// ── 事件构造器（只带本模块读取的字段，与 turn-review.test.ts 同形）──────────────

interface Ev {
  type: string;
  data: Record<string, unknown>;
}

function ev(type: string, data: Record<string, unknown> = {}): Ev {
  return { type, data };
}
function turnStart(turnNo?: number): Ev {
  return ev("turn/start", turnNo === undefined ? {} : { turn: turnNo });
}
function turnEnd(turnNo?: number, kind = "completed"): Ev {
  return ev("turn/end", { ...(turnNo === undefined ? {} : { turn: turnNo }), reason: { kind } });
}
function userMsg(source: unknown): Ev {
  return ev("user/message", { id: "m1", role: "user", content: [], source });
}
function toolCall(turnNo: number | undefined, name: string): Ev {
  return ev("tool/call", { ...(turnNo === undefined ? {} : { turn: turnNo }), callId: "c", name });
}
function todoWrite(todos: unknown): Ev {
  return ev("todo/write", { todos });
}

const OPEN = { content: "a", status: "pending" };
const DONE = { content: "b", status: "completed" };
const GOAL = { kind: "goal", goalId: "g1", revision: 1, round: 2 };
const USER = { kind: "user", rpcId: "r1" };
const RESCUE = { kind: "plugin:session-rescue" };

/** 一轮干净的回合：start → opener → end。 */
function round(turnNo: number, opener: unknown, reason = "completed"): Ev[] {
  return [turnStart(turnNo), userMsg(opener), turnEnd(turnNo, reason)];
}

/** 造 count 个干净回合（opener 窗口淘汰用例用）。 */
function manyRounds(count: number): Ev[] {
  const out: Ev[] = [];
  for (let index = 1; index <= count; index += 1) {
    out.push(...round(index, index === 1 ? GOAL : USER));
  }
  return out;
}

// ── 等价 harness ────────────────────────────────────────────────────────────

/** 三处判定逐一对照：可信则与旧扫描同解，不可信则只断言它交回 undefined。 */
function assertEquivalent(
  evs: readonly unknown[],
  turnNos: readonly number[] = [1, 2, 3, 5],
): void {
  const state = foldEvents(evs);

  const projected = reviewFromFacts(state);
  if (projected === undefined) {
    assert.ok(state.end !== null && !state.end.aligned, "只有 end 不可信时才交回 undefined");
  } else {
    assert.deepEqual(projected, reviewLastTurn(evs), "reviewLastTurn 与投影同解");
  }

  for (const turnNo of turnNos) {
    assert.equal(
      hasNewerTurn(state, turnNo),
      scanNewerTurn(evs, turnNo),
      `newer-turn(${turnNo}) 与倒扫同解`,
    );
    const kind = turnOpenerKind(state, turnNo);
    if (kind !== undefined) {
      assert.equal(kind, scanOpenerKind(evs, turnNo), `opener(${turnNo}) 与顺扫同解`);
    }
  }
}

describe("投影 ≡ 旧扫描（干净日志）", () => {
  it("空日志：与旧实现同一份空结论", () => {
    assertEquivalent([]);
    const state = foldEvents([]);
    assert.deepEqual(reviewFromFacts(state), reviewLastTurn([]));
  });

  it("普通用户回合：completed / 无清单 / 不等用户 / 非 goal", () => {
    // 标题点名的四项判据当场断言（投影侧），再由 assertEquivalent 与旧扫描对撞。
    const evs = round(1, USER);
    const review = reviewFromFacts(foldEvents(evs));
    assert.equal(review?.lastReasonKind, "completed", "completed 收口");
    assert.equal(review.openTodos, null, "无清单：从未 todo/write");
    assert.equal(review.awaitsUser, false, "不等用户");
    assert.equal(review.goalDrivenTurn, false, "非 goal 轮");
    assertEquivalent(evs);
  });

  it("goal 回合：goalDrivenTurn 两侧同为 true", () => {
    const goalTurn = round(1, GOAL);
    const state = foldEvents(goalTurn);
    assert.equal(reviewFromFacts(state)?.goalDrivenTurn, true);
    assert.equal(reviewLastTurn(goalTurn).goalDrivenTurn, true);
    assertEquivalent(goalTurn);
  });

  it("本插件续跑回合开启：opener kind 两侧同为 plugin:session-rescue", () => {
    const evs = round(1, RESCUE);
    const state = foldEvents(evs);
    assert.equal(turnOpenerKind(state, 1), scanOpenerKind(evs, 1));
    assertEquivalent(evs);
  });

  it("等待用户：awaitsUser 两侧同为 true", () => {
    const evs = [turnStart(1), userMsg(USER), toolCall(1, "ask_user_question"), turnEnd(1)];
    const state = foldEvents(evs);
    assert.equal(reviewFromFacts(state)?.awaitsUser, true);
    assertEquivalent(evs);
  });

  it("本回合写过未闭合清单：openTodos/todoUpdatedInTurn 同解", () => {
    const evs = [turnStart(1), userMsg(USER), todoWrite([DONE, OPEN]), turnEnd(1)];
    const state = foldEvents(evs);
    const review = reviewFromFacts(state);
    assert.equal(review?.openTodos, 1);
    assert.equal(review.todoUpdatedInTurn, true);
    assertEquivalent(evs);
  });

  it("陈旧清单（更早回合所写）：两侧都不算本回合的", () => {
    const evs = [
      turnStart(1),
      userMsg(USER),
      todoWrite([OPEN]),
      turnEnd(1, "error"),
      ...round(2, USER),
      ...round(3, USER),
    ];
    const state = foldEvents(evs);
    const review = reviewFromFacts(state);
    assert.equal(review?.openTodos, 1, "清单内容仍读得到");
    assert.equal(review.todoUpdatedInTurn, false, "但不是本回合写的");
    assertEquivalent(evs, [1, 2, 3]);
  });

  it("多回合 + 杂项事件：逐串同解", () => {
    const evs = [
      turnStart(1),
      userMsg(USER),
      toolCall(1, "bash"),
      ev("tool/result", { turn: 1 }),
      todoWrite([OPEN]),
      turnEnd(1, "max-tokens"),
      turnStart(2),
      userMsg(GOAL),
      toolCall(2, "ask_user_question"),
      todoWrite([DONE]),
      turnEnd(2, "completed"),
      turnStart(3),
      userMsg(RESCUE),
      turnEnd(3, "aborted"),
    ];
    // 「逐串同解」的可见判据：最后回合复盘 + 新轮判定 + opener 三项先当场对撞一次，
    // 再由 assertEquivalent 跑完整的 turnNos 矩阵。
    const state = foldEvents(evs);
    assert.deepEqual(reviewFromFacts(state), reviewLastTurn(evs), "reviewLastTurn 与投影同解");
    assert.equal(hasNewerTurn(state, 2), scanNewerTurn(evs, 2), "newer-turn(2) 与倒扫同解");
    assert.equal(turnOpenerKind(state, 2), scanOpenerKind(evs, 2), "opener(2) 与顺扫同解");
    assertEquivalent(evs, [1, 2, 3]);
  });

  it("更早回合问过问题、最后回合没问：awaitsUser 两侧同为 false", () => {
    const evs = [
      turnStart(1),
      userMsg(USER),
      toolCall(1, "ask_user_question"),
      turnEnd(1),
      turnStart(2),
      userMsg(USER),
      toolCall(2, "bash"),
      turnEnd(2),
    ];
    const state = foldEvents(evs);
    assert.equal(reviewFromFacts(state)?.awaitsUser, false);
    assertEquivalent(evs, [1, 2]);
  });

  it("回合内先写未完成再改完：以回合内最后一次为准", () => {
    const evs = [turnStart(5), userMsg(USER), todoWrite([OPEN]), todoWrite([DONE]), turnEnd(5)];
    assertEquivalent(evs, [5]);
    const state = foldEvents(evs);
    assert.equal(reviewFromFacts(state)?.openTodos, 0);
  });

  it("end 之后再写的清单不算进本回合（两侧同样只看定稿那一刻）", () => {
    const evs = [turnStart(1), userMsg(USER), turnEnd(1), todoWrite([OPEN, OPEN])];
    const state = foldEvents(evs);
    const review = reviewFromFacts(state);
    assert.equal(review?.openTodos, null);
    assert.equal(review.todoUpdatedInTurn, false);
    assertEquivalent(evs);
  });

  it("同回合内重复信号与非字符串字段：两侧同样只看有没有，不看第几次", () => {
    const evs = [
      turnStart(1),
      userMsg(USER),
      // 第二次 ask 不再改变状态（折叠的引用稳定侧）
      toolCall(1, "ask_user_question"),
      toolCall(1, "ask_user_question"),
      // 整表重写成同一份清单：快照值没变 ⇒ 状态引用也不变
      todoWrite([OPEN]),
      todoWrite([OPEN]),
      // name 非字符串：不是本包关心的工具
      ev("tool/call", { turn: 1, name: 42 }),
      // reason.kind 非字符串：读成 null（旧实现同判据）
      ev("turn/end", { turn: 1, reason: { kind: 42 } }),
    ];
    const state = foldEvents(evs);
    const review = reviewFromFacts(state);
    assert.equal(review?.lastReasonKind, null);
    assert.equal(review.awaitsUser, true);
    assert.equal(review.openTodos, 1);
    assertEquivalent(evs);
  });
});

describe("投影 ≡ 旧扫描（异常日志：不可采信则交回扫描）", () => {
  it("重复轮次号的 start：两侧都以最后一条为准", () => {
    const evs = [turnStart(2), userMsg(GOAL), turnStart(2), userMsg(USER), turnEnd(2)];
    const state = foldEvents(evs);
    assert.equal(turnOpenerKind(state, 2), "user");
    assert.equal(scanOpenerKind(evs, 2), "user");
    assertEquivalent(evs, [2]);
  });

  it("轮次号回退（重启后的 agent 重新计数）：newer-turn 仍按最大值同解", () => {
    const evs = [...round(5, USER), ...round(3, GOAL)];
    assertEquivalent(evs, [3, 4, 5]);
    const state = foldEvents(evs);
    assert.equal(hasNewerTurn(state, 4), true, "见过 turn/start(5) ⇒ 4 之后有新轮");
  });

  it("start 缺轮次号 ⇒ end 不可采信，交回 undefined", () => {
    const evs = [turnStart(), userMsg(USER), turnEnd(1)];
    const state = foldEvents(evs);
    assert.equal(reviewFromFacts(state), undefined);
    // 旧扫描在这一串上仍给出答案（找不到边界 ⇒ 保守 false），host 因此走扫描读法
    assert.equal(reviewLastTurn(evs).awaitsUser, false);
  });

  it("end 缺轮次号 ⇒ 不可采信", () => {
    const state = foldEvents([turnStart(1), userMsg(USER), turnEnd()]);
    assert.equal(reviewFromFacts(state), undefined);
  });

  it("end 的轮次号对不上最近的 start ⇒ 不可采信（旧倒扫会找到更早那条 start）", () => {
    const evs = [turnStart(3), userMsg(GOAL), turnEnd(3), turnStart(4), userMsg(USER), turnEnd(9)];
    const state = foldEvents(evs);
    assert.equal(reviewFromFacts(state), undefined);
    assert.equal(reviewLastTurn(evs).lastTurn, 9, "旧扫描仍给出末条 end");
  });

  it("连续两条 end（无中间 start）：第二条不可采信", () => {
    const evs = [turnStart(1), userMsg(USER), turnEnd(1), turnEnd(2)];
    const state = foldEvents(evs);
    assert.equal(reviewFromFacts(state), undefined);
    assertEquivalent(evs, [1, 2]);
  });

  it("只有 end 没有 start（崩溃恢复只读到半截日志）⇒ 不可采信", () => {
    const state = foldEvents([userMsg(GOAL), turnEnd(7)]);
    assert.equal(reviewFromFacts(state), undefined);
  });

  it("无关事件不改变状态引用（官方 Object.is 契约 = 零下游工作）", () => {
    const state = foldEvents([turnStart(1), userMsg(USER)]);
    for (const other of [ev("tool/result"), ev("agent/inbox/spliced"), { nope: 1 }, null, "x"]) {
      assert.equal(rescueFactsProjection.apply(state, other as never), state);
    }
  });

  it("畸形载荷：todo 非数组、元素缺 status、source 非对象、kind 非字符串", () => {
    const evs = [
      turnStart(1),
      userMsg(undefined),
      userMsg("not-an-object"),
      userMsg({ kind: 42 }),
      todoWrite("not-array"),
      todoWrite([null, { status: 7 }, DONE]),
      toolCall(undefined, "ask_user_question"),
      toolCall(9, "ask_user_question"),
      toolCall(1, "bash"),
      turnEnd(1),
    ];
    const state = foldEvents(evs);
    const review = reviewFromFacts(state);
    assert.deepEqual(review, reviewLastTurn(evs));
    // 首条 user/message 的 source 不可用 ⇒ kind null ⇒ 既非 goal 也非 rescue（两侧同判）
    assert.equal(review.goalDrivenTurn, false);
    assert.equal(turnOpenerKind(state, 1), null);
    assert.equal(turnOpenerKind(state, 1), scanOpenerKind(evs, 1));
    assert.equal(review.awaitsUser, false, "缺号/异号 tool/call 都不算本回合的等待用户");
  });

  it("start 之后一直没有 user/message：两侧都判 null", () => {
    const evs = [turnStart(1), turnEnd(1)];
    const state = foldEvents(evs);
    assert.equal(turnOpenerKind(state, 1), null);
    assert.equal(turnOpenerKind(state, 1), scanOpenerKind(evs, 1));
    assertEquivalent(evs);
  });

  it("跨回合照绑（旧顺扫跑到日志末尾）：未绑定的旧回合也绑上后来的消息", () => {
    const evs = [turnStart(1), turnStart(2), userMsg(GOAL), turnEnd(2)];
    const state = foldEvents(evs);
    assert.equal(turnOpenerKind(state, 1), "goal", "回合 1 读到的是回合 2 那条 opener（同旧）");
    assert.equal(turnOpenerKind(state, 1), scanOpenerKind(evs, 1));
    assertEquivalent(evs, [1, 2]);
  });
});

describe("newer-turn veto", () => {
  it("从未见过 turn/start ⇒ 不误判有新轮", () => {
    const evs = [userMsg(USER)];
    const state = foldEvents(evs);
    assert.equal(hasNewerTurn(state, 1), false);
    assert.equal(scanNewerTurn(evs, 1), false);
  });

  it("等于失败轮的那一轮不算新轮（严格大于）", () => {
    const state = foldEvents([turnStart(4), userMsg(USER)]);
    assert.equal(hasNewerTurn(state, 4), false);
    assert.equal(hasNewerTurn(state, 3), true);
  });

  it("缺轮次号的 turn/start 不参与（与倒扫同样忽略）", () => {
    const evs = [turnStart(2), turnStart(), userMsg(USER), turnEnd(2)];
    const state = foldEvents(evs);
    // 「不参与」的可判形态：缺号的 start 既不改 opener 也不改新轮判定，两侧同解。
    assert.equal(turnOpenerKind(state, 2), scanOpenerKind(evs, 2), "opener(2) 与顺扫同解");
    assert.equal(hasNewerTurn(state, 2), scanNewerTurn(evs, 2), "newer-turn(2) 与倒扫同解");
    assertEquivalent(evs);
  });
});

describe("opener 窗口", () => {
  it("窗口内的回合：投影与扫描同解", () => {
    const evs = manyRounds(70);
    const state = foldEvents(evs);
    assert.equal(turnOpenerKind(state, 70), "user");
    assertEquivalent(evs, [65, 70]);
  });

  it("窗口外的最早回合被淘汰 ⇒ 交回 undefined（host 回退扫描）", () => {
    const evs = manyRounds(70);
    const state = foldEvents(evs);
    assert.equal(turnOpenerKind(state, 1), undefined, "淘汰后不给答案，而不是给错答案");
    assert.equal(scanOpenerKind(evs, 1), "goal", "扫描仍读得到，回退路径照旧正确");
  });

  it("窗口未触发时状态里的表不长于回合数", () => {
    const state = foldEvents(manyRounds(3));
    assert.equal(state.openers.length, 3);
  });
});

describe("投影单元与状态形状", () => {
  it("init 交回空态（忽略 header 与继承前缀）", () => {
    // 直接摊开这一份空态：它是投影的首值，断言的对象就是「首值长什么样」这条判据本身，
    // 拿同一个模块里的第二个函数当右值等于把判据折成 self-comparison。
    assert.deepEqual(rescueFactsProjection.init({} as never, 0 as never), {
      end: null,
      latestTurnStart: null,
      todoOpen: null,
      start: null,
      openers: [],
    });
  });

  it("apply 逐条折叠出定稿后的那份状态", () => {
    const first = rescueFactsProjection.apply(
      rescueFactsProjection.init({} as never, 0 as never),
      turnStart(1) as never,
    );
    assert.equal(first.latestTurnStart, 1);
    assert.equal(first.end, null);
    const two = rescueFactsProjection.apply(first, turnEnd(1) as never);
    assert.deepEqual(two.end, {
      turn: 1,
      reasonKind: "completed",
      openTodos: null,
      todoUpdatedInTurn: false,
      awaitsUser: false,
      goalDrivenTurn: false,
      aligned: true,
    });
    assert.equal(two.start, null, "turn/end 定稿后清空本回合累加器");
  });

  it("注册键与 host-only 形状", () => {
    assert.equal(rescueFactsProjection.key, "session-rescue.turnFacts");
    assert.equal(rescueFactsProjection.stateVersion, 1);
    assert.equal("wire" in rescueFactsProjection, false, "host-only：不进客户端快照");
  });

  it("asFacts：形状相符才采信，坏值一律 undefined", () => {
    const good = foldEvents(round(1, USER));
    const cloned = asFacts(structuredClone(good));
    assert.equal(cloned?.latestTurnStart, 1);
    for (const bad of [undefined, null, "x", 7, {}, { ...good, openers: "no" }]) {
      assert.equal(asFacts(bad), undefined, "坏形状不采信");
    }
  });

  it("asFacts 拒绝被污染的字段类型", () => {
    const good: RescueFacts = foldEvents(round(1, USER));
    assert.equal(asFacts({ ...good, latestTurnStart: "1" }), undefined);
    const { end } = good;
    assert.ok(end !== null);
    assert.equal(asFacts({ ...good, end: { ...end, aligned: "yes" } }), undefined);
  });
});
