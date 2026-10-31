// 集成测试：**真 settings 装配**下的本插件设置契约。test/integration/loader-boot.test.ts
// 的 settings 是记账桩——桩的 describe() 永远返回 []，宿主设置投影的形状漂移它接不住。
// 这一台起真 profile + 真 Loader + 真 SettingsForms（真 config-editor / 真 settings 服务），
// 钉三件事：volatile 十三项真投影、mutate 写路径经真 CAS、陈旧 revision 的机器冲突码。
// 装配样板照抄 dir-prep 的 settings-boot.test.ts（真件组合一致，条目换成本包）。
import { afterEach, describe, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { strict as assert } from "node:assert";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { boot, initProfile, readProfilePatches } from "@deepseek-ai/dsh-app-boot";
import type { ProfileContext } from "@deepseek-ai/dsh-app-boot";
import { ConfigEditor } from "@deepseek-ai/dsh-config-editor";
import Settings from "@deepseek-ai/dsh-settings";
import type { SettingsDescriptor } from "@deepseek-ai/dsh-settings";

import plugin from "../../host.ts";

const PKG_JSON = "package.json";
const PATCH_YML = "cordis.patch.yml";
const CORDIS_YML = "cordis.yml";
const TEST_BUNDLE = "test-bundle";
// 条目 id 与 cordis.patch.yml 同源（loader 的 ns 轴 = 条目 id）。
const ENTRY_ID = "session-rescue";

/** 真 describe() 里本包命名空间的 volatile 字段清单。 */
const EXPECTED_VOLATILE_FIELDS = [
  "enabled",
  "providerExcludes",
  "resumeDelayMs",
  "resumeCooldownMs",
  "maxResumes",
  "chainResumeDelayMs",
  "continueDelayMs",
  "continueCooldownMs",
  "maxContinues",
  "resumeOnOpenTodos",
  "unfinishedDelayMs",
  "unfinishedCooldownMs",
  "maxUnfinished",
] as const;

interface Rig {
  home: string;
  ctx: Context;
  cleanup: () => Promise<void>;
}

/** 每台 rig 的装载观测（apply 是否运行/抛错、行 config），由 wrapper 写入。 */
const observed: { applyError: unknown; applyRan: boolean; capturedConfig: unknown } = {
  applyError: undefined,
  applyRan: false,
  capturedConfig: undefined,
};

const rigs: Rig[] = [];

async function start(): Promise<Rig> {
  const made = await mkdtemp(path.join(os.tmpdir(), "rescue-settings-"));
  const home = await realpath(made);
  try {
    const dir = path.join(home, "profiles", "test");
    initProfile(dir, [TEST_BUNDLE]);
    const bundle = path.join(dir, "node_modules", TEST_BUNDLE);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(bundle, { recursive: true });
    await writeFile(path.join(home, PKG_JSON), '{"name":"test-installation"}\n');
    await writeFile(
      path.join(bundle, PKG_JSON),
      JSON.stringify({
        name: "test-bundle",
        version: "1.0.0",
        dsh: { bundle: { patch: PATCH_YML } },
      }),
    );
    await writeFile(
      path.join(bundle, PATCH_YML),
      JSON.stringify([
        {
          insert: [
            { id: "config-editor", name: "cordis:editor" },
            { id: "settings", name: "cordis:settings" },
            { id: ENTRY_ID, name: "cordis:rescue" },
          ],
        },
      ]),
    );
    await writeFile(path.join(dir, CORDIS_YML), "[]\n");
    const profile: ProfileContext = {
      name: "test",
      startedBundles: [TEST_BUNDLE],
      dir,
      patchPath: path.join(dir, PATCH_YML),
      installAnchor: path.join(home, PKG_JSON),
      cwd: home,
      home,
      overlays: [],
      telemetryDisabledEnv: undefined,
    };
    const ctx = await boot(
      "test",
      path.join(dir, CORDIS_YML),
      readProfilePatches("test", profile),
      (root) => {
        // loader-boot 同款：本包 fiber 激活需要 agents/timer 服务面在位（inject 依赖从
        // 根 ctx 服务解析，不经 loader 条目——loader 条目里的 cordis:timer 不解析）。
        root.provide("agents", {
          get: (): undefined => undefined,
        });
        root.provide("timer", {
          timeout(fn: () => void, ms: number) {
            const handle = setTimeout(fn, ms);
            return (): void => {
              clearTimeout(handle);
            };
          },
        });
        root.provide("profileContext", profile);
        root.provide("appReady", {
          onReady: (listener: () => void) => {
            listener();
            return () => {
              /* appReady 的 disposer 在本测试面无人订阅 */
            };
          },
        });
        Object.assign(root.loader.builtins, {
          editor: ConfigEditor,
          settings: Settings,
          rescue: {
            Config: plugin.Config,
            inject: plugin.inject,
            apply: (child: Parameters<typeof plugin.apply>[0], config: unknown) => {
              observed.applyRan = true;
              observed.capturedConfig = config;
              try {
                plugin.apply(child, config as never);
              } catch (error) {
                observed.applyError = error;
                throw error;
              }
            },
          },
        });
      },
    );
    const rig: Rig = {
      home,
      ctx,
      cleanup: async () => {
        await ctx.fiber.dispose();
        await rm(home, { recursive: true, force: true });
      },
    };
    rigs.push(rig);
    return rig;
  } catch (error) {
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}

interface LoaderEntryFace {
  id: string;
  fiber?: { state?: number } | null;
}

function loaderDump(ctx: Context): string {
  const { loader } = ctx as unknown as { loader: { entries: () => Iterable<LoaderEntryFace> } };
  return JSON.stringify(
    Array.from(loader.entries(), (entry) => ({ id: entry.id, state: entry.fiber?.state })),
  );
}

function requireRow(ctx: Context, ns: string): SettingsDescriptor {
  const settings = ctx.get("settings") as { describe: () => SettingsDescriptor[] };
  const all = settings.describe();
  const row = all.find((entry) => entry.ns === ns);
  assert.ok(
    row !== undefined,
    `describe() 里找不到 ${ns}；现有命名空间：${JSON.stringify(all.map((entry) => entry.ns))}；applyRan: ${String(observed.applyRan)}；applyError: ${String(observed.applyError).slice(0, 300)}；loader: ${loaderDump(ctx)}`,
  );
  return row;
}

describe("真 settings 装配下的设置契约", () => {
  afterEach(async () => {
    const pending = rigs.splice(0);
    const outcomes = await Promise.allSettled(
      pending.map(async (rig) => {
        await rig.cleanup();
      }),
    );
    const failures = outcomes
      .filter((outcome) => outcome.status === "rejected")
      .map((outcome) => outcome.reason as unknown);
    if (failures.length > 0) {
      throw new AggregateError(failures, "真 settings 装配台回收失败");
    }
  });

  it("describe() 投影本包命名空间：volatile 十三项在场且带真实默认值", async () => {
    const rig = await start();
    const row = requireRow(rig.ctx, ENTRY_ID);
    const value = row.value as Record<string, unknown>;
    for (const field of EXPECTED_VOLATILE_FIELDS) {
      assert.ok(Object.hasOwn(value, field), `volatile 字段缺席：${field}`);
    }
    // 三枚代表字段的默认值独立写死（与 host.ts schema 的 .default() 同值不同源）。
    assert.equal(value["enabled"], true);
    assert.equal(value["resumeDelayMs"], 10_000);
    assert.equal(value["maxResumes"], 3);
    assert.equal(typeof row.revision, "number");
  });

  it("mutate 写路径经真 CAS：改值后行 config 现读，陈旧 revision 回 SETTINGS_CONFLICT", async () => {
    const rig = await start();
    const { settings } = rig.ctx as unknown as {
      settings: {
        describe: () => SettingsDescriptor[];
        mutate: (ns: string, ops: unknown, expectedRevision?: number) => Promise<unknown>;
      };
    };
    const row = requireRow(rig.ctx, ENTRY_ID);
    await settings.mutate(ENTRY_ID, [{ op: "set", path: ["maxResumes"], value: 5 }], row.revision);
    const after = requireRow(rig.ctx, ENTRY_ID);
    assert.equal((after.value as Record<string, unknown>)["maxResumes"], 5);
    assert.equal(typeof after.revision, "number");
    assert.notEqual(after.revision, row.revision, "写后 revision 必须前进");

    // 用旧 revision 再写 → 机器冲突码（真实 CAS 契约，桩测试给不出这个）。
    await assert.rejects(
      () =>
        settings.mutate(ENTRY_ID, [{ op: "set", path: ["maxResumes"], value: 7 }], row.revision),
      (error: unknown) => {
        const text = String((error as { code?: unknown }).code ?? error);
        return text.includes("SETTINGS_CONFLICT");
      },
    );
  });

  it("volatile 分隔在真宿主上成立：部署值进行 config、不进设置投影（探针实测的契约）", async () => {
    const rig = await start();
    assert.equal(observed.applyRan, true, "本包条目没被 loader 激活");
    const row = requireRow(rig.ctx, ENTRY_ID);
    const projected = Object.keys(row.value as Record<string, unknown>).toSorted();
    const declared = Object.keys(observed.capturedConfig ?? {}).toSorted();
    // 十三项 volatile 全部双向在场：行 config 有默认、设置投影可编辑。
    const declaredSet = new Set(declared);
    const projectedSet = new Set(projected);
    for (const field of EXPECTED_VOLATILE_FIELDS) {
      assert.ok(declaredSet.has(field), `行 config 缺 volatile 字段：${field}`);
      assert.ok(projectedSet.has(field), `设置投影缺 volatile 字段：${field}`);
    }
    // 三枚部署值（requestRetry*）刻意不标 volatile：进行 config（宿主每次回合读）、
    // 绝不进设置投影——volatile 分隔就是「部署调优不被用户翻」的机制本体。
    for (const field of ["requestRetryMax", "requestRetryBackoffMs", "requestRetryBackoffCapMs"]) {
      assert.ok(declaredSet.has(field), `行 config 缺部署值：${field}`);
      assert.equal(projectedSet.has(field), false, `部署值混进设置投影：${field}`);
    }
  });
});
