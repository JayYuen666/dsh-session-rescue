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
    // 先恢复一次让记录重新持有待办，再恢复同一枚快照：必须被拒，不能把已武装的那一份覆盖掉。
    // 这条判据就是重连时「已有待办 ⇒ 挂起快照作废」的调度器侧契约（host 侧对应
    // resumeAfterReconnect 里 restorePending 返回 false 的那一支）。
    assert.equal(scheduler.restorePending("s1", pending), true);
    assert.equal(scheduler.restorePending("s1", pending), false);
    assert.equal(scheduler.stateSnapshot()["s1"]?.pending?.turn, 3, "已武装的待办不被覆盖");
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

  it("restorePending：会话已不被记录（dispose/淘汰过）⇒ 拒绝，且不凭空造出一枚满额记录", () => {
    // 反例来自属性层（test/property/resume-scheduler.property.test.ts）：旧实现走
    // `rec()`，未知会话会被就地新建一枚 counts 全 0 的记录并返回 true——于是
    // 「恢复一条早就被 dispose 的挂起待办」拿到的是**满额** maxResumes 配额，
    // 防失控闸门在这条会话上被静默复位，日志里一个字都不会提。
    const clock = makeClock();
    const scheduler = new ResumeScheduler({ now: clock.now });
    const pending = { turn: 7, kind: "resume" as const, fireAt: 5_010_000, announcedAt: 1 };
    assert.equal(scheduler.restorePending("never-seen", pending), false, "无记录 ⇒ 快照作废");
    assert.deepEqual(scheduler.stateSnapshot(), {}, "拒绝不得留下任何记录");
    // 记录被 disposeAll 清空后同样拒绝（重连台账里残留的旧快照不能复活配额）。
    scheduler.onFailure(base);
    scheduler.disposeAll();
    assert.equal(scheduler.restorePending("s1", pending), false);
    assert.deepEqual(scheduler.stateSnapshot(), {});
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
