// test/schema-coverage.ts —— 卡片字段覆盖门禁（多包共用，复制式分发，同 client-freshness.ts）。
//
// 背景：host.ts 的 `Config` schema 声明 N 个设置字段（0.1.7：隐式注册，可编辑面 =
// 标了 `.volatile()` 的那些），client 卡片只渲染 M 个（M < N）→ 那 N-M 个字段用户无法从 UI 触及，只能改 profile 补丁或
// 读源码。此处踩坑：quality-gate 的 `memoryFeedback`（功能性开关——host.ts 的
// `if (cfg.memoryFeedback !== false)` 决定是否把门禁失败写入记忆库，且有专门测试）在卡片
// 漏项，两轮审查后才被发现。
//
// 做法：解析 host.ts 的 Schema.object 字段名 + client 源码树（src/** + lib/**）实际绑定的
// 字段名，断言后者 ⊇ 前者。漏项必须显式列入 allowUnbound 并给理由——测试同时校验
// allowUnbound 里的每一项确实未被绑定（防止"挂名豁免"绕过门禁）。
//
// 用法（各包 test/build-client.test.ts 的覆盖门禁用例里取证据后断言）：
//   schemaCoverageEvidence(import.meta.url)
//   schemaCoverageEvidence(import.meta.url, {
//     allowUnbound: [{ field: 'x', reason: '仅 CLI 侧使用，UI 无入口' }],
//   })
//
// 注意：绑定识别是"出现即算绑定"的宽松启发式（见 isBoundField），假阳性只会让门禁
// 更宽松（不会假绿漏拦功能性缺失）；假阴性会立刻报错，故宁可宽不可严。

// 本包副本形态：只导出**证据**（host 字段全集 / client 绑定集 / 豁免表），不引 vitest——
// 断言与用例注册都在 test/build-client.test.ts 的门禁用例里。共享夹具一旦自行 it()，
// 它就成了用例文件，vitest 的结构类规则（require-hook / consistent-test-it / valid-title）
// 全落到夹具头上。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AllowUnbound {
  field: string;
  reason: string;
}

/** 从 host.ts 抽取 `Schema.object({...})` 块内的字段名。 */
function hostSchemaFields(hostTs: string): string[] {
  const marker = "Schema.object(";
  const start = hostTs.indexOf(marker);
  if (start === -1) {
    return [];
  }
  // 从 Schema.object( 的左括号起做深度匹配，取到对应右括号
  const open = hostTs.indexOf("(", start);
  if (open === -1) {
    return [];
  }
  let depth = 0;
  let end = -1;
  for (let i = open; i < hostTs.length; i += 1) {
    const ch = hostTs[i];
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) {
    return [];
  }
  const block = hostTs.slice(open + 1, end);
  return [...block.matchAll(/^(?:\s{2,})(?<field>[A-Za-z_$][\w$]*):\s*Schema\./gmu)].map(
    (match) => match.groups?.["field"] ?? "",
  );
}

/** 扫描一个 client 源文件，收集作为「设置写入第一参」出现的字段名字面量。 */
function boundFieldsIn(src: string): Set<string> {
  const out = new Set<string>();
  // 输入行组件的 field prop：field: 'x'
  for (const match of src.matchAll(/\bfield\s*:\s*["'](?<field>[A-Za-z_$][\w$]*)["']/gu)) {
    out.add(match.groups?.["field"] ?? "");
  }
  // 各种写入惯用法：props.set('x' / set('x' / unset('x' / fireAndForget('x' / writeSet('x'
  //   刻意不要求限定 receiver——各包惯用法不同（props.set / fireAndForget / writer.set），
  //   收得太紧会假阴性。字段名是否算"绑定"由 schemaCoverageEvidence 与 host 字段名交集判定。
  for (const match of src.matchAll(
    /\b(?:set|unset|fireAndForget|writeSet|commit)\s*\(\s*["'](?<field>[A-Za-z_$][\w$]*)["']/gu,
  )) {
    out.add(match.groups?.["field"] ?? "");
  }
  // 卡片行 helper（numberRow/toggleRow）以字面量参数转发 field 名（第三参），
  // 与 `field: 'x'` 对象 prop 同属"绑定"信号。
  for (const match of src.matchAll(
    /\b(?:numberRow|toggleRow)\s*\(\s*["'][^"']*["']\s*,\s*["'][^"']*["']\s*,\s*["'](?<field>[A-Za-z_$][\w$]*)["']/gu,
  )) {
    out.add(match.groups?.["field"] ?? "");
  }
  return out;
}

/** 递归收集目录下所有 .ts 源文件文本（跳过 node_modules）。 */
function walk(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) {
    return out;
  }
  for (const entry of readdirSync(dir)) {
    if (entry !== "node_modules" && entry !== "test") {
      const filePath = path.join(dir, entry);
      const stat = statSync(filePath);
      if (stat.isDirectory()) {
        out.push(...walk(filePath));
      } else if (entry.endsWith(".ts")) {
        out.push(readFileSync(filePath, "utf8"));
      }
    }
  }
  return out;
}

/** client 侧实际绑定的字段名集合（src/** + lib/** + client-entry 同级单文件）。 */
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
}

/** 收集门禁证据：host 字段全集、client 绑定集、显式豁免表。 */
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
  const hostFields = hostSchemaFields(hostTs);
  const bound = clientBoundFields(pkgDir);
  const exemptions = new Map((opts.allowUnbound ?? []).map((x) => [x.field, x.reason]));
  return { pkgName, hostFields, bound, exemptions };
}
