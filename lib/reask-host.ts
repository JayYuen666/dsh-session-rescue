// Host-side「停止并重问」：客户端 API 只有 queue/steer，无法把消息放到 next-turn 队首；
// 宿主公开的 `agent.inbox.prepend` 可以。这里把 cancel → prepend → 唤醒 组合成一次操作，
// 并用一个只负责唤醒的临时消息触发 driver（prepend 本身不唤醒）。
import type { Inbox } from "@deepseek-ai/dsh-agent";
import type { MessageId, UserMessage } from "@deepseek-ai/dsh-llm";

/** host 侧真正用到的 Agent 写面（RescueAgent 是它的超集）。 */
export interface ReaskAgent {
  cancel: (cause: { kind: "user" }, options?: { keepInbox?: boolean }) => void;
  followup: (message: UserMessage) => void;
  inbox?:
    | {
        prepend?: Inbox["prepend"] | undefined;
        remove?: Inbox["remove"] | undefined;
      }
    | null
    | undefined;
}

/** `cancel-failed` 是半成功：重问已插队，但当前回合没停下，会在它自然结束后发出。 */
export type ReaskResult = { ok: true; warning?: "cancel-failed" } | { ok: false; error: string };

/**
 * cancel 后用 prepend 把重问放到 next-turn 队首，再用一条空消息唤醒 driver 并立刻移除
 * 它。宿主 `preStep` 在第一个 await 之前就 claim：idle 时这次唤醒同步取走队首的重问；
 * abort 收敛中则先 latch wake，收敛后取走队首。两条路径都不会让空消息被 claim。
 */
export function performHostReask(
  agent: ReaskAgent,
  text: string,
  nextId: () => MessageId,
): ReaskResult {
  const { inbox } = agent;
  if (inbox === undefined || inbox === null) {
    return { ok: false, error: "inbox-unavailable" };
  }
  if (inbox.prepend === undefined || inbox.remove === undefined) {
    return { ok: false, error: "inbox-unavailable" };
  }
  let warning: "cancel-failed" | undefined;
  try {
    agent.cancel({ kind: "user" }, { keepInbox: true });
  } catch {
    // cancel 抛错只说明「没停下」；重问仍插队，当前回合结束后会发出。
    warning = "cancel-failed";
  }
  const message: UserMessage = {
    id: nextId(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
  try {
    inbox.prepend("next-turn", message);
  } catch (error) {
    return { ok: false, error: String(error) };
  }
  const wake: UserMessage = {
    id: nextId(),
    role: "user",
    content: [],
    source: { kind: "user" },
  };
  try {
    agent.followup(wake);
  } catch (error) {
    // 唤醒失败：撤掉刚插入的重问，避免它永远停在队首无人唤醒。
    inbox.remove(message.id);
    return { ok: false, error: String(error) };
  }
  inbox.remove(wake.id);
  return warning === undefined ? { ok: true } : { ok: true, warning };
}

/** 每会话保留最近 N 个 requestId：同一次结果不明的重试复用身份，宿主据此拒绝重复入队。 */
const MAX_REASK_SESSIONS = 200;
const MAX_REASK_REQUESTS = 8;

export class ReaskSeen {
  private readonly bySession = new Map<string, Set<string>>();
  private readonly sessionLimit: number;
  private readonly requestLimit: number;

  public constructor(sessionLimit = MAX_REASK_SESSIONS, requestLimit = MAX_REASK_REQUESTS) {
    this.sessionLimit = sessionLimit;
    this.requestLimit = requestLimit;
  }

  public has(sessionId: string, requestId: string): boolean {
    return this.bySession.get(sessionId)?.has(requestId) === true;
  }

  public add(sessionId: string, requestId: string): void {
    let seen = this.bySession.get(sessionId);
    if (seen === undefined) {
      if (this.bySession.size >= this.sessionLimit) {
        const oldest = this.bySession.keys().next().value;
        if (oldest !== undefined) {
          this.bySession.delete(oldest);
        }
      }
      seen = new Set<string>();
      this.bySession.set(sessionId, seen);
    }
    if (seen.size >= this.requestLimit) {
      const oldest = seen.keys().next().value;
      if (oldest !== undefined) {
        seen.delete(oldest);
      }
    }
    seen.add(requestId);
  }

  public forget(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}
