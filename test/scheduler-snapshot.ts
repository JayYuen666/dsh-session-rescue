// test/scheduler-snapshot.ts —— 用调度器的**公开快照形状**读「有没有待办 / 还剩多久」。
//
// 为什么不是直接调 `hasPending()` / `remainingMs(sessionId)`：那两条按会话的出口在生产里
// 没有任何调用点——host 读待办走 `stateSnapshot()`，读剩余时间走 `remainingMsFor(fireAt)`
// （断连恢复与 state 路由两处，见 lib/resume-scheduler.ts），留下它们只会被用例养着。
// 快照本来就有 `pending` 与 `pending.remainingMs` 这两位，判据一字不改，只是换个读法。

import type { ResumeScheduler } from "../lib/resume-scheduler.ts";

/** 该会话是否有待办：未登记 = 快照里没有这一行，登记但已收掉 = `pending: null`。 */
export function hasPending(scheduler: ResumeScheduler, sessionId: string): boolean {
  const pending = scheduler.stateSnapshot()[sessionId]?.pending ?? null;
  return pending !== null;
}

/** 待办的剩余毫秒；无待办/未登记 → null。与快照同一份算式（走注入时钟，过期钳制为 0）。 */
export function remainingMs(scheduler: ResumeScheduler, sessionId: string): number | null {
  return scheduler.stateSnapshot()[sessionId]?.pending?.remainingMs ?? null;
}
