// build-types.mjs 的声明（供 test/publish-manifest.test.ts 与 test/dist-size.test.ts 从 TS 侧
// 类型化导入）。只声明测试真正调用的那一面：列 types/ 下的声明文件，以及把说明符后缀从 .ts
// 改写成 .js 的那一次改写（它只认说明符位置，字面量类型不能被碰）。
/**
 * 递归列出目录下的 `.d.ts` 文件。
 *
 * @param dir - 当前目录绝对路径
 * @param prefix - 相对包根前缀
 * @returns 命中的文件清单，相对包根、`/` 分隔
 */
export function listDeclarations(dir: string, prefix: string): Promise<string[]>;

/**
 * 把声明正文里说明符位置上的相对 `.ts` 后缀改写成 `.js`。
 *
 * @param text - 声明文件正文
 * @returns 改写后的正文
 */
export function canonicalizeDeclarationSpecifiers(text: string): string;
