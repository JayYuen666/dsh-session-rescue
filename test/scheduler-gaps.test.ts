// scheduler 契约补充：挂起/恢复/剩余时间等 host 集成面（纯状态机单测缺口）。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { MAX_SESSIONS, ResumeScheduler } from "../lib/resume-scheduler.ts";
import type { OnFailureInput } from "../lib/resume-scheduler.ts";
// 待办在位/剩余时间改用调度器的公开快照形状读（原先那两条按会话的出口只被用例取用）。
import { hasPending, remainingMs } from "./scheduler-snapshot.ts";

const CLOCK_START = 5_000_000;
// fireAt = 起始时钟 + delayMs：三处断言与给 restorePending 的快照都从这里推，
// 改起点或 delayMs 时不再手工同步魔数。
const FIRE_AT = CLOCK_START + 10_000;

function makeClock(start = CLOCK_START): { now: () => number; advance: (ms: number) => void } {
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
    assert.ok(pending !== null, "有待办的会话必须取出一枚待办");
    assert.equal(pending.turn, 3);
    assert.equal(pending.kind, "resume");
    assert.equal(pending.fireAt, FIRE_AT);
    assert.equal(disposed, 1, "挂起必须释放宿主定时器");
    assert.equal(hasPending(scheduler, "s1"), false);
    // 已登记但无待办的会话再挂起：返回 null（不臆造）。
    assert.equal(scheduler.suspendSession("s1"), null);
    // 返回的是副本：挂起已把内部待办收走，副本语义的可观测路径在恢复——恢复后
    // 改外部对象，不得污染已武装的记录（restorePending 存的是展开副本）。
    assert.equal(scheduler.restorePending("s1", pending), true);
    pending.turn = 999;
    assert.equal(scheduler.stateSnapshot()["s1"]?.pending?.turn, 3, "外部改副本不污染已武装的记录");
  });

  it("定时器 disposer 抛错不阻断挂起", () => {
    const scheduler = new ResumeScheduler({ now: makeClock().now });
    scheduler.onFailure(base);
    let disposeCalls = 0;
    scheduler.attachTimer("s1", () => {
      disposeCalls += 1;
      throw new Error("dispose boom");
    });
    const pending = scheduler.suspendSession("s1");
    assert.ok(pending !== null, "disposer 抛错后仍应取出待办");
    assert.equal(disposeCalls, 1, "disposer 确实被调用过（而不是压根没调）");
    assert.equal(hasPending(scheduler, "s1"), false, "disposeTimer 已收走待办");
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

  it("挂起位还在、期间又排上新的待办：旧快照不得覆盖新待办", () => {
    // suspendSession 只置 suspended、不清 pending 判据；冷却过后再次 onFailure 会在
    // suspended 仍为真时排上新的待办。此时重连拿旧快照来恢复，restorePending 的三道守卫里
    // 只有 `rec.pending !== null` 能挡住（另两道此时都放行）——摘掉它，旧快照会把刚排上的
    // 续跑覆盖掉，而调用方拿到的是 true。
    const clock = makeClock();
    const scheduler = new ResumeScheduler({ now: clock.now });
    scheduler.onFailure(base);
    const snapshot = scheduler.suspendSession("s1");
    assert.ok(snapshot !== null, "挂起要交回快照");
    clock.advance(200_000);
    assert.equal(
      scheduler.onFailure({ ...base, turn: 5 }).action,
      "schedule",
      "冷却已过：新待办排上",
    );
    assert.equal(scheduler.restorePending("s1", snapshot), false, "已有新待办 ⇒ 旧快照就此作废");
    assert.equal(scheduler.stateSnapshot()["s1"]?.pending?.turn, 5, "新排上的待办不被旧快照覆盖");
  });

  it("restorePending 成功：恢复原 fireAt，remainingMs 反映剩余时间", () => {
    const clock = makeClock();
    const scheduler = new ResumeScheduler({ now: clock.now });
    scheduler.onFailure(base);
    const pending = scheduler.suspendSession("s1");
    assert.ok(pending !== null);
    clock.advance(3000);
    assert.equal(scheduler.restorePending("s1", pending), true);
    assert.equal(scheduler.stateSnapshot()["s1"]?.pending?.fireAt, FIRE_AT, "保留原 fireAt");
    assert.equal(remainingMs(scheduler, "s1"), 7000, "剩余 = fireAt - now");
    // 恢复 ⇒ 待办可武装：restorePending 的语义是调用方随即 attachTimer，
    // 恢复出无法挂载的状态（或 suspended 未落回）时这里必须红。
    let reattached = 0;
    assert.equal(
      scheduler.attachTimer("s1", () => {
        reattached += 1;
      }),
      true,
      "恢复后的待办可重新挂定时器",
    );
    assert.equal(reattached, 0, "挂上的只是释放钩子，不该立刻被调");
    // 恢复还要把 `suspended` 落回 false：没落回的记录在台账淘汰那一判据里永远算「欠着补发」，
    // 长跑进程里永久占位（resume-scheduler.ts 那条注释自己写明这一点）。可观测面只有淘汰：
    // 结算后把台账灌满，这条记录必须出局。
    scheduler.attachTimer("s1", null);
    scheduler.settle("s1", "fired");
    for (let index = 0; index < MAX_SESSIONS; index += 1) {
      scheduler.onFailure({ ...base, sessionId: `f${String(index)}` });
      scheduler.settle(`f${String(index)}`, "fired");
    }
    assert.equal(scheduler.stateSnapshot()["s1"], undefined, "恢复并结算过的记录要重新可淘汰");
    assert.equal(reattached, 1, "换挂 null 时旧释放钩子被调用");
  });

  it("restorePending：会话已不被记录（dispose/淘汰过）⇒ 拒绝，且不凭空造出一枚满额记录", () => {
    // 反例来自属性层（test/property/resume-scheduler.property.test.ts）：旧实现走
    // `rec()`，未知会话会被就地新建一枚 counts 全 0 的记录并返回 true——于是
    // 「恢复一条早就被 dispose 的挂起待办」拿到的是**满额** maxResumes 配额，
    // 防失控闸门在这条会话上被静默复位，日志里一个字都不会提。
    const clock = makeClock();
    const scheduler = new ResumeScheduler({ now: clock.now });
    const pending = { turn: 7, kind: "resume" as const, fireAt: FIRE_AT, announcedAt: 1 };
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
    let disposeCalls = 0;
    scheduler.attachTimer("s1", () => {
      disposeCalls += 1;
      throw new Error("dispose boom");
    });
    assert.deepEqual(scheduler.cancel("s1"), { cancelled: true, turn: 3 });
    assert.equal(disposeCalls, 1, "disposer 确实被调用过");
    assert.equal(hasPending(scheduler, "s1"), false);
  });
});
