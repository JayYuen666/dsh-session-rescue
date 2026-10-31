// 失败分类的属性面：不问「这条载荷算不算瞬时」，而问**证据次序**在任意载荷上是否成立。
//
// 判据来自 lib/failure-classify.ts 文件里写明的原则，两条并存：
//   ① 先按 code 路由；未知 = 永久（保守）；
//   ② `code === "QUOTA"` 时「余额耗尽」证据必须先于裸 `status===429` 捷径——真宿主把
//      「额度到了」也交回 429；而**非 QUOTA 的 429 本身就是限速定义**，余额措辞不得抢判
//      永久（百度 token plan 的限流型配额拒绝就是这一形：冷却后有配额回来）。
//      这条立场在 test/failure-classify.test.ts 与请求级用例里各钉了一次，属性层沿用它，
//      而不是另立一条更严的规矩——把两条并存原则里较窄的那条推广到全部 code，正是本层
//      第一版犯的错，它给出的反例是判据写错，不是代码写错。
//
// oracle 是**独立重写的一份判序**（按上面两条原则写），不是把实现的分支照抄一遍——
// 照抄实现的属性测试只会永远通过。
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { classifyFailure, isRequestRetryWorthy } from "../../lib/failure-classify.ts";

/** 官方码表里「重试永远不会变好」那一族（与实现同一份清单，但这里是**判据陈述**：
 *  文档说这些码代表请求本身有问题，不是时机问题）。 */
const PERMANENT_CODES = [
  "CONTEXT_WINDOW_EXCEEDED",
  "AUTH",
  "INVALID_CREDENTIAL",
  "MISSING_CREDENTIAL",
  "INVALID_REQUEST",
  "INVALID_ARGS",
  "NO_ADAPTER",
  "INVALID_MODEL_CONTEXT",
  "INVALID_PREPARED_CALL",
];

/** 限速族 code（文档：provider 明确说了「是哪一类瞬时」）。 */
const RATE_CODES = ["RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT", "EMPTY_RESPONSE"];

/** 「余额真耗尽」的自然语言说法（只用文档承诺的那三种形态：insufficient+配额名 /
 *  余额或额度+exhausted|depleted / out of+额度或预算。造一句「credits are insufficient」
 *  然后断言它该判永久，是拿英文语感当契约——实现承诺的是那三形，兜底方向是保守永久）。 */
const BALANCE_PHRASES = [
  "Insufficient quota, please top up",
  "insufficient balance",
  "insufficient_credits after the last batch",
  "account balance exhausted",
  "credits depleted after yesterday's run",
  "out of budget for this month",
  "out of credits",
];

/** 配额**窗口**措辞（分钟/吞吐型额度的说法）：文档明写这一形只归请求级判瞬时。 */
const QUOTA_WINDOW_WORDING =
  /\bquota[\s_-]*(?:exceeded|exhausted|reached|limit)\b|\busage[\s_]+limit\b/u;

/** 「就是限速」的自然语言说法（只用文档承诺的措辞族：429 字样 / rate limit / throttl /
 *  too many requests）。自己造一句「too busy」然后断言它该瞬时，那就是拿想象当契约。 */
const RATE_PHRASES = [
  "Too Many Requests",
  "rate limit exceeded",
  "slow down, you are throttled",
  "429 too many requests",
  "Rate-Limit: retry soon",
];

/** 载荷面：code × message × status × providerRetryAfterMs 的笛卡尔抽样，
 *  外加「缺位」与「类型不对」的脏形状（宿主载荷跨进程，缺字段是真事）。 */
const failureArbitrary = fc.record(
  {
    code: fc.oneof(
      fc.constantFrom(...PERMANENT_CODES),
      fc.constantFrom(...RATE_CODES),
      fc.constantFrom("QUOTA", "PI_AI_ERROR", "UNKNOWN_CODE", ""),
      fc.string(),
    ),
    message: fc.oneof(
      fc.constantFrom(...BALANCE_PHRASES),
      fc.constantFrom(...RATE_PHRASES),
      fc.constantFrom("quota exceeded for month", "bad request", ""),
      fc.string(),
    ),
    status: fc.oneof(
      fc.constantFrom(0, 200, 400, 401, 402, 403, 408, 429, 500, 502, 503, 599, 600, 700),
      fc.integer({ min: -500, max: 1000 }),
    ),
    providerRetryAfterMs: fc.oneof(
      fc.constantFrom(undefined, 0, -1, 1, 1000, 60_000),
      fc.nat({ max: 120_000 }),
    ),
  },
  { requiredKeys: [] },
);

/** 限速措辞（文档承诺的那一族：整串裸 429、HTTP 语境里的 429、`429 too many/rate/throttl`、
 *  rate limit / throttl / too many requests|busy）。 */
function hasRateWording(lower: string): boolean {
  return (
    /^\s*429\s*$/u.test(lower) ||
    /\b(?:http|status|code|error)[\s:/]*429(?:\W|$)/u.test(lower) ||
    /\b429[\s:]+(?:too many|rate|throttl)/u.test(lower) ||
    /rate[\s_.-]*limit/u.test(lower) ||
    lower.includes("throttl") ||
    /too many (?:request|busy)/u.test(lower)
  );
}

/** 余额真耗尽的三种形态（与文档同一组形态，不是实现正则的副本）。 */
function hasBalanceEvidence(lower: string): boolean {
  return (
    /\binsufficient[\s_-]+(?:quota|balance|credits?)/u.test(lower) ||
    /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)/u.test(lower) ||
    /\bout[\s_-]+of[\s_-]+(?:credits?|budget)/u.test(lower)
  );
}

/** provider 明确说了什么时候再来（官方 `LlmFailure.providerRetryAfterMs`）。 */
function providerSaidWhen(retryAfter: number | undefined): boolean {
  return typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0;
}

/** 独立 oracle：按文档两条原则重写一遍证据优先级。
 *  交回 undefined = 这一形落在「保守永久」的兜底面，不参与同解断言。 */
function expectedTransient(info: {
  code: string;
  message: string;
  status: number;
  retryAfter: number | undefined;
}): boolean | undefined {
  const lower = `${info.code} ${info.message}`.toLowerCase();
  if (PERMANENT_CODES.includes(info.code)) {
    return false;
  }
  if (info.code === "QUOTA") {
    // QUOTA 支的判序（原则②完整生效的那一支）。
    if (hasRateWording(lower) || providerSaidWhen(info.retryAfter)) {
      return true;
    }
    if (hasBalanceEvidence(lower)) {
      return false;
    }
    return info.status === 429 ? true : undefined;
  }
  if (info.status === 401 || info.status === 403) {
    return false;
  }
  // 原则①：显式 code 先于文本兜底。
  if (RATE_CODES.includes(info.code)) {
    return true;
  }
  if (info.status === 429) {
    // 原则②的后半：非 QUOTA 的 429 就是限速定义，余额措辞不抢判。
    return true;
  }
  if (hasBalanceEvidence(lower)) {
    return false;
  }
  if (hasRateWording(lower)) {
    return true;
  }
  // 5xx 是「重开一回合」的经典瞬时证据；其余无任何证据 ⇒ oracle 弃权，调用方不据此判。
  return info.status >= 500 && info.status <= 599 ? true : undefined;
}

/** 永久码样本。 */
const permanentCodeArbitrary = fc.constantFrom(...PERMANENT_CODES);
/** 措辞证据样本：余额型与限速型都要出现在每一条「无论措辞」的断言里。 */
const evidencePhraseArbitrary = fc.oneof(
  fc.constantFrom(...BALANCE_PHRASES),
  fc.constantFrom(...RATE_PHRASES),
);
/** 给了再来时刻 / 没给。 */
const maybeRetryAfterArbitrary = fc.oneof(
  fc.constant(undefined),
  fc.integer({ min: 1, max: 60_000 }),
);
/** 非 QUOTA 的 code 样本（QUOTA 走自己那条判序，另有用例）。 */
const nonQuotaCodeArbitrary = fc.constantFrom("", "PI_AI_ERROR", "UNKNOWN_CODE");

/** 正毫秒数（「provider 确实给了再来时刻」那一支）。 */
const positiveNatArbitrary = fc.integer({ min: 1, max: 60_000 });

/** 限速措辞样本。 */
const rateMessageArbitrary = fc.constantFrom(...RATE_PHRASES);

/** 全性输入面：正常载荷 + 各种「压根不是失败面对象」的形状（宿主 `agent/error` 的
 *  `error` 位是 unknown，普通 Error / null / 数组 / 类型错位都真出现过）。 */
const oddFailureShapes = [
  null,
  undefined,
  "a string",
  7,
  [],
  { code: 7, message: null, status: "429" },
] as const;
const anyFailureArbitrary = fc.oneof(failureArbitrary, fc.constantFrom(...oddFailureShapes));

describe("失败分类的证据次序（属性）", () => {
  it("全性：任意形状的载荷都不抛，且结论总是填满两个字段", () => {
    fc.assert(
      fc.property(anyFailureArbitrary, (raw) => {
        const verdict = classifyFailure(raw as never);
        expect(verdict.transient).toBeTypeOf("boolean");
        expect(verdict.reason.length).toBeGreaterThan(0);
      }),
      { numRuns: 500 },
    );
  });

  it("QUOTA 支内部自洽：余额耗尽证据必须抢在裸 429 之前判永久", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...BALANCE_PHRASES),
        fc.constantFrom(0, 402, 429, 500, 503),
        (message, status) => {
          const verdict = classifyFailure({ code: "QUOTA", message, status });
          expect(
            verdict.transient,
            `QUOTA status=${status} message=${message} ⇒ ${verdict.reason}`,
          ).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("限速证据（措辞或 provider 给了再来时刻）能翻掉 QUOTA 的永久默认", () => {
    // 「给了再来时刻」的随机面：0（没给）或一个正毫秒数。
    const retryAfterArbitrary = fc.oneof(positiveNatArbitrary, fc.constant(0));
    fc.assert(
      fc.property(rateMessageArbitrary, retryAfterArbitrary, (message, retryAfter) => {
        const verdict = classifyFailure({
          code: "QUOTA",
          message,
          status: 429,
          providerRetryAfterMs: retryAfter,
        });
        expect(verdict.transient, `${message} ⇒ ${verdict.reason}`).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("永久码一票否决：无论带什么状态码或措辞都判永久", () => {
    fc.assert(
      fc.property(
        permanentCodeArbitrary,
        evidencePhraseArbitrary,
        fc.integer({ min: 0, max: 700 }),
        maybeRetryAfterArbitrary,
        (code, message, status, retryAfter) => {
          const verdict = classifyFailure({
            code,
            message,
            status,
            ...(retryAfter === undefined ? {} : { providerRetryAfterMs: retryAfter }),
          });
          expect(verdict.transient, `${code} 不该被当瞬时`).toBe(false);
          expect(isRequestRetryWorthy({ code, message, status })).toBe(false);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("认证类状态码（401/403）在两条链路上都判永久/不重发", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(401, 403),
        evidencePhraseArbitrary,
        nonQuotaCodeArbitrary,
        (status, message, code) => {
          expect(classifyFailure({ code, message, status }).transient).toBe(false);
          expect(isRequestRetryWorthy({ code, message, status })).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("与独立 oracle 同解：oracle 有明确态度的输入，实现必须给同一个答案", () => {
    fc.assert(
      fc.property(failureArbitrary, (raw) => {
        const info = {
          code: raw.code ?? "",
          message: raw.message ?? "",
          status: raw.status ?? 0,
          retryAfter: raw.providerRetryAfterMs,
        };
        const oracle = expectedTransient(info);
        if (oracle === undefined) {
          return;
        }
        // 喂实现的是官方字段名（`providerRetryAfterMs`），oracle 内部才用简名。
        // 早先这里把 `retryAfter` 原样递进去，等于让实现读不到那一维——反例是判据写错，
        // 不是代码写错，这类「测试自己造的错误形状」在本层要当失败对待。
        const verdict = classifyFailure({
          code: info.code,
          message: info.message,
          status: info.status,
          ...(info.retryAfter === undefined ? {} : { providerRetryAfterMs: info.retryAfter }),
        });
        expect(
          verdict.transient,
          `code=${info.code} status=${String(info.status)} retry=${String(info.retryAfter)} message=${info.message} ⇒ ${verdict.reason}`,
        ).toBe(oracle);
      }),
      { numRuns: 2000 },
    );
  });

  it("两条链路共用负向知识：回合级判永久且没有任何「等一会再来」的证据时，请求级不得原地重发", () => {
    fc.assert(
      fc.property(failureArbitrary, (raw) => {
        const failure = {
          code: raw.code ?? "",
          message: raw.message ?? "",
          status: raw.status ?? 0,
          ...(raw.providerRetryAfterMs === undefined
            ? {}
            : { providerRetryAfterMs: raw.providerRetryAfterMs }),
        };
        const lower = `${failure.code} ${failure.message}`.toLowerCase();
        // 请求级愿意原地重发的那几种证据：限速族 code、429、限速/配额窗口措辞、
        // provider 给了再来时刻。两条链路的**问题不同**（回合级问「值不值得重开一回合」，
        // 请求级问「等一会儿再发同一个请求会不会更好」），所以只在证据全无时才要求同向；
        // 配额窗口措辞那一形正是文档明写的「只归请求级」的差异面。
        const waitThenResend =
          RATE_CODES.includes(failure.code) ||
          failure.status === 429 ||
          hasRateWording(lower) ||
          QUOTA_WINDOW_WORDING.test(lower) ||
          providerSaidWhen(failure.providerRetryAfterMs);
        // 写成一次无条件断言：证据齐备时允许请求级独立表态（那条差异是文档明写的），
        // 所以「必须为 false」只在前件成立时才是判据——把它折进布尔式里，
        // 断言就与条件无关了（也满足 vitest/no-conditional-expect）。
        const turnSaysPermanent = !classifyFailure(failure).transient;
        expect(
          !turnSaysPermanent || waitThenResend || !isRequestRetryWorthy(failure as never),
          `回合级永久 + 无任何「等一会再来」证据时，请求级不得原地重发：${failure.code} / ${failure.message} / ${String(failure.status)}`,
        ).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });
});
