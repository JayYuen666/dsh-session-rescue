/** build-client.mjs 的声明（供 test/build-client.test.ts 等 TS 侧类型化导入）。 */
export function buildClient(): Promise<string>;

/** 取出源码里 `const BUNDLE_PKG = "…"` 的取值（先剥注释）；见 build-client.mjs 的 JSDoc。 */
export function bundlePkgFromSource(source: string): string | undefined;
