import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { MAX_SESSIONS, ResumeScheduler } from "../lib/resume-scheduler.ts";
import type { OnFailureInput, RescueKind } from "../lib/resume-scheduler.ts";
// 待办在位/剩余时间改用调度器的公开快照形状读（原先那两条按会话的出口只被用例取用）。
import { hasPending, remainingMs } from "./scheduler-snapshot.ts";

function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let time = start;
  return {
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
  };
}

/** 调度器「次数已满」闸门的拒因（decision.reason 的期望值，测试作者自持一份）。 */
const MAX_RESUMES_REASON = "max-resumes";

const base: OnFailureInput = {
  sessionId: "s1",
  turn: 3,
  delayMs: 10_000,
  cooldownMs: 120_000,
  maxResumes: 3,
};

/** 造一个"登记过但已无待办"的调度器：onFailure 排上、settle 收掉，pending 归 null。 */
function settled(): ResumeScheduler {
  const scheduler = new ResumeScheduler({ now: makeClock().now });
  scheduler.onFailure(base);
  assert.equal(scheduler.settle("s1", "fired"), true);
  return scheduler;
}

describe("onFailure 调度决策", () => {
  it("首个失败：schedule，fireAt = now + delayMs", () => {
    const clock = makeClock();
    const scheduler = new ResumeScheduler({ now: clock.now });
    const decision = scheduler.onFailure(base);
    assert.equal(decision.action, "schedule");
    assert.equal(decision.delayMs, 10_000);
    assert.equal(decision.fireAt, 1_010_000);
    assert.equal(hasPending(scheduler, "s1"), true);
  });

  it("时钟从 0 起时冷却照样生效（0 是合法时钟值，不是「从未 fire」）", () => {
    // 旧实现用 `firedAt > 0` 判「有没有 fire 过」，于是注入一台从 0 起的时钟时，
    // 一次真实 fire 留下的 `lastFireAt = 0` 被读成「从没发生过」，冷却被静默关闭。
    // 宿主默认的 `Date.now()` 是 13 位，恰好掩盖了这一支——属"只有注入时钟才看得见"的缺陷。
    const clock = makeClock(0);
    const scheduler = new ResumeScheduler({ now: clock.now });
    const first = scheduler.onFailure({
      ...base,
      kind: "resume",
      delayMs: 10_000,
      cooldownMs: 120_000,
      maxResumes: 3,
    });
    assert.equal(first.action, "schedule");
    scheduler.settle("s1", "fired");
    // 此刻 now() 仍是 0，lastFireAt.resume 也是 0：必须判成"在冷却里"，而不是"从没 fire"。
    const second = scheduler.onFailure({
      ...base,
      kind: "resume",
      delayMs: 10_000,
      cooldownMs: 120_000,
      maxResumes: 3,
    });
    assert.equal(second.action, "skip", "0 时刻 fire 之后必须还在冷却里");
    assert.equal(second.reason, "cooldown");
  });

  it("冷却按 kind 独立：resume fire 后同秒的 continue 不被误拦", () => {
    const scheduler = new ResumeScheduler({ now: makeClock().now });
    scheduler.onFailure({
      ...base,
      kind: "resume",
      delayMs: 10_000,
      cooldownMs: 120_000,
      maxResumes: 3,
    });
    scheduler.settle("s1", "fired");
    // 同一时刻（时钟未推进）continue 触发：它自己的冷却尚未启动，应可调度。
    // 共享 lastFireAt 时这里会被 resume 的 120s 冷却跨 kind 误拦（skip cooldown）。
    const contDecision = scheduler.onFailure({
      ...base,
      kind: "continue",
      delayMs: 3000,
      cooldownMs: 60_000,
      maxResumes: 3,
    });
    assert.equal(contDecision.action, "schedule", "各 kind 冷却独立，不得跨 kind 误拦");
    scheduler.settle("s1", "fired");
    const unfinDecision = scheduler.onFailure({
      ...base,
      kind: "unfinished",
      delayMs: 5000,
      cooldownMs: 120_000,
      maxResumes: 2,
    });
    assert.equal(unfinDecision.action, "schedule");
  });

  it("同 kind 冷却仍然生效（独立 ≠ 没有冷却）", () => {
    const scheduler = new ResumeScheduler({ now: makeClock().now });
    scheduler.onFailure({ ...base, kind: "continue", delayMs: 3000, cooldownMs: 60_000 });
    scheduler.settle("s1", "fired");
    const resultDecision = scheduler.onFailure({
      ...base,
      kind: "continue",
      delayMs: 3000,
      cooldownMs: 60_000,
    });
    assert.equal(resultDecision.action, "skip");
    assert.equal(resultDecision.reason, "cooldown");
  });

  it("非法 sessionId：skip invalid-session", () => {
    const scheduler = new ResumeScheduler({ now: makeClock().now });
    const empty = scheduler.onFailure({ ...base, sessionId: "" });
    assert.equal(empty.action, "skip");
    assert.equal(empty.reason, "invalid-session");
    // 运行时守卫：非字符串 sessionId 被拒绝（类型系统外注入）
    const wrongType = scheduler.onFailure({ ...base, sessionId: 42 as unknown as string });
    assert.equal(wrongType.action, "skip");
    assert.equal(wrongType.reason, "invalid-session");
  });

  it("已有待办：skip pending", () => {
    const scheduler = new ResumeScheduler({ now: makeClock().now });
    scheduler.onFailure(base);
    const decision = scheduler.onFailure({ ...base, turn: 4 });
    assert.equal(decision.action, "skip");
    assert.equal(decision.reason, "pending");
  });

  it("会话表满且无空闲记录：拒绝新记录，不让 Map 无界增长", () => {
    const scheduler = new ResumeScheduler({ now: makeClock().now });
    for (let index = 0; index < MAX_SESSIONS; index += 1) {
      const decision = scheduler.onFailure({ ...base, sessionId: `busy-${index}` });
      assert.equal(decision.action, "schedule", `第 ${index} 个会话应被排期`);
    }
    const rejected = scheduler.onFailure({ ...base, sessionId: "extra" });
    assert.equal(rejected.action, "skip");
    assert.equal(rejected.reason, "capacity");
    assert.equal(scheduler.stateSnapshot()["extra"], undefined, "被拒绝的会话不得建记录");
  });

  it("达到次数上限：skip max-resumes", () => {
    const clock = makeClock();
    const scheduler = new ResumeScheduler({ now: clock.now });
    for (let i = 0; i < 3; i += 1) {
      assert.equal(scheduler.onFailure({ ...base, turn: i + 1 }).action, "schedule");
      scheduler.settle("s1", "fired");
      // 跨过冷却
      clock.advance(200_000);
    }
    const decision = scheduler.onFailure({ ...base, turn: 9 });
    assert.equal(decision.action, "skip");
    assert.equal(decision.reason, MAX_RESUMES_REASON);
  });

  it("冷却期内：skip cooldown 并给出 retryAfterMs", () => {
    const clock = makeClock();
    const scheduler = new ResumeScheduler({ now: clock.now });
    scheduler.onFailure(base);
    scheduler.settle("s1", "fired");
    // 30s < 120s 冷却
    clock.advance(30_000);
    const decision = scheduler.onFailure({ ...base, turn: 4 });
    assert.equal(decision.action, "skip");
    assert.equal(decision.reason, "cooldown");
    assert.equal(decision.retryAfterMs, 90_000);
  });

  it("链式例外：冷却期内但 chainDelayMs>0 → 不被冷却拦截，延迟取大", () => {
    const clock = makeClock();
    const scheduler = new ResumeScheduler({ now: clock.now });
    // turn 3 失败 → 待办
    scheduler.onFailure(base);
    // fire → count=1, lastFireAt=t
    scheduler.settle("s1", "fired");
    // 18s < 120s 冷却（真实事故形态）
    clock.advance(18_000);
    const decision = scheduler.onFailure({ ...base, turn: 4, chainDelayMs: 60_000 });
    assert.equal(decision.action, "schedule");
    assert.equal(decision.chained, true);
    // max(10000, 60000)
    assert.equal(decision.delayMs, 60_000);
    assert.equal(decision.fireAt, 1_000_000 + 18_000 + 60_000);
    assert.equal(scheduler.stateSnapshot()["s1"]?.pending?.chained, true);
  });

  it("链式延迟小于常规延迟时取常规延迟（max 语义）", () => {
    const clock = makeClock();
    const scheduler = new ResumeScheduler({ now: clock.now });
    scheduler.onFailure(base);
    scheduler.settle("s1", "fired");
    clock.advance(18_000);
    const decision = scheduler.onFailure({ ...base, turn: 4, chainDelayMs: 5000 });
    assert.equal(decision.action, "schedule");
    // max(10000, 5000)
    assert.equal(decision.delayMs, 10_000);
  });

  it("链式例外不绕过 max-resumes 次数上限（防 runaway）", () => {
    const clock = makeClock();
    const scheduler = new ResumeScheduler({ now: clock.now });
    for (let i = 0; i < 3; i += 1) {
      assert.equal(
        scheduler.onFailure({ ...base, turn: i + 1, chainDelayMs: 60_000 }).action,
        "schedule",
      );
      scheduler.settle("s1", "fired");
      // 始终在冷却内，全靠链式例外放行
      clock.advance(18_000);
    }
    const decision = scheduler.onFailure({ ...base, turn: 9, chainDelayMs: 60_000 });
    assert.equal(decision.action, "skip");
    assert.equal(decision.reason, MAX_RESUMES_REASON);
  });

  it("冷却外的普通失败不受 chainDelayMs 语义影响（延迟仍取大，但 chained 标记如实）", () => {
    const clock = makeClock();
    const scheduler = new ResumeScheduler({ now: clock.now });
    scheduler.onFailure(base);
    scheduler.settle("s1", "fired");
    // 已出冷却
    clock.advance(130_000);
    const decision = scheduler.onFailure({ ...base, turn: 4, chainDelayMs: 60_000 });
    assert.equal(decision.action, "schedule");
    assert.equal(decision.chained, true);
    assert.equal(decision.delayMs, 60_000);
  });

  it("冷却过期后可再调度", () => {
    const clock = makeClock();
    const scheduler = new ResumeScheduler({ now: clock.now });
    scheduler.onFailure(base);
    scheduler.settle("s1", "fired");
    clock.advance(120_001);
    assert.equal(scheduler.onFailure({ ...base, turn: 4 }).action, "schedule");
  });

  it("会话之间互不影响", () => {
    const scheduler = new ResumeScheduler({ now: makeClock().now });
    scheduler.onFailure(base);
    assert.equal(scheduler.onFailure({ ...base, sessionId: "s2" }).action, "schedule");
  });

  it("resume 与 continue 计数独立（各自上限/冷却分开计数）", () => {
    const clock = makeClock();
    const scheduler = new ResumeScheduler({ now: clock.now });
    const resumeOpts = { ...base, maxResumes: 1 };
    // resume 达到上限 1
    assert.equal(scheduler.onFailure(resumeOpts).action, "schedule");
    scheduler.settle("s1", "fired");
    clock.advance(200_000);
    // resume 上限已满
    const exhausted = scheduler.onFailure(resumeOpts);
    assert.equal(exhausted.action, "skip");
    assert.equal(exhausted.reason, MAX_RESUMES_REASON);
    // continue 独立计数，仍可调度（maxResumes=2）
    const contOpts = { ...base, kind: "continue" as const, maxResumes: 2 };
    assert.equal(scheduler.onFailure(contOpts).action, "schedule");
    scheduler.settle("s1", "fired");
    const snap = scheduler.stateSnapshot();
    // 首条断言走 node:assert 的 `asserts actual is T`：`snap["s1"]?.counts.resume === 1`
    // 成立即证明该键存在，其后同一引用上的 `?.` 都是冗余守卫（值本身照旧断言）。
    assert.equal(snap["s1"]?.counts.resume, 1);
    assert.equal(snap["s1"].counts.continue, 1);
    assert.equal(snap["s1"].count, 2);
  });
});

describe("cancel", () => {
  it("取消待办：释放定时器、清 pending、不增 count、随后可再调度", () => {
    const scheduler = new ResumeScheduler({ now: makeClock().now });
    scheduler.onFailure(base);
    let disposed = 0;
    scheduler.attachTimer("s1", () => {
      disposed += 1;
    });
    assert.deepEqual(scheduler.cancel("s1"), { cancelled: true, turn: 3 });
    assert.equal(disposed, 1);
    assert.equal(hasPending(scheduler, "s1"), false);
    assert.equal(scheduler.stateSnapshot()["s1"]?.count, 0);
    assert.equal(scheduler.onFailure(base).action, "schedule");
  });

  it("无待办时 cancel 是 no-op", () => {
    const scheduler = new ResumeScheduler({ now: makeClock().now });
    assert.deepEqual(scheduler.cancel("sX"), { cancelled: false, reason: "no-pending" });
  });
});

describe("settle", () => {
  it("fired：清 pending、count+1、记录 lastFireAt", () => {
    const clock = makeClock();
    const scheduler = new ResumeScheduler({ now: clock.now });
    scheduler.onFailure(base);
    clock.advance(10_000);
    assert.equal(scheduler.settle("s1", "fired"), true);
    assert.equal(hasPending(scheduler, "s1"), false);
    const snap = scheduler.stateSnapshot();
    assert.equal(snap["s1"]?.count, 1);
    assert.equal(snap["s1"].lastFireAt, 1_010_000);
  });

  it("skipped：清 pending，不增 count、不进冷却", () => {
    const clock = makeClock();
    const scheduler = new ResumeScheduler({ now: clock.now });
    scheduler.onFailure(base);
    assert.equal(scheduler.settle("s1", "skipped"), true);
    assert.equal(scheduler.stateSnapshot()["s1"]?.count, 0);
    assert.equal(scheduler.onFailure({ ...base, turn: 4 }).action, "schedule");
  });

  it("无待办时 settle 返回 false", () => {
    const scheduler = new ResumeScheduler({ now: makeClock().now });
    assert.equal(scheduler.settle("nope", "fired"), false);
  });
});

describe("attachTimer", () => {
  it("重复挂载时先释放旧 disposer（否则旧定时器泄漏到下一次触发）", () => {
    const scheduler = new ResumeScheduler({ now: makeClock().now });
    scheduler.onFailure(base);
    let firstDisposed = 0;
    assert.equal(
      scheduler.attachTimer("s1", () => {
        firstDisposed += 1;
      }),
      true,
    );
    assert.equal(
      scheduler.attachTimer("s1", () => {
        void 0;
      }),
      true,
    );
    assert.equal(firstDisposed, 1);
  });

  it("有待办时挂载 disposer 成功", () => {
    const scheduler = new ResumeScheduler({ now: makeClock().now });
    scheduler.onFailure(base);
    assert.equal(
      scheduler.attachTimer("s1", () => {
        void 0;
      }),
      true,
    );
  });

  it("无待办时立即释放（竞态守卫）", () => {
    const scheduler = new ResumeScheduler({ now: makeClock().now });
    let disposed = 0;
    assert.equal(
      scheduler.attachTimer("s1", () => {
        disposed += 1;
      }),
      false,
    );
    assert.equal(disposed, 1);
  });
});

describe("stateSnapshot / disposeAll", () => {
  it("snapshot 按注入时钟报告 remainingMs", () => {
    const clock = makeClock();
    const scheduler = new ResumeScheduler({ now: clock.now });
    scheduler.onFailure(base);
    clock.advance(4000);
    const snap = scheduler.stateSnapshot();
    assert.equal(snap["s1"]?.pending?.turn, 3);
    assert.equal(snap["s1"].pending.fireAt, 1_010_000);
    assert.equal(snap["s1"].pending.remainingMs, 6000);
    assert.equal(snap["s1"].count, 0);
    assert.equal(snap["s1"].lastFireAt, 0);
  });

  it("disposeAll 释放所有待办定时器并清空", () => {
    const scheduler = new ResumeScheduler({ now: makeClock().now });
    scheduler.onFailure(base);
    scheduler.onFailure({ ...base, sessionId: "s2" });
    let disposed = 0;
    scheduler.attachTimer("s1", () => {
      disposed += 1;
    });
    scheduler.attachTimer("s2", () => {
      disposed += 1;
    });
    scheduler.disposeAll();
    assert.equal(disposed, 2);
    assert.deepEqual(scheduler.stateSnapshot(), {});
  });
});

describe("unfinished kind（未闭合待办自动补跑）", () => {
  it("三种 kind 各自独立计数与上限", () => {
    const clock = makeClock();
    const scheduler = new ResumeScheduler({ now: clock.now });
    for (const kind of ["resume", "continue", "unfinished"] as const) {
      assert.equal(scheduler.onFailure({ ...base, kind, maxResumes: 1 }).action, "schedule");
      scheduler.settle("s1", "fired");
      clock.advance(200_000);
    }
    const counts = scheduler.stateSnapshot()["s1"]?.counts;
    assert.equal(counts?.resume, 1);
    assert.equal(counts.continue, 1);
    assert.equal(counts.unfinished, 1);
    assert.equal(scheduler.stateSnapshot()["s1"]?.count, 3);
  });

  it("unfinished 达到上限后仅拦该 kind，其它两种仍可调度", () => {
    const clock = makeClock();
    const scheduler = new ResumeScheduler({ now: clock.now });
    scheduler.onFailure({ ...base, kind: "unfinished", maxResumes: 1 });
    scheduler.settle("s1", "fired");
    clock.advance(200_000);
    const blocked = scheduler.onFailure({ ...base, kind: "unfinished", maxResumes: 1 });
    assert.equal(blocked.action, "skip");
    assert.equal(blocked.reason, MAX_RESUMES_REASON);
    assert.equal(
      scheduler.onFailure({ ...base, kind: "resume", maxResumes: 1 }).action,
      "schedule",
    );
  });

  it("闸门顺序：次数已满且仍在冷却期 → 先报 max-resumes（与 resume 同序）", () => {
    const scheduler = new ResumeScheduler({ now: makeClock().now });
    scheduler.onFailure({ ...base, kind: "unfinished", maxResumes: 1 });
    scheduler.settle("s1", "fired");
    // 此刻次数已满且仍在冷却内：次数闸门在前，报 max-resumes。
    const both = scheduler.onFailure({ ...base, kind: "unfinished", maxResumes: 1 });
    assert.equal(both.action, "skip");
    assert.equal(both.reason, MAX_RESUMES_REASON);
    // 次数不受限时同一时刻报的是 cooldown —— 证明两闸确实独立存在。
    const cooling = scheduler.onFailure({ ...base, kind: "unfinished", maxResumes: 2 });
    assert.equal(cooling.action, "skip");
    assert.equal(cooling.reason, "cooldown");
  });
});

describe('onSuccess 重置连续失败计数（长跑会话不得"用完即哑"）', () => {
  it("成功回合后计数归零，恢复调度（原缺陷：满额后永久静默直到重启）", () => {
    const clock = makeClock();
    const scheduler = new ResumeScheduler({ now: clock.now });
    for (let i = 0; i < 3; i += 1) {
      assert.equal(scheduler.onFailure(base).action, "schedule");
      scheduler.settle("s1", "fired");
      // 越出冷却，确保拦住的原因是计数而非冷却
      clock.advance(200_000);
    }
    assert.equal(scheduler.stateSnapshot()["s1"]?.counts.resume, 3);
    const blocked = scheduler.onFailure(base);
    assert.equal(blocked.action, "skip");
    assert.equal(blocked.reason, MAX_RESUMES_REASON);
    // 一次成功回合 = 失败序列已断 → 计数重置，恢复调度能力
    scheduler.onSuccess("s1");
    assert.equal(scheduler.stateSnapshot()["s1"]?.counts.resume, 0);
    assert.equal(scheduler.onFailure(base).action, "schedule");
  });

  it("resume 与 continue 两种计数一起重置", () => {
    const clock = makeClock();
    const scheduler = new ResumeScheduler({ now: clock.now });
    scheduler.onFailure({ ...base, kind: "continue", delayMs: 3000, cooldownMs: 60_000 });
    scheduler.settle("s1", "fired");
    clock.advance(200_000);
    scheduler.onFailure(base);
    scheduler.settle("s1", "fired");
    assert.equal(scheduler.stateSnapshot()["s1"]?.counts.continue, 1);
    assert.equal(scheduler.stateSnapshot()["s1"]?.counts.resume, 1);
    scheduler.onSuccess("s1");
    assert.equal(scheduler.stateSnapshot()["s1"]?.counts.continue, 0);
    assert.equal(scheduler.stateSnapshot()["s1"]?.counts.resume, 0);
  });

  it("onSuccess 不清冷却（防抖保留：成功不绕过冷却）", () => {
    const scheduler = new ResumeScheduler({ now: makeClock().now });
    scheduler.onFailure(base);
    scheduler.settle("s1", "fired");
    scheduler.onSuccess("s1");
    assert.equal(scheduler.stateSnapshot()["s1"]?.lastFireAt, 1_000_000, "冷却起点保留");
    const resultDecision = scheduler.onFailure(base);
    assert.equal(resultDecision.action, "skip");
    assert.equal(resultDecision.reason, "cooldown");
  });

  it("onSuccess 不清待办、不动定时器", () => {
    let disposed = 0;
    const scheduler = new ResumeScheduler({ now: makeClock().now });
    scheduler.onFailure(base);
    scheduler.attachTimer("s1", () => {
      disposed += 1;
    });
    scheduler.onSuccess("s1");
    assert.equal(hasPending(scheduler, "s1"), true, "待办必须存活");
    assert.equal(disposed, 0, "不得释放定时器");
  });

  it("onSuccess 对未知会话是 no-op（不建记录、不复活已清理会话）", () => {
    const scheduler = new ResumeScheduler({ now: makeClock().now });
    scheduler.onSuccess("nope");
    assert.deepEqual(scheduler.stateSnapshot(), {});
  });

  it("跨会话隔离：A 成功不影响 B 的满额计数", () => {
    const clock = makeClock();
    const scheduler = new ResumeScheduler({ now: clock.now });
    for (let i = 0; i < 3; i += 1) {
      scheduler.onFailure({ ...base, sessionId: "s2" });
      scheduler.settle("s2", "fired");
      clock.advance(200_000);
    }
    scheduler.onSuccess("s1");
    const s2Decision = scheduler.onFailure({ ...base, sessionId: "s2" });
    assert.equal(s2Decision.action, "skip");
    assert.equal(s2Decision.reason, MAX_RESUMES_REASON);
  });

  it('onSuccess 不重置 unfinished（防"注入→仍带未完成清单→再注入"无限循环）', () => {
    const clock = makeClock();
    const scheduler = new ResumeScheduler({ now: clock.now });
    scheduler.onFailure({ ...base, kind: "unfinished", maxResumes: 2 });
    scheduler.settle("s1", "fired");
    clock.advance(200_000);
    scheduler.onSuccess("s1");
    assert.equal(
      scheduler.stateSnapshot()["s1"]?.counts.unfinished,
      1,
      "成功回合不得给 unfinished 回满配额",
    );
  });

  it("onTodosClosed 恢复 unfinished 配额（清单确实闭合）", () => {
    const clock = makeClock();
    const scheduler = new ResumeScheduler({ now: clock.now });
    scheduler.onFailure({ ...base, kind: "unfinished", maxResumes: 2 });
    scheduler.settle("s1", "fired");
    clock.advance(200_000);
    assert.equal(scheduler.stateSnapshot()["s1"]?.counts.unfinished, 1);
    scheduler.onTodosClosed("s1");
    assert.equal(scheduler.stateSnapshot()["s1"]?.counts.unfinished, 0);
    assert.equal(
      scheduler.onFailure({ ...base, kind: "unfinished", maxResumes: 2 }).action,
      "schedule",
    );
  });

  it("onTodosClosed 不动 resume/continue 计数、不清待办、对未知会话 no-op", () => {
    const clock = makeClock();
    const scheduler = new ResumeScheduler({ now: clock.now });
    scheduler.onFailure(base);
    scheduler.settle("s1", "fired");
    // 越出冷却，确保下一步真的建出待办
    clock.advance(200_000);
    scheduler.onFailure(base);
    assert.equal(hasPending(scheduler, "s1"), true, "前置：待办应存在");
    scheduler.onTodosClosed("s1");
    const snap = scheduler.stateSnapshot()["s1"];
    assert.equal(snap?.counts.resume, 1, "resume 计数保持");
    assert.equal(hasPending(scheduler, "s1"), true, "待办必须存活");
    scheduler.onTodosClosed("nope");
    assert.equal(Object.keys(scheduler.stateSnapshot()).length, 1, "不得为未知会话建记录");
  });
});

describe("MAX_SESSIONS：会话记录上限（防长驻 Map 无界膨胀）", () => {
  const entryBase = {
    turn: 1,
    kind: "resume" as const,
    delayMs: 10,
    cooldownMs: 1000,
    maxResumes: 3,
  };

  it("超过上限时淘汰最旧空闲记录，记录总数有界", () => {
    const scheduler = new ResumeScheduler();
    for (let i = 0; i < 260; i += 1) {
      const decision = scheduler.onFailure({ ...entryBase, sessionId: `s${i}` });
      assert.equal(decision.action, "schedule");
      // 立即结算 → 记录回到空闲态
      scheduler.settle(`s${i}`, "fired");
    }
    const size = Object.keys(scheduler.stateSnapshot()).length;
    assert.ok(size <= 200, `记录数 ${size} 应被压回 MAX_SESSIONS(200) 以内`);
  });

  it("有 pending（含定时器）的记录绝不淘汰：新记录把空闲记录挤掉，活动记录保留", () => {
    const scheduler = new ResumeScheduler();
    // s-active 有待办
    scheduler.onFailure({ ...entryBase, sessionId: "s-active" });
    assert.equal(hasPending(scheduler, "s-active"), true);
    // 再灌满大量空闲会话
    for (let i = 0; i < 220; i += 1) {
      const decision = scheduler.onFailure({ ...entryBase, sessionId: `x${i}` });
      if (decision.action === "schedule") {
        scheduler.settle(`x${i}`, "fired");
      }
    }
    assert.equal(hasPending(scheduler, "s-active"), true, "活动会话记录保留");
    // 活动会话仍可正常 settle
    scheduler.settle("s-active", "fired");
    assert.equal(hasPending(scheduler, "s-active"), false);
  });

  it("全忙时 noteTurnHandled 也不再新建记录：水位记不下，但 Map 不涨", () => {
    const scheduler = new ResumeScheduler();
    for (let i = 0; i < MAX_SESSIONS; i += 1) {
      assert.equal(scheduler.onFailure({ ...entryBase, sessionId: `busy${i}` }).action, "schedule");
    }
    const before = Object.keys(scheduler.stateSnapshot()).length;
    assert.equal(before, MAX_SESSIONS);
    assert.equal(scheduler.noteTurnHandled("extra", 5), true);
    assert.equal(Object.keys(scheduler.stateSnapshot()).length, before);
    // 该会话此后同样不会被排期：容量判据拦住新建记录（与上面同一个结论面）。
    assert.equal(scheduler.onFailure({ ...entryBase, sessionId: "extra" }).action, "skip");
  });

  it("淘汰只影响空闲记录：被淘汰会话再失败时重新调度（不误判 pending）", () => {
    const scheduler = new ResumeScheduler();
    for (let i = 0; i < 260; i += 1) {
      const decision = scheduler.onFailure({ ...entryBase, sessionId: `y${i}` });
      if (decision.action === "schedule") {
        scheduler.settle(`y${i}`, "fired");
      }
    }
    const decision = scheduler.onFailure({ ...entryBase, sessionId: "y0", turn: 2 });
    assert.equal(decision.action, "schedule", "被淘汰的老会话重新失败仍可调度");
  });
});

describe("定时器挂载面与脏 kind 降级（审计补漏）", () => {
  it("attachTimer：会话未知 → 传入的定时器立刻释放；dispose 非函数也只返回 false", () => {
    const scheduler = new ResumeScheduler();
    let released = 0;
    assert.equal(
      scheduler.attachTimer("ghost", () => {
        released += 1;
      }),
      false,
    );
    assert.equal(released, 1, "无待办即释放，不留孤儿定时器");
    assert.equal(scheduler.attachTimer("ghost", null), false);
  });

  it("attachTimer：待办在位但无定时器 → cancel/disposeAll 走'无定时器可释放'侧", () => {
    const scheduler = new ResumeScheduler();
    scheduler.onFailure({ ...base });
    assert.equal(scheduler.attachTimer("s1", null), true);
    assert.deepEqual(scheduler.cancel("s1"), { cancelled: true, turn: 3 });
    scheduler.onFailure({ ...base, turn: 4 });
    assert.equal(scheduler.attachTimer("s1", null), true);
    scheduler.disposeAll();
    assert.equal(hasPending(scheduler, "s1"), false);
  });

  it("跨版本脏快照（kind 为空串）：settle 与 stateSnapshot 双双回落 resume", () => {
    const scheduler = new ResumeScheduler();
    // 恢复的前提是这条记录还在（`restorePending` 不再凭空造记录）：先用一次正常的
    // 调度+挂起把它留成「有记录、无待办」的形状——那正是重连台账里残留快照的来路。
    scheduler.onFailure({ ...base });
    assert.ok(scheduler.suspendSession("s1") !== null);
    const dirty = { turn: 9, kind: "" as RescueKind, fireAt: 5, announcedAt: 1 };
    assert.equal(scheduler.restorePending("s1", dirty), true);
    assert.equal(scheduler.stateSnapshot()["s1"]?.pending?.kind, "resume", "快照回落 resume");
    assert.equal(scheduler.settle("s1", "fired"), true);
    assert.equal(scheduler.stateSnapshot()["s1"]?.counts.resume, 1, "配额记在 resume 名下");
    assert.equal(scheduler.stateSnapshot()["s1"]?.pending, null);
  });

  it("restorePending：会话已有待办 → 拒绝覆盖（不丢已武装的续跑）", () => {
    const scheduler = new ResumeScheduler();
    scheduler.onFailure({ ...base });
    assert.equal(
      scheduler.restorePending("s1", { turn: 9, kind: "resume", fireAt: 5, announcedAt: 1 }),
      false,
    );
    assert.equal(scheduler.stateSnapshot()["s1"]?.pending?.turn, 3, "原待办保留");
  });
});

describe("已了结会话上的重复动作（host 竞态：定时器先跑完，dispose/settle 才到）", () => {
  it("attachTimer：已无待办时不许把 host 定时器挂上去，且要立刻释放 disposer", () => {
    const scheduler = settled();
    let released = 0;
    assert.equal(
      scheduler.attachTimer("s1", () => {
        released += 1;
      }),
      false,
    );
    assert.equal(released, 1, "挂不上就必须释放，否则 host 的定时器句柄会泄漏");
  });

  it("attachTimer：会话从未登记过同样返回 false，并释放 disposer", () => {
    const scheduler = new ResumeScheduler({ now: makeClock().now });
    let released = 0;
    assert.equal(
      scheduler.attachTimer("ghost", () => {
        released += 1;
      }),
      false,
    );
    assert.equal(released, 1);
  });

  it("settle：没有待办时二次 settle 返回 false（幂等，不重复计数）", () => {
    const scheduler = settled();
    assert.equal(scheduler.settle("s1", "fired"), false);
    assert.equal(scheduler.settle("ghost", "skipped"), false);
  });

  it("remainingMs：无待办与未登记都返回 null，不给出假的倒计时", () => {
    const scheduler = settled();
    assert.equal(remainingMs(scheduler, "s1"), null);
    assert.equal(remainingMs(scheduler, "ghost"), null);
  });
});

describe("挂起中的记录不得被台账淘汰（防失控闸门不能被静默清零）", () => {
  it("填满台账后恢复挂起待办：counts 必须还是原来的", () => {
    const scheduler = new ResumeScheduler({ now: makeClock().now });
    // 真正 fire 一次，用掉 1 枚 resume 配额。
    scheduler.onFailure(base);
    assert.equal(scheduler.settle("s1", "fired"), true);
    // 再排一次，随后被宿主挂起（follower 抛错那条路）。
    scheduler.onFailure({ ...base, cooldownMs: 0 });
    const suspended = scheduler.suspendSession("s1");
    assert.notEqual(suspended, null, "挂起应交出待办快照");
    // 220 枚别家会话把台账推过 MAX_SESSIONS：此刻 s1 的记录形状是
    // 「无 pending、无定时器」，正是淘汰条件命中的那一类。
    for (let i = 0; i < 220; i += 1) {
      scheduler.onFailure({ ...base, sessionId: `other-${String(i)}`, cooldownMs: 0 });
    }
    assert.equal(scheduler.restorePending("s1", suspended!), true);
    // 断言的是**行为**：恢复后配额仍在，长跑 daemon 上「失败→续跑→同失败」的上限
    // 不会因为一次淘汰而回到满额。
    const snap = scheduler.stateSnapshot()["s1"];
    assert.equal(snap?.counts.resume, 1, "挂起中的会话被淘汰后，max-resumes 闸门会静默归零");
  });

  it("releaseSuspended：宿主丢快照后该记录重新可淘汰（不留永久占位）", () => {
    const scheduler = new ResumeScheduler({ now: makeClock().now });
    scheduler.onFailure(base);
    assert.equal(scheduler.settle("s1", "fired"), true);
    scheduler.onFailure({ ...base, cooldownMs: 0 });
    const held = scheduler.suspendSession("s1");
    assert.notEqual(held, null, "挂起应交出待办快照");
    // 先证明挂起中不可淘汰。
    for (let i = 0; i < 220; i += 1) {
      scheduler.onFailure({ ...base, sessionId: `pin-${String(i)}`, cooldownMs: 0 });
    }
    assert.ok(scheduler.stateSnapshot()["s1"] !== undefined, "挂起中不得被淘汰");
    // 宿主丢弃这份快照（取消/关开关/dispose/裁剪都走这里）。
    scheduler.releaseSuspended("s1");
    for (let i = 0; i < 220; i += 1) {
      scheduler.onFailure({ ...base, sessionId: `after-${String(i)}`, cooldownMs: 0 });
    }
    assert.equal(
      scheduler.stateSnapshot()["s1"],
      undefined,
      "释放后重新成为可淘汰的空闲记录，否则就换成一处永久占位",
    );
    // 记录已经不在了：拿着宿主丢弃的那份快照回来恢复必须被拒——`restorePending` 绝不凭空
    // 造记录，否则 counts 全 0 的新记录等于把 max-resumes 闸门静默复位。
    assert.equal(
      scheduler.restorePending("s1", held!),
      false,
      "被淘汰的会话仍可用旧快照恢复，等于凭空造出一条带满额配比的记录",
    );
    // 幂等：对没有记录的会话调用是 no-op。
    scheduler.releaseSuspended("never-seen");
  });
});
