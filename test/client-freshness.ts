// test/client-freshness.ts —— 产物新鲜度指纹门禁（多包共用）。
// 本包副本形态：只提供**证据**（磁盘产物 vs 内存构建产物 + 包名），用例注册留在
// test/build-client.test.ts 的 describe 里。共享夹具一旦自行 it()，它就变成用例文件，
// vitest 的结构类规则（require-hook / consistent-test-it / valid-title）全部落到夹具上。
//
// 背景：src/client-entry.ts 改后忘跑 node build-client.mjs，浏览器一直加载旧
// client.js——已踩过坑（rescue 403 修复没进产物；ctx-observe 字段补齐
// 曾靠人工时间戳核对）。mtime 断言在 git clone / touch 下不稳定，故用
// **内容指纹**：内存构建（buildClient()，纯函数、确定性输出）vs 磁盘
// client.js 按 **Buffer 逐字节**比对（不是 utf8 字符串比较：非法 UTF-8 字节会被
// 解码成 U+FFFD 从而掩盖真实差异）。src 任何变更未重建 → 字节必差 → 红。
// 行尾由仓根 .gitattributes 的 `* text=auto eol=lf` 钉住，所以真机上不会出现
// 「只有换行符不同」的假红；万一哪天那条规则被删，这里按字节仍会红——那是文件
// 真的不一样，不是测量的锅。
//
// 用法（各包 test/build-client.test.ts 的指纹用例里）：
//   const evidence = await clientFreshnessEvidence(import.meta.url)
//   —— 自动向上定位最近的 package.json，再取该包根的 client.js 与 build-client.mjs
//
// 注意：buildClient() 必须是确定性构建（同输入同输出）。各包的
// build-client.mjs 均不含时间戳/随机数（rollup 无 banner hash 变量），
// 逐字节相等成立；若未来构建引入非确定性，改为规范哈希比较并在
// build-client.mjs 里输出 canonical 形态。

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 指纹门禁的两份产物 + 包名与包根（消息里标身份与修复命令，两侧同源）。 */
export interface FreshnessEvidence {
  readonly pkgName: string;
  readonly pkgDir: string;
  /** 磁盘 client.js 与当期内存构建产物**逐字节**相等（Buffer.equals）。 */
  readonly identical: boolean;
  readonly onDiskBytes: number;
  readonly builtBytes: number;
}

/** 只认形如 { buildClient(): Promise<string> } 的模块面：改名、只 default 导出或仍是
 *  CJS 时，门禁要给出可操作诊断而不是把 TypeError 原样抛给读测试的人。 */
const isBuildClientModule = (
  value: unknown,
): value is { readonly buildClient: () => Promise<string> } =>
  typeof value === "object" &&
  value !== null &&
  "buildClient" in value &&
  typeof value.buildClient === "function";

/** 从用例所在目录向上找最近的 package.json：夹具放哪一层（test/ 或 test/unit/）
 *  都能定位到真正的包根，而不是硬编码「上一级」。 */
function findPkgDir(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(path.resolve(dir, "package.json"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`[client-freshness] 从 ${startDir} 向上找不到 package.json，无法定位包根`);
    }
    dir = parent;
  }
}

/** 读包名：JSON 解析后取 name（不用正则——package.json 里 bin/publishConfig/脚本字符串
 *  都可能出现同形的 "name" 片段）。读不到就抛：门禁消息靠它标身份，回退成 "unknown"
 *  等于把可操作线索丢掉且不报警。 */
function readPkgName(pkgDir: string): string {
  const manifestPath = path.resolve(pkgDir, "package.json");
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  const name =
    typeof manifest === "object" && manifest !== null && "name" in manifest
      ? manifest.name
      : undefined;
  if (typeof name !== "string" || name === "") {
    throw new Error(`[client-freshness] ${manifestPath} 里没有非空字符串 name`);
  }
  return name;
}

/** 取指纹门禁证据：磁盘 client.js 与当期内存构建产物。 */
export async function clientFreshnessEvidence(testFileUrl: string): Promise<FreshnessEvidence> {
  const testDir = path.dirname(fileURLToPath(testFileUrl));
  const pkgDir = findPkgDir(testDir);
  const pkgName = readPkgName(pkgDir);
  // 动态导入 .mjs 对 TS 为 any，先收窄到调用面再 await（避免 no-unsafe-*）。
  // import() 只收 URL 或说明符，不收裸文件系统路径：Windows 上 `C:\…\build-client.mjs`
  // 会被当成协议 `c:` 解析而抛 ERR_UNSUPPORTED_ESM_URL_SCHEME；POSIX 的 `/…` 只是恰好能过。
  const buildScript = path.resolve(pkgDir, "build-client.mjs");
  let mod: unknown;
  try {
    mod = await import(pathToFileURL(buildScript).href);
  } catch (error) {
    throw new Error(
      `[client-freshness] 导入不了 ${buildScript}（夹具定位到的包根：${pkgDir}）：` +
        "先确认 build-client.mjs 在包根，且它的构建依赖已安装",
      { cause: error },
    );
  }
  if (!isBuildClientModule(mod)) {
    throw new Error(
      `[client-freshness] ${buildScript} 没有导出 buildClient()：` +
        "改名、只 default 导出或仍是 CJS 时拿不到当期产物",
    );
  }
  const builtText = await mod.buildClient();
  const builtBytes = Buffer.from(builtText, "utf8");
  const onDiskBytes = readFileSync(path.resolve(pkgDir, "client.js"));
  return {
    pkgName,
    pkgDir,
    identical: onDiskBytes.equals(builtBytes),
    onDiskBytes: onDiskBytes.length,
    builtBytes: builtBytes.length,
  };
}
