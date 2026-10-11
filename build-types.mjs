#!/usr/bin/env node
/// <reference types="node" />
// 构建 types/：先让 tsc 出声明，再把声明里的相对说明符从源码后缀改写成产物后缀。
//
// 为什么需要后处理：host.ts 与 lib/*.ts 按 NodeNext 约定写 `./lib/turn-facts.ts` 这种显式
// `.ts` 后缀（基线 tsconfig 的 allowImportingTsExtensions + verbatimModuleSyntax 都要求它），
// 而 tsc 的**声明**产物会把说明符原样抄进 .d.ts —— 于是 `types/host.d.ts` 里留着
// `from "./lib/turn-facts.ts"`，而包里根本没有那个文件（只有 `types/lib/turn-facts.d.ts`）。
// `rewriteRelativeImportExtensions` 救不了：它只作用于 JS 产物，不动声明。
//
// 改成 `./lib/turn-facts.js` 才是对的：TypeScript 把 `.js` 说明符解析到同名 `.d.ts`，消费方
// 因此解析到本包发出去的那份声明。
//
// 两件必做的事：
//   1. 出声明前**清空** types/ —— tsc 不清 outDir，删掉某个 lib 文件后它的旧 .d.ts 会留在
//      原地，而 `files` 里列的是整目录，陈旧声明照样被发出去。
//   2. 把产出清单交给调用方 —— `test/publish-manifest.test.ts` 的声明门禁要按同一口径列
//      types/，在测试里重写一份遍历逻辑只会让两边的目录形状悄悄分叉。
//
// 顶部 node reference：oxlint 的类型检查对 .mjs 不自动加载 @types/node，需显式声明才能解析
// node:fs/promises、node:child_process、process（否则整文件按 error 类型误报 unsafe）。
import { execFileSync } from "node:child_process";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = import.meta.dirname;
const outDir = path.join(root, "types");

/**
 * 只改写相对说明符（以 `./` 或 `../` 开头）里的 `.ts` 后缀。
 *
 * 裸说明符（`node:fs`、`@deepseek-ai/…`）一概不碰：包名段里不存在带 `.ts` 的形状，而放宽到
 * 任意说明符会误伤 `import("some-pkg.ts")` 这类合法的第三方引用。命中的形态有三处：
 * `import type … from`、`export … from` 与内联的 `import("…")` 类型。
 */
const RELATIVE_SOURCE_SPECIFIER = /(?<quote>["'])(?<prefix>\.{1,2}\/[^"']*)\.ts\k<quote>/gu;

/**
 * 把一段声明正文里的相对 `.ts` 说明符改写成 `.js`。
 *
 * @param {string} text - 声明文件正文
 * @returns {string} 改写后的正文
 */
export function canonicalizeDeclarationSpecifiers(text) {
  return text.replace(
    RELATIVE_SOURCE_SPECIFIER,
    (_match, quote, prefix) => `${quote}${prefix}.js${quote}`,
  );
}

/**
 * 跑一条命令；失败时抛出的信息取子进程自己的 stderr，而不是包装层的壳。
 *
 * 用同步版：这是构建步骤，阻塞等 tsc 跑完完全够用，异步包装在这里只会为一个用不上的并发度
 * 引入回调与 Promise 两种形态。
 *
 * @param {string} file - 可执行文件
 * @param {string[]} args - 参数
 * @returns {void}
 */
function run(file, args) {
  try {
    execFileSync(file, args, { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error ? error.stderr : "";
    const detail = typeof stderr === "string" ? stderr.trim() : "";
    throw new Error(detail === "" ? String(error) : detail, { cause: error });
  }
}

/**
 * 递归列出 `types/` 下的声明文件（相对包根、`/` 分隔）。
 *
 * 文件与目录分成两支再汇总：混在一个 map 里时，只有文件的那一支会变成一个没有 `await`
 * 的 `async` 回调；拆开后两支各自理由完整。
 *
 * @param {string} dir - 当前目录绝对路径
 * @param {string} prefix - 相对包根前缀
 * @returns {Promise<string[]>} 命中的文件清单（相对包根）
 */
export async function listDeclarations(dir, prefix) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((entry) => !entry.isDirectory() && entry.name.endsWith(".d.ts"))
    .map((entry) => `${prefix}${entry.name}`);
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => listDeclarations(path.join(dir, entry.name), `${prefix}${entry.name}/`)),
  );
  return [...files, ...nested.flat()];
}

/**
 * 产出 types/：跑 tsc 出声明，再逐个改写相对说明符。
 *
 * @returns {Promise<string[]>} 改写过的声明文件清单（相对包根，`/` 分隔）
 */
export async function buildTypes() {
  // 先清空：tsc 不清 outDir，留着旧声明等于把陈旧类型一起发出去。
  await rm(outDir, { recursive: true, force: true });
  // tsc 自己已经按 tsconfig 排好了依赖与增量，这里只把失败原样抛出。
  run("npx", ["tsc", "-p", "tsconfig.types.json"]);
  const files = await listDeclarations(outDir, "");
  await Promise.all(
    files.map(async (file) => {
      const full = path.join(outDir, file);
      const text = await readFile(full, "utf8");
      await writeFile(full, canonicalizeDeclarationSpecifiers(text), "utf8");
    }),
  );
  return files;
}

async function main() {
  const files = await buildTypes();
  console.info("types/ written:", files.length, "files");
}

if (process.argv[1] === import.meta.filename) {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
