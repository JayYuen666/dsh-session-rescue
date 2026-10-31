/** build-host.mjs 的声明（供 test/build-host.test.ts 等 TS 侧类型化导入）。
 *  运行期只导出 buildHost 一个可调用成员：单 chunk 断言住在 shared，本脚本不再转导出
 *  （此前那条转导出没有消费者，且声明指向一个不存在的 build-utils.mjs）。 */
export function buildHost(): Promise<string>;
