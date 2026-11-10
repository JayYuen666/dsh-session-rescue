// 停止并重问的宿主交互：cancel 收敛等待、requestId 幂等台账，以及 cancel/queue/steer
// 的顺序。放在 lib 而不是 client-entry：后者受 max-lines 预算约束，且这几段可以脱离
// React 单测（只依赖官方 SessionFace 类型）。
import type { SessionFace, SubmissionHandle } from "@deepseek-ai/dsh-api-session-controller/client";
import type { SessionRequestId } from "@deepseek-ai/dsh-api-session-controller/types";
import type {
  RemoteFailure as TypertRemoteFailure,
  RemoteResult,
} from "@deepseek-ai/dsh-typert-protocol";
import type { TextBlock } from "@deepseek-ai/dsh-llm";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

/** 业务动作的失败支（client-entry 的 sendSameSession/forkAndSend 共用同一形状）。 */
export interface RemoteFailure {
  ok: false;
  code?: string;
  message?: string;
}

/** 官方 `RemoteResult` 的失败支（`error` 在必选位上，故不再写 `?.`）。 */
type Rejected = Extract<RemoteResult<never>, { ok: false }>;

/**
 * `RemoteFailure` 的 code/message 两位按可选读。官方声明把它们钉在必选位上，但交回
 * 本包的失败体在运行时真的可能缺这两位：`remoteErrorOf` 只按结构标记认出失败对象、
 * 不核对字段；网关跨 realm 转发的是裸 JSON 体，测试桩件更直接交 `{ ok:false, error:{} }`。
 * ⇒ 类型在说谎：把这两位的声明改宽，缺字段仍走「不写这一位」的真分支。
 */
type FailureFields = Partial<Pick<TypertRemoteFailure, "code" | "message">>;

export function failureOf(result: Rejected): RemoteFailure {
  // `error` 在类型上是必选，但网关跨 realm 转发的裸 JSON 可能整位缺位——缺位时直接读
  // `.code` 会在失败路径上抛 TypeError，把原本可读的宿主拒绝换成一条与原因无关的错误。
  const raw: unknown = result.error;
  const error: FailureFields = isRecord(raw) ? raw : {};
  return {
    ok: false,
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.message === undefined ? {} : { message: error.message }),
  };
}

/** 一条停止重问的幂等身份：同一段文本重试复用 requestId，宿主据此拒绝重复入队。 */
export interface ReaskRequest {
  readonly text: string;
  readonly requestId: SessionRequestId;
  readonly abandon: () => void;
}

/** 按会话保留重问身份的有界台账。 */
export interface ReaskLedger {
  get: (sessionId: string) => ReaskRequest | undefined;
  remember: (sessionId: string, request: ReaskRequest) => void;
  delete: (sessionId: string) => void;
}

/** 默认只保最近 8 个会话的身份：只为「结果不明的失败重试」服务，不无限增长。 */
export const REASK_REQUEST_LIMIT = 8;

export function createReaskLedger(limit = REASK_REQUEST_LIMIT): ReaskLedger {
  const requests = new Map<string, ReaskRequest>();
  return {
    get: (sessionId) => requests.get(sessionId),
    delete: (sessionId) => {
      requests.delete(sessionId);
    },
    remember: (sessionId, request) => {
      requests.delete(sessionId);
      // 先淘汰再插入：limit=0 这一档让「空表」分支可达，正常档位下不产生额外分支。
      if (requests.size >= limit) {
        const oldest = requests.entries().next().value;
        if (oldest !== undefined) {
          requests.delete(oldest[0]);
          oldest[1].abandon();
        }
      }
      requests.set(sessionId, request);
    },
  };
}

/** host 侧停止重问的幂等身份：没有本地回显可退休，只保留文本与普通字符串 id。 */
export interface HostReaskRequest {
  readonly text: string;
  readonly requestId: string;
}

export interface HostReaskLedger {
  get: (sessionId: string) => HostReaskRequest | undefined;
  remember: (sessionId: string, request: HostReaskRequest) => void;
  delete: (sessionId: string) => void;
}

export function createHostReaskLedger(limit = REASK_REQUEST_LIMIT): HostReaskLedger {
  const requests = new Map<string, HostReaskRequest>();
  return {
    get: (sessionId) => requests.get(sessionId),
    delete: (sessionId) => {
      requests.delete(sessionId);
    },
    remember: (sessionId, request) => {
      requests.delete(sessionId);
      if (requests.size >= limit) {
        const oldest = requests.keys().next().value;
        if (oldest !== undefined) {
          requests.delete(oldest);
        }
      }
      requests.set(sessionId, request);
    },
  };
}

let hostReaskSeq = 0;

/** 客户端只负责给宿主一个稳定身份；服务端按它去重，不要求品牌类型。 */
export function nextHostReaskRequestId(): string {
  hostReaskSeq += 1;
  return `${Date.now()}-${hostReaskSeq}`;
}

export interface HostReaskOptions {
  readonly ledger: HostReaskLedger;
  readonly queuedCancelFailed: string;
}

/** 宿主侧已实现 prepend + wake（见 host Remote 的 reask）；失败重试复用同一 requestId。 */
export async function reaskViaHost(
  call: (sessionId: string, text: string, requestId: string) => Promise<unknown>,
  sessionId: string,
  text: string,
  options: HostReaskOptions,
): Promise<RemoteFailure | { ok: true; warning?: string }> {
  const { ledger } = options;
  let request = ledger.get(sessionId);
  if (request === undefined || request.text !== text) {
    request = { text, requestId: nextHostReaskRequestId() };
    ledger.remember(sessionId, request);
  }
  const raw = await call(sessionId, text, request.requestId);
  const record = isRecord(raw) ? raw : {};
  if (record["ok"] !== true) {
    ledger.delete(sessionId);
    return {
      ok: false,
      ...(typeof record["code"] === "string" ? { code: record["code"] } : {}),
      ...(typeof record["message"] === "string" ? { message: record["message"] } : {}),
    };
  }
  ledger.delete(sessionId);
  if (record["warning"] !== "cancel-failed") {
    return { ok: true };
  }
  return { ok: true, warning: options.queuedCancelFailed };
}

/** 收敛等待只读这两位：官方 `SessionFace` 是 `ObservableSnapshot<SessionSnapshot>` 的加宽。 */
export interface SessionIdleSource {
  getSnapshot: () => { readonly running: boolean };
  subscribe: (fn: () => void) => () => void;
}

/** setTimeout 的占位退订：subscribe 同步回放时，finish 先于真实退订函数赋值。 */
const NOOP = (): void => undefined;

/** 纯文本块：官方 `prompt` 的 text 支收 `TextBlock`。 */
function textBlock(text: string): TextBlock {
  return { type: "text", text };
}

/**
 * cancel 只保证「取消已登记」，不保证宿主已把当前活动收敛成 idle。等到快照
 * running=false 再发重问，发送路径就不依赖宿主在 RPC 内同步 abort；超时（宿主停不
 * 下来、事件没到）返回 false，调用方回退 queue。返回值只表示「是否确认 idle」。
 */
export async function awaitSessionIdle(
  session: SessionIdleSource,
  timeoutMs: number,
): Promise<boolean> {
  if (!session.getSnapshot().running) {
    return true;
  }
  const settled = Promise.withResolvers<boolean>();
  // 对象包一层：done 在 finish 闭包里改写，TS 对裸 let 的控制流分析会把它判成恒 false；
  // timer 同理走对象属性，避免「声明在 finish 之后」与 prefer-const 两条规则互相打架。
  const state: { done: boolean; timer?: ReturnType<typeof setTimeout> } = { done: false };
  let unsubscribe: () => void = NOOP;
  const finish = (idle: boolean): void => {
    if (state.done) {
      return;
    }
    state.done = true;
    clearTimeout(state.timer);
    unsubscribe();
    settled.resolve(idle);
  };
  state.timer = setTimeout(finish, timeoutMs, false);
  unsubscribe = session.subscribe(() => {
    if (!session.getSnapshot().running) {
      finish(true);
    }
  });
  // 订阅前到订阅后之间可能已经翻假（ObservableSnapshot 不承诺订阅即回放）：
  // 再读一次，避免白等到超时。
  if (!session.getSnapshot().running) {
    finish(true);
  }
  if (state.done) {
    unsubscribe();
  }
  return settled.promise;
}

/** `stopAndReaskSession` 的入参：台账、收敛上限与本地化文案由调用方注入。 */
export interface StopReaskOptions {
  readonly ledger: ReaskLedger;
  readonly queuedCancelFailed: string;
  readonly cancelSettleTimeoutMs?: number;
}

const DEFAULT_CANCEL_SETTLE_TIMEOUT_MS = 2000;

/**
 * 停止并重问的完整顺序：cancel →（成功则等收敛）→ 选 queue/steer → 幂等入队。
 *
 * 顺序不能反：宿主驱动在 abort 收敛后只重放「cancel 之后到达的唤醒」；先入队再
 * cancel 的那一条 abort 收尾后没有驱动再唤醒它，会永远停在排队区（宿主实测见
 * test/integration/abort-semantics.test.ts）。
 *
 * cancel 被拒时仍入队（当前回合还在跑，只能 queue），结果以 `warning` 半成功返回。
 * cancel 成功且确认 idle 时用 steer：next-step 在 next-turn 之前被 claim，重问因此
 * 排在已有排队回合之前（宿主没有前置插入 API，这是最接近的队首位）；超时未收敛
 * 回退 queue，由宿主的 abort 收尾唤醒它。
 */
export async function stopAndReaskSession(
  session: SessionFace,
  sessionId: string,
  text: string,
  options: StopReaskOptions,
): Promise<RemoteFailure | { ok: true; warning?: string }> {
  const { ledger, queuedCancelFailed } = options;
  const timeoutMs = options.cancelSettleTimeoutMs ?? DEFAULT_CANCEL_SETTLE_TIMEOUT_MS;
  let cancelFailure: RemoteFailure | undefined;
  try {
    const stopped = await session.cancel();
    if (!stopped.ok) {
      cancelFailure = failureOf(stopped);
    }
  } catch (error) {
    cancelFailure = {
      ok: false,
      message: String(error),
    };
  }
  if (cancelFailure === undefined) {
    await awaitSessionIdle(session, timeoutMs);
  }
  const mode: "queue" | "steer" =
    cancelFailure === undefined && !session.getSnapshot().running ? "steer" : "queue";
  let request = ledger.get(sessionId);
  if (request === undefined || request.text !== text) {
    request?.abandon();
    const handle: SubmissionHandle = session.beginSubmission({ mode, text, attachments: [] });
    request = {
      text,
      requestId: handle.requestId,
      abandon: () => {
        handle.abandon();
      },
    };
    ledger.remember(sessionId, request);
  }
  try {
    const queued = await session.prompt([textBlock(text)], mode, undefined, request.requestId);
    if (!queued.ok) {
      ledger.delete(sessionId);
      return failureOf(queued);
    }
    ledger.delete(sessionId);
    if (cancelFailure === undefined) {
      return { ok: true };
    }
    return {
      ok: true,
      warning:
        cancelFailure.message === undefined
          ? queuedCancelFailed
          : `${queuedCancelFailed}（${cancelFailure.message}）`,
    };
  } catch (error) {
    // 结果不明（传输层中断）：本地回显先退休，requestId 留在台账里供用户重试；
    // 宿主按 requestId 去重，重试不会发成两条。
    request.abandon();
    throw error;
  }
}
