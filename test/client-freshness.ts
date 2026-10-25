// test/client-freshness.ts —— 产物新鲜度指纹门禁（8 包共用，TDD 驱动编写）。
// 本包副本形态：只提供**证据**（磁盘产物 vs 内存构建产物 + 包名），用例注册留在
// test/build-client.test.ts 的 describe 里。共享夹具一旦自行 it()，它就变成用例文件，
// vitest 的结构类规则（require-hook / consistent-test-it / valid-title）全部落到夹具上。
//
// 背景：src/client-entry.ts 改后忘跑 node build-client.mjs，浏览器一直加载旧
// client.js——本会话已两次踩坑（rescue 403 修复没进产物；ctx-observe 字段补齐
// 曾靠人工时间戳核对）。mtime 断言在 git clone / touch 下不稳定，故用
// **内容指纹**：内存构建（buildClient()，纯函数、确定性输出）vs 磁盘
// client.js 逐字节比对。src 任何变更未重建 → 字节必差 → 红。
//
// 用法（各包 test/build-client.test.ts 的指纹用例里）：
//   const evidence = await clientFreshnessEvidence(import.meta.url)
//   —— 自动定位 ../client.js 与 ../build-client.mjs
//
// 注意：buildClient() 必须是确定性构建（同输入同输出）。当前 8 包的
// build-client.mjs 均不含时间戳/随机数（rollup 无 banner hash 变量），
// 逐字节相等成立；若未来构建引入非确定性，改为规范哈希比较并在
// build-client.mjs 里输出 canonical 形态。

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 指纹门禁的两份产物 + 包名与包根（消息里标身份与修复命令，两侧同源）。 */
export interface FreshnessEvidence {
  readonly pkgName: string;
  readonly pkgDir: string;
  readonly onDisk: string;
  readonly built: string;
}

/** 取指纹门禁证据：磁盘 client.js 与当期内存构建产物。 */
export async function clientFreshnessEvidence(testFileUrl: string): Promise<FreshnessEvidence> {
  const testDir = path.dirname(fileURLToPath(testFileUrl));
  const pkgDir = path.resolve(testDir, "..");
  const pkgName =
    /"name":\s*"(?<pkgName>[^"]+)"/u.exec(
      readFileSync(path.resolve(pkgDir, "package.json"), "utf8"),
    )?.groups?.["pkgName"] ?? "unknown";
  // 动态导入 .mjs 对 TS 为 any，先收窄到调用面再 await（避免 no-unsafe-*）。
  const mod = (await import(path.resolve(pkgDir, "build-client.mjs"))) as {
    buildClient: () => Promise<string>;
  };
  return {
    pkgName,
    pkgDir,
    onDisk: readFileSync(path.resolve(pkgDir, "client.js"), "utf8"),
    built: await mod.buildClient(),
  };
}
