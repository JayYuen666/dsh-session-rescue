// test/log-templates.test.ts —— 日志骨架清单与源码的同步判据。
//
// 账本（test/setup-logs.ts）只保证「跑出来的每条日志都对得上某个骨架」；它管不到反向：
// 源码里新增一条日志而清单没跟着改，要等那条日志真在某条用例里被打印出来才红，而多半的
// 分支日志在用例里根本不会被触发。这个文件补的是反向那一半：现扫一遍源码，把清单拿去
// 逐条对齐，清单漏条、多出陈旧条目、顺序错位都当场红。
//
// 扫描口径与清单的写出方式一致：取每个 console.* 调用的首个模板字面量，插值按花括号配对
// 整体归一成占位符（多行模板里的换行与缩进折叠成单空格）。用模板字面量之外的形态打印
// 日志的调用也算红：那种日志没有可对齐的骨架，账本对它恒判未认领。
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "vitest";

import { LOG_SKELETONS, claimsLog } from "./log-templates.ts";

const PKG_ROOT = path.resolve(import.meta.dirname, "..");

/** 账本覆盖的扫描面：宿主侧模块（客户端日志不进这个账本）。 */
const SCAN_ROOTS: readonly string[] = ["lib"];

/** 插值占位符，与 test/log-templates.ts 用的是同一个记号。 */
const PLACEHOLDER = "⟨slot⟩";

const CONSOLE_CALL = /\bconsole\.(?:info|warn|error|log|debug)\(/gu;

async function collectTypeScript(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => collectTypeScript(path.join(dir, entry.name))),
  );
  const here = entries
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"),
    )
    .map((entry) => path.join(dir, entry.name));
  return [...here, ...nested.flat()];
}

/** 跳过空白，返回首个非空白字符的下标。 */
function skipWhitespace(source: string, from: number): number {
  let index = from;
  while (index < source.length && /\s/u.test(source[index] ?? "")) {
    index += 1;
  }
  return index;
}

/** 读一个插值（`${` 之后到配对的花括号为止），返回它之后的下标。 */
function skipInterpolation(source: string, from: number): number {
  let depth = 0;
  let index = from;
  do {
    if (source[index] === "{") {
      depth += 1;
    } else if (source[index] === "}") {
      depth -= 1;
    }
    index += 1;
  } while (index < source.length && depth > 0);
  return index;
}

/**
 * 从 `from` 起读一个模板字面量的正文，插值整体折成 {@link PLACEHOLDER}。
 *
 * 返回 null 表示首个实参不是模板字面量。花括号按深度配对，所以 `${a ? {x:1} : {}}`
 * 这类插值里的对象字面量不会被当成插值结束。
 */
function templateBodyAt(source: string, from: number): string | null {
  let index = skipWhitespace(source, from);
  if (source[index] !== "`") {
    return null;
  }

  index += 1;
  let body = "";
  while (index < source.length) {
    const char = source[index];
    if (char === "`") {
      return body;
    }
    if (char === "\\") {
      body += char + (source[index + 1] ?? "");
      index += 2;
    } else if (char === "$" && source[index + 1] === "{") {
      index = skipInterpolation(source, index + 1);
      body += PLACEHOLDER;
    } else {
      body += char;
      index += 1;
    }
  }

  return null;
}

/** 源码里现存的日志骨架，按出现顺序；非模板字面量形态的调用单独收集。 */
async function scanLogSkeletons(): Promise<{ skeletons: string[]; opaque: string[] }> {
  const nested = await Promise.all(
    SCAN_ROOTS.map((entry) => collectTypeScript(path.join(PKG_ROOT, entry))),
  );
  const files = [path.join(PKG_ROOT, "host.ts"), ...nested.flat()];

  const sources = await Promise.all(files.map((file) => readFile(file, "utf8")));
  const skeletons: string[] = [];
  const opaque: string[] = [];
  for (const [at, source] of sources.entries()) {
    const file = files[at] ?? "";
    for (const match of source.matchAll(CONSOLE_CALL)) {
      const [call] = match;
      const body = templateBodyAt(source, match.index + call.length);
      if (body === null) {
        opaque.push(`${path.relative(PKG_ROOT, file)}: ${call}`);
      } else {
        skeletons.push(body.replaceAll(/\s+/gu, " ").trim());
      }
    }
  }

  return { skeletons, opaque };
}

describe("日志骨架清单与源码同源", () => {
  it("清单逐条对上源码里现存的日志，不多不少、顺序一致", async () => {
    const { skeletons, opaque } = await scanLogSkeletons();

    assert.deepEqual(
      opaque,
      [],
      "这些 console.* 调用的首个实参不是模板字面量：账本按整条骨架对齐，拼出来的日志没有可对齐的形状",
    );
    assert.notEqual(
      skeletons.length,
      0,
      "扫描面里一个 console.* 调用都没找到：扫描口径坏了，不是清单干净",
    );
    assert.deepEqual(LOG_SKELETONS, skeletons, "清单与源码漂移：按源码重排或补上漏掉的条目");
  });

  it("清单不是空转：按骨架填值后必被认领，且首端锚死", () => {
    assert.notEqual(
      LOG_SKELETONS.length,
      0,
      "骨架清单为空时 claimsLog 恒假，账本会退化成「每条日志都未认领」",
    );

    for (const skeleton of LOG_SKELETONS) {
      const filled = skeleton.replaceAll(PLACEHOLDER, "填值");
      assert.equal(claimsLog(filled), true, `按骨架填出来的日志没被认领：${skeleton}`);
      assert.equal(
        claimsLog(`前缀${filled}`),
        false,
        `骨架首端没锚死，多一个字仍被认领：${skeleton}`,
      );
      // 尾端只有在骨架以字面量收尾时才判得出来：以插值收尾的骨架，插值本来就吃任意尾巴。
      if (!skeleton.endsWith(PLACEHOLDER)) {
        assert.equal(
          claimsLog(`${filled} 尾随`),
          false,
          `骨架尾端没锚死，多一个字仍被认领：${skeleton}`,
        );
      }
    }
  });
});
