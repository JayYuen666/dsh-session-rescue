// test/publish-manifest.test.ts —— 发布形态门禁：入口面必须**与发布器无关**地可解析。
//
// 为什么值得一条测试：构建与单测都在源码侧跑绿，而真实故障发生在装出去之后。两类坑都在
// 那一侧。其一是入口指向没随包发出去的文件；其二是入口覆盖写在 `publishConfig` 里——
// pnpm 发布时把它合并到顶层，npm 不合并（npm 会打印
// "Unknown publishConfig config main/exports" 并忽略），同一个仓库换个发布器就发出一个
// import 必失败的包。这里不模仿任何发布器的实现，而是把不变式钉成断言：**顶层入口自己就
// 完整可解析，且 publishConfig 不再承载入口字段**，于是两套发布器语义的差恒为空。
//
// 第二组门禁扫注释：日期、评审条目号、决策来源簿记、退役叙事与本机绝对路径，写下时对作者
// 有用，对读者只是困惑，且没有人能从中重建当时的上下文。只扫注释行与文档；测试夹具里的日期
// （modifiedAfter 之类的边界值）是数据，不在禁面内。
//
// 第三组门禁盯**声明产物**：`types/` 整目录进 `files`，于是它的四类静默故障都没有运行期信号
// ——入口声明缺失、声明停在上一版源码上、声明里带着构建机的本机路径或 pnpm 的内容寻址目录、
// 相对说明符还指着源码 `.ts`。这些全都只能在发布前拦。
//
// 第四组门禁管 registry 侧的元数据与宿主发现面：本包靠 `dsh` 段被宿主认出条目与客户端半，靠
// `engines`/peer 被版本门校验，靠 keywords/homepage/bugs 被检索与反馈找回。这些字段拼错不会
// 让任何用例变红，只会让包在 registry 上沉默地难找，或装上去才发现宿主不认识它。
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listDeclarations } from "../build-types.mjs";

const pkgDir = path.join(import.meta.dirname, "..");

/**
 * 只在注释与文档里禁的指涉。
 *
 * 「轮次编号」刻意不进门禁。本仓的 `本轮` / `第 N 轮` 绝大多数指的是**会话轮次**这个产品概念
 * （`第一轮消息不支持 fork`、补跑的「下一轮重新计数」），而不是写下这段注释时的工作轮次。
 * 两种含义在中文里同形，机器分不开；要禁只能靠逐条人工判断，那不是门禁能做到的事。
 *
 * 绝对路径那一条要求路径段以字母数字开头，所以注释里的占位写法（`<home>`、`~someone/x`）不
 * 命中——那是说明而非泄漏。真账号名会被构建器原样搬进随包发布的 `host.js`，那才是这一条要的。
 */
const FORBIDDEN_IN_COMMENTS: readonly RegExp[] = [
  /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/u,
  /\/(?:Users|home)\/[A-Za-z0-9._-]+/u,
  /\bitem[ _-]?[0-9]+/iu,
  /用户裁决/u,
  /评审修复/u,
  /依据.{0,6}取证/u,
  /计划\s*[「《]/u,
  /已退役/u,
];

/** `publishConfig` 里唯一允许出现的字段：可见性与源，都不是入口面。 */
const ALLOWED_PUBLISH_CONFIG = new Set(["access", "registry"]);

/** 遍历时跳过的目录：依赖、产物、以及本门禁刻意不管的面。 */
const SKIP_DIRS = new Set([
  "node_modules",
  "coverage",
  "_env",
  "dist",
  ".git",
  // 测试夹具里的日期与轮次编号是数据，不是注释噪音。
  "test",
  "tests",
  "__tests__",
  // 角色文档库：那里的日期是内容（例如下一份威胁报告的时间线）。
  "agents",
]);

/** package.json 里与入口面有关的形状；其余字段本门禁不关心。 */
interface Manifest {
  readonly main?: string;
  readonly types?: string;
  readonly exports?: Record<string, unknown>;
  readonly files?: readonly string[];
  readonly publishConfig?: Record<string, unknown>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly name?: string;
  readonly license?: string;
  readonly keywords?: readonly string[];
  readonly homepage?: string;
  readonly bugs?: { readonly url?: string };
  readonly repository?: { readonly type?: string; readonly url?: string };
  readonly engines?: Record<string, string>;
  readonly dsh?: {
    readonly manifestVersion?: number;
    readonly bundle?: { readonly patch?: string };
    readonly client?: { readonly platform?: string; readonly immediately?: boolean };
  };
}

/** 一条 `files` 模式的两种形态。 */
type PatternShape =
  /** 目录或后缀模式：列该目录（可递归）下以 `extension` 结尾的文件。 */
  | { readonly kind: "glob"; readonly dir: string; readonly extension: string }
  /** 精确文件名：带点号又无通配的条目是**文件名**（`host.js`），不是后缀过滤。 */
  | { readonly kind: "exact"; readonly file: string };

/**
 * 把 `files` 的一条模式归类。本仓实际用到的只有三种写法：裸文件名、目录名、`dir/*.ext`。
 *
 * 「精确文件名」这一档不能和后缀过滤混为一谈：把 `host.js` 当成 `.js` 后缀过滤，于是
 * `files` 里列的每个构建产物都匹配不上任何条目——`files` 覆盖这道断言的集合会空掉，门禁
 * 自己先失效。实测报出来是「main 指向 host.js，但它不在 files 覆盖范围内」。
 *
 * @param entry - `files` 数组里的一项
 * @returns 该模式要列的目录与后缀过滤，或一个精确文件名
 */
function shapeOf(entry: string): PatternShape {
  const dot = entry.lastIndexOf(".");
  const star = entry.indexOf("*");
  if (star !== -1) {
    return {
      kind: "glob",
      dir: entry.slice(0, star).replace(/\/$/u, ""),
      extension: entry.slice(dot),
    };
  }
  if (!entry.includes(".")) {
    return { kind: "glob", dir: entry, extension: "" };
  }
  return { kind: "exact", file: entry };
}

/**
 * 按 `files` 模式列出包内确实存在的文件（相对包根、`/` 分隔）。
 *
 * @param shape - 见 {@link shapeOf}
 * @returns 命中的文件清单
 */
async function expand(shape: PatternShape): Promise<string[]> {
  if (shape.kind === "exact") {
    return existsSync(path.join(pkgDir, shape.file)) ? [shape.file] : [];
  }
  const names = await readdir(path.join(pkgDir, shape.dir), { recursive: shape.dir !== "." });
  return names
    .map((name) => name.split(path.sep).join("/"))
    .filter((name) => shape.extension === "" || name.endsWith(shape.extension))
    .map((name) => path.posix.join(shape.dir, name));
}

/**
 * 递归收集一条 `exports` 值里的具体目标文件。通配条目（值含 `*`）没有可验证的固定文件。
 *
 * @param value - `exports` 里某一键的值（字符串或条件对象）
 * @returns 该条目要求存在的包内路径
 */
function filesOf(value: unknown): string[] {
  if (typeof value === "string") {
    return value.includes("*") ? [] : [value];
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap((nested) => filesOf(nested));
  }
  return [];
}

/** 入口目标的相对形态（去掉 `./` 前缀）。 */
function asRelative(target: string): string {
  return target.replace(/^\.\//u, "");
}

/**
 * manifest 里全部需要落地的入口文件：main、types 与每个 exports 具体目标。
 *
 * @param manifest - 解析后的 package.json
 * @returns 目标清单，每项带来源标签以便失败时点名
 */
function entryFiles(manifest: Manifest): readonly { label: string; file: string }[] {
  const flat = Object.entries(manifest.exports ?? {}).flatMap(([specifier, value]) =>
    filesOf(value).map((file) => ({ label: specifier, file })),
  );
  const scalars = [
    ...(typeof manifest.main === "string" ? [{ label: "main", file: manifest.main }] : []),
    ...(typeof manifest.types === "string" ? [{ label: "types", file: manifest.types }] : []),
  ];
  return [...scalars, ...flat];
}

/**
 * 发布器无条件附带的文件：不受 `files` 约束，也不该由门禁去断言它在 `files` 里。
 *
 * 这份清单是 `npm pack --dry-run` 实测出来的，不是照抄文档口径：`package.json`、`LICENSE` 与
 * 任何 `README*`（`README.zh-CN.md` 也算）无条件进 tarball，而 `CHANGELOG.md` **不在**其中——
 * 把它从 `files` 里删掉，tarball 里就真没有它。名字越像「标准文档」越容易以为它自然会被带上，
 * 于是漏写进 `files` 也没人发现：registry 页面看不出任何异常，只有真去找那份文件的人会撞到。
 * 下面的「包根每份 .md 都在发布面」把这一类一次性封住，不靠这份清单枚举得完整。
 */
const ALWAYS_SHIPPED = ["package.json", "README.md", "README.zh-CN.md", "LICENSE"];

/** 声明入口：`types` 字段与 `exports["."].types` 都指向它，宿主侧的类型面由它落地。 */
const DECLARATION_ENTRY = "types/host.d.ts";

/**
 * 仓库归属（`<owner>/<repo>`）：homepage、bugs、repository 三条 URL 都由它对照。
 *
 * 四处各写一遍是漂移的温床（换 owner 时最容易漏 bugs.url），所以这里留唯一真源。
 * npm 名不从这里派生：registry 的作用域一律小写（`@jayyuen66`），而 GitHub 的 owner 大小写
 * 混用（`JayYuen666`），把两者绑成同一个常量会让其中一边写成错的字面量。
 */
const REPO_SLUG = "JayYuen666/dsh-session-rescue";

/** 发布名：与 `REPO_SLUG` 的仓库段同名，作用域按 npm 的小写规矩单独写。 */
const PKG_NAME = "@jayyuen66/dsh-session-rescue";

/**
 * 源码后缀判定：`.d.ts` 是**产物**不是源码。
 *
 * `types/host.d.ts` 由 `build:types` 从 TS 源码 emit 出来，与 `host.js` 同为构建结果；直接写
 * `/\.tsx?$/u` 会把声明一并判成源码，于是补上 `types` 入口后这道门自己先红。负向后顾只放过
 * 声明，`host.ts` / `lib/x.ts` 指进来照样红。
 */
const SOURCE_SUFFIX = /(?<!\.d)\.tsx?$/u;

/**
 * 读 manifest 与它应当发出去的文件清单。
 *
 * @returns manifest 本体与 `files` 展开后的集合（含发布器无条件附带的件）
 */
async function readSurface(): Promise<{ manifest: Manifest; shipped: Set<string> }> {
  const manifest = JSON.parse(
    await readFile(path.join(pkgDir, "package.json"), "utf8"),
  ) as unknown as Manifest;
  const groups = await Promise.all((manifest.files ?? []).map((entry) => expand(shapeOf(entry))));
  const attached = ALWAYS_SHIPPED.filter((name) => existsSync(path.join(pkgDir, name)));
  return { manifest, shipped: new Set([...groups.flat(), ...attached]) };
}

/**
 * 递归收集该纳入注释门禁的源文件与文档（相对包根、`/` 分隔）。
 *
 * @param dir - 当前目录的绝对路径
 * @param prefix - 相对包根的前缀
 * @returns 命中的文件清单
 */
async function collectSources(dir: string, prefix: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  // 每个条目一个 promise 再一起等：顺序无关，而顺序相关的写法（循环里 await）在这里既
  // 慢又没有对应的正确性理由——收集的是文件名集合，先返回谁都一样。
  const groups = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          return [];
        }
        const nested = await collectSources(path.join(dir, entry.name), `${prefix}${entry.name}/`);
        return nested;
      }
      if (/\.(?:ts|tsx|mjs|yml|md)$/u.test(entry.name)) {
        return [`${prefix}${entry.name}`];
      }
      return [];
    }),
  );
  return groups.flat();
}

/**
 * 取一段文本里属于注释或文档的行。文档（`.md`）整体算；代码只取注释行，免得把字符串
 * 字面量里的数据（日期夹具、示例路径）误判成注释噪音。
 *
 * @param file - 相对包根的文件名，用于决定判定口径
 * @param text - 文件全文
 * @returns 参与门禁的行
 */
function commentLines(file: string, text: string): string[] {
  if (file.endsWith(".md")) {
    return text.split("\n");
  }
  return text.split("\n").filter((line) => /^\s*(?:\/\/|\/\*|\*|#)/u.test(line));
}

describe("发布形态", () => {
  it("files 覆盖全部入口目标（换个发布器也不会发出悬空入口）", async () => {
    const { manifest, shipped } = await readSurface();
    const targets = entryFiles(manifest);
    expect(targets.length, "入口面不该是空的").toBeGreaterThan(0);
    for (const target of targets) {
      expect(
        shipped.has(asRelative(target.file)),
        `${target.label} 指向 ${target.file}，但它不在 files 覆盖范围内`,
      ).toBe(true);
    }
  });

  it("入口一律指向构建产物，源码目录不参与发布", async () => {
    const { manifest } = await readSurface();
    for (const target of entryFiles(manifest)) {
      expect(target.file, `${target.label} 不该指源码`).not.toMatch(SOURCE_SUFFIX);
    }
  });

  it("publishConfig 只留可见性与源，不留入口覆盖", async () => {
    const { manifest } = await readSurface();
    for (const key of Object.keys(manifest.publishConfig ?? {})) {
      expect(ALLOWED_PUBLISH_CONFIG.has(key), `publishConfig.${key} 会被 npm 忽略`).toBe(true);
    }
  });

  it("包根的每一份 .md 都在发布面里（npm 只自动附带 README* 与 LICENSE）", async () => {
    // 一次性封住这一类陷阱，而不是每加一份文档就补一条断言：文档名字越像「npm 自然会带上」，
    // 漏写进 `files` 就越安静——registry 页面看不出任何异常，只有真去找那份文件的人会发现它不在。
    const { shipped } = await readSurface();
    const docs = readdirSync(pkgDir)
      .filter((name) => name.endsWith(".md"))
      .toSorted();
    expect(docs.length, "包根至少该有一份 .md").toBeGreaterThan(0);
    for (const doc of docs) {
      expect(shipped.has(doc), `${doc} 不在发布面：写进 files，或确认它本就不该随包发`).toBe(true);
    }
  });

  it("声明入口存在，且 types/ 真的产出了声明文件", async () => {
    // 存在性锚点：`types` 指向的文件若不在，npm 页面与 tsserver 都只会静默退化成「无类型
    // 模块」，没有任何运行期信号——这类故障只能在这里钉住。
    expect(existsSync(path.join(pkgDir, DECLARATION_ENTRY)), `${DECLARATION_ENTRY} 不存在`).toBe(
      true,
    );
    const produced = await listDeclarations(path.join(pkgDir, "types"), "");
    expect(produced.length, "types/ 至少该产出一个声明文件").toBeGreaterThan(0);
  });

  it("声明不比它派生的源码旧（types 不能停在上一版源码上）", async () => {
    // 声明由 build-types.mjs 从 host.ts 与 lib/*.ts emit 出来，所以「声明过期」的**充要**表现就是
    // 这批输入里至少有一个比声明新——build:types 没跑，或跑了但失败。不按导出名比：那要先
    // import 产物，于是这道门反过来依赖 build 已经跑过，而单跑 `vitest` 时产物可能不存在。
    const declaredAt = statSync(path.join(pkgDir, DECLARATION_ENTRY)).mtimeMs;
    const sources = [
      "host.ts",
      ...readdirSync(path.join(pkgDir, "lib"))
        .filter((name) => name.endsWith(".ts"))
        .map((name) => path.join("lib", name)),
    ];
    const stale = sources.filter((rel) => statSync(path.join(pkgDir, rel)).mtimeMs > declaredAt);
    expect(
      stale,
      `types/ 比这些源文件旧：${stale.join("、")}——请运行 npm run build:types`,
    ).toStrictEqual([]);
  });

  it("声明产物不含本机绝对路径或包管理器内部路径", async () => {
    // 声明会原样进 tarball，而 tsc 常把 rootDir 之外解析到的真实路径写进类型里
    // （`typeof import("/Users/…/node_modules/…")`）。那是构建机的家目录，不该发出去；
    // `.pnpm/` 是 pnpm 的内容寻址目录名，出现即说明类型从硬链接路径解析来，消费方在自己
    // 机器上解析不到。
    const produced = await listDeclarations(path.join(pkgDir, "types"), "");
    const forbidden: readonly RegExp[] = [/\/(?:Users|home)\//u, /\.pnpm[\\/]/u];
    const texts = await Promise.all(
      produced.map(async (file) => ({
        file,
        text: await readFile(path.join(pkgDir, "types", file), "utf8"),
      })),
    );
    for (const { file, text } of texts) {
      for (const pattern of forbidden) {
        expect(pattern.test(text), `types/${file} 命中 ${pattern}`).toBe(false);
      }
    }
  });

  it("声明里的相对说明符都指向产物后缀（消费方才解析得到）", async () => {
    // build-types.mjs 的存在理由：源码按 NodeNext 写 `./lib/x.ts`，tsc 会把说明符原样抄进
    // .d.ts，而包里没有 `lib/x.ts`（只有 `types/lib/x.d.ts`）。留着 `.ts` 后缀，消费方解析
    // `types/host.d.ts` 就指向一个不存在的文件。
    const produced = await listDeclarations(path.join(pkgDir, "types"), "");
    const texts = await Promise.all(
      produced.map(async (file) => ({
        file,
        text: await readFile(path.join(pkgDir, "types", file), "utf8"),
      })),
    );
    for (const { file, text } of texts) {
      expect(
        /from\s+["']\.{1,2}\/[^"']*\.ts["']/u.test(text),
        `types/${file} 的相对说明符仍指源码 .ts：请运行 npm run build:types`,
      ).toBe(false);
    }
  });
});

/**
 * 宿主包在 peer 与 dev 两张表里的并集。`dependencies` 是禁区（见下面那条门禁）：peer 记录
 * 「运行期由宿主提供」，dev 记录「本包编译与测试要用它」，两者都不会被消费方的 profile 安装。
 * 同名键以 peer 表为准，那才是消费方环境里真正提供的那一枚。
 * @param manifest - 解析后的 package.json
 * @returns 宿主包名到版本区间
 */
function hostRanges(manifest: Manifest): Record<string, string> {
  return { ...manifest.devDependencies, ...manifest.peerDependencies };
}

describe("宿主依赖的版本形状（升级防线）", () => {
  it("@deepseek-ai/* 一律不进 dependencies：装出去会在宿主进程里物化第二份", async () => {
    // 钉的是「全绿但宿主瘫痪」这一类坑，别把它当风格偏好，更别把它「恢复」回去。本插件装进
    // 消费方 profile 的 pnpm 配置是 `nodeLinker: hoisted` 且 `autoInstallPeers: false`，所以
    // `dependencies` 里每一枚 @deepseek-ai/* 都会被落成**真实目录**，与宿主进程已经加载的那份
    // 并存在一起。而 `@deepseek-ai/dsh-tools` 的 TOOL_RUNTIME_SCHEDULER 是普通 Symbol（不是
    // Symbol.for），符号身份按模块实例计算：宿主的 dsh-agent-loop 用自己那份的 Symbol 去读
    // 由 profile 副本挂载出来的 ToolRuntime，得到 undefined，于是 `.prepare(...)` 在**每一次**
    // 原生工具调用上抛 "Cannot read properties of undefined (reading 'prepare')"，整个 profile
    // 的工具一起失效。构建、类型检查与本包测试在此之前全部照绿，判据只能落在 manifest 面上。
    // 本包确有两枚宿主包是运行期值导入（host.js 值导入 dsh-brand 与 schemastery），但它们落
    // peer 就够了：说明符由宿主那一份解析，peer 与 dev 都不进 profile。
    const { manifest } = await readSurface();
    const leaked = Object.keys(manifest.dependencies ?? {}).filter((name) =>
      name.startsWith("@deepseek-ai/"),
    );
    expect(leaked, "这些宿主包会随本包装进 profile，物化出第二份实例").toStrictEqual([]);
  });

  it("dsh-* 家族一律精确钉，不留任何范围算子", async () => {
    // registry 上的 dist-tag 是实测出来的陷阱：`latest` 可能指向远早于宿主 ABI 的版本。
    // 精确钉是让「不带版本地装成远古版本」这件事不可能发生的最小条件；一旦放宽成 `^`/`~`，
    // 宿主某天发新 minor 就会自动跟上去，而插件与宿主 ABI 耦合，那等于让消费方在没有测试的
    // 情况下换掉宿主类型面。宿主包现居 peer 与 dev（见上面那条门禁），所以取并集来判。
    const { manifest } = await readSurface();
    // 过滤出违规项再一次性断言，而不是在循环里按条件 expect：失败时 diff 直接列出
    // 「哪个包钉成了什么」，比逐条抛错更好读。
    const ranged = Object.entries(hostRanges(manifest)).filter(
      ([name, range]) => name.startsWith("@deepseek-ai/dsh-") && !/^\d+\.\d+\.\d+-/u.test(range),
    );
    expect(ranged, "这些 dsh-* 依赖没有精确钉住版本").toStrictEqual([]);
  });

  it("dsh-* 全部与 peer 的 dsh 同版本（不许装出第二份宿主类型）", async () => {
    // 宿主类型面被这些包以 type-only 方式消费；同一个会话里出现两个 dsh-session 的拷贝，
    // nominal 类型（品牌串、投影状态）会开始互相不认，而那不报编译错、只报运行期
    // 「认不出这个 callId」。同版本是让这件事不发生的最小条件。判面同样取 peer ∪ dev。
    const { manifest } = await readSurface();
    const peer = manifest.peerDependencies?.["@deepseek-ai/dsh"];
    expect(peer, "peer 依赖缺失：宿主版本就失去基准了").toBeDefined();
    const hostVersion = (peer ?? "").replace(/^[\^~]/u, "");
    const drifted = Object.entries(hostRanges(manifest)).filter(
      ([name, range]) => name.startsWith("@deepseek-ai/dsh-") && range !== hostVersion,
    );
    expect(drifted, "这些 dsh-* 与宿主 dsh 不同版本").toStrictEqual([]);
  });
});

describe("registry 与宿主发现面", () => {
  it("包名、可见性与许可三者齐备（scope 写错就是发不出去或发到错的位置）", async () => {
    const { manifest } = await readSurface();
    expect(manifest.name, "缺 name 或写错了作用域").toBe(PKG_NAME);
    expect(REPO_SLUG.split("/")[1], "仓库名与发布名不同名：改名要同时改这两处").toBe(
      PKG_NAME.split("/")[1],
    );
    expect(manifest.publishConfig?.["access"], "public 包缺 publishConfig.access").toBe("public");
    expect(manifest.license, "缺 license：registry 页面与法律面都要它").toBe("MIT");
  });

  it("keywords 全小写、去重且带上宿主生态名（检索面拼错只会沉默地少人找到）", async () => {
    const { manifest } = await readSurface();
    const keywords = manifest.keywords ?? [];
    expect(keywords.length, "keywords 不能为空：registry 检索只认它和 description").toBeGreaterThan(
      0,
    );
    const malformed = keywords.filter((word) => word !== word.toLowerCase() || word.trim() === "");
    expect(malformed, "这些 keyword 不是小写或含空白").toStrictEqual([]);
    const duplicated = keywords.filter((word, index) => keywords.indexOf(word) !== index);
    expect(duplicated, "keywords 有重复项").toStrictEqual([]);
    for (const required of ["dsh", "plugin"]) {
      expect(keywords, `keywords 少了 ${required}`).toContain(required);
    }
  });

  it("homepage / bugs / repository 指向同一个仓（三条各写一处迟早漂）", async () => {
    const { manifest } = await readSurface();
    expect(manifest.repository?.type, "repository.type 该是 git").toBe("git");
    // 三条 URL 分属两种形状（bugs 是个对象），先摊平成 [标签, 值] 再统一断言：写三遍
    // 「取出来看它含不含仓库归属」的话，改一处漏两处，就只剩一条门在管这件事。
    const urls: readonly (readonly [string, string | undefined])[] = [
      ["repository.url", manifest.repository?.url],
      ["homepage", manifest.homepage],
      ["bugs.url", manifest.bugs?.url],
    ];
    for (const [label, value] of urls) {
      expect(value, `缺 ${label}`).toBeDefined();
      expect(value ?? "", `${label} 应指向 ${REPO_SLUG}`).toContain(REPO_SLUG);
    }
  });

  it("engines 的 node 与 dsh 都在，且 dsh 下界与 peer 同版本", async () => {
    // 宿主装插件时校验的是 peer（`@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`），`engines.dsh`
    // 目前无人读——正因此它更容易被留在旧值上：读它的人（编辑器、文档、以及将来任何工具）
    // 会拿到一个与真判据不一致的下界。钉成同值是让两份说法不能各自成立。
    const { manifest } = await readSurface();
    const peer = manifest.peerDependencies?.["@deepseek-ai/dsh"];
    expect(peer, "peer 缺失：宿主版本失去基准").toBeDefined();
    expect(manifest.engines?.["node"], "缺 engines.node").toBeDefined();
    expect(manifest.engines?.["dsh"], "engines.dsh 要与 peer 的 dsh 同值（去掉范围算子）").toBe(
      `>=${(peer ?? "").replace(/^[\^~]/u, "")}`,
    );
  });

  it("dsh 段齐备：bundle.patch 指向的文件真存在且随包发出", async () => {
    // 宿主靠这一段认出条目（`bundle.patch` 的 insert 条目）与客户端半（`client.platform`）。
    // 少一项不会报错，只会装上去什么都没有——本包一半功能（设置卡/续跑台）在客户端半里。
    const { manifest, shipped } = await readSurface();
    expect(manifest.dsh?.manifestVersion, "缺 dsh.manifestVersion").toBe(1);
    expect(manifest.dsh?.client?.platform, '缺 dsh.client.platform（应为 "web"）').toBe("web");
    expect(manifest.dsh?.client?.immediately, "缺 dsh.client.immediately").toBe(true);
    const patch = manifest.dsh?.bundle?.patch;
    expect(patch, "缺 dsh.bundle.patch").toBeDefined();
    const relative = asRelative(patch ?? "");
    expect(existsSync(path.join(pkgDir, relative)), `dsh.bundle.patch 指向的 ${patch} 不存在`).toBe(
      true,
    );
    expect(shipped.has(relative), `${patch} 不在发布面`).toBe(true);
  });

  it("files 不打包源码面与测试面（发布的是产物，源码由仓库读）", async () => {
    // 与「入口指产物」互补：那条管入口指向，这条管整目录别被顺手带上。`lib` 或 `src` 写进
    // files 会把 TS 源面发出去，消费方 profile 里多出一堆没人解析的文件，而仓库才是源码真源。
    const { manifest } = await readSurface();
    const sources = (manifest.files ?? []).filter(
      (entry) =>
        entry === "src" || entry === "lib" || entry === "test" || SOURCE_SUFFIX.test(entry),
    );
    expect(sources, "这些 files 条目是源码面").toStrictEqual([]);
  });
});

describe("注释与文档没有内部指涉", () => {
  it("源码与文档的注释里没有日期", async () => {
    const collected = await collectSources(pkgDir, "");
    const sources = collected.toSorted();
    expect(sources.length, "至少要扫到源码文件").toBeGreaterThan(0);
    const texts = await Promise.all(
      sources.map(async (file) => ({
        file,
        text: await readFile(path.join(pkgDir, file), "utf8"),
      })),
    );
    for (const entry of texts) {
      for (const line of commentLines(entry.file, entry.text)) {
        for (const pattern of FORBIDDEN_IN_COMMENTS) {
          expect(
            pattern.test(line),
            `${entry.file} 的注释命中内部指涉 ${pattern}：${line.trim().slice(0, 80)}`,
          ).toBe(false);
        }
      }
    }
  });
});
