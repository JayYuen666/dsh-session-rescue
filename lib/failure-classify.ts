/**
 * 失败分类：瞬时（可自动续跑）vs 永久（绝不续跑）。
 * 原则：先按 code 路由（官方约定），文本模式仅作已知误分类的兜底
 * （百度 token plan 429 被 pi-ai 归为 QUOTA）；未知 = 永久（保守）。
 */

import type { LlmFailure } from "@deepseek-ai/dsh-llm";
import { isRecord } from "@jayyuen666/dsh-plugin-shared/lib/record";

/** harness `LlmFailure` 的本插件读面子集：字段名与类型逐位取自官方声明
 *  （`message`/`code`/`status`/`providerRetryAfterMs`/`requestId`/`offloadImages`），
 *  官方改名即在此编译失败，不再靠注释手抄源码行号。
 *  按 `Partial` 取「逐位可缺」是有意为之：宿主侧任何缺字段形状都必须能进来并被
 *  降级（事件载荷来自宿主，运行时仍走守卫读取，类型只是文档）；原声明
 *  `FailureLike = unknown` 逼出调用方一堆 `as { message?: unknown }` 断言。 */
export type LlmFailureLike = Partial<LlmFailure>;

/** 一个待分类的失败对象（`agent/error` 的 `error.failure` /
 *  `agent/request-error` 的 `failure`；null/undefined = 载荷缺失，例如
 *  `agent/error` 的 error 是普通 Error（非 LlmError）时根本没有 `.failure`。
 *  非对象输入由 classifyFailure 的守卫拒绝）。 */
export type FailureLike = LlmFailureLike | null | undefined;

/** 分类结论。 */
export interface Verdict {
  transient: boolean;
  reason: string;
}

/** compaction 负责的永久失败码：续跑只会同样失败。 */
const PERMANENT_CODES = new Set([
  "CONTEXT_WINDOW_EXCEEDED",
  "AUTH",
  "INVALID_CREDENTIAL",
  "MISSING_CREDENTIAL",
  "INVALID_REQUEST",
  "INVALID_ARGS",
  "NO_ADAPTER",
  "INVALID_MODEL_CONTEXT",
  "INVALID_PREPARED_CALL",
]);

const RATE_LIMIT_TEXT = /\b429\b|rate[\s_.-]*limit|throttl|too many (?:request|busy)/iu;

/**
 * pi-ai 适配器的兜底失败码 PI_AI_ERROR + 「不认识的 finish_reason」。
 * 典型 message：`Provider finish_reason: other` —— 上游返回了适配器无法归类的
 * 结束理由，属服务端异常而非请求错误，重试通常即成功。此前落入 unclassified
 * 被当永久失败，导致该失败永不自动续跑（审查中曾在真实会话里发现两例）。
 * 严格限定 finish_reason 形态：PI_AI_ERROR 还兜底其它 adapter 异常，那些保守不猜。
 */
const UNRECOGNIZED_FINISH_REASON = /finish[\s_-]*reason/iu;

/**
 * 网关把「上游什么也没返回」作为 error stopReason 的原文送回来，典型 message：
 * `Provider returned an empty response`（OpenRouter）。pi-ai 的 classifyPiAiError
 * 在这句话里认不出任何已知措辞（无 429/5xx/timeout/stream ended/network 字样），
 * 兜底成 PI_AI_ERROR；而适配器只在 `stopReason:"stop"` 且零内容块时才给
 * EMPTY_RESPONSE，所以这条瞬时形状到不了官方码表，此前落 unclassified 被当永久
 * 失败、永不自动续跑（真实会话里同一形状连失 5 个回合）。
 * 只匹配 `empty…respons*`，不给 PI_AI_ERROR 整码放行：它同时兜底一堆真正的
 * adapter 编程错误，那些保守不猜。
 */
const EMPTY_RESPONSE_TEXT = /empty[\s_.-]*respons/iu;

/** 余额真耗尽（不可恢复）——与百度 429 的限流型 quota 区分。 */
function isBalanceExhausted(text: string): boolean {
  return (
    /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/iu.test(text) ||
    /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/iu.test(text) ||
    /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/iu.test(text)
  );
}

interface FailureInfo {
  code: string;
  message: string;
  status: number;
  text: string;
}

/** 少数 code 路由（RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT/EMPTY_RESPONSE → 瞬时；
 *  QUOTA 按文本证据二次判定；否则 null 交给后续模式判断）。 */
function specialCodeVerdict(code: string, text: string): Verdict | null {
  if (
    code === "RATE_LIMIT" ||
    code === "SERVER" ||
    code === "TIMEOUT" ||
    code === "TRANSPORT" ||
    code === "EMPTY_RESPONSE"
  ) {
    return { transient: true, reason: `code ${code}` };
  }
  if (code === "QUOTA") {
    if (RATE_LIMIT_TEXT.test(text)) {
      return { transient: true, reason: "QUOTA with rate-limit evidence" };
    }
    return { transient: false, reason: "QUOTA without rate-limit evidence" };
  }
  return null;
}

/** code/status/文本证据三层判定（HTTP 429 = 限速定义；先于文本型余额判断）。 */
function verdictOf(info: FailureInfo): Verdict {
  const { code, message, status, text } = info;
  if (PERMANENT_CODES.has(code)) {
    return { transient: false, reason: `permanent code: ${code}` };
  }
  if (status === 401 || status === 403) {
    return { transient: false, reason: `auth status ${status}` };
  }
  if (status === 429) {
    return { transient: true, reason: "status 429" };
  }
  if (isBalanceExhausted(text)) {
    return { transient: false, reason: "balance exhausted" };
  }
  const special = specialCodeVerdict(code, text);
  if (special !== null) {
    return special;
  }
  if (RATE_LIMIT_TEXT.test(text)) {
    return { transient: true, reason: "rate-limit text pattern" };
  }
  if (status >= 500 && status <= 599) {
    return { transient: true, reason: "status 5xx" };
  }
  if (code === "PI_AI_ERROR") {
    if (UNRECOGNIZED_FINISH_REASON.test(message)) {
      return { transient: true, reason: "unrecognized provider finish_reason" };
    }
    if (EMPTY_RESPONSE_TEXT.test(message)) {
      return { transient: true, reason: "provider returned an empty response" };
    }
  }
  const fallback = code || message.slice(0, 80);
  return { transient: false, reason: `unclassified: ${fallback || "empty"}` };
}

export function classifyFailure(failure: FailureLike): Verdict {
  if (!isRecord(failure)) {
    return { transient: false, reason: "not-a-failure" };
  }
  const code = typeof failure.code === "string" ? failure.code : "";
  const message = typeof failure.message === "string" ? failure.message : "";
  const status = typeof failure.status === "number" ? failure.status : 0;
  const text = `${code} ${message}`;
  return verdictOf({ code, message, status, text });
}

/** 观察性：疑似限流但被分类为永久 → 调用方打日志以便扩展匹配器。
 *  注意 throttl 后不能加 \b：throttling/throttled 的 t→i 是字母到字母、
 *  无词边界，加了会永远匹配不上（与 RATE_LIMIT_TEXT 的写法对齐）。 */
export function looksRateLimitish(failure: FailureLike): boolean {
  if (!isRecord(failure)) {
    return false;
  }
  const code = typeof failure.code === "string" ? failure.code : "";
  const message = typeof failure.message === "string" ? failure.message : "";
  const text = `${code} ${message}`.toLowerCase();
  return /\b(?:429|quota|rate|limit|busy)\b|\bthrottl|\btoo many\b/u.test(text);
}
