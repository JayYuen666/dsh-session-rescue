import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { ResumeScheduler } from "../lib/resume-scheduler.ts";

// E3：state 路由 suspended 快照的 remainingMs 在 host.ts 里用 Date.now()
// 直算，而调度器时钟是可注入的 now()——两者漂移时 UI 倒计时与真实 fire
// 时刻不一致。修复：调度器暴露 remainingMsFor(fireAt)（走注入时钟），
// host 一律经它计算。本文件先红后绿：方法缺失时即失败。
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
    const { fireAt } = decision;
    assert.equal(
      typeof (scheduler as unknown as { remainingMsFor?: unknown }).remainingMsFor,
      "function",
    );
    const remainingMsFor = (
      scheduler as unknown as { remainingMsFor: (fireAt: number) => number }
    ).remainingMsFor.bind(scheduler);
    assert.equal(remainingMsFor(fireAt), 10_000);
    now += 4000;
    assert.equal(remainingMsFor(fireAt), 6000);
    now += 7000;
    assert.equal(remainingMsFor(fireAt), 0, "过期钳制为 0，不返回负数");
  });

  it("默认时钟仍为 Date.now（不破坏现有行为）", () => {
    const scheduler = new ResumeScheduler();
    const t0 = Date.now();
    const decision = scheduler.onFailure({
      sessionId: "s1",
      turn: 1,
      kind: "resume",
      delayMs: 5000,
      cooldownMs: 0,
      maxResumes: 3,
    });
    assert.equal(decision.action, "schedule");
    const remainingMsFor = (
      scheduler as unknown as { remainingMsFor: (fireAt: number) => number }
    ).remainingMsFor.bind(scheduler);
    const remain = remainingMsFor(decision.fireAt);
    assert.ok(remain <= 5000 && remain > 4900, `expected ~5000, got ${remain}`);
    assert.ok(Date.now() - t0 < 1000);
  });
});
