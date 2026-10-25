import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { classifyFailure, looksRateLimitish } from "../lib/failure-classify.ts";
import type { FailureLike } from "../lib/failure-classify.ts";

/** 宿主事件载荷在类型面上是 `unknown`（`agent/error` 的 `error.failure`）：真实
 *  载荷可以带本插件契约之外的字段（pi-ai 的原始错误就带 OpenAI 式 `type`），也
 *  可以根本不是对象（普通 Error 无 `.failure`）。测试经这道窄门把这类形状交给
 *  守卫，而不是把 `FailureLike` 契约放宽回 `unknown`（那会重新逼出生产代码里
 *  一堆断言）。 */
function payloadLike(raw: unknown): FailureLike {
  return raw as FailureLike;
}

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

  it("瞬时：百度 token plan 429（code QUOTA + 限流文本证据）", () => {
    const verdict = classifyFailure({
      code: "QUOTA",
      message: "HTTP 429: type quota_exceeded, rate limit",
    });
    assert.equal(verdict.transient, true);
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
