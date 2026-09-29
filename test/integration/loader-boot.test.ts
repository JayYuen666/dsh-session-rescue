import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

import { buildHost } from "../../build-host.mjs";

// 真实组合测试：用真实的 cordis + cordis-plugin-loader（本包 devDependencies 里的那对，
// 版本与 dsh 自带的同一份：cordis 4.0.2 / loader 1.0.3，且 loader 把 cordis 声明为 peer，
// 两边解析到同一实例）组装会话：
// - session-rescue 的 host 半边由 Loader 走 Node 原生 import 载入（源码态 .ts 副本
//   + 发布态 .js 产物各测一次，见下方 fixture 注释）
// - 其余宿主服务（settings/timer/agents/webServer）用最基本的 provide 替身，
//   保持"非产品服务全 mock、插件本体全真实"的 dsh 测试纪律。
// 这验证的是"产品可见插件走真实 Loader 组合"，而不只是手搓 ctx.plugin。
// 走依赖解析而不是写死某个安装位置：单包仓的 CI 装的是 node_modules 里这一对，
// 写死 /opt/homebrew/... 就只能在这台机器上跑（实测 CI 因此整条 suite 红）。

const CORDIS_ENTRY = createRequire(import.meta.url).resolve("@deepseek-ai/cordis");
const LOADER_ENTRY = createRequire(import.meta.url).resolve("@deepseek-ai/cordis-plugin-loader");
const PKG_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const HOST_TS = path.join(PKG_ROOT, "host.ts");

/** 本包在 Loader 里的条目 id（= 隐式 settings 命名空间，真源是 cordis.patch.yml 的裸
 *  `- id:`）：建条目与按 id 找 fiber 两侧必须是同一个串，测试侧按期望值自持。 */
const PLUGIN_ENTRY_ID = "session-rescue";
/** 宿主事件名：瞬时失败与回合终态两条驱动续跑的事件。 */
const AGENT_ERROR_EVENT = "agent/error";
const AGENT_STATUS_EVENT = "agent/status";

// 装载对象是 host 的**逐字节副本**，连同它的相对依赖一起放在 .tmp/ 下（既不在
// vitest 的 coverage.include 里，也只在测试期间存在，故不会被 lint/fmt/tsc 看见）。
// 为什么不能直接装载 host.ts 本体：同一份文件若既被 vite 变换载入（单测）、又被
// cordis loader 走 Node 原生 import 载入，v8 会把两份实例的覆盖记录按偏移合并，
// 真实命中被冲成 0（host.ts 与它 import 的 lib/*.ts 全部受影响），阈值 100 下恒红。
// 本包自己的 `./lib/...` 需要跟着复制（副本相对路径才成立）；跨包依赖已是裸包名
// （@jayyuen666/dsh-plugin-shared/lib/*），由 .tmp/ 向上到本包 node_modules 正常解析，无需搬运。
//
// 两份装载对象各有职责，不是重复：
//   - .tmp/pkg/host.ts：源码态（绝对路径直载 .ts，即 Node 类型剥离那条路）；
//   - .tmp/pkg/host.js：发布态——tarball 里的 publishConfig.exports 把 "." 指到
//     build-host.mjs 的产物，故"真装机跑的是哪一份文件"只有载产物才验得到（内联/残留 ./x.ts 之类的
//     构建回归，源码态测试一律看不见）。产物文本在内存里现建（buildHost() 是纯函数），
//     不依赖磁盘上那份 gitignored host.js；本机 link: 装法解析到的仍是 host.ts 源码，
//     所以这条用例覆盖的正是本机日常跑不到的那一面。
const FIXTURE_DIR = path.join(PKG_ROOT, ".tmp");
const FIXTURE_PKG = path.join(FIXTURE_DIR, "pkg");
const FIXTURE_HOST = path.join(FIXTURE_PKG, "host.ts");
const FIXTURE_HOST_JS = path.join(FIXTURE_PKG, "host.js");

// 动态导入 .mjs 对 TS 为 any，先收窄到用到的最小面再取成员（避免 no-unsafe-*）。
const CordisMod = (await import(CORDIS_ENTRY)) as { Context: unknown };
const LoaderMod = (await import(LOADER_ENTRY)) as { default: unknown };

interface TestRoute {
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void;
}

interface TimerEntry {
  fn: () => void;
  ms: number;
  cancelled: boolean;
  fired: boolean;
}

/** 极简 ctx 面（本测试只用到的 subset）。 */
interface TestCtx {
  plugin: (plugin: unknown) => Promise<unknown>;
  emit: (name: string, payload: unknown) => void;
  loader: {
    /** `config` 即 profile 条目行的 `config:`（0.1.7 唯一的插件调参入口，
     *  宿主按条目导出的 `Config` 校验并以 `.default()` 填齐）。 */
    create: (options: {
      id: string;
      name: string;
      config?: Record<string, unknown>;
    }) => Promise<string>;
    await: () => Promise<void>;
    /** 条目 fiber：本文件只用到 uid（configure 的 owner 比对键）与 dispose。 */
    entries: () => Iterable<{ id: string; fiber: { uid: unknown } | undefined }>;
  };
  fiber?: { dispose: () => Promise<void> };
}

const CordisContext = CordisMod.Context as new () => TestCtx;
const Loader: unknown = LoaderMod.default;

interface Mount {
  ctx: TestCtx;
  agent: {
    id: string;
    options: { provider: string };
    status: string;
    inbox: { nextTurn?: unknown[]; nextStep?: unknown[] };
    session: {
      id: string;
      evs: unknown[];
      snapshotEvents: () => unknown[];
      header: { cwd: string };
    };
    followup: (message: unknown) => void;
    calls: unknown[];
  };
  timers: TimerEntry[];
  routes: Map<string, TestRoute>;
  /** `settings.configure` 的调用记录（页面策略：0.1.7 本包在 settings 上唯一还调的
   *  写侧方法，且只经 cordis 的注入子上下文被调）。替身少给这个成员时那次调用会抛错，
   *  而**抛错被 cordis 整个吞掉**（实测：删掉假件里的 configure 后本文件六条用例仍全绿），
   *  所以它必须被断言，而不是只被提供。owner 只留 uid（fiber 是代理，标识不可比）。 */
  configureCalls: { presentation: { auto?: boolean }; ownerUid: unknown }[];
  /** 触发所有未到点定时器（模拟时钟到点）。 */
  tick: () => void;
}

/** lesson-loop 总线替身（report/pass 的调用记录面）。 */
interface LessonBus {
  report: (input: Record<string, unknown>) => void;
  pass: (input: Record<string, unknown>) => { ok: boolean };
}

/** 挂载一份真实 Loader 组合的会话。`config` 是**条目行的 config**（0.1.7 唯一的
 *  调参通道：宿主按条目导出的 `Config` 校验它、以 `.default()` 填齐缺省，再把每个
 *  `.volatile()` 字段包成引用交进 `apply(ctx, config)`）——不是塞进 settings 替身，
 *  `settings.register(ns, schema, { base })` 那层底座连同 `settings.get` 都已被宿主
 *  移除。值一律走 `config.<field>.get()`，所以缺省不写时读到的是 schema 默认本身。
 *  bus 缺席（默认）即"宿主没装 lesson-loop"的真实装配线。
 *  hostEntry 决定装载哪一份 host（默认源码态副本；发布态产物见对应用例）。 */
async function mount(
  config: Record<string, unknown> = {},
  bus?: LessonBus,
  hostEntry: string = FIXTURE_HOST,
): Promise<Mount> {
  const timers: TimerEntry[] = [];
  const routes = new Map<string, TestRoute>();
  const calls: unknown[] = [];
  const evs: unknown[] = [];
  const configureCalls: { presentation: { auto?: boolean }; ownerUid: unknown }[] = [];

  const agent = {
    id: "s1",
    options: { provider: "tokenrouter" },
    status: "idle",
    inbox: { nextTurn: [], nextStep: [] },
    session: {
      id: "s1",
      evs,
      snapshotEvents: () => evs,
      header: { cwd: "/work/demo" },
    },
    followup(message: unknown) {
      calls.push(message);
    },
    calls,
  };
  const agentsStore = {
    roots: () => [agent],
    get: (id: string) => (id === "s1" ? agent : undefined),
  };

  // 宿主服务替身（provide 形式；与 loader 条目共享同一根 ctx，注入可见）
  const dependencies = {
    name: "session-rescue-test-deps",
    apply(ctx: {
      provide: (name: string, value: unknown) => void;
      get: (name: string) => unknown;
      [key: string]: unknown;
    }) {
      // settings 服务替身：只给 0.1.7 还剩下的那一面（installed
      // dsh-settings/lib/types/index.d.ts：configure:80 / describe:96 / mutate:114；
      // `register`/`get`/`installSection` 已被宿主移除，命名空间改按条目 id 隐式注册）。
      // apply 的宿主契约守卫点名校验 describe/mutate，configure 由注入子上下文调用。
      ctx.provide("settings", {
        // 本包不读自己的表单：跨命名空间读的**唯一**入口。回 []＝没有任何条目被
        // 投影（含官方 locale）→ host 注入文案走中文默认。
        describe: () => [],
        mutate: async (): Promise<void> => undefined,
        // `owner` 按官方面声明成可选位（installed dsh-settings/lib/types/index.d.ts:80-82
        // `configure(presentation, owner?: Fiber)`，文档明写「defaults to the calling
        // fiber」）：本替身原先把它写成必选，是替身在说谎。守卫 `owner?.uid` 保留。
        configure: (presentation: { auto?: boolean }, owner?: { uid?: unknown }) => {
          // 页面策略登记（本包自带卡片 → auto:false）；记录调用供断言（见 Mount）。
          // 只留 uid：fiber 是 cordis 代理，对象标识不可比，且失败信息会踩上
          // 代理属性读取的 pretty-format 坑（实测 `cannot get property "$$typeof" without inject`）。
          configureCalls.push({ presentation, ownerUid: owner?.uid });
          return () => {
            // 替身无收尾资源。
          };
        },
      });
      ctx.provide("timer", {
        timeout(fn: () => void, ms: number) {
          const entry: TimerEntry = { fn, ms, cancelled: false, fired: false };
          timers.push(entry);
          return () => {
            entry.cancelled = true;
          };
        },
      });
      ctx.provide("agents", agentsStore);
      ctx.provide("webServer", {
        register(route: TestRoute) {
          routes.set(route.path, route);
          return () => routes.delete(route.path);
        },
      });
      // lesson-loop 总线：仅在用例显式要「已遵守」观测时装上（默认缺席，
      // 与没装 lesson-loop 的宿主一致）。
      if (bus !== undefined) {
        ctx.provide("lessonLoop", bus);
      }
    },
  };

  const ctx = new CordisContext();
  await ctx.plugin(dependencies);
  await ctx.plugin(Loader);
  // 条目 id == settings 命名空间（隐式注册；见 cordis.patch.yml 的裸 id）。
  await ctx.loader.create({ id: PLUGIN_ENTRY_ID, name: hostEntry, config });
  await ctx.loader.await();

  return {
    ctx,
    agent,
    timers,
    routes,
    configureCalls,
    tick() {
      for (const timerEntry of timers) {
        if (!timerEntry.fired && !timerEntry.cancelled) {
          timerEntry.fired = true;
          timerEntry.fn();
        }
      }
    },
  };
}

/** 条目确实经 Loader 激活（Node 原生 import + 类型剥离路径可用）。 */
function assertLoaded(inst: Mount): void {
  const rescue = [...inst.ctx.loader.entries()].find((entry) => entry.id === PLUGIN_ENTRY_ID);
  expect(rescue?.fiber).toBeDefined();
}

function turnEnd(turn: number, kind: string): unknown {
  return { type: "turn/end", seq: turn * 10, time: turn * 10, data: { turn, reason: { kind } } };
}

describe("加载 session-rescue host（真实 Loader 组合：源码副本 + 发布产物）", () => {
  // 夹具的建/删在本套件的全部用例之外各跑一次（原先挂在文件顶层，vitest 的结构类规则
  // 判它"用例与 hook 不在 describe 里"；本文件只有这一个顶层套件，移进来作用面不变）。
  beforeAll(async () => {
    await mkdir(path.join(FIXTURE_PKG, "lib"), { recursive: true });
    await cp(HOST_TS, FIXTURE_HOST);
    await cp(path.join(PKG_ROOT, "lib"), path.join(FIXTURE_PKG, "lib"), { recursive: true });
    await writeFile(FIXTURE_HOST_JS, await buildHost(), "utf8");
  });

  let live: TestCtx | undefined;
  afterEach(async () => {
    await live?.fiber?.dispose();
    live = undefined;
    // 冷却用例 fake 过 Date（见下），每条用例后放回真实时钟。
    vi.useRealTimers();
  });

  afterAll(async () => {
    await rm(FIXTURE_DIR, { recursive: true, force: true });
  });

  it("loader 原生载入 host.ts：注入等待、事件驱动续跑、路由注册", { timeout: 30_000 }, async () => {
    const inst = await mount();
    live = inst.ctx;
    assertLoaded(inst);

    // 页面策略：0.1.7 的 settings 只剩 configure 这条写侧方法，且它只在
    // `svc.inject(['settings'], child => child.effect(() => child.settings.configure(...)))`
    // 的注入子上下文里被调。这条链在真实 cordis 下必须真的走通——假件里删掉
    // configure 时那次调用会抛错，而**抛错被 cordis 静默吞掉、六条用例全绿**（实测），
    // 所以这里点名断言：恰好一次、presentation 是 { auto: false }、owner 是本条目 fiber。
    expect(inst.configureCalls).toHaveLength(1);
    expect(inst.configureCalls[0]?.presentation).toStrictEqual({ auto: false });
    // owner 比 fiber.uid，不比 fiber 对象本身：cordis 交出的 ctx/fiber 是代理，
    // 不同调用点拿到的对象标识并不保证相同（直接 toBe 必然不等，失败信息还会踩上
    // 代理属性读取的 pretty-format 坑）。uid 才是宿主自己的身份键。
    const rescueFiberUid = [...inst.ctx.loader.entries()].find(
      (entry) => entry.id === PLUGIN_ENTRY_ID,
    )?.fiber?.uid;
    expect(rescueFiberUid, "比对基准：条目 fiber 必须有 uid").toBeDefined();
    expect(
      inst.configureCalls[0]?.ownerUid,
      "owner 必须是本插件 fiber（缺省是 settings 服务自己的 fiber，传错等于给别人的页面定策略）",
    ).toBe(rescueFiberUid);

    // 事件驱动：瞬时失败 → 定时器武装 → 触发 → followup 发出
    inst.ctx.emit(AGENT_ERROR_EVENT, {
      agent: inst.agent,
      turn: 1,
      step: 1,
      error: { failure: { code: "RATE_LIMIT", message: "x" } },
    });
    expect(inst.timers).toHaveLength(1);
    // 10_000 既不是本用例写的、也不是替身写的：0.1.7 交进 apply 的是 cordis 按条目
    // `Config` 解析出的 volatile 引用，本用例 config 传空 → 这一读到的就是 schema 的
    // `.default(10_000)`（旧替身那份手写 baseSettings 表随 `settings.register` 一起删了）。
    // 因此这条断言现在真正在测「内置默认有没有被静默丢弃」，而不是自己喂给自己。
    expect(inst.timers[0]?.ms).toBe(10_000);

    inst.tick();
    expect(inst.agent.calls).toHaveLength(1);
    expect((inst.agent.calls[0] as { role?: string }).role).toBe("user");

    // host apply 的 ctx.effect 内注册的 webServer 路由
    expect(inst.routes.has("/_dsh/session-rescue/state")).toBe(true);
    expect(inst.routes.has("/_dsh/session-rescue/cancel")).toBe(true);
    expect(inst.routes.has("/_dsh/session-rescue/toggle")).toBe(true);

    // 非瞬时失败 → 不武装
    const before = inst.timers.length;
    inst.ctx.emit(AGENT_ERROR_EVENT, {
      agent: inst.agent,
      turn: 2,
      step: 1,
      error: { failure: { code: "CONTEXT_WINDOW_EXCEEDED", message: "too long" } },
    });
    expect(inst.timers).toHaveLength(before);
  });

  it(
    "发布态产物 host.js：真实 Loader 同样载得动，路由与续跑行为一致",
    { timeout: 30_000 },
    async () => {
      // 装载对象换成 build-host.mjs 现建的产物：装机后 dsh 按包名解析到的就是这份
      // 文件（publishConfig.exports），源码态测试盖不住它的回归（依赖被内联、./x.ts 残留、
      // 默认导出在打包中丢失——任一条都让真装机直接起不来）。
      const inst = await mount({}, undefined, FIXTURE_HOST_JS);
      live = inst.ctx;
      assertLoaded(inst);

      // host apply 的 ctx.effect 内注册的 webServer 路由（产物里同样在）
      expect(inst.routes.has("/_dsh/session-rescue/state")).toBe(true);
      expect(inst.routes.has("/_dsh/session-rescue/cancel")).toBe(true);
      expect(inst.routes.has("/_dsh/session-rescue/toggle")).toBe(true);

      // 事件驱动链在产物形态下等价：瞬时失败 → 定时器武装 → 触发 → followup 发出
      inst.ctx.emit(AGENT_ERROR_EVENT, {
        agent: inst.agent,
        turn: 1,
        step: 1,
        error: { failure: { code: "RATE_LIMIT", message: "x" } },
      });
      expect(inst.timers).toHaveLength(1);
      inst.tick();
      expect(inst.agent.calls).toHaveLength(1);
      expect((inst.agent.calls[0] as { role?: string }).role).toBe("user");
    },
  );

  it("真实 Loader 下：待办未闭合的 completed 回合触发补跑", { timeout: 30_000 }, async () => {
    // 不调任何参：会话的第一次 fire 永远不在冷却里（调度器的判据是
    // `lastFireAt > 0 && now - lastFireAt < cooldownMs`，新记录的 lastFireAt 是 0），
    // 旧替身那句 `unfinishedCooldownMs: 0` 本来就是空操作——而且 0 在 0.1.7 过不了
    // Config 校验（`.min(5000)`，实测 `invalid config: $.unfinishedCooldownMs ...`）。
    const inst = await mount();
    live = inst.ctx;
    assertLoaded(inst);

    inst.agent.session.evs.push(
      { type: "turn/start", seq: 1, time: 1, data: { turn: 4 } },
      {
        type: "todo/write",
        seq: 2,
        time: 2,
        data: {
          todos: [
            { content: "a", status: "completed" },
            { content: "b", status: "in_progress" },
          ],
        },
      },
      turnEnd(4, "completed"),
    );
    inst.ctx.emit(AGENT_STATUS_EVENT, { agent: inst.agent, status: "idle" });
    expect(inst.timers).toHaveLength(1);
    // unfinishedDelayMs
    expect(inst.timers[0]?.ms).toBe(5000);

    inst.tick();
    expect(inst.agent.calls).toHaveLength(1);
    const text = String((inst.agent.calls[0] as { content: { text: string }[] }).content[0]?.text);
    // 必须发的是"清单未闭合"这一种文案，而不是被当成瞬时失败续跑文案
    expect(text).toContain("任务清单");
    expect(text).not.toContain("瞬时失败");
  });

  it("真实 Loader 下：成功回合重置配额，满额后仍可持续续跑", { timeout: 30_000 }, async () => {
    // 冷却只能压到 Config schema 的下限（host.ts configSchema：`resumeCooldownMs`
    // `.min(5000)`）。0.1.7 起行 config 先过 `Config` 校验才交进 apply
    // （vendor/cordis fiber.ts 的 resolveConfig；实测传 0 时条目直接挂不上，报
    // `invalid config: $.resumeCooldownMs expected number >= 5000 but got 0`），
    // 旧替身那句 `resumeCooldownMs: 0` 从此不再可表达。于是本用例把冷却按到下限、
    // 逐次跨过它（只 fake Date：定时器仍由本用例的 tick() 驱动，冷却读的是 Date.now）——
    // 冷却闸门照旧生效，用例考察的仍是配额。起始时刻取真实量级的纪元而不是 0：
    // 从 0 起跳会让 `lastFireAt > 0` 这条「从未 fire 过」判据把冷却整个抹掉。
    const resumeCooldownMs = 5000;
    const START_EPOCH_MS = 1_760_000_000_000;
    const inst = await mount({ resumeCooldownMs });
    live = inst.ctx;
    assertLoaded(inst);

    vi.useFakeTimers({ toFake: ["Date"] });
    let now = START_EPOCH_MS;
    vi.setSystemTime(now);
    const pastCooldown = (): void => {
      now += resumeCooldownMs + 1;
      vi.setSystemTime(now);
    };

    // 打满 3 次 resume（maxResumes 取 schema 默认 3，本用例不再自己喂表）
    for (let i = 1; i <= 3; i += 1) {
      inst.agent.session.evs.length = 0;
      inst.agent.session.evs.push(turnEnd(i, "error"));
      inst.ctx.emit(AGENT_ERROR_EVENT, {
        agent: inst.agent,
        turn: i,
        step: 1,
        error: { failure: { code: "RATE_LIMIT", message: "x" } },
      });
      inst.tick();
      pastCooldown();
    }
    expect(inst.timers).toHaveLength(3);

    // 第 4 次：配额已满 → 不再武装（修复前这就是永久静默到重启）
    inst.agent.session.evs.length = 0;
    inst.agent.session.evs.push(turnEnd(4, "error"));
    inst.ctx.emit(AGENT_ERROR_EVENT, {
      agent: inst.agent,
      turn: 4,
      step: 1,
      error: { failure: { code: "RATE_LIMIT", message: "x" } },
    });
    expect(inst.timers).toHaveLength(3);

    // 一次 completed 回合 → 配额恢复 → 第 6 轮失败可再续跑
    inst.agent.session.evs.length = 0;
    inst.agent.session.evs.push(turnEnd(5, "completed"));
    inst.ctx.emit(AGENT_STATUS_EVENT, { agent: inst.agent, status: "idle" });
    inst.agent.session.evs.length = 0;
    inst.agent.session.evs.push(turnEnd(6, "error"));
    inst.ctx.emit(AGENT_ERROR_EVENT, {
      agent: inst.agent,
      turn: 6,
      step: 1,
      error: { failure: { code: "RATE_LIMIT", message: "x" } },
    });
    expect(inst.timers).toHaveLength(4);
  });

  it(
    "真实 Loader 下：瞬时失败后同 provider 的成功回合兑出一条 lesson-loop pass",
    { timeout: 30_000 },
    async () => {
      const reports: Record<string, unknown>[] = [];
      const passes: Record<string, unknown>[] = [];
      const inst = await mount(
        {},
        {
          report: (input) => {
            reports.push(input);
          },
          pass: (input) => {
            passes.push(input);
            return { ok: true };
          },
        },
      );
      live = inst.ctx;
      assertLoaded(inst);

      inst.agent.session.evs.push(turnEnd(1, "error"));
      inst.ctx.emit(AGENT_ERROR_EVENT, {
        agent: inst.agent,
        turn: 1,
        step: 1,
        error: { failure: { code: "RATE_LIMIT", message: "429 too many requests" } },
      });
      expect(reports).toHaveLength(1);
      expect(reports[0]?.["category"]).toBe("transient-failure");
      expect(passes).toHaveLength(0);

      inst.agent.session.evs.length = 0;
      inst.agent.session.evs.push(turnEnd(2, "completed"));
      inst.ctx.emit(AGENT_STATUS_EVENT, { agent: inst.agent, status: "idle" });
      expect(passes).toHaveLength(1);
      expect(passes[0]?.["category"]).toBe("transient-failure");
      expect(passes[0]?.["signature"], "签名必须与 report 同源（规则卡定位键）").toBe(
        reports[0]?.["signature"],
      );
      expect(passes[0]?.["cwd"], "project 由 cwd 推导，必须与 report 同一份").toBe("/work/demo");
      expect(passes[0]?.["sessionId"]).toBe("s1");
    },
  );

  it("真实 Loader 下：模型在等用户回答时不注入补跑", { timeout: 30_000 }, async () => {
    // 不调参（见上一条用例里关于冷却下限的说明）：本用例断言的是「一枚定时器都没有」，
    // 冷却与它无关。
    const inst = await mount();
    live = inst.ctx;
    assertLoaded(inst);

    inst.agent.session.evs.push(
      { type: "turn/start", seq: 1, time: 1, data: { turn: 7 } },
      {
        type: "todo/write",
        seq: 2,
        time: 2,
        data: { todos: [{ content: "b", status: "pending" }] },
      },
      {
        type: "tool/call",
        seq: 3,
        time: 3,
        data: { turn: 7, step: 1, callId: "c1", name: "ask_user_question", arguments: "{}" },
      },
      turnEnd(7, "completed"),
    );
    inst.ctx.emit(AGENT_STATUS_EVENT, { agent: inst.agent, status: "idle" });
    expect(inst.timers).toHaveLength(0);
  });
});
