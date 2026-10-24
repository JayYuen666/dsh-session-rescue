import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  classifyFailure,
  isRequestRetryWorthy,
  looksRateLimitish,
} from "../lib/failure-classify.ts";
import type { FailureLike } from "../lib/failure-classify.ts";

/** 宿主事件载荷在类型面上是 `unknown`（`agent/error` 的 `error.failure`）：真实
 *  载荷可以带本插件契约之外的字段（pi-ai 的原始错误就带 OpenAI 式 `type`），也
 *  可以根本不是对象（普通 Error 无 `.failure`）。测试经这道窄门把这类形状交给
 *  守卫，而不是把 `FailureLike` 契约放宽回 `unknown`（那会重新逼出生产代码里
 *  一堆断言）。 */
function payloadLike(raw: unknown): FailureLike {
  return raw as FailureLike;
}

/** 余额耗尽的原始措辞（provider 回执里的原话）：三处用例都拿它当「不可恢复」的证据。 */
const BALANCE_TEXT = "Insufficient quota, please top up";

describe("classifyFailure（失败分类：瞬时/永久）", () => {
  it("瞬时：标准码 RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT/EMPTY_RESPONSE", () => {
    for (const code of ["RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT", "EMPTY_RESPONSE"]) {
      const verdict = classifyFailure({ code, message: "x" });
      assert.equal(verdict.transient, true, code);
    }
  });

  it("瞬时：status 429（deepseek 官方适配器形态）", () => {
    assert.equal(classifyFailure({ code: "ANY", message: "", status: 429 }).transient, true);
  });

  it("瞬时：status 5xx", () => {
    assert.equal(
      classifyFailure({ code: "", message: "bad gateway", status: 502 }).transient,
      true,
    );
  });

  it("瞬时：408 / 425 与 429 同一档（请求内容无关，等一会儿重发）", () => {
    for (const status of [408, 425]) {
      const verdict = classifyFailure({ code: "", message: "", status });
      assert.equal(verdict.transient, true, `status ${status} 是瞬时`);
      assert.match(verdict.reason, new RegExp(`status ${String(status)}`, "u"));
      assert.equal(
        isRequestRetryWorthy({ code: "", message: "", status }),
        true,
        `status ${status} 请求级也值得原地重发`,
      );
    }
  });

  it("402 按 QUOTA 同一支判：无证据永久，随信限速措辞可翻成瞬时", () => {
    // 裸 402：账单侧「先付钱」，没有随信证据就是永久。
    const bare = classifyFailure({ code: "", message: "", status: 402 });
    assert.equal(bare.transient, false);
    assert.match(bare.reason, /billing status 402/u);
    assert.equal(isRequestRetryWorthy({ code: "", message: "", status: 402 }), false);
    // 正文明确写了限速措辞：那是「伪装成账单的限流」，与 QUOTA 码第一支同解
    // （适配器把 402 归进 QUOTA 码，见 isQuotaExceededError(detail) || status === 402）。
    const rateWording = classifyFailure({
      code: "",
      message: "429 too many requests",
      status: 402,
    });
    assert.equal(rateWording.transient, true);
    assert.match(rateWording.reason, /rate-limit text pattern/u);
  });

  it("瞬时：百度 token plan 429（code QUOTA + 限流文本证据）", () => {
    const verdict = classifyFailure({
      code: "QUOTA",
      message: "HTTP 429: type quota_exceeded, rate limit",
    });
    assert.equal(verdict.transient, true);
  });

  it("裸数字 429 只在 HTTP 语境里算限速证据", () => {
    // 正文里任意一个 429 数字都当限速，等于给「重开一个回合」开了一道误判口子：
    // 请求 id、trace 号、端口、计数都可能撞上这个数，而误判的代价是一次无意义续跑。
    for (const message of ["request req-429 failed", "trace 429 recorded", "processed 429 items"]) {
      assert.equal(
        classifyFailure({ code: "ANY", message }).transient,
        false,
        `不该被当限速：${message}`,
      );
    }
    // 真限速的几个写法仍要认得（`429` 裸串是宿主实测交回的形态）。
    for (const message of ["HTTP 429: rate limit", "429 too many requests", "status 429"]) {
      assert.equal(
        classifyFailure({ code: "ANY", message }).transient,
        true,
        `该判限速：${message}`,
      );
    }
    // 整个正文就是一个 429（清空了 code）：这是宿主交回的裸形态，仍要判限速。
    assert.equal(classifyFailure({ code: "", message: "429" }).transient, true);
  });

  it("瞬时：仅文本模式命中（429/rate limit/throttle/too many）", () => {
    assert.equal(
      classifyFailure({ message: "Request throttled, too many requests" }).transient,
      true,
    );
  });

  it("永久：上下文超长（compaction 负责）", () => {
    assert.equal(
      classifyFailure({ code: "CONTEXT_WINDOW_EXCEEDED", message: "context window exceeded" })
        .transient,
      false,
    );
  });

  it("永久：认证/凭据/非法请求/无适配器", () => {
    for (const code of [
      "AUTH",
      "INVALID_CREDENTIAL",
      "MISSING_CREDENTIAL",
      "INVALID_REQUEST",
      "INVALID_ARGS",
      "NO_ADAPTER",
    ]) {
      assert.equal(classifyFailure({ code, message: "x" }).transient, false, code);
    }
  });

  it("永久：status 401/403", () => {
    assert.equal(classifyFailure({ message: "unauthorized", status: 401 }).transient, false);
    assert.equal(classifyFailure({ message: "forbidden", status: 403 }).transient, false);
  });

  it("永久：余额真耗尽（insufficient quota / out of credits）", () => {
    assert.equal(
      classifyFailure({ code: "QUOTA", message: "Insufficient quota" }).transient,
      false,
    );
    assert.equal(classifyFailure({ message: "You are out of credits" }).transient, false);
    assert.equal(classifyFailure({ message: "balance exhausted" }).transient, false);
  });

  it("显式瞬时码先于账单措辞：provider 说是限速，随附文案提余额也不得判永久", () => {
    // 文件头的第一原则是「先按 code 路由，文本模式仅作已知误分类的兜底」。
    // 反例由属性层给出（test/property/failure-classify.property.test.ts）：文本兜底一旦排在
    // code 路由之前，`{code:"RATE_LIMIT", message:"Insufficient quota…"}` 就永久不续跑——
    // 一个明确自称限速的失败被一句账单文案钉死，正是本包最不该漏的那一形。
    for (const code of ["RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT", "EMPTY_RESPONSE"]) {
      const verdict = classifyFailure({ code, message: BALANCE_TEXT });
      assert.equal(verdict.transient, true, `${code} 应按 code 路由判瞬时：${verdict.reason}`);
      assert.match(verdict.reason, /code /u);
    }
    // 与之对照：没有码可路由时，账单措辞仍然是永久证据（上一条用例的判据不被这次调序抹掉）。
    assert.equal(
      classifyFailure({ message: BALANCE_TEXT }).transient,
      false,
      "无 code 可路由 ⇒ 文本兜底仍判永久",
    );
  });

  it("永久：QUOTA 码抢在 status 429 之前判（真宿主就这么交回）", () => {
    // 形状出处：test/integration/agent-loop.test.ts 里官方 deepseek 适配器对
    // mock server `quota_exceeded` 行为交回的 agent/error.failure
    // ——`{ code:"QUOTA", status:429 }`。让 429 那条捷径先命中，等于给
    // 「额度到了、重试不会变好」的失败反复补发回合。
    const verdict = classifyFailure({
      code: "QUOTA",
      message: "mock insufficient quota",
      status: 429,
    });
    assert.equal(verdict.transient, false);
    // 余额型耗尽的证据在 reason 里可见（不是靠 status 抢判）
    assert.match(verdict.reason, /QUOTA with balance-exhausted evidence/u);
  });

  it("瞬时：QUOTA 带 provider Retry-After 即按 provider 的话再来一次", () => {
    const verdict = classifyFailure({
      code: "QUOTA",
      message: "quota reached",
      status: 429,
      providerRetryAfterMs: 15_000,
    });
    assert.equal(verdict.transient, true);
    assert.match(verdict.reason, /QUOTA with provider Retry-After/u);
  });

  it("瞬时：status 429 + insufficient_quota 必须重试（HTTP 429 定义即限速；百度 token plan 限流型配额拒绝，冷却后有配额回来）", () => {
    const verdict = classifyFailure(
      payloadLike({
        code: "insufficient_quota",
        message: "Allocated quota exceeded, please increase your quota limit.",
        status: 429,
        type: "invalid_request_error",
      }),
    );
    assert.equal(verdict.transient, true, "429 状态码优先：余额文本不得抢在限速信号之前判永久");
  });

  it("永久：QUOTA 无限流证据（保守）", () => {
    assert.equal(
      classifyFailure({ code: "QUOTA", message: "quota exceeded for month" }).transient,
      false,
    );
  });

  it("永久：未知失败保守不放行", () => {
    assert.equal(classifyFailure({ code: "SOMETHING_NEW", message: "weird" }).transient, false);
  });

  it("瞬时：PI_AI_ERROR + finish_reason 异常（上游吐不认识的理由；2026-09 真实漏跑案例）", () => {
    assert.equal(
      classifyFailure({ code: "PI_AI_ERROR", message: "Provider finish_reason: other" }).transient,
      true,
    );
    assert.equal(
      classifyFailure({ code: "PI_AI_ERROR", message: "Provider finish_reason: unknown" })
        .transient,
      true,
    );
    // 反例：已知的确定性结束理由出现在 error 里，不该被当成「上游异常、重试即成功」。
    // 把它们洗成可重试，会让同一份坏请求被反复重发。
    for (const known of ["end_turn", "stop", "tool_use", "max_tokens", "content_filter"]) {
      assert.equal(
        classifyFailure({ code: "PI_AI_ERROR", message: `Provider finish_reason: ${known}` })
          .transient,
        false,
        `${known} 是确定性结束理由，不该判瞬时`,
      );
    }
  });

  it("瞬时：PI_AI_ERROR + 上游空响应原文（网关措辞；2026-09 真实漏跑案例）", () => {
    assert.equal(
      classifyFailure({ code: "PI_AI_ERROR", message: "Provider returned an empty response" })
        .transient,
      true,
    );
    assert.equal(
      classifyFailure({ code: "PI_AI_ERROR", message: "Empty response from upstream" }).transient,
      true,
    );
    assert.equal(
      classifyFailure({
        code: "PI_AI_ERROR",
        message: "Provider returned an empty response",
      }).reason,
      "provider returned an empty response",
    );
  });

  it("永久：PI_AI_ERROR 其它 adapter 异常（含 empty 但非空响应措辞）", () => {
    assert.equal(
      classifyFailure({ code: "PI_AI_ERROR", message: "parse failed" }).transient,
      false,
    );
    assert.equal(
      classifyFailure({ code: "PI_AI_ERROR", message: "empty tool arguments rejected" }).transient,
      false,
    );
  });

  it("非对象输入", () => {
    assert.equal(classifyFailure(null).transient, false);
    assert.equal(classifyFailure(payloadLike("str")).transient, false);
  });
});

describe("请求级判据 isRequestRetryWorthy（与回合级同源）", () => {
  it("余额耗尽的措辞对任何状态码都成立：5xx 也不能放成「值得再发」", () => {
    // 判序在 isRequestRetryWorthy 里与回合级同源：余额耗尽排在瞬时状态码之前。
    // 少了这一条，`{status:500, message:"Insufficient quota"}` 会被当成普通服务端错误重发，
    // 而重发对余额耗尽没有任何意义，只会多烧几轮。
    assert.equal(isRequestRetryWorthy({ code: "", message: BALANCE_TEXT, status: 500 }), false);
    assert.equal(isRequestRetryWorthy({ code: "", message: "out of credits", status: 503 }), false);
  });

  it("QUOTA + 429 无限流证据 ⇒ 不重发（真宿主对余额/配额到期的交回形）", () => {
    // 这条即 test/integration/agent-loop.test.ts 抓到的原始载荷。host 的内联判据
    // 曾用 `status===429 ||` 直接放行，于是无策略 provider 上最多连发 requestRetryMax 次。
    assert.equal(
      isRequestRetryWorthy({ code: "QUOTA", message: "mock insufficient quota", status: 429 }),
      false,
    );
  });

  it("QUOTA + 限流措辞或 Retry-After ⇒ 值得再发一次", () => {
    assert.equal(
      isRequestRetryWorthy({ code: "QUOTA", message: "HTTP 429: rate limit", status: 429 }),
      true,
    );
    assert.equal(
      isRequestRetryWorthy({
        code: "QUOTA",
        message: "quota reached",
        status: 429,
        providerRetryAfterMs: 15_000,
      }),
      true,
    );
  });

  it("限速族之外的一律交回：5xx/超时不是限速，余额耗尽也不是", () => {
    assert.equal(
      isRequestRetryWorthy({ code: "SERVER", message: "bad gateway", status: 502 }),
      false,
    );
    assert.equal(isRequestRetryWorthy({ code: "TIMEOUT", message: "timed out" }), false);
    // 非 QUOTA 码 + 429：沿用本包既有立场「429 状态码优先，余额文本不得抢判永久」
    // （classifyFailure 那条同名用例钉着），请求级与它保持同向。
    // 余额耗尽要拒重发的那一支是 code===QUOTA，由上面一条用例钉。
    assert.equal(
      isRequestRetryWorthy({ code: "ANY", message: "insufficient balance", status: 429 }),
      true,
    );
    assert.equal(
      isRequestRetryWorthy({ code: "AUTH", message: "429 rate limit" }),
      false,
      "永久码优先，文本证据不得翻案",
    );
    assert.equal(isRequestRetryWorthy({ code: "RATE_LIMIT", message: "" }), true);
    assert.equal(isRequestRetryWorthy(null), false);
    assert.equal(isRequestRetryWorthy(payloadLike("not a record")), false);
  });
});

describe("QUOTA@429 的两种形（回合级也必须分得开）", () => {
  it("窗口型配额（无余额措辞的 429）⇒ 瞬时：冷却后有配额回来", () => {
    // 百度 token plan 的实测措辞。回合级与请求级在这里必须同向，
    // 否则同一枚失败会「重发请求可以、重开回合不行」，行为难以解释。
    const verdict = classifyFailure({
      code: "QUOTA",
      message: "Allocated quota exceeded, please increase your quota limit.",
      status: 429,
    });
    assert.equal(verdict.transient, true);
    assert.match(verdict.reason, /QUOTA at 429 without balance-exhaustion evidence/u);
  });

  it("字段类型不符时按缺失降级，不抛", () => {
    assert.equal(
      classifyFailure(payloadLike({ code: 429, message: null, status: "429" })).transient,
      false,
    );
    // 请求级：code/message 不是串、status 不是数时，只剩 Retry-After 这一条证据可用。
    assert.equal(isRequestRetryWorthy(payloadLike({ code: 429, message: null })), false);
    assert.equal(
      isRequestRetryWorthy(payloadLike({ code: 429, providerRetryAfterMs: 30_000 })),
      true,
      "provider 明确给了再来时刻 ⇒ 值得等",
    );
  });
});

describe("looksRateLimitish（观察性日志用）", () => {
  it("疑似限流措辞命中", () => {
    assert.equal(looksRateLimitish({ code: "QUOTA", message: "quota_exceeded" }), true);
    assert.equal(looksRateLimitish({ message: "all fine" }), false);
  });

  it("非对象输入一律不算疑似限流（不误报）", () => {
    assert.equal(looksRateLimitish(null), false);
    assert.equal(looksRateLimitish(undefined), false);
    assert.equal(looksRateLimitish(payloadLike("rate limit")), false);
    assert.equal(looksRateLimitish(payloadLike(429)), false);
  });

  it("throttl 词根无词边界也命中（throttling/throttled）", () => {
    assert.equal(looksRateLimitish({ message: "request throttling" }), true);
    assert.equal(looksRateLimitish({ message: "too many busy requests" }), true);
  });
});

describe("降级细节（fallback 组装与坏字段形状）", () => {
  it("无 code 的未知失败：reason 取 message 前 80 字", () => {
    const verdict = classifyFailure({ message: "mystery ".repeat(20) });
    assert.equal(verdict.transient, false);
    assert.equal(verdict.reason, `unclassified: ${"mystery ".repeat(20).slice(0, 80)}`);
  });

  it("完全空白的失败：reason 落到 empty 兜底", () => {
    assert.equal(classifyFailure({}).reason, "unclassified: empty");
  });

  it("message 非字符串（宿主坏形状）→ 按空串参与判定，不抛错", () => {
    assert.equal(looksRateLimitish(payloadLike({ code: "X", message: 42 })), false);
    assert.equal(
      classifyFailure(payloadLike({ code: "X", message: null })).reason,
      "unclassified: X",
    );
  });
});
