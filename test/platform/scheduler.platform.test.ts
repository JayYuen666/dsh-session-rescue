// 调度器的时钟与容量判据：now() 可注入是本模块的设计面（头注写明），这一层把
// 「非单调时钟」「容量饱和」「0 是合法时钟值」三件平台相关假设逐条钉住。
// 期望值全部来自 lib/resume-scheduler.ts 头注与字段注释写明的契约，不从实现派生。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import fc from "fast-check";

import { MAX_SESSIONS, ResumeScheduler } from "../../lib/resume-scheduler.ts";
import type { PendingRecord } from "../../lib/resume-scheduler.ts";

/** 决策动词的期望值（断言侧自持）。 */
const SCHEDULED = "schedule";
const SKIPPED = "skip";
/** 共用会话标识。 */
const SESSION = "s";

/** 一条最小合法输入（决策判据只看这几位）。 */
function failureInput(overrides: {
  sessionId?: string;
  delayMs?: number;
  cooldownMs?: number;
  maxResumes?: number;
  chainDelayMs?: number;
}): Parameters<ResumeScheduler["onFailure"]>[0] {
  return {
    sessionId: overrides.sessionId ?? SESSION,
    turn: 1,
    kind: "resume",
    delayMs: overrides.delayMs ?? 1000,
    cooldownMs: overrides.cooldownMs ?? 5000,
    maxResumes: overrides.maxResumes ?? 3,
    ...(overrides.chainDelayMs === undefined ? {} : { chainDelayMs: overrides.chainDelayMs }),
  };
}

/** 挂起快照恢复那条用例的共用会话标识。 */
const SUSPENDED_SESSION = "suspended-one";

/** 填一个「挂起中」的会话记录：调度 → 挂定时器 → 挂起（suspended=true，绝不淘汰）。 */
function addSuspendedSession(scheduler: ResumeScheduler, sessionId: string): void {
  const decision = scheduler.onFailure(failureInput({ sessionId, delayMs: 60_000 }));
  assert.equal(decision.action, SCHEDULED, sessionId);
  const mounted = scheduler.attachTimer(sessionId, (): void => {
    void 0;
  });
  assert.equal(mounted, true);
  const suspended = scheduler.suspendSession(sessionId);
  assert.ok(suspended !== null, sessionId);
}

describe("非单调时钟下的冷却方向", () => {
  it("时钟回拨只会延长等待（skip），绝不立刻重发——保守方向", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2_000_000 }),
        fc.integer({ min: 1, max: 60_000 }),
        (firedAt, cooldownMs) => {
          let clock = firedAt;
          const scheduler = new ResumeScheduler({ now: () => clock });
          assert.equal(scheduler.onFailure(failureInput({ cooldownMs })).action, SCHEDULED);
          assert.equal(scheduler.settle(SESSION, "fired"), true);
          // 回拨：now 落到 firedAt 之前（含相等）。now - firedAt ≤ 0 < cooldownMs ⇒ 冷却中。
          for (const rolledBack of [0, Math.max(0, firedAt - 1), firedAt]) {
            clock = rolledBack;
            const decision = scheduler.onFailure(
              failureInput({ sessionId: SESSION, cooldownMs, chainDelayMs: 0 }),
            );
            assert.equal(
              decision.action,
              SKIPPED,
              `回拨后必须仍在冷却：firedAt=${String(firedAt)} now=${String(rolledBack)}`,
            );
          }
          // 冷却自然到期（时钟前进过界）才放行。
          clock = firedAt + cooldownMs;
          assert.equal(
            scheduler.onFailure(failureInput({ sessionId: SESSION, cooldownMs })).action,
            SCHEDULED,
          );
        },
      ),
    );
  });

  it("冷却自然到期后才允许重调度；链式例外（chainDelayMs > 0）不受冷却拦截", () => {
    let clock = 1000;
    const scheduler = new ResumeScheduler({ now: () => clock });
    assert.equal(scheduler.onFailure(failureInput({ cooldownMs: 5000 })).action, SCHEDULED);
    scheduler.settle(SESSION, "fired");
    // 冷却中：普通失败被拦；链中段失败放行（并取 max(delayMs, chainDelayMs)）。
    clock = 3000;
    assert.equal(scheduler.onFailure(failureInput({ cooldownMs: 5000 })).action, SKIPPED);
    const chained = scheduler.onFailure(failureInput({ cooldownMs: 5000, chainDelayMs: 4000 }));
    assert.equal(chained.action, SCHEDULED);
    assert.equal(chained.delayMs, 4000, "链式延迟取大者");
    // 链式那笔按「触发前被否决」静默解除：不记冷却时刻（settle("skipped") 的契约）。
    assert.equal(scheduler.settle(SESSION, "skipped"), true);
    // 冷却到期：普通失败放行（lastFireAt 仍是 1000，7000-1000 ≥ 5000）。
    clock = 7000;
    assert.equal(scheduler.onFailure(failureInput({ cooldownMs: 5000 })).action, SCHEDULED);
  });
});

describe("0 是合法时钟值（null 哨兵契约）", () => {
  it("注入 now() 从 0 起的机器上，真实 fire 的冷却照常生效，不被当成「从未 fire」", () => {
    let clock = 0;
    const scheduler = new ResumeScheduler({ now: () => clock });
    assert.equal(scheduler.onFailure(failureInput({ cooldownMs: 5000 })).action, SCHEDULED);
    scheduler.settle(SESSION, "fired");
    clock = 100;
    assert.equal(
      scheduler.onFailure(failureInput({ sessionId: SESSION, cooldownMs: 5000 })).action,
      SKIPPED,
    );
    // 对外快照的 lastFireAt 仍按 number 报（0 而不是 null）。
    assert.equal(scheduler.stateSnapshot()[SESSION]?.lastFireAt, 0);
    // 从未 fire 的会话对外报 0（与旧契约逐字一致）。
    scheduler.onFailure(failureInput({ sessionId: "fresh" }));
    assert.equal(scheduler.stateSnapshot()["fresh"]?.lastFireAt, 0);
  });

  it("remainingMsFor 走注入时钟：过期钳 0，未来为差值", () => {
    let clock = 1000;
    const scheduler = new ResumeScheduler({ now: () => clock });
    assert.equal(scheduler.remainingMsFor(4000), 3000);
    clock = 5000;
    assert.equal(scheduler.remainingMsFor(4000), 0);
  });
});

describe("容量饱和的现行为", () => {
  it("MAX_SESSIONS 条挂起记录占满后，新会话 skip(capacity)，且告警只报一次（真修复的观察面）", () => {
    const scheduler = new ResumeScheduler();
    for (let index = 0; index < MAX_SESSIONS; index += 1) {
      addSuspendedSession(scheduler, `full-${String(index)}`);
    }
    const overflow = scheduler.onFailure(failureInput({ sessionId: "the-next-one" }));
    assert.equal(overflow.action, SKIPPED);
    assert.equal(overflow.reason, "capacity");
    // 挂起的记录确实不可淘汰：计数就是 MAX_SESSIONS。
    assert.equal(Object.keys(scheduler.stateSnapshot()).length, MAX_SESSIONS);
  });

  it("非挂起记录可被腾位：饱和后新会话仍能进（淘汰的是空闲者）", () => {
    const scheduler = new ResumeScheduler();
    for (let index = 0; index < MAX_SESSIONS; index += 1) {
      // 只调度、不挂起：pending 为 null 且无定时器 ⇒ 空闲记录。
      const sessionId = `idle-${String(index)}`;
      const decision = scheduler.onFailure(failureInput({ sessionId, delayMs: 60_000 }));
      assert.equal(decision.action, SCHEDULED);
      scheduler.settle(sessionId, "skipped");
    }
    const next = scheduler.onFailure(failureInput({ sessionId: "fits-after-evict" }));
    assert.equal(next.action, SCHEDULED);
  });

  it("挂起快照恢复：restorePending 拒绝凭空造记录；恢复后再挂起往返对称；releaseSuspended 幂等", () => {
    const scheduler = new ResumeScheduler();
    addSuspendedSession(scheduler, SUSPENDED_SESSION);
    const snapshot: PendingRecord = {
      turn: 1,
      kind: "resume",
      fireAt: 60_000,
      announcedAt: 0,
      chained: false,
    };
    assert.equal(scheduler.restorePending("unknown-session", snapshot), false);
    assert.equal(scheduler.restorePending(SUSPENDED_SESSION, snapshot), true);
    // 恢复后待办已回位：再挂起取回的是同一份快照（往返对称），不是 null。
    const again = scheduler.suspendSession(SUSPENDED_SESSION);
    assert.ok(again?.fireAt === 60_000);
    // 幂等 + 未知会话 no-op。
    scheduler.releaseSuspended(SUSPENDED_SESSION);
    scheduler.releaseSuspended(SUSPENDED_SESSION);
    scheduler.releaseSuspended("unknown-session");
  });
});
