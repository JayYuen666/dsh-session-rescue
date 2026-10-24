/** build-client.mjs 的声明（供 test/build-client.test.ts 等 TS 侧类型化导入）。
 *  `buildClient` 之外还转导出 `singleEntryChunk`（真源在 build-utils.mjs）：
 *  运行期就是这么导出的，声明面照抄，否则从 TS 侧 import 它会被判「没有这个成员」。 */
export function buildClient(): Promise<string>;
export { singleEntryChunk } from "./build-utils.mjs";
