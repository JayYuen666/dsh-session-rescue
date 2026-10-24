// test/config-refs.ts —— 0.1.7 隐式注册的测试桩件（本包两个 host 测试共用）。
//
// 背景：0.1.7 删掉了 `settings.register(ns, schema, { base })`（连同 `settings.get` 与
// `installSection`）。命名空间变成**隐式**的（= profile 条目 id，见 cordis.patch.yml），
// 可编辑字段由 schema 上的 `.volatile()` 声明，内置默认从「register 的第二层底座」搬进
// schema 的 `.default()`；交进 apply 的每个 volatile 字段是一枚 **Volatile 引用**
// （读当前值 `.get()`），不再是普通值快照。于是 mock 不能再造一个 `scope.get()`：
// 必须复刻宿主真正交给插件的那份形状。
//
// 这里只做一件事：从**导出**的 Config schema 反推字段名/默认/投影，测试里不手写清单，
// 漏字段就是测试红（而不是"两份各自漂移"）。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import plugin from "../host.ts";

/** 宿主判 volatile 用的是**真值**（settings/src/schema.ts:38 `if (schema.meta?.volatile)`），
 *  不是 `=== true`：写窄了会让「meta.volatile 是别的真值」那种 schema 在本桩件里被判成
 *  非 volatile，而宿主照样把它投影进表单 ⇒ 测试绿、卡片少一项。 */
function isVolatileField(node: SchemaNode): boolean {
  // 直接问真值，不自己拼一个"排除 undefined 与 false"的近似：宿主那句 `if (meta?.volatile)`
  // 把 null / 0 / "" / NaN 一律当假，而近似式把它们全当真有 ⇒ 那些 schema 在宿主里不进表单、
  // 在本桩件里被判 volatile，测试绿而卡片少一项。
  return Boolean(node.meta?.["volatile"]);
}

/** Config schema 的字段节点（读 meta/type/dict 用，不复制 schema 结构）。 */
export interface SchemaNode {
  type?: string;
  meta?: Record<string, unknown>;
  dict?: Record<string, SchemaNode>;
}

/** 一次 settings.configure() 的调用记录（页面策略断言用）。 */
export interface ConfigureCall {
  presentation: { auto?: boolean };
  owner: unknown;
}

/** 导出 Config schema 的 dict（字段名与元数据都从宿主实际读的那份来）。
 *  `dict` 缺位时抛而不是回落 `{}`：空字典会让「每个 schema 字段都被配置项覆盖」这条断言
 *  在**零个字段**上成立，而 schemastery 换成别的形状（Config 不再是带 dict 的 object schema）
 *  正是它会发生的时候——那时门禁会安静地全绿，而卡片可能一个字段都没接上。 */
export function configDict(): Record<string, SchemaNode> {
  // 解构而不是直接取成员：`plugin.Config.dict` 这条读法被判 prefer-destructuring，
  // 而这里要的也只是 dict 一个字段。
  const { dict } = plugin.Config as unknown as SchemaNode;
  assert.ok(
    dict !== undefined && Object.keys(dict).length > 0,
    "plugin.Config 上没有 dict：schemastery 的 object schema 形状变了，配置面门禁无从比对",
  );
  return dict;
}

/**
 * 复刻 cordis 交进 apply 的那份 Config：每个字段一枚**稳定引用**，其 get() 现读
 * `read()` 交回的那份活值 —— 与真实 Volatile 的"引用不变、值可变"同构（cosmokit
 * createVolatile 也只有一个 get()，见 harness vendor/cosmokit/src/volatile.ts）。
 * @param read - 现读设置活值（mock 的 scope.set 会整体换表，故这里传函数而不是快照）。
 */
function refsOf(read: () => Record<string, unknown>): Record<string, unknown> {
  // volatile 字段给稳定引用（值可变）；**非 volatile**（请求级重试三值）给普通值
  // 快照 —— 真宿主从不给它们 .get()，给错了插件就读到一个函数。
  return Object.fromEntries(
    Object.entries(configDict()).map(([key, field]) =>
      // 宿主判的是**真值**（settings/src/schema.ts:38 `if (schema.meta?.volatile)`），
      // 不是 `=== true`：写窄了会让「meta.volatile 是别的真值」那种 schema 在本桩件里
      // 被判成非 volatile，而宿主照样把它投影进表单 ⇒ 测试绿、卡片少一项。
      isVolatileField(field)
        ? [key, { get: () => read()[key] }]
        : [key, read()[key] ?? field.meta?.["default"]],
    ),
  );
}

/** apply + 它的 Config 引用：0.1.7 的 config 是引用而不是快照，两处必须同源。 */
export function applyRescue(ctx: unknown, read: () => Record<string, unknown>): void {
  plugin.apply(ctx as never, refsOf(read) as never);
}

/** 本桩件的读法与宿主 `plainSchema` 的分歧点，用一条断言钉住：宿主对
 *  `meta.role === "secret"` 的字段会**抹掉 default/required**（settings/src/schema.ts:22-24），
 *  而 `schemaDefaults()` 读的是 raw `meta.default`。本包 Config 里没有任何 secret 字段，
 *  所以两份默认值今日同解；将来谁加了 secret 字段，这条就会红着提醒改读法。 */
export function secretBearingFields(): string[] {
  return Object.entries(configDict())
    .filter(([, field]) => field.meta?.["role"] === "secret")
    .map(([key]) => key);
}

/** 逐字段 schema 默认 —— 等价于 0.1.6 交给 `settings.register(ns, schema, { base })`
 *  的那份底座，0.1.7 把它搬到了 schema 的 `.default()` 上（少一层「底座」）。 */
export function schemaDefaults(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(configDict()).map(([key, field]) => [key, field.meta?.["default"]]),
  );
}

/**
 * 复刻宿主 packages/settings/settings/src/schema.ts:37-47 的 volatileForm()：
 * 「自身标了 volatile」或「是 object 且子树里有可编辑字段」的字段才进表单。
 * @returns 顶层 object 时给表单字段名清单；叶子可编辑时给 []；
 *  null = 该子树没有任何可编辑字段 → 宿主 describe() 会整条跳过本条目
 *  （settings/src/index.ts:308-309），写入则抛 `has no volatile fields`（:386）。
 *  （用 null 而不是 undefined 表"没有"：本仓 lint 的 consistent-return 把
 *  `return undefined` 记作无值返回，与同函数里的 `return []` 冲突。）
 */
export function volatileFormOf(node: SchemaNode): string[] | null {
  // 与宿主同步：按真值判（schema.ts:38），不按 === true。
  if (isVolatileField(node)) {
    return [];
  }
  if (node.type !== "object") {
    return null;
  }
  const kept = Object.entries(node.dict ?? {}).flatMap(([key, child]) =>
    volatileFormOf(child) === null ? [] : [key],
  );
  return kept.length === 0 ? null : kept;
}

/** cordis.patch.yml 里的裸条目 id —— 0.1.7 的 settings 命名空间就是它。
 *  读文件而不是抄常量：卡片 namespace / 端点 / 命名空间三处都按它对齐，
 *  写死会让测试与包体漂移。 */
export function patchEntryId(): string {
  const yml = readFileSync(fileURLToPath(new URL("../cordis.patch.yml", import.meta.url)), "utf8");
  const pkgName = (
    JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      name: string;
    }
  ).name;
  // 取「紧跟着本包 name」的那一条，而不是文件里第一个裸 `- id:`：patch 里插入的条目不止
  // 本包一个时（将来把别的插件一起拼进来），第一个 id 会静默变成别人的，而三处对齐的
  // 断言仍会全绿——它们比的都是同一个错值。
  const pattern = new RegExp(
    `^\\s*-\\s+id:\\s*(?<id>\\S+)\\s*$[\\s\\S]*?^\\s*name:\\s*["']?${pkgName.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)}["']?\\s*$`,
    "mu",
  );
  const match = pattern.exec(yml);
  const id = match?.groups?.["id"];
  assert.ok(
    typeof id === "string" && id.length > 0,
    `cordis.patch.yml 里没有跟着 ${pkgName} 的裸 \`- id:\` 条目`,
  );
  return id;
}
