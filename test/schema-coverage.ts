// test/schema-coverage.ts —— 卡片字段覆盖门禁（多包共用，复制式分发，同 client-freshness.ts）。
//
// 背景：host.ts 的 `Config` schema 声明 N 个设置字段（隐式注册，可编辑面 = 标了
// `.volatile()` 的那些），client 卡片只渲染 M 个（M < N）→ 那 N-M 个字段用户无法从 UI
// 触及，只能改 profile 补丁或读源码。此处踩坑：quality-gate 的 `memoryFeedback`
// （功能性开关——host.ts 的 `if (cfg.memoryFeedback !== false)` 决定是否把门禁失败写入
// 记忆库，且有专门测试）在卡片漏项，审查后才被发现。
//
// 做法：解析 host.ts 的 Schema.object 字段名 + client 源码树（src/** + lib/**）实际绑定的
// 字段名，断言后者 ⊇ 前者。漏项必须显式列入 allowUnbound 并给理由——断言侧同时校验
// allowUnbound 里的每一项确实未被绑定（防止"挂名豁免"绕过门禁）。
//
// 门禁语义刻意是「全部 schema 字段绑定或有理由豁免」，而不是只收 `.volatile()` 字段：
// 非 volatile 字段靠豁免表显式记账，豁免的过时与缺理由都由断言侧判红；单仓收紧成
// volatile-only 会让复制分发的各仓夹具失同步。
//
// 用法（各包 test/build-client.test.ts 的覆盖门禁用例里取证据后断言）：
//   schemaCoverageEvidence(import.meta.url)
//   schemaCoverageEvidence(import.meta.url, {
//     allowUnbound: [{ field: 'x', reason: '仅 CLI 侧使用，UI 无入口' }],
//   })
//
// 绑定识别是"出现即算绑定"的宽松启发式（见 boundFieldsIn），取舍方向写死在这里：
// 多认（注释/字符串外的同名调用）→ 门禁更宽松，是已知代价；少认（组件是 .tsx、
// 字段名在别的惯用法里）→ 功能性缺失被放过，是真漏拦。所以注释先剥掉再扫
// （被注释掉的旧绑定不许算数），扩展名白名单收 .tsx，剩下的假阳性靠豁免表
// 反向校验与人工审查兜。

// 本包副本形态：只导出**证据**（host 字段全集 / client 绑定集 / 豁免表 / 解析不了的块），
// 不引 vitest——断言与用例注册都在 test/build-client.test.ts 的门禁用例里。共享夹具一旦
// 自行 it()，它就成了用例文件，vitest 的结构类规则（require-hook / consistent-test-it /
// valid-title）全落到夹具头上。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AllowUnbound {
  field: string;
  reason: string;
}

/** 字符串或注释的跨度：`end` 是它之后的下标，`quote` 是跨过之后所处的引号状态。 */
interface LiteralSpan {
  readonly end: number;
  readonly quote: string;
  readonly kind: "comment" | "string";
}

/** 行注释/块注释的收尾下标（找不到收尾就吃到文末）。 */
function commentEndAfter(text: string, index: number): number {
  const isLine = text.charAt(index + 1) === "/";
  const stop = isLine ? text.indexOf("\n", index) : text.indexOf("*/", index + 2);
  if (stop === -1) {
    return text.length;
  }
  return isLine ? stop : stop + 2;
}

const isQuoteChar = (char: string): boolean => char === '"' || char === "'" || char === "`";

/**
 * `index` 处若是字符串/注释的开头（或正处在字符串内部），交回它的跨度；否则交回 `null`。
 *
 * 取字段名、配括号、剥注释三处文本扫描要认同一套字面量边界，抄三份就会三处不同步，
 * 所以只在这里定义一次。转义只认反斜杠（模板串里的 `${}` 不需要特判：里面出现的括号
 * 属于表达式，本来该参与配对）。
 */
function literalAt(text: string, index: number, quote: string): LiteralSpan | null {
  const char = text.charAt(index);
  const next = text.charAt(index + 1);
  let span: LiteralSpan | null = null;
  if (quote !== "") {
    const end = index + (char === "\\" ? 2 : 1);
    const nextQuote = char === "\\" || char !== quote ? quote : "";
    span = { end, quote: nextQuote, kind: "string" };
  } else if (char === "/" && (next === "/" || next === "*")) {
    span = { end: commentEndAfter(text, index), quote: "", kind: "comment" };
  } else if (isQuoteChar(char)) {
    span = { end: index + 1, quote: char, kind: "string" };
  }
  return span;
}

/** `index` 处的「顶层键」：词首的标识符且其后紧跟冒号。 */
function keyAt(block: string, index: number): { name: string; end: number } | null {
  const char = block.charAt(index);
  const prev = index === 0 ? "" : block.charAt(index - 1);
  const startsWord = /[A-Za-z_$]/u.test(char) && (prev === "" || /[\s,{[(]/u.test(prev));
  const name = startsWord ? (/^[A-Za-z_$][\w$]*/u.exec(block.slice(index))?.[0] ?? "") : "";
  const isKey =
    name !== "" &&
    block
      .slice(index + name.length)
      .trimStart()
      .startsWith(":");
  return isKey ? { name, end: index + name.length } : null;
}

/**
 * 对象字面量的**顶层**键（逐字符扫描，不用行首缩进猜层级）。
 *
 * 按行首缩进取键的旧写法有两个洞：单行写法一个键都取不到；缩进不是两格（一层嵌套
 * 对象恰好也缩两格、或被格式化到四格）就会把嵌套键当顶层键。改成按括号深度扫：
 * 深度 0 处的 `标识符:` 才是这个对象的顶层键（入参是去掉外层花括号之后的块体）。
 */
function literalTopLevelKeys(block: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  for (let index = 0; index < block.length; index += 1) {
    const span = literalAt(block, index, quote);
    const char = block.charAt(index);
    const key = span === null && quote === "" && depth === 0 ? keyAt(block, index) : null;
    if (span !== null) {
      ({ quote } = span);
      index = span.end - 1;
    } else if (key !== null) {
      out.push(key.name);
      index = key.end - 1;
    } else if (char === "{" || char === "(" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === ")" || char === "]") {
      depth -= 1;
    }
  }
  return out;
}

/** 配括号的行走状态。 */
interface BracketWalk {
  started: boolean;
  depth: number;
  out: string;
}

/**
 * 非字面量位置的一步。交回 `true` 表示刚收到配平的右括号（区段到此结束）。
 *
 * 拆出来是因为主循环里「跳过字面量」与「数括号」两件事混在一起时认知复杂度会越过
 * 本仓 sonarjs 的门槛，读的人还得同时记住两个状态。
 */
function bracketStep(
  state: BracketWalk,
  char: string,
  openChar: string,
  closeChar: string,
): boolean {
  if (!state.started) {
    state.started = char === openChar;
    state.depth = state.started ? 1 : 0;
    return false;
  }
  if (char === openChar) {
    state.depth += 1;
    state.out += char;
    return false;
  }
  if (char !== closeChar) {
    state.out += char;
    return false;
  }
  state.depth -= 1;
  if (state.depth === 0) {
    return true;
  }
  state.out += char;
  return false;
}

/**
 * 从 `open` 处的括号起取配对括号内的文本；没配对上时返回空串。
 *
 * 字符串、模板串与注释里的括号不参与配对——按字符数深度时，块里只要出现 `")"` 或
 * 一行 `// )` 就会提前收尾，块后半段的字段全被截掉，而唯一失败判据是「字段数为 0」，
 * 部分截断不会报错。
 */
function sliceInside(text: string, open: number, openChar: string, closeChar: string): string {
  const state: BracketWalk = { started: false, depth: 0, out: "" };
  let quote = "";
  for (let index = open; index < text.length; index += 1) {
    const span = literalAt(text, index, quote);
    if (span !== null) {
      state.out += span.kind === "comment" ? "" : text.slice(index, span.end);
      ({ quote } = span);
      index = span.end - 1;
    } else if (bracketStep(state, text.charAt(index), openChar, closeChar)) {
      return state.out;
    }
  }
  return "";
}

/** 括号家族的两个便捷入口（花括号取对象字面量、圆括号取实参）。 */
const bracesAt = (text: string, open: number): string => sliceInside(text, open, "{", "}");
const parensAt = (text: string, open: number): string => sliceInside(text, open, "(", ")");

/** `Schema.object(` 的实参 → 字段名；字面量直取顶层键，标识符回溯到同名 const 字面量。 */
function fieldsOfSchemaArgument(hostTs: string, argument: string): string[] {
  const trimmed = argument.trim();
  if (trimmed.startsWith("{")) {
    return literalTopLevelKeys(trimmed.slice(1, -1));
  }
  const identifier = /^(?<name>[A-Za-z_$][\w$]*)$/u.exec(trimmed)?.groups?.["name"] ?? "";
  if (identifier === "") {
    return [];
  }
  const declaration = new RegExp(
    `(?:const|let|var)\\s+${identifier}\\s*(?::[^=]+)?=\\s*\\{`,
    "u",
  ).exec(hostTs);
  if (declaration === null) {
    return [];
  }
  return literalTopLevelKeys(bracesAt(hostTs, declaration.index + declaration[0].length - 1));
}

/**
 * 去掉注释（块注释整段抹掉、行注释抹到行尾），保留字符串原样。
 *
 * 绑定识别的两条正则都要扫**这条之后**的文本：被注释掉的旧代码、废弃分支里的
 * `field: 'x'` / `set('x')` 会算成"已绑定"，卡片明明没有那个控件却过门禁——这是漏拦
 * （假绿）。字符串里的内容不抹：要认的字段名本身就写在字符串里（`set("retryMax")`），
 * 抹了等于一个都认不出。
 */
function stripComments(src: string): string {
  let out = "";
  let quote = "";
  for (let index = 0; index < src.length; index += 1) {
    const span = literalAt(src, index, quote);
    if (span === null) {
      out += src.charAt(index);
    } else {
      out += span.kind === "comment" ? "" : src.slice(index, span.end);
      ({ quote } = span);
      index = span.end - 1;
    }
  }
  return out;
}

/**
 * 从 host.ts 抽取**全部** `Schema.object(...)` 块内的字段名（并集），并交回解析不了的块。
 *
 * 只取第一处 `Schema.object(` 的旧写法有个静默洞：标记先出现在注释或文档字符串、
 * 或存在多个块时，取到的可能根本不是设置 schema——而"解析器少认了一种写法"与
 * "这个包没有设置"在旧结果上无法区分，门禁会悄悄缩小到一个子集上照绿。所以两种
 * 实参形态都收（字面量直取、标识符回溯 const），解析不了的块原样交回给断言侧点名。
 */
function hostSchemaFields(source: string): { fields: string[]; unresolved: string[] } {
  // 先剥注释再找块：注释里写着的 `Schema.object({ legacy: 1 })` 也是一处字面匹配，
  // 拿它当块起点会把 `legacy` 收进字段全集，随后报成「卡片未暴露」——纯属虚构的漏项。
  const hostTs = stripComments(source);
  const marker = "Schema.object(";
  const fields = new Set<string>();
  const unresolved: string[] = [];
  let from = 0;
  for (;;) {
    const start = hostTs.indexOf(marker, from);
    if (start === -1) {
      break;
    }
    from = start + marker.length;
    const open = hostTs.indexOf("(", start);
    const argument = open === -1 ? "" : parensAt(hostTs, open);
    const parsed = argument === "" ? [] : fieldsOfSchemaArgument(hostTs, argument);
    if (parsed.length === 0) {
      unresolved.push(
        argument === "" ? `${marker}… 的括号没有配对` : `${marker}${argument.trim().slice(0, 40)})`,
      );
    }
    for (const field of parsed) {
      fields.add(field);
    }
  }
  return { fields: [...fields], unresolved };
}

/** 捕获组取值（严格模式下 matchAll 捕获为 `string | undefined`，这里收口为 string）。 */
function group(match: RegExpExecArray, index: number): string {
  return match[index] ?? "";
}

/** 扫描一个 client 源文件，收集作为「设置写入第一参」出现的字段名字面量。 */
function boundFieldsIn(source: string): Set<string> {
  const src = stripComments(source);
  const out = new Set<string>();
  // 输入行组件的 field prop：field: 'x'
  for (const match of src.matchAll(/\bfield\s*:\s*["'](?<field>[A-Za-z_$][\w$]*)["']/gu)) {
    out.add(group(match, 1));
  }
  // 各种写入惯用法：props.set('x' / set('x' / unset('x' / fireAndForget('x' / writeSet('x'
  //   刻意不要求限定 receiver——各包惯用法不同（props.set / fireAndForget / writer.set），
  //   收得太紧会假阴性。字段名是否算"绑定"由断言侧与 host 字段名交集判定。
  for (const match of src.matchAll(
    /\b(?:set|unset|fireAndForget|writeSet|commit)\s*\(\s*["'](?<field>[A-Za-z_$][\w$]*)["']/gu,
  )) {
    out.add(group(match, 1));
  }
  // 卡片行 helper（numberRow/toggleRow）以字面量参数转发 field 名（第三参），
  // 与 `field: 'x'` 对象 prop 同属"绑定"信号。
  for (const match of src.matchAll(
    /\b(?:numberRow|toggleRow)\s*\(\s*["'][^"']*["']\s*,\s*["'][^"']*["']\s*,\s*["'](?<field>[A-Za-z_$][\w$]*)["']/gu,
  )) {
    out.add(group(match, 1));
  }
  return out;
}

/** 卡片源码的扩展名白名单：组件可能是 .tsx，别只看 .ts。 */
const CLIENT_SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"] as const;

/** 递归收集目录下所有卡片源文件文本（跳过 node_modules，不跟随软链，IO 失败不抛）。 */
function walk(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) {
    return out;
  }
  let entries;
  try {
    // withFileTypes 一次拿到类型，省掉每条目一次 statSync；isSymbolicLink 不跟随，
    // 否则目录自指的软链会让这里无限递归（或 ELOOP）。
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // 读不动就是读不动：调用方的契约是「交回证据」，不该在这里抛。
    return out;
  }
  for (const entry of entries) {
    const usable = entry.name !== "node_modules" && !entry.isSymbolicLink();
    const filePath = path.join(dir, entry.name);
    if (!usable) {
      // 跳过依赖树与软链（后者可能自指，跟随就会无限递归）。
    } else if (entry.isDirectory()) {
      out.push(...walk(filePath));
    } else if (CLIENT_SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      try {
        out.push(readFileSync(filePath, "utf8"));
      } catch {
        // 同上：读不到就跳过，别让门禁自己炸。
      }
    }
  }
  return out;
}

/** client 侧实际绑定的字段名集合（只扫 `src/` 与 `lib/` 两棵树；本包卡片入口在 src/ 内）。 */
function clientBoundFields(pkgDir: string): Set<string> {
  const out = new Set<string>();
  for (const src of [...walk(path.join(pkgDir, "src")), ...walk(path.join(pkgDir, "lib"))]) {
    for (const field of boundFieldsIn(src)) {
      out.add(field);
    }
  }
  return out;
}

/** 「卡片字段覆盖 host schema」门禁的证据（断言在 test/build-client.test.ts 的用例里）。 */
export interface SchemaCoverageEvidence {
  readonly pkgName: string;
  readonly hostFields: string[];
  readonly bound: Set<string>;
  readonly exemptions: Map<string, string>;
  /** 解析不了的 `Schema.object(` 块（原文截段）。断言侧必须判空：解析失败静默缩小时
   *  字段全集，门禁会在一个子集上照绿——「换了写法」与「没有设置」必须可区分。 */
  readonly unresolved: string[];
}

/** 收集门禁证据：host 字段全集、client 绑定集、显式豁免表、解析不了的块。 */
export function schemaCoverageEvidence(
  testFileUrl: string,
  opts: { allowUnbound?: AllowUnbound[] } = {},
): SchemaCoverageEvidence {
  const testDir = path.dirname(fileURLToPath(testFileUrl));
  const pkgDir = path.resolve(testDir, "..");
  const pkgName =
    /"name":\s*"(?<pkgName>[^"]+)"/u.exec(
      readFileSync(path.resolve(pkgDir, "package.json"), "utf8"),
    )?.groups?.["pkgName"] ?? "unknown";
  const hostTs = readFileSync(path.resolve(pkgDir, "host.ts"), "utf8");
  const { fields, unresolved } = hostSchemaFields(hostTs);
  const bound = clientBoundFields(pkgDir);
  const exemptions = new Map((opts.allowUnbound ?? []).map((x) => [x.field, x.reason]));
  return { pkgName, hostFields: fields, bound, exemptions, unresolved };
}
