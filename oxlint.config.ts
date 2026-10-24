import { definePluginConfig } from "@jayyuen66/dsh-plugin-shared/config/oxlint";

export default definePluginConfig({
  // 无包内规则例外：基线（只读那一组同步 API）已覆盖本包的全部用法。
  //
  // titlePrefixes 只登记「标题确实以这个完整术语开头」的技术名（方法名、env 常量、视图组件名）。
  // 登记项越短，被它顺手放过的标题越多，而放过的那些没有任何门会红，所以宁缺勿滥：本列表只
  // 留实际用到的长术语，加入新项前先确认有标题真的以它开头、且它已是最长的那个术语。
  //
  // 登记项本身要满足什么形式（是否收通配、能否带点、前缀如何与实际标题匹配），判据在共享包
  // 基线与它自己的用例里（dsh-plugin-shared/config/oxlint.base.ts、test/config-oxlint.test.ts）；
  // 这里不重复描述那些口径——写在消费方会与基线脱钩，而被写下的那句话不会被任何门检验。
  titlePrefixes: [
    "Config",
    "MAX_SESSIONS",
    "QUOTA",
    "RescueDockView",
    "RescueEditor",
    "RescueSettingsCard",
    "RetryPolicySection",
  ],
});
