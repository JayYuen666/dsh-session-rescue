// test/scheduler-snapshot.ts —— 用调度器的**公开快照形状**读「有没有待办 / 还剩多久」。
//
// 为什么按快照读、而不是给调度器开 `hasPending()` / `remainingMs(sessionId)` 两条按会话的出口：
// host 读待办走 `stateSnapshot()`，读剩余时间走 `remainingMsFor(fireAt)`（定义见
// lib/resume-scheduler.ts），按会话的出口开出来只会被用例养着。
// 快照本来就有 `pending` 与 `pending.remainingMs` 这两位，判据一字不改，只是换个读法。

import type { ResumeScheduler } from "../lib/resume-scheduler.ts";

/**
 * 一次快照同时取两位读数。
 *
 * `stateSnapshot()` 每次都会按注入时钟取一次 now() 并重建**全部**会话的 pending
 * （含逐个算 remainingMs），所以两个读数各调一次不只是多一次遍历：两次调用之间时钟可能
 * 已经走了一格，于是「有待办、但剩余 0ms」与「没待办」这两条断言就读到了两份不同的
 * 快照——失败信息会自相矛盾。取一次、读两位，两条判据才在同一个时刻上。
 */
export interface PendingReading {
  pending: boolean;
  remainingMs: number | null;
}

/** 一次快照同时取两位读数；需要同时断言「有待办」与「剩余多久」时用它，别分别调两次。 */
export function readPending(scheduler: ResumeScheduler, sessionId: string): PendingReading {
  const row = scheduler.stateSnapshot()[sessionId]?.pending ?? null;
  return { pending: row !== null, remainingMs: row === null ? null : row.remainingMs };
}

/** 该会话是否有待办：未登记 = 快照里没有这一行，登记但已收掉 = `pending: null`。 */
export function hasPending(scheduler: ResumeScheduler, sessionId: string): boolean {
  return readPending(scheduler, sessionId).pending;
}

/** 待办的剩余毫秒；无待办/未登记 → null。与快照同一份算式（走注入时钟，过期钳制为 0）。 */
export function remainingMs(scheduler: ResumeScheduler, sessionId: string): number | null {
  return readPending(scheduler, sessionId).remainingMs;
}
