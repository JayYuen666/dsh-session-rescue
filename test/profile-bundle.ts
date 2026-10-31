// test/profile-bundle.ts —— 卡片槽位 key 的漂移针（多包共用，复制式分发，同 client-freshness.ts）。
//
// 背景（这一条就是排查时查出来的真缺陷）：`plugins.bundle.config` 是**按 bundle 包名**
// keyed 的槽位，宿主派发时拿注册项的 key 与该 bundle 的包名做精确相等匹配：
//   installed dsh-client-ui-plugin-manager/lib/client.js:2907
//     renderSlot("plugins.bundle.config", { view: "page" }, { entryKey: pkg.name })
//   installed dsh-client-ui-renderer/lib/client.js:1179
//     host.entriesOfSlot(slotKey).find((e) => e.options.key === opts?.entryKey)
//   同插件页 :3979 的「这个 bundle 有没有配置卡」位 = ledger.bundles.has(openPkg.name)，
//   而 ledger.bundles 就是上面那批注册 key 的集合（:62 `keysOf("plugins.bundle.config")`）
//   installed dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:111-113
//     —— "keyed by the bundle's package name"，key 必填
//   首方先例 installed dsh-experimental-client-ui-voice-input/lib/client.js:2924-2926
//     —— key 写的就是 bundle 包名
// key 写成 loader 的裸条目 id（cordis.patch.yml 的 `- id:`）时，宿主拿包名找不到这个
// 键，`configured` 也是 false → 插件页上永不出卡（本文件存在的理由）。
//
// 两个标识**各管各的**，本模块把两侧真源都读出来，防止「一改全改」把另一边带坏：
//   - 槽位 key = bundle 包名，真源是本包自己的 package.json（宿主派发 entryKey 用的就是
//     被装 bundle 的包名，与装法无关）；profile 只在这台开发机上存在，装了才顺手钉一道
//     「清单里确有这一条」的机器侧漂移针；
//   - configForms.get(entryId) 的入参（= 隐式 settings 命名空间）= 裸条目 id，
//     真源本包 cordis.patch.yml（installed dsh-client-ui-settings/lib/client.js:1294-1298
//     把 entryId 原样当命名空间用）。
// 所以这里**不写任何包名/条目 id 字面量**：测试里抄一份常量，正是本缺陷当初漏网的原因。

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** 本包根目录：helper 与 client-freshness.ts 同放 test/，据此定位包内文件。 */
const PKG_DIR = path.resolve(import.meta.dirname, "..");

/** unknown → Record 的窄化判据。刻意手抄：test/ 不引运行时依赖，真源见
 *  shared/lib/record.ts（本包 client 半不抄第二份，别再往这里加判据）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 断言为 Record 并交回窄化后的值：assert.fail 走 never，isRecord 守卫完成收窄，
 *  不需要 `as` 断言。 */
function assertRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) {
    assert.fail(message);
  }
  return value;
}

/** 读一份 JSON 文件并投影为 Record（形状不对即抛，不静默兜成空对象）。 */
function readJson(file: string): Record<string, unknown> {
  assert.ok(existsSync(file), `读不到 ${file}`);
  const text = readFileSync(file, "utf8");
  const parsed: unknown = JSON.parse(text);
  assert.ok(isRecord(parsed), `${file} 的顶层不是 JSON 对象`);
  return parsed;
}

/** profile 清单路径：`~/.dsh/profiles/web/package.json`（DSH_PROFILE_PACKAGE_JSON 可改指）。 */
function profileManifestPath(): string {
  const override = process.env["DSH_PROFILE_PACKAGE_JSON"] ?? "";
  return override === ""
    ? path.join(os.homedir(), ".dsh", "profiles", "web", "package.json")
    : override;
}

/** 本包的包名（`package.json.name`）；清单与注册 key 两处都用它当唯一真源。 */
function ownPackageName(): string {
  const own = readJson(path.join(PKG_DIR, "package.json"))["name"];
  assert.equal(typeof own, "string", "本包 package.json 没有 name");
  return typeof own === "string" ? own : "";
}

/** profile 的 `dsh.profile.bundles` 清单；没装 profile 的环境（CI、消费者克隆）回 null。
 *  清单存在但结构损坏（缺 dsh/profile 段、bundles 非数组、混入非字符串项）是**另一回事**：
 *  逐层显式断言并点名缺的是哪一段——回落成空表会把环境问题误报成「本包不在清单里」。 */
function profileBundleListOrNull(): string[] | null {
  const file = profileManifestPath();
  if (!existsSync(file)) {
    return null;
  }
  const root = readJson(file);
  const dshSection = assertRecord(root["dsh"], `${file} 缺 dsh 段或它不是对象：profile 清单损坏`);
  const profileSection = assertRecord(
    dshSection["profile"],
    `${file} 缺 dsh.profile 段或它不是对象：profile 清单损坏`,
  );
  const listed = profileSection["bundles"];
  assert.ok(Array.isArray(listed), `${file} 的 dsh.profile.bundles 不是数组：profile 清单损坏`);
  const items: unknown[] = listed;
  const nonStrings = items.filter((item) => typeof item !== "string");
  assert.deepEqual(
    nonStrings,
    [],
    `${file} 的 dsh.profile.bundles 含非字符串项（清单损坏，不静默丢弃）：${JSON.stringify(nonStrings).slice(0, 200)}`,
  );
  const bundles = items as string[];
  // 同名 profile 未必属于本工作面：`--from-default-profile web` 也会造一个只装官方基座的
  // web profile。清单里一个本族包都没有时按「没装 profile」处理——机器侧针只钉在真装着
  // 本族插件的 profile 上，把陌生 profile 报成「本包不在清单」是把环境当成了漂移。
  // 作用域从本包 package.json 的 name 推：写死 `@jayyuen66/` 会在改名/换 scope 后静默失效。
  const own = ownPackageName();
  const scopeEnd = own.indexOf("/");
  const belongs =
    scopeEnd === -1
      ? bundles.includes(own)
      : bundles.some((name) => name.startsWith(`${own.slice(0, scopeEnd)}/`));
  if (!belongs) {
    return null;
  }
  return bundles;
}

/**
 * 本包在 profile 里那条 bundle 的包名 —— `plugins.bundle.config` 的 key 必须是它。
 * 取的是本包自己的 `package.json.name`：宿主派发的 `entryKey` 就是**被装的那个 bundle**
 * 的包名，所以对任何装法（registry / link / 本机 profile）它都是那个值。
 * profile 只存在在这台开发机上，装了才加一道机器侧针（清单里确有这一条）。
 */
export function profileBundleName(): string {
  const name = ownPackageName();
  const listed = profileBundleListOrNull();
  if (listed !== null) {
    assert.ok(
      listed.includes(name),
      `${name} 不在 profile 的 dsh.profile.bundles 里：没有 bundle 行就没有配置卡`,
    );
  }
  return name;
}

/** 剥 YAML 标量的行尾注释（` #` 起到行尾）：引号内的 `#` 不算注释。 */
function stripYamlTrailingComment(raw: string): string {
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i] ?? "";
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#" && i > 0 && /\s/u.test(raw[i - 1] ?? "")) {
      return raw.slice(0, i).trim();
    }
  }
  return raw.trim();
}

/**
 * cordis.patch.yml 里的裸条目 id —— 隐式 settings 命名空间与
 * `configForms.get(entryId)` 的入参都取它，与 bundle 包名是两回事。
 * 收集**全部**裸 `- id:` 行并断言唯一：只取第一条的话，清单里多出第二条（或条目嵌进
 * 别的键下）时会把无关条目当成命名空间，「隐式命名空间」这条证据失真却不报错。
 * 引号与行尾注释都剥掉：`- id: "foo"  # 说明` 与 `- id: foo` 是同一条目。
 */
function patchEntryId(): string {
  const yml = readFileSync(path.join(PKG_DIR, "cordis.patch.yml"), "utf8");
  const ids: string[] = [];
  for (const line of yml.split("\n")) {
    const match = /^\s*-\s+id:\s*(?<raw>.*?)\s*$/u.exec(line);
    const raw = match?.groups?.["raw"] ?? "";
    if (match !== null && raw !== "") {
      const body = stripYamlTrailingComment(raw);
      const unquoted = /^(?<quote>["'])(?<body>.*)\k<quote>$/u.exec(body)?.groups?.["body"] ?? body;
      if (unquoted !== "") {
        ids.push(unquoted);
      }
    }
  }
  assert.notEqual(ids.length, 0, "cordis.patch.yml 里没有裸 `- id:` 条目");
  assert.equal(
    ids.length,
    1,
    `cordis.patch.yml 里有 ${ids.length} 条裸 \`- id:\`（${ids.join(", ")}）：无法断定哪条是本包的 settings 命名空间`,
  );
  return ids[0] ?? "";
}

/** 产物里 `const <name> = "<字面量>"` 的值；取不到即抛（漂移针不许静默放过）。
 *  标识符先进正则转义再拼模式（产物常量名可能带 `$`，不转义就成了行尾锚点），
 *  并给 `const` 加词边界：注释或字符串里出现的同名片段不许命中。 */
function constLiteral(text: string, name: string): string {
  const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
  const pattern = new RegExp(`(?:^|[^A-Za-z0-9_$])const ${escaped}\\s*=\\s*"(?<value>[^"]*)"`, "u");
  const value = pattern.exec(text)?.groups?.["value"] ?? "";
  assert.notEqual(value, "", `产物里找不到 const ${name} = "…" 的字面量声明`);
  return value;
}

/** 求文本中 `at` 所在对象字面量的跨度（前后向花括号配平、深度归零即边界）。
 *  刻意不识别字符串里的花括号：注册 desc 的对象体没有含 `{`/`}` 的字符串，
 *  若将来出现，跨度算错会让 key 读不到而判红（fail-loud），不会误报成别处的 key。 */
/** 从 `at` 往回找包住它的 `{`，返回该括号的下标；找不到时回 0。 */
function objectStartAt(text: string, at: number): number {
  let start = at;
  let depth = 0;
  while (start > 0) {
    const char = text[start - 1] ?? "";
    if (char === "}") {
      depth += 1;
    } else if (char === "{") {
      if (depth === 0) {
        return start - 1;
      }
      depth -= 1;
    }
    start -= 1;
  }
  return 0;
}

/** 从 `at` 往后找配对的 `}`，返回它之后一位；不闭合时回文本末尾。 */
function objectEndAt(text: string, at: number): number {
  let end = at;
  let depth = 0;
  while (end < text.length) {
    const char = text[end] ?? "";
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      if (depth === 0) {
        return end + 1;
      }
      depth -= 1;
    }
    end += 1;
  }
  return text.length;
}

/** `at` 所在的对象字面量跨度（含两侧花括号）；找不到时退回从 0 到文本末尾。
 *  若将来出现，跨度算错会让 key 读不到而判红（fail-loud），不会误报成别处的 key。 */
function enclosingObjectSpan(text: string, at: number): [number, number] {
  return [objectStartAt(text, at), objectEndAt(text, at)];
}

/** 读 `i` 处的 `key: <字面量|标识符>`；不是顶层 key 或没有冒号时交回 undefined。 */
function keyValueAt(span: string, i: number): { literal: string; ident: string } | null {
  if (!span.startsWith("key", i) || /[\w$]/u.test(span[i - 1] ?? "")) {
    return null;
  }
  let cursor = i + 3;
  while (/\s/u.test(span[cursor] ?? "")) {
    cursor += 1;
  }
  if (span[cursor] !== ":") {
    return null;
  }
  cursor += 1;
  while (/\s/u.test(span[cursor] ?? "")) {
    cursor += 1;
  }
  const opener = span[cursor] ?? "";
  if (opener === '"' || opener === "'") {
    let end = cursor + 1;
    let literal = "";
    while (end < span.length && span[end] !== opener) {
      if (span[end] === "\\") {
        end += 1;
      }
      literal += span[end] ?? "";
      end += 1;
    }
    return { literal, ident: "" };
  }
  return { literal: "", ident: /^[A-Za-z_$][\w$]*/u.exec(span.slice(cursor))?.[0] ?? "" };
}

/** 在对象字面量文本里取**顶层**（深度 1）的 key 值；字符串与嵌套对象不参与。
 *  嵌套对象先出现 `key:` 时，全局正则会把它当成槽位 key。 */
function topLevelSlotKey(span: string): { literal: string; ident: string } {
  let depth = 0;
  let quote = "";
  let found: { literal: string; ident: string } | undefined;
  for (let i = 0; i < span.length && found === undefined; i += 1) {
    const char = span[i] ?? "";
    if (quote !== "") {
      if (char === "\\") {
        i += 1;
      } else if (char === quote) {
        quote = "";
      }
    } else if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
    } else if (depth === 1) {
      found = keyValueAt(span, i) ?? undefined;
    }
  }
  return found ?? { literal: "", ident: "" };
}

/** 取产物里 `plugins.bundle.config` 那次 register 的 key（字面量或常量标识符都解析）。
 *  搜索范围限定在本次 register 的对象字面量内：产物里别处也有裸 `key:`（槽位键、
 *  React list key），全局抓会拿错；名字相同的注册必须唯一，否则定位本身就不成立。 */
function registeredSlotKey(text: string): string {
  const marker = text.indexOf('name: "plugins.bundle.config"');
  assert.notEqual(marker, -1, "产物里没有 plugins.bundle.config 的注册");
  assert.equal(
    text.indexOf('name: "plugins.bundle.config"', marker + 1),
    -1,
    "产物里有不止一处 plugins.bundle.config 注册：槽位 key 的定位不唯一",
  );
  const [start, end] = enclosingObjectSpan(text, marker);
  const { literal, ident } = topLevelSlotKey(text.slice(start, end));
  if (literal !== "") {
    return literal;
  }
  assert.notEqual(ident, "", "产物里读不到 slot 注册 desc 的 key（既不是字面量也不是标识符）");
  return constLiteral(text, ident);
}

/** 从 openParen 处的 `(` 起做括号配平，交回括号内的实参文本（支持嵌套调用）。 */
function balancedCallArg(text: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < text.length; i += 1) {
    const char = text[i] ?? "";
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(openParen + 1, i);
      }
    }
  }
  return "";
}

/** 取产物里 `ctx.configForms.get(<入参>)` 实际用到的条目 id（同样兼容字面量/常量）。
 *  收集全部调用并断言唯一：产物里若出现多出的一次 get（另一处默认值读取），
 *  只取第一处会把无关入参当成命名空间，断言结论整个错掉。 */
function configFormsEntryId(text: string): string {
  const args: string[] = [];
  for (const match of text.matchAll(/configForms\.get\(/gu)) {
    const raw = balancedCallArg(text, match.index + match[0].length - 1).trim();
    if (raw !== "") {
      args.push(raw);
    }
  }
  assert.equal(
    args.length,
    1,
    `产物里 configForms.get(…) 出现 ${args.length} 次（${args.join(", ")}）：无法断定哪次是卡片命名空间`,
  );
  const arg = args[0] ?? "";
  const inline = /^"(?<value>[^"]*)"$/u.exec(arg)?.groups?.["value"] ?? "";
  if (inline !== "") {
    return inline;
  }
  return constLiteral(text, arg);
}

/**
 * 漂移针的三份证据，全部从真源读出来（本模块**不写任何包名/条目 id 字面量**：
 * 测试里抄一份常量，正是本缺陷当初漏网的原因）。判据断言在
 * test/build-client.test.ts 的「漂移针」用例里。
 *   1. `plugins.bundle.config` 的 key === profile `dsh.profile.bundles` 中本包那条包名；
 *   2. `configForms.get()` 的入参 === cordis.patch.yml 的裸条目 id
 *      （**没有**被顺手一起改成包名 —— 那会把 client 半的写入面再次弄坏）；
 *   3. 两个标识不同值（相等就说明本包恰好条目 id == 包名，那这一层的混用钉不住，直接红）。
 */
export interface SlotKeyEvidence {
  readonly bundle: string;
  readonly entryId: string;
  readonly slotKey: string;
  readonly formsEntryId: string;
}

export function slotKeyEvidence(clientText: string): SlotKeyEvidence {
  return {
    bundle: profileBundleName(),
    entryId: patchEntryId(),
    slotKey: registeredSlotKey(clientText),
    formsEntryId: configFormsEntryId(clientText),
  };
}
