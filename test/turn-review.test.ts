import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { reviewLastTurn } from "../lib/turn-review.ts";

/** 任务清单写入的日志事件名（fixture 造事件与混合事件流两处同判据）。 */
const TODO_WRITE_EVENT = "todo/write";

// 事件构造器：只带本模块读取的字段，其余省略。
function ev(
  type: string,
  data: Record<string, unknown> = {},
): { type: string; data: Record<string, unknown> } {
  return { type, data };
}

function toolCall(
  turn: number,
  callId: string,
  name: string,
): { type: string; data: Record<string, unknown> } {
  return ev("tool/call", { turn, step: 1, callId, name, arguments: "{}" });
}
function toolResult(turn: number, callId: string): { type: string; data: Record<string, unknown> } {
  return ev("tool/result", { turn, step: 1, message: { source: { kind: "tool", callId } } });
}
function turnEnd(turn: number, kind: string): { type: string; data: Record<string, unknown> } {
  return ev("turn/end", { turn, reason: { kind } });
}
function turnStart(turn: number): { type: string; data: Record<string, unknown> } {
  return ev("turn/start", { turn });
}
function userMsg(source: Record<string, unknown>): { type: string; data: Record<string, unknown> } {
  return ev("user/message", { id: "m1", role: "user", content: [], source });
}
function todoWrite(todos: unknown): { type: string; data: Record<string, unknown> } {
  return ev(TODO_WRITE_EVENT, { todos });
}

const DONE = { content: "a", status: "completed" };
const OPEN = { content: "b", status: "pending" };
const DOING = { content: "c", status: "in_progress" };

describe("reviewLastTurn — 回合终态", () => {
  it("空事件流 → 无终态", () => {
    const result = reviewLastTurn([]);
    assert.equal(result.lastReasonKind, null);
    assert.equal(result.lastTurn, null);
  });

  it("取最后一条 turn/end 的 turn 与 reason.kind", () => {
    const result = reviewLastTurn([turnEnd(3, "completed"), turnEnd(4, "max-tokens")]);
    assert.equal(result.lastTurn, 4);
    assert.equal(result.lastReasonKind, "max-tokens");
  });

  it("turn/end 缺 reason 时 reasonKind 为 null（不抛）", () => {
    const result = reviewLastTurn([ev("turn/end", { turn: 2 })]);
    assert.equal(result.lastTurn, 2);
    assert.equal(result.lastReasonKind, null);
  });
});

describe("reviewLastTurn — todo 清单（最新快照 last-wins）", () => {
  it("无 todo/write → openTodos 为 null（无从判断）", () => {
    assert.equal(reviewLastTurn([turnEnd(1, "completed")]).openTodos, null);
  });

  it("最新快照含 pending/in_progress → 计数", () => {
    const result = reviewLastTurn([todoWrite([DONE, OPEN, DOING]), turnEnd(1, "completed")]);
    assert.equal(result.openTodos, 2);
  });

  it("最新快照全 completed → 0", () => {
    const result = reviewLastTurn([todoWrite([DONE, DONE]), turnEnd(1, "completed")]);
    assert.equal(result.openTodos, 0);
  });

  it("后写覆盖先写（whole-list 语义：以最后一次为准）", () => {
    const result = reviewLastTurn([
      todoWrite([OPEN, OPEN]),
      // 旧快照：2 个未完成
      todoWrite([DONE, DONE]),
      // 新快照：都完成
      turnEnd(1, "completed"),
    ]);
    assert.equal(result.openTodos, 0);
  });

  it("最后回合之后没有新的 todo/write 时，仍用其之前最近一次快照", () => {
    const result = reviewLastTurn([
      turnStart(1),
      todoWrite([DONE, OPEN]),
      turnEnd(1, "completed"),
      turnStart(2),
      turnEnd(2, "completed"),
    ]);
    // 回合 2 没写 todo；会话当前清单仍是回合 1 的那份（未闭合）
    assert.equal(result.openTodos, 1);
  });

  it("非法 todos 载荷（非数组/元素缺合法 status）被安全忽略", () => {
    const result = reviewLastTurn([
      ev(TODO_WRITE_EVENT, { todos: "not-array" }),
      ev(TODO_WRITE_EVENT, { todos: [{ status: 123 }, null, DONE] }),
      turnEnd(1, "completed"),
    ]);
    assert.equal(result.openTodos, 0);
  });
});

describe("reviewLastTurn — 清单是否属于最后回合（防陈旧清单误触发）", () => {
  it("最后回合内写过 todo/write → todoUpdatedInTurn=true", () => {
    const result = reviewLastTurn([turnStart(5), todoWrite([DONE, OPEN]), turnEnd(5, "completed")]);
    assert.equal(result.openTodos, 1);
    assert.equal(result.todoUpdatedInTurn, true);
  });

  it("清单是更早回合写的、最后回合没更新 → todoUpdatedInTurn=false（陈旧，不得据此续跑）", () => {
    const result = reviewLastTurn([
      turnStart(1),
      todoWrite([OPEN, OPEN]),
      turnEnd(1, "completed"),
      // 之后用户改了方向，第 2 回合做了别的事并正常结束
      userMsg({ kind: "user", rpcId: "r2" }),
      turnStart(2),
      toolCall(2, "c1", "bash"),
      toolResult(2, "c1"),
      turnEnd(2, "completed"),
    ]);
    assert.equal(result.openTodos, 2, "清单内容仍可读");
    assert.equal(result.todoUpdatedInTurn, false, "但它不属于本回合，宿主不得触发");
  });

  it("最后回合内先写未完成、随后自己改完 → 以回合内最后一次为准", () => {
    const result = reviewLastTurn([
      turnStart(5),
      todoWrite([OPEN]),
      todoWrite([DONE]),
      turnEnd(5, "completed"),
    ]);
    assert.equal(result.openTodos, 0);
    assert.equal(result.todoUpdatedInTurn, true);
  });

  it("缺 turn/start（老会话日志）→ 保守判为不在本回合", () => {
    const result = reviewLastTurn([todoWrite([OPEN]), turnEnd(5, "completed")]);
    assert.equal(result.openTodos, 1);
    assert.equal(result.todoUpdatedInTurn, false);
  });
});

describe("reviewLastTurn — 等待用户（必须抑制续跑）", () => {
  it("最后回合调用 ask_user_question → awaitsUser=true", () => {
    const result = reviewLastTurn([
      turnStart(5),
      toolCall(5, "c1", "bash"),
      toolResult(5, "c1"),
      toolCall(5, "c2", "ask_user_question"),
      toolResult(5, "c2"),
      turnEnd(5, "completed"),
    ]);
    assert.equal(result.awaitsUser, true);
  });

  it("更早回合问过问题、最后回合没问 → awaitsUser=false", () => {
    const result = reviewLastTurn([
      turnStart(4),
      toolCall(4, "c1", "ask_user_question"),
      toolResult(4, "c1"),
      turnEnd(4, "completed"),
      turnStart(5),
      toolCall(5, "c2", "bash"),
      toolResult(5, "c2"),
      turnEnd(5, "completed"),
    ]);
    assert.equal(result.awaitsUser, false);
  });

  it("turn/end 之后才出现的调用不算入最后回合（保守 false）", () => {
    const result = reviewLastTurn([
      turnEnd(1, "completed"),
      toolCall(2, "c1", "ask_user_question"),
    ]);
    assert.equal(result.lastTurn, 1);
    assert.equal(result.awaitsUser, false);
  });
});

describe("reviewLastTurn — goal 驱动回合（避免与 goal 轮次双重注入）", () => {
  it("最后回合的首条 user 消息 source.kind=goal → goalDrivenTurn=true", () => {
    const result = reviewLastTurn([
      turnStart(9),
      userMsg({ kind: "goal", goalId: "g1", revision: 1, round: 2 }),
      turnEnd(9, "completed"),
    ]);
    assert.equal(result.goalDrivenTurn, true);
  });

  it("普通用户消息 → goalDrivenTurn=false", () => {
    const result = reviewLastTurn([
      turnStart(9),
      userMsg({ kind: "user", rpcId: "r1" }),
      turnEnd(9, "completed"),
    ]);
    assert.equal(result.goalDrivenTurn, false);
  });

  it("插件注入（producer-owned source.kind）的回合不算 goal 驱动", () => {
    const result = reviewLastTurn([
      turnStart(9),
      userMsg({ kind: "plugin:session-rescue" }),
      turnEnd(9, "completed"),
    ]);
    assert.equal(result.goalDrivenTurn, false);
  });

  it("回合内没有 user/message → goalDrivenTurn=false", () => {
    assert.equal(reviewLastTurn([turnStart(9), turnEnd(9, "completed")]).goalDrivenTurn, false);
  });
});

describe("reviewLastTurn — 鲁棒性", () => {
  it("非数组输入 → 空结论", () => {
    const result = reviewLastTurn(undefined);
    assert.equal(result.lastReasonKind, null);
    assert.equal(result.openTodos, null);
    assert.equal(result.awaitsUser, false);
    assert.equal(result.goalDrivenTurn, false);
  });

  it("事件缺 data / 数组含空洞不抛", () => {
    const result = reviewLastTurn([
      { type: "turn/end" },
      undefined,
      null,
      ev("turn/end", { turn: 1, reason: { kind: "completed" } }),
    ]);
    assert.equal(result.lastTurn, 1);
    assert.equal(result.lastReasonKind, "completed");
  });
});

describe("坏形状事件与无终态（防御降级，审计补漏）", () => {
  it("最后一条 turn/end 缺 turn → lastTurn 为 null，终态理由仍读出", () => {
    const result = reviewLastTurn([
      turnStart(1),
      ev("turn/end", { reason: { kind: "completed" } }),
    ]);
    assert.equal(result.lastTurn, null, "numIn 的降级侧 + `?? null`");
    assert.equal(result.lastReasonKind, "completed");
  });

  it("本回合 tool/call 缺 name → 不误判为等待用户", () => {
    const result = reviewLastTurn([
      turnStart(1),
      ev("tool/call", { turn: 1, step: 1, callId: "c1" }),
      turnEnd(1, "completed"),
    ]);
    assert.equal(result.awaitsUser, false, "directStr 的降级侧");
    assert.equal(result.lastTurn, 1);
  });

  it("会话从未有过 turn/end → 整份结论为空（不猜终态）", () => {
    const result = reviewLastTurn([turnStart(1), userMsg({ kind: "user" })]);
    assert.equal(result.lastTurn, null);
    assert.equal(result.lastReasonKind, null);
    assert.equal(result.openTodos, null);
    assert.equal(result.goalDrivenTurn, false);
  });

  it("找不到 turn/start 边界时：陈旧 todo 不算本回合所写", () => {
    const result = reviewLastTurn([
      ev(TODO_WRITE_EVENT, { todos: [{ content: "a", status: "pending" }] }),
      turnEnd(4, "completed"),
    ]);
    assert.equal(result.openTodos, 1, "清单快照仍读出");
    assert.equal(result.todoUpdatedInTurn, false, "无左边界 → 判为陈旧");
  });
});
