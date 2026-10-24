#!/usr/bin/env node
// @ts-check
/// <reference types="node" />
// 构建 types/：先让 tsc 出声明，再把声明里的相对说明符从源码后缀改写成产物后缀。
// 编排（两阶段草稿→替换、说明符正典化、清单口径）统一住在 @jayyuen66/dsh-plugin-shared/
// lib/build-types，一处可改；本文件只定位本仓依赖图里的 tsc 入口并转交目录约定。
// 为什么需要后处理与两阶段——见 shared 同名切面的文件头。
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { buildDeclarations } from "@jayyuen66/dsh-plugin-shared/lib/build-types";
import { invokedDirectly } from "@jayyuen66/dsh-plugin-shared/lib/build-artifacts";

// 声明门禁（test/publish-manifest.test.ts）按同一口径列 types/ 与判说明符，此处转导出，
// 测试里不必改路径。
export {
  canonicalizeDeclarationSpecifiers,
  listDeclarations,
} from "@jayyuen66/dsh-plugin-shared/lib/build-types";

const root = import.meta.dirname;
const require = createRequire(import.meta.url);

/**
 * 本地 tsc 的入口文件绝对路径。
 *
 * 不拼 `node_modules/typescript/bin/tsc`：非提升布局下它不存在，脚代会以一个与成因无关
 * 的 ENOENT 失败。先按解析器找到 typescript 包根，再读它 package.json 的 `bin.tsc`——
 * 那是包自己声明的入口，布局无关（`./bin/tsc` 不在 exports 里，直接 resolve 会撞
 * ERR_PACKAGE_PATH_NOT_EXPORTED）。
 * @returns {string} tsc 入口绝对路径
 */
function tscEntry() {
  const manifestPath = require.resolve("typescript/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const binTable = manifest?.bin;
  const bin = typeof binTable === "object" && binTable !== null ? binTable.tsc : binTable;
  if (typeof bin !== "string" || bin.length === 0) {
    throw new Error(`typescript 的 package.json 没有可用的 bin.tsc：${manifestPath}`);
  }
  return path.resolve(path.dirname(manifestPath), bin);
}

/** 产出 types/：跑 tsc 出声明，再逐个改写相对说明符。 */
export async function buildTypes() {
  return buildDeclarations({ root, tscEntry: tscEntry() });
}

async function main() {
  const files = await buildTypes();
  console.info("types/ written:", files.length, "files");
}

if (invokedDirectly(import.meta.filename)) {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
