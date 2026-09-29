/**
 * 自动续跑调度器：纯状态机。
 * 不持有定时器、不访问 agent、无 I/O。host.ts 用 ctx.timer.timeout 建真定时器，
 * 经 attachTimer() 把 disposer 挂进来；所有时间读注入的 now()，测试可控制时钟。
 *
 * 每会话记录：
 *   count        已真正 fire 的续跑次数（次数上限闸门）
 *   lastFireAt   各 kind 上次 fire 的时钟值（冷却闸门，按 kind 独立）
 *   pending      { turn, fireAt, announcedAt }，待办存在期间非 null
 *   disposeTimer 挂载的 host 定时器 disposer
 */

export type RescueKind = "resume" | "continue" | "unfinished";

/** 调度决策：判别联合——`skip` 必带 reason、`schedule` 必带 fireAt/delayMs/chained。
 *  （此前是单一 interface + 全可选字段，调用方因此写出
 *  `decision.reason ?? "unknown"`、`decision.delayMs ?? 0` 两个永远走不到的
 *  兜底分支：状态机自己发的每条决策都填满了字段，缺字段在类型上就该不可能。） */
export type FailureDecision =
  | { readonly action: "skip"; readonly reason: string; readonly retryAfterMs?: number }
  | {
      readonly action: "schedule";
      readonly fireAt: number;
      readonly delayMs: number;
      readonly chained: boolean;
    };

export interface PendingRecord {
  turn: number;
  /** 三类之一，**外加空串**：`restorePending()` 收的是调用方交回的待办快照
   *  （host 的 suspended 台账可以来自上一个版本的进程），那里 `kind` 可能是空串；
   *  两个读取点因此都带 `|| "resume"` 回落，并有专门用例钉住（见
   *  test/resume-scheduler.test.ts「跨版本脏快照」）。类型写窄了 = 那两条回落被
   *  判成死代码，所以这里如实承认这一位可缺。 */
  kind: RescueKind | "";
  fireAt: number;
  announcedAt: number;
  chained?: boolean;
}

interface SessionRecord {
  counts: Record<RescueKind, number>;
  /** 冷却时间戳按 kind 分别记录：三种注入各有自己的 cooldownMs，共享一个
   *  lastFireAt 会让 resume 的 120s 冷却跨 kind 误拦 continue/unfinished。 */
  lastFireAt: Record<RescueKind, number>;
  pending: PendingRecord | null;
  disposeTimer: (() => void) | null;
}

export interface SnapshotPending {
  turn: number;
  kind: RescueKind;
  fireAt: number;
  remainingMs: number;
  chained: boolean;
}

export interface SessionSnapshot {
  count: number;
  counts: Record<RescueKind, number>;
  lastFireAt: number;
  pending: SnapshotPending | null;
}

export interface OnFailureInput {
  sessionId: string;
  turn: number;
  kind?: RescueKind;
  delayMs: number;
  cooldownMs: number;
  maxResumes: number;
  chainDelayMs?: number;
}

export type TimerDisposer = () => void;

/** 挂载竞态里已无待办 → 立刻释放刚建好的定时器（`attachTimer` 的两个无待办出口共用）。 */
function releaseDisposer(dispose: TimerDisposer | null): void {
  if (typeof dispose === "function") {
    dispose();
  }
}

/** 会话记录上限：长驻进程防 Map 无界膨胀（每条记录很小，但会话数会一直涨）。
 *  超限时淘汰最旧的"空闲"记录（无 pending、无挂载定时器——有定时器的记录
 *  绝不淘汰，否则定时器泄漏）。与 quality-gate(50)/ctx-observe(200) 同一纪律。 */
const MAX_SESSIONS = 200;

export class ResumeScheduler {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly now: () => number;

  public constructor({ now }: { now?: () => number } = {}) {
    this.now = typeof now === "function" ? now : () => Date.now();
  }

  private rec(sessionId: string): SessionRecord {
    let rec = this.sessions.get(sessionId);
    if (rec !== undefined) {
      return rec;
    }
    this.evictIdleSessions();
    rec = {
      counts: { resume: 0, continue: 0, unfinished: 0 },
      lastFireAt: { resume: 0, continue: 0, unfinished: 0 },
      pending: null,
      disposeTimer: null,
    };
    this.sessions.set(sessionId, rec);
    return rec;
  }

  /** 新建记录前腾位：删最旧的空闲记录（无 pending 且无定时器）直到未超限。 */
  private evictIdleSessions(): void {
    if (this.sessions.size < MAX_SESSIONS) {
      return;
    }
    for (const [key, rec] of this.sessions) {
      if (rec.pending === null && rec.disposeTimer === null) {
        this.sessions.delete(key);
      }
      if (this.sessions.size < MAX_SESSIONS) {
        return;
      }
    }
  }

  /** 对一次新的瞬时失败/截断做调度决策；除状态外无任何副作用。
   *  kind = 'resume'|'continue'，maxResumes 是该 kind 的次数上限（两种独立计数）。
   *  chainDelayMs（链式延迟）> 0 时表示本次失败轮由本插件上一次 fire 开启
   *  （续跑链中段）：冷却不拦截，改按 max(delayMs, chainDelayMs) 重调度。 */
  public onFailure(input: OnFailureInput): FailureDecision {
    const {
      sessionId,
      turn,
      kind = "resume",
      delayMs,
      cooldownMs,
      maxResumes,
      chainDelayMs = 0,
    } = input;
    if (typeof sessionId !== "string" || sessionId === "") {
      return { action: "skip", reason: "invalid-session" };
    }
    const rec = this.rec(sessionId);
    if (rec.pending !== null) {
      return { action: "skip", reason: "pending" };
    }
    if (rec.counts[kind] >= maxResumes) {
      return { action: "skip", reason: "max-resumes" };
    }
    const nowTime = this.now();
    const firedAt = rec.lastFireAt[kind];
    const inCooldown = firedAt > 0 && nowTime - firedAt < cooldownMs;
    if (inCooldown && chainDelayMs <= 0) {
      return { action: "skip", reason: "cooldown", retryAfterMs: cooldownMs - (nowTime - firedAt) };
    }
    // 链式例外：失败轮属于上次 fire 开出的续跑链 → 允许重调度，但延迟取大，
    // 避免再次打进同一限流窗口（如 8 req/min 配额）导致连环失败。
    const effectiveDelay = chainDelayMs > delayMs ? chainDelayMs : delayMs;
    rec.pending = {
      turn,
      kind,
      fireAt: nowTime + effectiveDelay,
      announcedAt: nowTime,
      chained: chainDelayMs > 0,
    };
    return {
      action: "schedule",
      fireAt: rec.pending.fireAt,
      delayMs: effectiveDelay,
      chained: chainDelayMs > 0,
    };
  }

  /** 挂载 host 定时器 disposer；若此刻已无待办（竞态）则立即释放。 */
  public attachTimer(sessionId: string, dispose: TimerDisposer | null): boolean {
    const rec = this.sessions.get(sessionId);
    if (rec === undefined) {
      releaseDisposer(dispose);
      return false;
    }
    if (rec.pending === null) {
      releaseDisposer(dispose);
      return false;
    }
    rec.disposeTimer = typeof dispose === "function" ? dispose : null;
    return true;
  }

  /** 用户取消（UI 按钮 / webServer 路由）：释放定时器，清待办，不增 count。 */
  public cancel(sessionId: string): { cancelled: boolean; reason?: string; turn?: number } {
    const rec = this.sessions.get(sessionId);
    if (rec === undefined) {
      return { cancelled: false, reason: "no-pending" };
    }
    if (rec.pending === null) {
      return { cancelled: false, reason: "no-pending" };
    }
    if (rec.disposeTimer !== null) {
      try {
        rec.disposeTimer();
      } catch {
        /* 释放失败不阻断取消 */
      }
      rec.disposeTimer = null;
    }
    const { turn } = rec.pending;
    rec.pending = null;
    return { cancelled: true, turn };
  }

  /**
   * 定时器已触发后来结算：
   *   'fired'   触发前校验通过、followup 已发出 → count+1，冷却开始计时。
   *   'skipped' 触发前校验否决 → 静默解除，不增 count、不进冷却。
   * 定时器已经跑过，无需再 dispose。
   */
  public settle(sessionId: string, outcome: "fired" | "skipped"): boolean {
    const rec = this.sessions.get(sessionId);
    if (rec === undefined) {
      return false;
    }
    if (rec.pending === null) {
      return false;
    }
    const kind = rec.pending.kind || "resume";
    rec.pending = null;
    rec.disposeTimer = null;
    if (outcome === "fired") {
      rec.counts[kind] += 1;
      rec.lastFireAt[kind] = this.now();
    }
    return true;
  }

  /**
   * 会话出现一个**成功完成**的回合（reason.kind === 'completed'）→ 重置两种
   * 失败计数。
   *
   * 存在的必要（审查发现的真实缺陷）：counts 此前只在记录创建时归零、
   * 只有 fire 时 +1，没有任何重置点。配合默认 maxResumes=3，等于**每个会话整个
   * 生命周期只允许自动续跑 3 次**；长跑会话（跨天、上百回合）一旦在早段耗尽配额，
   * 之后所有该续跑的瞬时失败都会静默 skip(max-resumes)，直到重启 dsh 才恢复——
   * 用户侧现象即"模型自己停了却没有自动续跑"。
   *
   * 语义：次数上限要挡的是「失败→续跑→同样失败」的连续 runaway，不是整个会话
   * 的累计次数。一次成功回合说明失败序列已断，配额理应恢复。
   *
   * 只清计数：不动 pending、不动定时器、不动各 kind 的冷却时间戳（冷却是防抖，
   * 与配额无关，成功不应绕过冷却）。对未知会话是 no-op——绝不复活 disposeAll
   * 清掉的记录。
   */
  public onSuccess(sessionId: string): void {
    const rec = this.sessions.get(sessionId);
    if (rec === undefined) {
      return;
    }
    rec.counts.resume = 0;
    rec.counts.continue = 0;
    // 故意不重置 unfinished：它的触发条件本身就是「completed 且清单未闭合」，
    // 若成功回合也给它回满配额，就会形成 注入→仍带未完成清单完成→再注入 的
    // 无限循环。它的配额只能由 onTodosClosed() 恢复。
  }

  /**
   * 清单已闭合（completed 回合且待办全部完成）→ 恢复 unfinished 配额。
   * 语义：只有"确实做完了"才重新给补跑机会；注入后仍带未完成清单时配额消耗。
   */
  public onTodosClosed(sessionId: string): void {
    const rec = this.sessions.get(sessionId);
    if (rec === undefined) {
      return;
    }
    rec.counts.unfinished = 0;
  }

  /** JSON 安全快照，供 /_dsh/session-rescue/state 路由序列化。 */
  public stateSnapshot(): Record<string, SessionSnapshot> {
    const nowTime = this.now();
    const out: Record<string, SessionSnapshot> = {};
    for (const [sessionId, rec] of this.sessions) {
      out[sessionId] = {
        count: rec.counts.resume + rec.counts.continue + rec.counts.unfinished,
        counts: {
          resume: rec.counts.resume,
          continue: rec.counts.continue,
          unfinished: rec.counts.unfinished,
        },
        // 对外仍报告单一"最近一次注入时刻"（UI 只用它做展示，闸门判定在内部按 kind）。
        lastFireAt: Math.max(
          rec.lastFireAt.resume,
          rec.lastFireAt.continue,
          rec.lastFireAt.unfinished,
        ),
        pending:
          rec.pending === null
            ? null
            : {
                turn: rec.pending.turn,
                kind: rec.pending.kind || "resume",
                fireAt: rec.pending.fireAt,
                remainingMs: Math.max(0, rec.pending.fireAt - nowTime),
                chained: rec.pending.chained === true,
              },
      };
    }
    return out;
  }

  /** 插件停止：释放所有待办定时器，清空全部记录。 */
  public disposeAll(): void {
    for (const rec of this.sessions.values()) {
      if (rec.disposeTimer !== null) {
        try {
          rec.disposeTimer();
        } catch {
          /* 释放失败不阻断清理 */
        }
        rec.disposeTimer = null;
      }
      rec.pending = null;
    }
    this.sessions.clear();
  }

  /**
   * 单会话挂起：follower 发送抛错（连接/传输类）时把该会话待办取出、释放
   * 定时器，返回 pending 快照供 host 等待重连后恢复。无待办返回 null。
   */
  public suspendSession(sessionId: string): PendingRecord | null {
    const rec = this.sessions.get(sessionId);
    if (rec === undefined) {
      return null;
    }
    if (rec.pending === null) {
      return null;
    }
    if (rec.disposeTimer !== null) {
      try {
        rec.disposeTimer();
      } catch {
        /* 定时器释放失败不阻断挂起 */
      }
      rec.disposeTimer = null;
    }
    const { pending } = rec;
    rec.pending = null;
    return { ...pending };
  }

  /**
   * 恢复一个此前被挂起的待办：重新登记 pending（保原 fireAt），
   * 由调用方挂上新定时器。返回 false 表示该会话当前无待办（不应发生）。
   */
  public restorePending(sessionId: string, pending: PendingRecord): boolean {
    const rec = this.rec(sessionId);
    if (rec.pending !== null) {
      return false;
    }
    rec.pending = { ...pending };
    return true;
  }

  /** 任意 fireAt 的剩余时间（ms，过期钳制为 0）：一律走注入的 now()。
   *  E3：host state 路由的 suspended 快照经此计算，不再直调 Date.now()
   *  导致与调度器时钟漂移。
   *  没有 `remainingMs(sessionId)` 那种按会话的变体：`stateSnapshot()` 的
   *  `pending.remainingMs` 就是同一条算式（挂起恢复路径要的「还有多久」在快照里，
   *  按会话再开一条出口只会有用例在读它）。 */
  public remainingMsFor(fireAt: number): number {
    return Math.max(0, fireAt - this.now());
  }
}
