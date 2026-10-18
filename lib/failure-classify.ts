/**
 * 失败分类：瞬时（可自动续跑）vs 永久（绝不续跑）。
 * 原则：先按 code 路由（官方约定），文本模式仅作已知误分类的兜底
 * （百度 token plan 429 被 pi-ai 归为 QUOTA）；未知 = 永久（保守）。
 */

import type { LlmFailure } from "@deepseek-ai/dsh-llm";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

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

/** 配额窗口措辞（分钟/吞吐型额度的说法）。只在**请求级**判据里用：那里问的是
 *  「等一会儿再发同一个请求会不会更好」，配额窗口措辞答「会」；
 *  回合级 `classifyFailure` 不认这一条——那里问的是「值不值得重开一个回合」，
 *  只有 `quota exceeded for month` 这类没有其它证据时按保守判永久（有用例钉着）。
 *  两处判据问题不同，所以正向下这一条只归请求级；负向知识（永久码、余额耗尽、
 *  认证类状态）两边共用。 */
const QUOTA_WINDOW_TEXT =
  /\bquota[\s_-]*(?:exceeded|exhausted|reached|limit)\b|\busage[\s_-]+limit\b/iu;

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
  /** 官方 `LlmFailure.providerRetryAfterMs`：provider **自己说了什么时候再来**
   *  （适配器读 `retry-after` 与 code 无关，llm-deepseek/src/transport.ts:38-42）。 */
  retryAfterMs: number | undefined;
}

/** QUOTA 码单独成判，且必须**先于**裸 HTTP 状态判定：真宿主把「额度到了」也交回 429
 *  （集成用例实测 `{ code:"QUOTA", status:429, message:"…insufficient quota" }`；
 *  出处 llm-deepseek/src/transport.ts:30 的 `isQuotaExceededError(detail) || status === 402`）。
 *  让 `status===429` 那条捷径先命中，等于给一个重试绝不可能变好的失败反复补发回合，
 *  还会往 lesson-loop 沉淀一条「退避重试」的错误教训。
 *
 *  但 QUOTA@429 **不是一种失败，是两种**，只能按证据分：
 *    - 窗口型限流：百度 token plan 那句 `Allocated quota exceeded, please increase your
 *      quota limit.`——分钟额度，冷却后有配额回来，重发是对的（host-contract 一直钉着）；
 *    - 余额型耗尽：`insufficient quota` / `insufficient balance` / `out of credits`——
 *      重试永远不会变好。
 *  所以次序是：限速字样 → 瞬时；provider 给了再来时刻 → 瞬时（信任它的显式表态，
 *  适配器读 `retry-after` 与 code 无关，见 transport.ts:38-42）；余额耗尽字样 → 永久；
 *  剩下带 429 的（只有 quota 字样、没有余额措辞）→ 按窗口型瞬时；无状态码的 → 永久。 */
function quotaVerdict(text: string, retryAfterMs: number | undefined, status: number): Verdict {
  if (RATE_LIMIT_TEXT.test(text)) {
    return { transient: true, reason: "QUOTA with rate-limit evidence" };
  }
  if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return { transient: true, reason: "QUOTA with provider Retry-After" };
  }
  if (isBalanceExhausted(text)) {
    return { transient: false, reason: "QUOTA with balance-exhausted evidence" };
  }
  if (status === 429) {
    return { transient: true, reason: "QUOTA at 429 without balance-exhaustion evidence" };
  }
  return { transient: false, reason: "QUOTA without rate-limit evidence" };
}

/** 少数 code 路由（RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT/EMPTY_RESPONSE → 瞬时；
 *  QUOTA 已由 quotaVerdict 先判，其余交回后续模式判断）。 */
function specialCodeVerdict(code: string): Verdict | null {
  if (
    code === "RATE_LIMIT" ||
    code === "SERVER" ||
    code === "TIMEOUT" ||
    code === "TRANSPORT" ||
    code === "EMPTY_RESPONSE"
  ) {
    return { transient: true, reason: `code ${code}` };
  }
  return null;
}

/** code/status/文本证据三层判定（QUOTA 按码先判；其余 HTTP 429 = 限速定义）。 */
function verdictOf(info: FailureInfo): Verdict {
  const { code, message, status, text, retryAfterMs } = info;
  if (PERMANENT_CODES.has(code)) {
    return { transient: false, reason: `permanent code: ${code}` };
  }
  if (code === "QUOTA") {
    return quotaVerdict(text, retryAfterMs, status);
  }
  if (status === 401 || status === 403) {
    return { transient: false, reason: `auth status ${status}` };
  }
  // 显式瞬时码先于文本兜底：文件头的第一原则是「先按 code 路由，文本模式仅作已知误分类
  // 的兜底」，而 provider 直接说「这是限速/服务端/超时」时，随附的账单措辞就不再是证据
  // ——把它放在这一路之前，等于 `{code:"RATE_LIMIT", message:"Insufficient quota"}`
  // 这一形永久不续跑（属性层给的反例）。QUOTA 例外仍走 quotaVerdict：那个码本身就是
  // 「额度到了」与「分钟限速」共用的一件外衣，只能按证据分。
  const special = specialCodeVerdict(code);
  if (special !== null) {
    return special;
  }
  if (status === 429) {
    return { transient: true, reason: "status 429" };
  }
  if (isBalanceExhausted(text)) {
    return { transient: false, reason: "balance exhausted" };
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

/** 这一次失败值不值得**请求级**原地重发（`agent/request-error` 返回 {kind:'retry'}）。
 *  与 {@link classifyFailure} 同源，专为消灭「两条链路各写一套限速判据」：host 曾在
 *  `status===429 || 文本` 上另立内联判据，于是 QUOTA@429 在**没有重试策略的 provider**
 *  上仍被当限速连发，最多 requestRetryMax 次——回合级判序修好了，请求级还坏着。
 *  范围收在限速族：5xx / TIMEOUT / TRANSPORT 这些「瞬时但不是限速」的形状仍交回官方
 *  llm-retry 的策略面，本包的固定阶梯不越界去接。 */
export function isRequestRetryWorthy(failure: FailureLike): boolean {
  if (!isRecord(failure)) {
    return false;
  }
  const code = typeof failure.code === "string" ? failure.code : "";
  const message = typeof failure.message === "string" ? failure.message : "";
  const status = typeof failure.status === "number" ? failure.status : 0;
  const text = `${code} ${message}`;
  const retryAfterMs = failure.providerRetryAfterMs;
  // 「绝不重发」这一侧与 classifyFailure 同知识：永久码、认证类状态、以及 QUOTA 的
  // 余额型耗尽——等再久也不会变好。其余按限速/配额证据判。
  if (PERMANENT_CODES.has(code) || status === 401 || status === 403) {
    return false;
  }
  if (code === "QUOTA" && isBalanceExhausted(text)) {
    return false;
  }
  if (code === "RATE_LIMIT") {
    return true;
  }
  if (status === 429) {
    return true;
  }
  // 无状态码的形（官方 pi-ai 适配器实测会**丢掉 status**，见 host.test.ts 那条钉法）
  // 只能靠措辞：限速措辞或配额窗口措辞都值得等一等。
  // 5xx / TIMEOUT / TRANSPORT 这些「瞬时但不是限速」的形状仍交回官方 llm-retry 的
  // 策略面，本包的固定阶梯不越界去接。
  return (
    RATE_LIMIT_TEXT.test(text) ||
    QUOTA_WINDOW_TEXT.test(text) ||
    (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0)
  );
}

export function classifyFailure(failure: FailureLike): Verdict {
  if (!isRecord(failure)) {
    return { transient: false, reason: "not-a-failure" };
  }
  const code = typeof failure.code === "string" ? failure.code : "";
  const message = typeof failure.message === "string" ? failure.message : "";
  const status = typeof failure.status === "number" ? failure.status : 0;
  const rawRetryAfter = failure.providerRetryAfterMs;
  const text = `${code} ${message}`;
  return verdictOf({
    code,
    message,
    status,
    text,
    retryAfterMs: typeof rawRetryAfter === "number" ? rawRetryAfter : undefined,
  });
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
