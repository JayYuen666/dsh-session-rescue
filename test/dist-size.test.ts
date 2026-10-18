// test/dist-size.test.ts —— 产物体积闸门。
//
// 为什么要有：`npm run check` 的顺序是 build 在 test 之前，所以这道门读到的是**当轮刚产出**
// 的产物，不是上一次遗留的。它挡的是「有人往某个切面里塞进大对象字面量或整段查表」这类
// 回退——体积不是行为，任何现有用例都不会因此变红，所以必须有一把单独的尺子。
//
// 预算怎么定的：取当前实测值上浮约 25%。留这 25% 是给正常演进的——加一条规则、改一句文案
// 不该立刻要求改预算；翻倍一定会顶穿。确需突破时改这些常量并写明理由。
//
// 明确不做的事：**不开 minify**。压缩后的产物里跨包说明符字符串（`from "@deepseek-ai/dsh-brand"`
// 与 `from "@jayyuen66/dsh-plugin-shared/lib/record"`）会双双消失，于是 test/build-host.test.ts 那
// 两条「跨包依赖必须外部化」的断言从「被内联了也不报」变成恒绿——它们防的正是 isRecord /
// brandString 这类单点被就地复制成多份。省下的体积不值得废掉两道真门禁，所以产物保持可读，
// 体积改用预算盯着。
import { describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const pkgDir = path.resolve(import.meta.dirname, "..");

/** host 半产物体积预算：宿主按包名载入它，这些字节是真实装载成本。 */
// 官方 Typert Remote 服务（六条端点的方法版）让 host.js 增加约 2 KB。
const HOST_BUDGET_BYTES = 112_000;
/** client 半产物体积预算：浏览器侧加载，按平台计账。 */
const CLIENT_BUDGET_BYTES = 92_000;
/** `types/` 入口声明体积预算：整目录进 `files`，体积会计进 tarball。 */
const DECLARATION_ENTRY_BUDGET_BYTES = 35_000;

/** 产物文件名与预算的对照。 */
const BUDGETS: readonly (readonly [string, number])[] = [
  ["host.js", HOST_BUDGET_BYTES],
  ["client.js", CLIENT_BUDGET_BYTES],
];

/**
 * 读一个应当已由 build 产出的文件，缺失时给出可执行的提示。
 *
 * 单独走这一步而不是直接 readFileSync：`vitest run` 单跑时产物可能压根不存在，
 * ENOENT 那条系统错误看不出是谁的责任，而这道门的正确用法永远是「先 build」。
 *
 * @param file - 相对包根的产物路径
 * @returns 产物正文
 */
function readArtifact(file: string): string {
  const full = path.join(pkgDir, file);
  assert.ok(
    existsSync(full),
    `${file} 不存在：这道门读的是 build 的产出，请先 npm run build:client && npm run build`,
  );
  return readFileSync(full, "utf8");
}

/**
 * `types/` 入口层声明的字节合计（**不递归**）。
 *
 * 不递归是刻意的：types/ 顶层就是宿主读到的那份入口声明，`lib/` 一层是它派生的依赖，
 * 量级与变更频率都不同。只对顶层求和，就不必去减一个可能为空的子目录——那种写法在子目录
 * 为空时得到 0、断言恒真，而一条永远绿的闸门比没有闸门更坏：它让人以为有护栏。
 *
 * @returns 字节合计
 */
function entryDeclarationBytes(): number {
  const dir = path.join(pkgDir, "types");
  assert.ok(existsSync(dir), "types/ 不存在：请先 npm run build:types");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".d.ts"))
    .reduce((sum, name) => sum + readFileSync(path.join(dir, name)).byteLength, 0);
}

describe("产物体积", () => {
  // 用 it.each 而不是手写循环：两条预算断言形状完全相同，而新增一条预算时手写循环容易漏。
  it.each(BUDGETS)("%s 不超过 %s 字节预算", (file, budget) => {
    const bytes = Buffer.byteLength(readArtifact(file), "utf8");
    assert.ok(
      bytes <= budget,
      `${file} 实测 ${bytes.toLocaleString("en-US")} B，超出预算 ${budget.toLocaleString("en-US")} B：` +
        "多半是某个切面塞进了大查表或字面量。确属正常演进就改 test/dist-size.test.ts 里对应的" +
        "预算常量，并写明理由。",
    );
  });

  it("types/ 入口声明不超出预算", () => {
    const bytes = entryDeclarationBytes();
    assert.ok(
      bytes <= DECLARATION_ENTRY_BUDGET_BYTES,
      `types/ 入口声明实测 ${bytes.toLocaleString("en-US")} B，超出预算 ` +
        `${DECLARATION_ENTRY_BUDGET_BYTES.toLocaleString("en-US")} B：确认是正常演进就改这条预算常量。`,
    );
  });
});
