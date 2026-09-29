import { describe, it } from "vitest";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { buildClient } from "../build-client.mjs";
import { clientFreshnessEvidence } from "./client-freshness.ts";
import { slotKeyEvidence } from "./profile-bundle.ts";
import { schemaCoverageEvidence } from "./schema-coverage.ts";

// 模块表 id 必须等于包名（dsh 的 client-modules 只扫裸包名条目并按包名建键）：
// 断言两侧同源，验的是「构建器取了 package.json 的 name」，改名不再需要改测试。
const PKG_NAME = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as unknown as {
    name: string;
  }
).name;

// 卡片字段覆盖门禁的证据：收集期就把 host 字段全集 / client 绑定集读出来（判据见
// test/schema-coverage.ts），用例只负责断言。allowUnbound = 有意不给 UI 卡位的字段。
const SCHEMA_COVERAGE = schemaCoverageEvidence(import.meta.url, {
  allowUnbound: [
    {
      field: "requestRetryMax",
      reason:
        "非 volatile 部署值（cordis.yml config: 改）：请求级 429 重试次数上限，随部署的限流严度调整，不是用户可调项",
    },
    {
      field: "requestRetryBackoffMs",
      reason: "非 volatile 部署值：退避阶梯（数组整体替换），无卡位",
    },
    {
      field: "requestRetryBackoffCapMs",
      reason:
        "非 volatile 部署值：代等封顶，超过即交回官方 llm-retry；与 providers.*.retryPolicy 同域，不在本卡重复给入口",
    },
  ],
});

describe("共享夹具的三条门禁", () => {
  it(`${PKG_NAME}: client.js 与最新构建逐字节一致（改 src 后必须 node build-client.mjs）`, async () => {
    const { pkgName, pkgDir, onDisk, built } = await clientFreshnessEvidence(import.meta.url);
    assert.equal(
      onDisk,
      built,
      onDisk === built
        ? "fresh"
        : `[${pkgName}] client.js 已过期：src/client-entry.ts（或其依赖）变更后未重建。请运行：cd ${pkgDir} && node build-client.mjs`,
    );
  });

  it(`${PKG_NAME}: 卡片覆盖 host schema 全部字段（改 host 字段必须同步卡片或声明豁免）`, () => {
    const { pkgName, hostFields, bound, exemptions } = SCHEMA_COVERAGE;
    assert.ok(hostFields.length > 0, "host.ts 未找到 Schema.object 字段（解析失败或该包无设置）");
    const missing = hostFields.filter((field) => !bound.has(field));
    const unexempted = missing.filter((field) => !exemptions.has(field));
    assert.deepEqual(
      unexempted,
      [],
      `[${pkgName}] 以下 host 设置字段卡片未暴露：${unexempted.join(", ")}\n` +
        `host 字段全集：${hostFields.join(", ")}\n` +
        `卡片已绑定：${[...bound].join(", ")}\n` +
        `→ 补卡片控件；若确实不该有 UI 入口，在 schemaCoverageEvidence 的 allowUnbound 里\n` +
        `  显式声明 { field, reason }（测试会校验被豁免项确实未绑定，防止挂名豁免）。`,
    );
    // 反向校验：豁免项若其实已绑定，说明豁免过时——删除即可，留着会让门禁失效。
    const stale = [...exemptions].filter(([field]) => bound.has(field));
    assert.deepEqual(
      stale,
      [],
      `[${pkgName}] allowUnbound 已过时——这些字段其实已绑定，请删除豁免声明：${stale.map(([field, reason]) => `${field}（${reason}）`).join(", ")}`,
    );
    // 豁免必须有理由，否则等于无门禁。
    const noReason = [...exemptions].filter(
      ([, reason]) => typeof reason !== "string" || reason.trim().length === 0,
    );
    assert.deepEqual(
      noReason,
      [],
      `[${pkgName}] allowUnbound 项缺少 reason：${noReason.map(([field]) => field).join(", ")}`,
    );
  });

  // 漂移针（判据与真源读取见 test/profile-bundle.ts）：当期构建产物里
  //   1. `plugins.bundle.config` 的 key === profile `dsh.profile.bundles` 中本包那条包名；
  //   2. `configForms.get()` 的入参 === cordis.patch.yml 的裸条目 id
  //      （**没有**被顺手一起改成包名 —— 那会把 client 半的写入面再次弄坏）；
  //   3. 两个标识不同值（相等就说明本包恰好条目 id == 包名，那这一层的混用钉不住，直接红）。
  it("漂移针：槽位 key = profile 的 bundle 包名，configForms 入参 = patch 裸条目 id", async () => {
    const { bundle, entryId, slotKey, formsEntryId } = slotKeyEvidence(await buildClient());
    assert.notEqual(
      bundle,
      entryId,
      "bundle 包名与裸条目 id 相同 → 这两个标识无从区分，漂移针失效，需人工确认宿主派发键",
    );
    assert.equal(
      slotKey,
      bundle,
      `plugins.bundle.config 的 key 必须是 bundle 包名 ${bundle}（宿主按包名派发），写成裸条目 id ${entryId} 就是永不出卡`,
    );
    assert.equal(
      formsEntryId,
      entryId,
      `configForms.get() 的入参必须仍是裸条目 id ${entryId}（0.1.7 里它就是 settings 命名空间），不得顺手换成 bundle 包名`,
    );
  });
});

describe("buildClient()", () => {
  it("产物包含 ModuleLoader 包装、react 外部化与两半内容", async () => {
    const out = await buildClient();
    assert.ok(out.includes("window.__ModuleLoader__.load({"));
    assert.ok(out.includes(`id: '${PKG_NAME}'`));
    // react 外部化断言
    assert.ok(out.includes('require("react")') || out.includes("require('react')"));
    // UI/入口半断言
    assert.ok(out.includes("exports.apply"));
  });

  it("产物不含 EXPORT-GUARD 与 Node 专用残留", async () => {
    const out = await buildClient();
    assert.ok(!out.includes("EXPORT-GUARD"));
    assert.ok(!out.includes("node:test"));
    assert.ok(!out.includes("import.meta"));
  });
});

describe("client.js 冒烟（stub ModuleLoader + stub react）", () => {
  it("factory 可求值并导出 inject/apply", async () => {
    const out = await buildClient();
    const sandbox: {
      loadedDef?: { id?: string; factory?: (require: (name: string) => unknown) => unknown };
      window: { __ModuleLoader__: { load: (def: unknown) => void } };
      console: Console;
    } = {
      window: {
        __ModuleLoader__: {
          load(def: unknown) {
            sandbox.loadedDef = def as {
              id?: string;
              factory?: (require: (name: string) => unknown) => unknown;
            };
          },
        },
      },
      console,
    };
    vm.createContext(sandbox);
    vm.runInContext(out, sandbox);
    const loaded = sandbox.loadedDef;
    assert.ok(
      loaded && typeof loaded === "object" && typeof loaded.factory === "function",
      "ModuleLoader.load was called",
    );
    assert.equal(loaded.id, PKG_NAME);

    const fakeReact = {
      memo: (comp: unknown) => comp,
      createElement: () => ({}),
      useState: (init: unknown) => [
        typeof init === "function" ? (init as () => unknown)() : init,
        () => {
          // noop setter stub
          void 0;
        },
      ],
      useEffect: () => {
        // noop effect stub
        void 0;
      },
      useSyncExternalStore: () => null,
    };
    const mod = loaded.factory((name: string) => {
      if (name === "react") {
        return fakeReact;
      }
      throw new Error(`unexpected require in client factory: ${name}`);
    });
    const exports = mod as { apply?: unknown; inject?: unknown };
    assert.equal(typeof exports.apply, "function");
    // 跨 realm（vm context）数组原型不同，strict deepEqual 会报
    // “same structure but not reference-equal”；Array.from 归一化到宿主 realm。
    // locale 在列：卡片/dock 的文案全部经官方 ctx.locale.register + bind 取
    //（见 src/client-entry.ts 的 apply），缺席则 apply 里读不到 locale 面。
    // configForms 取代 0.1.6 的 settingsScope（该服务在 installed 0.1.7 全树零命中，
    // 继续注入它 = 整条 client 入口挂不上）：契约源 installed
    // dsh-client-ui-settings/lib/types/client/config-form.d.ts:95-96（Context 增强）
    // 与 :142（get(entryId)）。仍是**精确全等**清单，不放宽为包含判定。
    assert.deepEqual(
      [...(exports.inject as unknown[])],
      ["slots", "sessions", "configForms", "locale"],
    );
  });
});
