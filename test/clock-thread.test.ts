import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { ResumeScheduler } from "../lib/resume-scheduler.ts";

// state 路由 suspended 快照的 remainingMs 在 host.ts 里用 Date.now()
// 直算，而调度器时钟是可注入的 now()——两者漂移时 UI 倒计时与真实 fire
// 时刻不一致。修复：调度器暴露 remainingMsFor(fireAt)（走注入时钟），
// host 一律经它计算。本文件先红后绿：方法缺失时即失败。

/** 绑定私有方法：先断言「是函数」再绑定，方法缺失时红因直接点名，而不是在
 *  后续调用上抛一句与成因对不上的 TypeError。两条用例共用这一段强转。 */
function remainingMsForOf(scheduler: ResumeScheduler): (fireAt: number) => number {
  const method = (scheduler as unknown as { remainingMsFor?: unknown }).remainingMsFor;
  assert.equal(
    typeof method,
    "function",
    "调度器缺 remainingMsFor：state 路由的倒计时会退回 Date.now 直算",
  );
  return (method as (fireAt: number) => number).bind(scheduler);
}

describe("调度器时钟一致（remainingMsFor 走注入 now）", () => {
  it("假时钟下 remainingMsFor 按注入时钟计算 fireAt 剩余", () => {
    let now = 1_000_000;
    const scheduler = new ResumeScheduler({ now: () => now });
    const decision = scheduler.onFailure({
      sessionId: "s1",
      turn: 1,
      kind: "resume",
      delayMs: 10_000,
      cooldownMs: 0,
      maxResumes: 3,
    });
    assert.equal(decision.action, "schedule");
    // `schedule` 分支的 fireAt 是必选位（FailureDecision 是判别联合，缺字段在类型上
    // 就该不可能）——上面那条断言已把 decision 收窄到该分支，这里无需兜底。
    const remainingMsFor = remainingMsForOf(scheduler);
    assert.equal(remainingMsFor(decision.fireAt), 10_000);
    now += 4000;
    assert.equal(remainingMsFor(decision.fireAt), 6000);
    now += 7000;
    assert.equal(remainingMsFor(decision.fireAt), 0, "过期钳制为 0，不返回负数");
  });

  it("默认时钟仍为 Date.now（不破坏现有行为）", () => {
    const scheduler = new ResumeScheduler();
    const decision = scheduler.onFailure({
      sessionId: "s1",
      turn: 1,
      kind: "resume",
      delayMs: 5000,
      cooldownMs: 0,
      maxResumes: 3,
    });
    assert.equal(decision.action, "schedule");
    const remainingMsFor = remainingMsForOf(scheduler);
    // 本用例只证「默认时钟给出真实推进的墙钟」：fireAt 在真实时钟的未来、剩余为正
    // 且不超 delay。不设毫秒级窗口——GC/CI 调度停顿会让 100ms 容差偶发跌破，
    // 而这条用例的判据从来不是执行速度。
    const remain = remainingMsFor(decision.fireAt);
    assert.ok(remain <= 5000 && remain > 0, `expected (0, 5000], got ${remain}`);
  });
});
