// scheduler 契约补充：挂起/恢复/剩余时间等 host 集成面（纯状态机单测缺口）。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { ResumeScheduler } from "../lib/resume-scheduler.ts";
import type { OnFailureInput } from "../lib/resume-scheduler.ts";
// 待办在位/剩余时间改用调度器的公开快照形状读（原先那两条按会话的出口只被用例取用）。
import { hasPending, remainingMs } from "./scheduler-snapshot.ts";

function makeClock(start = 5_000_000): { now: () => number; advance: (ms: number) => void } {
  let time = start;
  return {
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
  };
}

const base: OnFailureInput = {
  sessionId: "s1",
  turn: 3,
  delayMs: 10_000,
  cooldownMs: 120_000,
  maxResumes: 3,
};

describe("suspendSession（发送抛错时的挂起面）", () => {
  it("无待办会话返回 null（不臆造挂起）", () => {
    const scheduler = new ResumeScheduler({ now: makeClock().now });
    assert.equal(scheduler.suspendSession("ghost"), null);
    assert.equal(scheduler.suspendSession("s1"), null);
  });

  it("有待办：取出 pending 副本、释放定时器、会话回到无待办", () => {
    const clock = makeClock();
    const scheduler = new ResumeScheduler({ now: clock.now });
    scheduler.onFailure(base);
    let disposed = 0;
    scheduler.attachTimer("s1", () => {
      disposed += 1;
    });
    const pending = scheduler.suspendSession("s1");
    // 首条 `pending?.turn` 经 node:assert 的 `asserts actual is T` 证明取出非空
    //（suspendSession 返回 PendingRecord | null），之后的 `?.` 是冗余守卫；
    // 副本可变性由下面 `pending.turn = 999` 那条断言链继续把守。
    assert.equal(pending?.turn, 3);
    assert.equal(pending.kind, "resume");
    assert.equal(pending.fireAt, 5_010_000);
    assert.equal(disposed, 1, "挂起必须释放宿主定时器");
    assert.equal(hasPending(scheduler, "s1"), false);
    // 返回的是副本：外部改它不影响调度器
    pending.turn = 999;
    assert.equal(scheduler.suspendSession("s1"), null);
  });

  it("定时器 disposer 抛错不阻断挂起", () => {
    const scheduler = new ResumeScheduler({ now: makeClock().now });
    scheduler.onFailure(base);
    scheduler.attachTimer("s1", () => {
      throw new Error("dispose boom");
    });
    const pending = scheduler.suspendSession("s1");
    assert.ok(pending !== null, "disposer 抛错后仍应取出待办");
  });
});

describe("restorePending / remainingMs（重连恢复面）", () => {
  it("restorePending：当前已有待办时拒绝（返回 false，不覆盖）", () => {
    const clock = makeClock();
    const scheduler = new ResumeScheduler({ now: clock.now });
    scheduler.onFailure(base);
    const pending = scheduler.suspendSession("s1");
    assert.ok(pending !== null);
    // 恢复前又调度了一次（竞态）：新 pending 存在 → 拒绝恢复
    scheduler.onFailure({ ...base, turn: 4 });
    assert.equal(scheduler.restorePending("s1", pending), false);
    assert.equal(scheduler.stateSnapshot()["s1"]?.pending?.turn, 4, "原待办不被覆盖");
  });

  it("restorePending 成功：恢复原 fireAt，remainingMs 反映剩余时间", () => {
    const clock = makeClock();
    const scheduler = new ResumeScheduler({ now: clock.now });
    scheduler.onFailure(base);
    const pending = scheduler.suspendSession("s1");
    assert.ok(pending !== null);
    clock.advance(3000);
    assert.equal(scheduler.restorePending("s1", pending), true);
    assert.equal(scheduler.stateSnapshot()["s1"]?.pending?.fireAt, 5_010_000, "保留原 fireAt");
    assert.equal(remainingMs(scheduler, "s1"), 7000, "剩余 = fireAt - now");
  });

  it("remainingMs：无待办返回 null；已到点钳制为 0", () => {
    const clock = makeClock();
    const scheduler = new ResumeScheduler({ now: clock.now });
    assert.equal(remainingMs(scheduler, "s1"), null);
    assert.equal(scheduler.remainingMsFor(clock.now() + 500), 500);
    assert.equal(scheduler.remainingMsFor(clock.now() - 100), 0, "过期钳制 0 不出现负数");
    scheduler.onFailure(base);
    clock.advance(10_000);
    assert.equal(remainingMs(scheduler, "s1"), 0, "到点即 0（尽快 fire）");
  });
});

describe("cancel 边界", () => {
  it("定时器 disposer 抛错不阻断取消", () => {
    const scheduler = new ResumeScheduler({ now: makeClock().now });
    scheduler.onFailure(base);
    scheduler.attachTimer("s1", () => {
      throw new Error("dispose boom");
    });
    assert.deepEqual(scheduler.cancel("s1"), { cancelled: true, turn: 3 });
    assert.equal(hasPending(scheduler, "s1"), false);
  });
});
