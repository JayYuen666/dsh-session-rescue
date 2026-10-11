// build-types.mjs 的声明（供 test/publish-manifest.test.ts 与 test/dist-size.test.ts 从 TS 侧
// 类型化导入）。只声明测试真正调用的那一面：列 types/ 下的声明文件。
// canonicalizeDeclarationSpecifiers 同为导出但测试不直接调它，故不在此声明——多写一份没人用的
// 签名只会让它与实现悄悄分叉。
/**
 * 递归列出目录下的 `.d.ts` 文件。
 *
 * @param dir - 当前目录绝对路径
 * @param prefix - 相对包根前缀
 * @returns 命中的文件清单，相对包根、`/` 分隔
 */
export function listDeclarations(dir: string, prefix: string): Promise<string[]>;
