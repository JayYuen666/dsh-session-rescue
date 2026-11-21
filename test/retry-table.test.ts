// retry-table.ts 纯函数判据矩阵：免检/手写形状、确认门按目标档位，以及 client/host
// 码表常量的漂移钉。期望值全部独立写死（host 写盘语义见 host.ts RETRY_PRESETS 的
// 注释与条目），不从被测实现推导；host 或 client 任一侧的码表常量漂移都在这里红。
import assert from "node:assert/strict";
import { describe, it } from "vitest";
// host 常量只在单测里读取（client 产物不引用 host.ts）。
import { OFFICIAL_DEFAULT_RETRY_POLICY } from "../host.ts";
import { isPresetShape, needsOverwriteConfirm, parseProviderRow } from "../src/retry-table.ts";
import type { RetryProviderRow } from "../src/retry-table.ts";

/** 判据输入用的行构造：缺省 = 未配置 provider 的投影形状（normal/5/码表 []）。 */
function rowOf(
  patch: Partial<{
    provider: string;
    mode: string;
    maxRetries: number;
    hasQuota: boolean;
    retryableCodes: string[];
  }> = {},
): RetryProviderRow {
  return parseProviderRow({
    provider: patch.provider ?? "p",
    mode: patch.mode ?? "normal",
    maxRetries: patch.maxRetries ?? 5,
    hasQuota: patch.hasQuota ?? false,
    retryableCodes: patch.retryableCodes ?? [],
  });
}

// 期望值独立写死（与 host.test.ts 对 host 侧的钉、client-ui.test.ts 对 UI 的钉同源）。
const DEFAULT_CODES = ["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"];
const ENHANCED_CODES = [...DEFAULT_CODES, "QUOTA"];

describe("isPresetShape 判据矩阵（免检形状）", () => {
  it("档位可产出或未配置的行判 true", () => {
    assert.equal(isPresetShape(rowOf({})), true, "未配置行：normal/5/码表 []");
    assert.equal(
      isPresetShape(rowOf({ retryableCodes: DEFAULT_CODES })),
      true,
      "default 档产出：官方默认码表",
    );
    assert.equal(
      isPresetShape(rowOf({ maxRetries: 0, retryableCodes: ["RATE_LIMIT"] })),
      true,
      "off 档产出：RATE_LIMIT 占位码表",
    );
    assert.equal(
      isPresetShape(rowOf({ mode: "always", maxRetries: 999 })),
      true,
      "always 档产出：码表键不落盘，读侧投影空表",
    );
    assert.equal(
      isPresetShape(rowOf({ mode: "always", retryableCodes: DEFAULT_CODES })),
      true,
      "always 档手抄默认码表：无语义内容可丢",
    );
    assert.equal(
      isPresetShape(rowOf({ retryableCodes: ENHANCED_CODES })),
      true,
      "enhanced 产出（基座未改造，次数 5 沿用）",
    );
    assert.equal(
      isPresetShape(rowOf({ maxRetries: 0, retryableCodes: ENHANCED_CODES })),
      true,
      "enhanced 产出（基座 off，次数 0 沿用）",
    );
    assert.equal(
      isPresetShape(rowOf({ mode: "always", retryableCodes: ENHANCED_CODES })),
      true,
      "enhanced 产出（基座 always，次数在 always 档不起作用）",
    );
    const reorderedRow = rowOf({ retryableCodes: DEFAULT_CODES.toReversed() });
    assert.equal(
      isPresetShape(reorderedRow),
      true,
      "码表顺序无关：preset 写盘顺序固定，手写顺序不影响行为",
    );
  });

  it("手写形状判 false（旧判据的漏报面）", () => {
    assert.equal(
      isPresetShape(rowOf({ retryableCodes: ["PI_AI_ERROR"] })),
      false,
      "规范次数 + 手写码表：旧判据只看次数，误判 ok",
    );
    assert.equal(
      isPresetShape(rowOf({ maxRetries: 10, hasQuota: true, retryableCodes: ENHANCED_CODES })),
      false,
      "enhanced 归类但次数 10 写不出：手写次数藏在 enhanced 产出里",
    );
    assert.equal(isPresetShape(rowOf({ maxRetries: 10 })), false, "手写次数");
    assert.equal(isPresetShape(rowOf({ maxRetries: 3 })), false, "手写次数");
    assert.equal(
      isPresetShape(rowOf({ maxRetries: 0 })),
      false,
      "normal/0 但码表为空表：preset off 必写码表键，这是手写关闭",
    );
    assert.equal(
      isPresetShape(rowOf({ maxRetries: 0, hasQuota: true, retryableCodes: ["QUOTA"] })),
      false,
      "手写关闭 + 自写码表",
    );
    assert.equal(
      isPresetShape(rowOf({ mode: "always", retryableCodes: ["PI_AI_ERROR"] })),
      false,
      "always 档手写码表",
    );
  });
});

describe("needsOverwriteConfirm 确认门（按目标档位）", () => {
  it("enhanced/custom 永不确认（host 合并码表/编辑器预填即确认）", () => {
    const handWritten = rowOf({ retryableCodes: ["PI_AI_ERROR"] });
    const enhancedShaped = rowOf({
      maxRetries: 10,
      hasQuota: true,
      retryableCodes: ENHANCED_CODES,
    });
    assert.equal(needsOverwriteConfirm(handWritten, "enhanced"), false);
    assert.equal(needsOverwriteConfirm(enhancedShaped, "enhanced"), false);
    assert.equal(needsOverwriteConfirm(handWritten, "custom"), false);
  });

  it("整表替换档位（default/off/always）只对带手写内容的行确认", () => {
    const handWritten = rowOf({ retryableCodes: ["PI_AI_ERROR"] });
    const enhancedShaped = rowOf({
      maxRetries: 10,
      hasQuota: true,
      retryableCodes: ENHANCED_CODES,
    });
    const untouched = rowOf({});
    assert.equal(needsOverwriteConfirm(handWritten, "off"), true);
    assert.equal(needsOverwriteConfirm(handWritten, "always"), true);
    assert.equal(needsOverwriteConfirm(handWritten, "default"), true);
    assert.equal(
      needsOverwriteConfirm(enhancedShaped, "default"),
      true,
      "例2：enhanced 归类行的手写次数在整表替换下会丢",
    );
    assert.equal(needsOverwriteConfirm(untouched, "off"), false, "未改造行常用路径免检");
    assert.equal(needsOverwriteConfirm(untouched, "always"), false);
    assert.equal(needsOverwriteConfirm(untouched, "default"), false);
  });

  it("键表之外的档位名保守确认（UI 路径不可达，防御坏载荷）", () => {
    assert.equal(needsOverwriteConfirm(rowOf({ retryableCodes: ["PI_AI_ERROR"] }), "bogus"), true);
  });
});

describe("client/host 码表常量漂移钉", () => {
  it("host.ts OFFICIAL_DEFAULT_RETRY_POLICY 与判据矩阵假设的默认码表同源", () => {
    // 本用例的期望值与上方矩阵用的 DEFAULT_CODES 是同一份独立写死的清单：
    // host 侧漂移在这里红，client 判据侧漂移在上面的矩阵里红。
    assert.equal(OFFICIAL_DEFAULT_RETRY_POLICY["mode"], "normal");
    assert.equal(OFFICIAL_DEFAULT_RETRY_POLICY["maxRetries"], 5);
    assert.deepEqual(OFFICIAL_DEFAULT_RETRY_POLICY["retryableCodes"], DEFAULT_CODES);
  });
});
