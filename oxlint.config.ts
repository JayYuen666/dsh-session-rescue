import { definePluginConfig } from "@jayyuen66/dsh-plugin-shared/config/oxlint";

export default definePluginConfig({
  // 无包内规则例外：基线（只读那一组同步 API）已覆盖本包的全部用法。
  // titlePrefixes 只登记"标题确实以这个完整术语开头"的技术名（方法名、env 常量、视图组件名）。
  // 短一级都不许：实测 oxlint 前缀一命中就免检整条标题，`Retry` 会把 `Retry-After …` 与
  // `RetryPolicySection …` 两类一起放过 —— 陈旧/过宽条目由 scripts/assert-config-baseline.mjs 点名。
  // 带连字符的 HTTP 头名（Retry-After）登记不进来：基线那条 `只收裸标识符` 的校验会拒（它挡的是
  // 通配与带点形式）⇒ 这类标题改成中文主体在前、把头名留在句中，免检面为零。
  titlePrefixes: [
    "Config",
    "GET",
    "MAX_SESSIONS",
    "POST",
    "QUOTA",
    "QueueSection",
    "RescueDockView",
    "RescueEditor",
    "RescueSettingsCard",
    "RetryPolicySection",
  ],
});
