/** build-utils.mjs 的声明：三个构建脚本共用的对象守卫、产物写入与直跑判据。
 *  单文件产物断言的真源只在这里；build-client.mjs / build-host.mjs 只是转导出它。 */
export function isRecord(raw: unknown): raw is Record<string, unknown>;
export function asRecord(raw: unknown): Record<string, unknown>;
/** 单文件产物只接受唯一的 entry chunk；多余 chunk / asset 直接构建失败。 */
export function singleEntryChunk(
  output: readonly { type: string; fileName: string; code?: string; isEntry?: boolean }[],
  source: string,
): { type: string; fileName: string; code?: string; isEntry?: boolean } & { code: string };
export function writeArtifact(target: string, text: string): Promise<void>;
export function closeQuietly(bundle: { close: () => Promise<void> }): Promise<void>;
export function invokedDirectly(moduleUrl: string): boolean;
