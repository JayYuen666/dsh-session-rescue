// build-types.mjs 的声明（供 test/publish-manifest.test.ts 从 TS 侧类型化导入）。
// 门禁用的两个纯函数真源在 shared（本脚本只是运行期转导出），类型也从同一处取：
// 手抄签名的那一版会在 shared 改签名时静默过期——本文件此前就是这么漂移的。
export {
  canonicalizeDeclarationSpecifiers,
  listDeclarations,
} from "@jayyuen66/dsh-plugin-shared/lib/build-types";

/** 产出 types/ 并交回本次写出的声明清单（相对包根、`/` 分隔）。 */
export function buildTypes(): Promise<string[]>;
