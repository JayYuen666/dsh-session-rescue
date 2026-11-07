// test/setup-logs.ts —— 插件运行日志的账本（vitest setupFile）。
//
// 为什么不用 vitest 的 `silent`：那只是不显示，新飘出来的日志照样没人看。这里把「跑测不该有
// 算子日志漏进报告」变成一条可判的契约：
//   ① 每条 `[<pkg>]` 日志必须整条对上 test/log-templates.ts 里的某个骨架，否则当场红；
//   ② 带别家标签的日志出现在本包测试里也红（装配范围错了）；
//   ③ 生产侧一行不改：级别、文案、时机全部照旧，账本只在测试进程里接管输出。
// 用例要看日志内容时用 logged()/loggedText() 取，断言写在用例里。
// 账本按**串行用例**建模（records/testFailed 是模块级单例、console 接管是进程级状态）：
// 本包测试禁用 test.concurrent / --sequence.concurrent——并发用例会共用同一份 records，
// 日志串用例且先收尾的 afterEach 会摘走另一条用例的接管。真要并发化得先把 records
// 换成按用例上下文隔离的形态，那是一次单独的改造。
import { afterEach, beforeEach, onTestFailed } from "vitest";
import assert from "node:assert/strict";

import { claimsLog, LOG_PREFIX } from "./log-templates.ts";

/** 本包标签前缀（与骨架账本同源，见 log-templates.ts 的导出）。 */
const PKG_PREFIX = LOG_PREFIX;

/** 插件会用到的 console 级别（联合类型取属性，避免以字符串索引 Console）。
 *  带上 debug：`log-templates.test.ts` 的源码扫描认这一级，接管处不跟上的话，
 *  一条 console.debug 会被骨架清单要求登记、却在运行时逃过账本两条断言。 */
export type LogLevel = "info" | "warn" | "error" | "log" | "debug";
export const LEVELS: readonly LogLevel[] = ["info", "warn", "error", "log", "debug"];

/** 一次接管到的调用：拼平的首参 + 其余实参（堆栈通常就藏在其余实参里）。 */
export interface LogRecord {
  level: LogLevel;
  text: string;
  extra: unknown[];
  /** 首参是否字符串：本包骨架都是模板字面量（字符串首参），非字符串首参（Error/对象）
   *  落进 String() 会变成 `[object Object]` 一类摘要，三段分类会把它错报成「没打标签」。 */
  stringFirst: boolean;
}

let records: LogRecord[] = [];
const originals = new Map<LogLevel, (...args: unknown[]) => void>();

/** 接管一个级别：处理器单独成函数，别在 for 里现造闭包（no-loop-func 拦的就是这个）。
 *  已经接管过就跳过：`originals` 里只有原方法是还原的唯一依据，重复接管会把它覆盖成
 *  上一个 spy，还原时把 spy 装回去——之后整条 arm 就再也抓不到真实 console 了。 */
function spyLevel(level: LogLevel): void {
  if (originals.has(level)) {
    return;
  }
  originals.set(level, console[level]);
  console[level] = (...args: unknown[]) => {
    // 只认首参：本包每条 console.* 的骨架就是它的模板字面量（首个实参），后续实参是插值进去
    // 的值——把它们也拼进来会让「整条骨架对齐」这条认领判据永远对不上（骨架结尾的标点之后
    // 还会多出值）。写到磁盘的一律是首参，其余实参留在 extra 里（堆栈就藏在那儿）。
    const [first, ...rest] = args;
    records.push({
      level,
      text: String(first).replaceAll(/\s+/gu, " "),
      extra: rest,
      stringFirst: typeof first === "string",
    });
  };
}

/** 接管全部级别。导出只为让 test/setup-logs.test.ts 能验证还原判据。 */
export function install(): void {
  for (const level of LEVELS) {
    spyLevel(level);
  }
}

/** 还原全部级别。导出只为让 test/setup-logs.test.ts 能验证还原判据。 */
export function uninstall(): void {
  for (const [level, fn] of originals) {
    console[level] = fn;
  }

  originals.clear();
}

/** 当前用例是否已经失败（决定 afterEach 还要不要判日志契约）。 */
let testFailed = false;

beforeEach(() => {
  testFailed = false;
  records = [];
  install();
  onTestFailed(() => {
    testFailed = true;
  });
});

/** 断言消息里的单条读数：级别 + 首参摘要 + 其余实参的个数与首个。
 *  `String(first)` 会丢掉结构（Error 变成 "Error: …"、对象变成 "[object Object]"），
 *  而真正的原因常常在其余实参里（堆栈就在那儿），所以这里把它一并带进消息。 */
function describeRecord(record: LogRecord): string {
  const rest =
    record.extra.length === 0
      ? ""
      : `（另有 ${String(record.extra.length)} 个实参，首个：${String(record.extra[0]).slice(0, 120)}）`;
  return `${record.level}: ${record.text.slice(0, 120)}${rest}`;
}

/** 三条日志契约的判定体。单独抽出来是为了让它在两种时机都能跑（见下面两处调用）：
 *  正常收尾的 afterEach，以及「用例已经失败」那条路径。 */
function assertLogContract(): void {
  // 非字符串首参单独点名：console.error(new Error(…)) / console.log(obj) 这类调用的
  // String() 摘要既不以标签开头也不像人话，混进 untagged 只会给出误导性的「补前缀」。
  const nonStringFirst = records
    .filter((record) => !record.stringFirst)
    .map((record) => describeRecord(record));
  const classified = records.filter((record) => record.stringFirst);
  const ours = classified.filter((record) => record.text.startsWith(PKG_PREFIX));
  const strangers = classified
    .filter((record) => record.text.startsWith("["))
    .filter((record) => !record.text.startsWith(PKG_PREFIX))
    .map((record) => describeRecord(record));
  // 一条连标签都没写的日志两头不落：不以 PKG_PREFIX 开头，所以不进 ours（躲过骨架账本）；
  // 也不以 `[` 开头，所以不进 strangers（躲过装配范围判据）。两条断言都读不到它。
  const untagged = classified
    .filter((record) => !record.text.startsWith("["))
    .map((record) => describeRecord(record));
  const unclaimed = ours
    .filter((record) => !claimsLog(record.text))
    .map((record) => describeRecord(record));

  assert.deepEqual(
    nonStringFirst,
    [],
    "这些 console.* 调用的首参不是字符串（Error/对象/格式串）：算子日志必须以带标签的字符串首参打印",
  );
  assert.deepEqual(strangers, [], "本包测试里出现了别家插件的日志：装配范围错了");
  assert.deepEqual(
    untagged,
    [],
    "这些日志既没有本包标签也不带任何标签：补上 [session-rescue] 前缀",
  );
  assert.deepEqual(
    unclaimed,
    [],
    "这些日志对不上本包源的任何骨架：新增 console.* 没有用例认领，或消息是临时拼的",
  );
}

afterEach(() => {
  uninstall();
  // 用例已失败时不再判：hook 里抛出的第二条错会叠加在首因之上，读报告的人先看到「日志
  // 契约失败」，真正的失败原因反而沉到下面。失败用例的日志本来就是它自己打出来的，重复
  // 判定也不会给出新信息。标志由 beforeEach 里注册的 onTestFailed 置位。
  if (testFailed) {
    return;
  }
  assertLogContract();
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
