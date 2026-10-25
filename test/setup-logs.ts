// test/setup-logs.ts —— 插件运行日志的账本（vitest setupFile）。
//
// 为什么不用 vitest 的 `silent`：那只是不显示，新飘出来的日志照样没人看。这里把「跑测不该有
// 算子日志漏进报告」变成一条可判的契约：
//   ① 每条 `[<pkg>]` 日志必须含有 test/log-templates.ts 里的某个模板片段，否则当场红；
//   ② 带别家标签的日志出现在本包测试里也红（装配范围错了）；
//   ③ 生产侧一行不改：级别、文案、时机全部照旧，账本只在测试进程里接管输出。
// 用例要看日志内容时用 logged()/loggedText() 取，断言写在用例里。
import { afterEach, beforeEach } from "vitest";
import assert from "node:assert/strict";

import { LOG_TEMPLATES } from "./log-templates.ts";

/** 本包标签前缀，如 `[session-rescue]`。 */
const PKG_PREFIX = "[session-rescue]";

/** 插件会用到的四个 console 级别（联合类型取属性，避免以字符串索引 Console）。 */
export type LogLevel = "info" | "warn" | "error" | "log";
const LEVELS: readonly LogLevel[] = ["info", "warn", "error", "log"];

/** 一次接管到的调用：拼平的首参 + 其余实参（堆栈通常就藏在其余实参里）。 */
export interface LogRecord {
  level: LogLevel;
  text: string;
  extra: unknown[];
}

let records: LogRecord[] = [];
const originals = new Map<LogLevel, (...args: unknown[]) => void>();

/** 接管一个级别：处理器单独成函数，别在 for 里现造闭包（no-loop-func 拦的就是这个）。 */
function spyLevel(level: LogLevel): void {
  originals.set(level, console[level]);
  console[level] = (...args: unknown[]) => {
    const [first, ...rest] = args;
    records.push({ level, text: String(first).replaceAll(/\s+/gu, " "), extra: rest });
  };
}

function install(): void {
  for (const level of LEVELS) {
    spyLevel(level);
  }
}

function uninstall(): void {
  for (const [level, fn] of originals) {
    console[level] = fn;
  }

  originals.clear();
}

function containsTemplate(text: string): boolean {
  return LOG_TEMPLATES.some((fragment) => text.includes(fragment));
}

beforeEach(() => {
  records = [];
  install();
});

afterEach(() => {
  uninstall();
  const ours = records.filter((record) => record.text.startsWith(PKG_PREFIX));
  const strangers = records
    .filter((record) => record.text.startsWith("["))
    .filter((record) => !record.text.startsWith(PKG_PREFIX))
    .map((record) => record.text.slice(0, 120));
  const unclaimed = ours
    .filter((record) => !containsTemplate(record.text))
    .map((record) => record.text.slice(0, 120));

  assert.deepEqual(strangers, [], "本包测试里出现了别家插件的日志：装配范围错了");
  assert.deepEqual(
    unclaimed,
    [],
    "这些日志对不上本包源码里的任何模板片段：新增 console.* 没有用例认领，或消息是临时拼的",
  );
});

/** 本条用例产生的插件日志，按调用顺序。 */
export function logged(): readonly LogRecord[] {
  return records.filter((record) => record.text.startsWith(PKG_PREFIX));
}

/** 拼平的日志正文，便于 match 断言。 */
export function loggedText(): string {
  return logged()
    .map((record) => record.text)
    .join("\n");
}
