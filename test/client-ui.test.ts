// client-entry.ts 契约测试：真实 DOM 渲染（happy-dom Window + react-dom createRoot
// + React 19 act），不依赖自研 fake-react 替身（其在多组件/跨渲染场景 hook 轴错位，
// 存在断言不到真实 DOM 的固有缺陷）。
//
// 分层：
//   渲染类用例（dock / 设置卡 / 重试策略区块）→ 挂真实组件树、按 DOM 断言；
//   纯逻辑用例（diffTouched / rescueState 轮询 / postCancel / postToggle /
//   notifyHostConnected / apply 装配 / createActions）→ 直调导出函数。
//
// 注意：本文件 import client-entry.ts 并依赖浏览器全局（document/window），
// 与 client-csrf.test.ts 同属 client 侧测试，tsconfig.json 含 DOM lib。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import {
  rescueCsrfStore,
  rescueState,
  rescueStoreBinding,
  nextPollMs,
  ACTIVE_POLL_MS,
  IDLE_POLL_MS,
  postCancel,
  postToggle,
  notifyHostConnected,
  diffTouched,
  apply as clientApply,
} from "../src/client-entry.ts";
// 0.1.7 隐式注册的单源桩件：条目 id 直接读 cordis.patch.yml，不在测试里抄一遍。
import { patchEntryId } from "./config-refs.ts";
// 卡片槽位 key 的单源桩件：bundle 包名直接读 ~/.dsh/profiles/web/package.json。
import { profileBundleName } from "./profile-bundle.ts";
import type { RescueStateBody } from "../lib/dock-state.ts";
// 注册 ns 在本文件写字面量：src/ui-messages.ts 那枚本源经 `LocaleNs` 标注钉在
// client-entry.ts 的 `NS` 上（分叉即编译期红），断言若再 import 本源就成了同义反复；
// 写真串才是「运行时注册的到底是哪个命名空间」的判据（下面还与 cordis.patch.yml 比对）。
import { UI_MESSAGES } from "../src/ui-messages.ts";
import type { Translate, UiMessages } from "../src/ui-messages.ts";
import type { ConfigForm, ConfigFormSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";

/** 本条目那张共享表单的官方面（src/client-entry.ts 的 EntryForm 同源）。 */
type EntryForm = ConfigForm<Record<string, unknown>>;

/** 官方快照面：7 位全必选。 */
type FormSnapshot = ConfigFormSnapshot<Record<string, unknown>>;

/** 本卡渲染视模型的形状（src 的 CardSnapshot：status/writable 在官方快照上必选）。 */
interface CardSnapshotView {
  status: "loading" | "ready" | "unavailable";
  writable: boolean;
  value: Record<string, unknown>;
}

/** 官方 `ConfigFormSnapshot` 的合法形状（7 位全必选）；首个快照受理前 value/revision
 *  为 undefined，memory 模式 writable 永假——这两态正是卡片要渲染的「还没数据/只读」。 */
function snap(over: Partial<FormSnapshot> = {}): FormSnapshot {
  return {
    status: "ready",
    value: {},
    base: {},
    user: {},
    revision: 3,
    writable: true,
    mode: "host",
    ...over,
  };
}

// ── 测试辅助 ─────────────────────────────────────────────────────────────

/** 官方 locale 的 `{name}` 插值（宿主同语义）：测试里自己实现，不引宿主内部实现。 */
function fillTemplate(text: string, params: Record<string, unknown>): string {
  return text.replaceAll(/\{(?<key>\w+)\}/gu, (_all: string, key: string) => {
    const value = params[key];
    if (typeof value === "number") {
      return String(value);
    }
    return typeof value === "string" ? value : "";
  });
}

/**
 * 官方 locale 的取值语义（测试侧复刻）：本包字典命中即用，未命中回落**键名本身**
 * （官方 `LocaleRuntime.translate` 在 active 语言与 fallback 链都 miss、且 common 命名空间
 * 也 miss 之后 `?? key` 的行为）。表按 `Record<string, string>` 承载而不是 `UiMessages`：
 * merge 进 `LocaleNamespaceMap` 之后 `TranslateNS<NS>` 的键域是「本包键 ∪ common 命名空间
 * 键」（官方 `LocaleKeysOf`，installed dsh-client-ui-slots/lib/types/index.d.ts:59），
 * 按 `UiMessages` 索引那条并集在编译期就红（实测 `Property 'back' does not exist on type
 * 'UiMessages'`）。展开成字面量是为了拿到隐式索引签名（`UiMessages` 是 interface，
 * 本身给不出）。
 */
function localeText(
  dict: Record<string, string>,
  key: string,
  params: Record<string, unknown>,
): string {
  return fillTemplate(dict[key] ?? key, params);
}

const zhTable: Record<string, string> = { ...UI_MESSAGES.zh };
const enTable: Record<string, string> = { ...UI_MESSAGES.en };

/** 中文 translator：既有断言里的中文串因此与 i18n 迁移前完全一致。 */
const tZh: Translate = (key, params) => localeText(zhTable, key, params ?? {});

/** 英文 translator：同一渲染路径换语言（见文末「卡片双语」用例）。 */
const tEn: Translate = (key, params) => localeText(enTable, key, params ?? {});

/** 模板里的 {占位符} 名字清单：按 `{name}` 精确取，不用「按花括号切段」的写法——
 *  本用例要把全部键过一遍一致性，而 "Cancel"/"Toggle" 这类整串是单个词的 plain 文案
 *  会被切段误判成占位符，花括号之外的正文（`{secs}s` 尾巴上的 `s`）同理。
 *  取名字走 replaceAll 的具名组回调（与 fillTemplate 同一手法）：直接读
 *  `match.groups` 会撞上 dot-notation 与 noPropertyAccessFromIndexSignature 的相互要求。 */
function placeholders(template: string): Set<string> {
  const found = new Set<string>();
  template.replaceAll(/\{(?<name>\w+)\}/gu, (_all: string, name: string) => {
    found.add(name);
    return "";
  });
  return found;
}

interface FetchCall {
  url: string;
  init: { method?: unknown; headers?: unknown; body?: unknown };
}
const fetchCalls: FetchCall[] = [];

interface FetchRoute {
  ok: boolean;
  body: unknown;
  /** 非 2xx 时 host 回的状态码（applyPreset 的 `HTTP <status>` 文案取它）。 */
  status?: number;
  /** 响应体不可 JSON 解析（host 直接回 HTML/空体）——真实网络里非罕见。 */
  badJson?: boolean;
  /** 传输层直接以该值 reject（非 Error 的 reject 是真实存在的形态）。 */
  rejectWith?: unknown;
}

/** 按 URL 路由的 fetch 桩（返回 Promise 化的普通对象，不引用 DOM 类型）。 */
function stubFetch(router: (url: string) => FetchRoute): void {
  fetchCalls.length = 0;
  vi.stubGlobal("fetch", async (url: unknown, init: unknown) => {
    const urlText = String(url);
    fetchCalls.push({
      url: urlText,
      init: init ?? {},
    });
    const route = router(urlText);
    if (route.rejectWith !== undefined) {
      const settled = Promise.withResolvers<unknown>();
      settled.reject(route.rejectWith);
      return settled.promise;
    }
    return {
      ok: route.ok,
      status: route.status ?? (route.ok ? 200 : 500),
      json: async () => {
        if (route.badJson === true) {
          throw new Error("response body is not json");
        }
        return route.body;
      },
    };
  });
}

const flush = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setTimeout(() => {
    resolve(undefined);
  }, 0);
  return promise;
};

/** 真实等一拍（毫秒级）：用于轮询定时器（快慢档见 nextPollMs）——该回调必须被真实
 *  tick 触发，假定时器会让 fetch 的 Promise 链与 act 的队列交错，测不出真实排布。 */
const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setTimeout(() => {
    resolve(undefined);
  }, ms);
  return promise;
};

/** 一次业务动作的门控桩：让 Promise 悬住以观察 busy/重入保护，再放行结果。 */
interface Gate {
  promise: Promise<unknown>;
  release: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

function makeGate(): Gate {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  return { promise, release: resolve, reject };
}

const STATE_URL = "/_dsh/session-rescue/state";
const CANCEL_URL = "/_dsh/session-rescue/cancel";
const TOGGLE_URL = "/_dsh/session-rescue/toggle";
const PROVIDERS_URL = "/_dsh/session-rescue/retry-providers";
const POLICY_URL = "/_dsh/session-rescue/retry-policy";

// ── 槽位名：测试按名字取注册项，名字写错就是「取到 undefined ⇒ 用例空转」。 ──
/** dock 的 list 槽位名。 */
const DOCK_SLOT = "conversation.input.dock";
/** 配置卡的 keyed 槽位名（0.1.6 起取代 settings.plugin.item）。 */
const BUNDLE_CONFIG_SLOT = "plugins.bundle.config";

// ── DOM 稳定锚点：卡片/ dock 的 data-field 选择器（组件改结构时这里一处跟）。 ──
const SAVE_BUTTON_SELECTOR = '[data-field="save"]';
const RETRY_SAVE_BUTTON_SELECTOR = '[data-field="retry-save"]';
const RESUME_DELAY_INPUT_SELECTOR = 'input[data-field="resumeDelayMs"]';
/** 「启用自动续跑」开关（role=switch + 中文 label，zh 面）。 */
const ENABLE_TOGGLE_SELECTOR = 'button[role="switch"][aria-label="启用自动续跑"]';

// ── 期望值由测试作者写死（不从 src/client-entry.ts 导入，否则断言自证） ──
/** 会话绑定缺失时卡片该看到的失败码。 */
const SESSION_UNAVAILABLE_CODE = "session-unavailable";
/** host 侧「没有可用路由」的拒因。 */
const NO_PROVIDERS_ERROR = "no providers";
/** 替身 settings 写入被拒时抛/回的消息。 */
const SETTINGS_REJECT_REASON = "settings-rejected";
/** 替身编辑重发被拒时 reject 的理由。 */
const RAW_EDIT_REJECT_REASON = "raw-edit-fail";
/** 替身运输层抛错的消息。 */
const CARRIER_DOWN_MESSAGE = "carrier down";
/** 故意不是记录形状的 /state pending 值。 */
const NOT_A_RECORD_VALUE = "not-a-record";
/** fork 重发按钮的 zh 文案（按文本找按钮的锚点）。 */
const FORK_RESEND_LABEL = "Fork 重发（新分支）";

function resetStateStore(): void {
  rescueState.data = null;
  rescueState.stableKey = "";
  rescueState.listeners.clear();
  rescueState.stop();
  rescueState.inFlight = false;
  rescueCsrfStore.token = "";
}

/** 只数 /state 这一条 URL 的请求次数（轮询放大与否的观测量）。 */
function stateFetchCount(): number {
  return fetchCalls.filter((call) => call.url === STATE_URL).length;
}

// ── happy-dom + react-dom 真实渲染环境（每用例独立 Window）────────────────

let win: Window;
let mountHost: HTMLElement;
let root: Root | null = null;

async function mount(ui: React.ReactElement): Promise<void> {
  root = createRoot(mountHost);
  await act(async () => {
    root!.render(ui);
  });
}

/** 卸载当前 root（下次 mount 复用同一 container）。 */
async function unmountRoot(): Promise<void> {
  if (root !== null) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
}

// happy-dom 运行环境夹具。本文件有 21 个并列的顶层套件，夹具必须对**每一条用例**生效：
// 挂在文件顶层会被 vitest/require-top-level-describe 判成"用例与 hook 不在 describe 里"，
// 塞进其中任意一个套件又只会罩住那一个套件——故夹具做成两个具名函数，由每个套件用
// `beforeEach(resetDomEnv) / afterEach(teardownDomEnv)` 各自登记（作用面＝全部用例，与
// 原先挂在根上一模一样；漏登记的套件会直接没有 window，当场红，不会静默放行）。
function resetDomEnv(): void {
  win = new Window();
  const globals = globalThis as unknown as Record<string, unknown>;
  // Node ≥22 的 globalThis.navigator 是 getter-only：用 defineProperty 覆盖。
  Object.defineProperty(globals, "window", { value: win, configurable: true, writable: true });
  Object.defineProperty(globals, "document", {
    value: win.document,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globals, "navigator", {
    value: win.navigator,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globals, "IS_REACT_ACT_ENVIRONMENT", {
    value: true,
    configurable: true,
    writable: true,
  });
  mountHost = win.document.createElement("div") as unknown as HTMLElement;
  (win.document.body as unknown as { append: (child: Node) => void }).append(mountHost);
  // 重置 client apply 幂等守卫（globalThis.__sessionRescueApplied）：否则
  // 首个用例 apply 后后续用例的 apply 直接 return，slot/样式均不注册。
  globalThis.__sessionRescueApplied = undefined;
  resetStateStore();
  fetchCalls.length = 0;
}

async function teardownDomEnv(): Promise<void> {
  await unmountRoot();
  await win.happyDOM.close();
  const globals = globalThis as unknown as Record<string, unknown>;
  delete globals["window"];
  delete globals["document"];
  delete globals["navigator"];
  delete globals["IS_REACT_ACT_ENVIRONMENT"];
  vi.unstubAllGlobals();
  resetStateStore();
  globalThis.__sessionRescueApplied = undefined;
}

/** 取 React 19 挂在 DOM 节点上的真实 props（含 onChange/onKeyDown），直调绕过
 *  happy-dom 合成事件层（happy-dom 的合成事件到不了 React 19 root 监听器——
 *  danger-guard 已实证；只绕过 DOM 事件传输层，state/防抖/写通道全是真实链路）。 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Props 只在返回位出现是这里的设计：23 个调用点各自声明本用例关心的 __reactProps$ 形状；去掉泛形就得把 23 处类型断言散进用例，断言面比现在这个单一收口更大。
function reactProps<Props>(element: Element): Props {
  const key = Object.keys(element).find((keyName) => keyName.startsWith("__reactProps$"));
  assert.ok(key !== undefined, "拿到 React props");
  return (element as unknown as Record<string, Props>)[key]!;
}

/** happy-dom 的 <select> 节点收不到 React 的 __reactProps$ 标记（探针实证），
 *  但 dispatch change 事件能触达 React 19 的 onChange（onChange 读 e.target.value，
 *  不经 value 追踪器）。先写 value 再派发即可走通真实 onChange 链路。 */
function changeSelect(el: HTMLSelectElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new (win.Event as unknown as typeof Event)("change", { bubbles: true }));
}

function allButtons(el: HTMLElement): HTMLButtonElement[] {
  return [...el.querySelectorAll("button")] as HTMLButtonElement[];
}

function buttonByText(el: HTMLElement, text: string): HTMLButtonElement | null {
  return allButtons(el).find((btn) => btn.textContent.trim() === text) ?? null;
}

function buttonContaining(el: HTMLElement, text: string): HTMLButtonElement | null {
  return allButtons(el).find((btn) => btn.textContent.includes(text)) ?? null;
}

// ── 纯函数：diffTouched ──────────────────────────────────────────────────

describe("diffTouched（touched 层与快照的差异字段）", () => {
  beforeEach(resetDomEnv);
  afterEach(teardownDomEnv);

  it("值语义比较：undefined 与缺失等价，变化字段列出", () => {
    assert.deepEqual(diffTouched({ a: 1 }, { a: 1 }), []);
    assert.deepEqual(diffTouched({ a: undefined }, {}), []);
    assert.deepEqual(diffTouched({ a: 1 }, { a: 2 }), ["a"]);
    // 第二个数据键取有意义的名字（`a` 在 id-length 白名单里、`b` 不在），断言不变。
    assert.deepEqual(diffTouched({ a: 1, note: "x" }, { a: 1 }), ["note"]);
  });
});

// ── rescueState 轮询（快慢两档、自排循环、订阅启停）───────────────────────

describe("rescueState 轮询契约", () => {
  beforeEach(resetDomEnv);
  afterEach(teardownDomEnv);

  it("refresh 成功：内容变化才替换 data 引用（快照稳定化）", async () => {
    let body = {
      ok: true,
      csrf: "t1",
      sessions: { s1: { count: 0, lastFireAt: 0, pending: null } },
    };
    stubFetch(() => ({ ok: true, body }));
    await rescueState.refresh();
    const first = rescueState.data;
    assert.ok(first !== null);
    assert.equal(rescueCsrfStore.token, "t1");
    await rescueState.refresh();
    assert.equal(rescueState.data, first, "内容不变时保留旧引用");
    body = {
      ok: true,
      csrf: "t1",
      sessions: { s1: { count: 1, lastFireAt: 0, pending: null } },
    };
    await rescueState.refresh();
    assert.notEqual(rescueState.data, first, "内容变化才替换引用");
  });

  it("refresh：HTTP 非 ok 或 body.ok!==true → 不更新 data", async () => {
    stubFetch(() => ({ ok: false, body: null }));
    await rescueState.refresh();
    assert.equal(rescueState.data, null);
    stubFetch(() => ({ ok: true, body: { ok: false, error: "x" } }));
    await rescueState.refresh();
    assert.equal(rescueState.data, null);
  });

  it("refresh：fetch 抛错静默（轮询不炸），listener 仍收到通知", async () => {
    let notified = 0;
    rescueState.listeners.add(() => {
      notified += 1;
    });
    stubFetch(() => {
      throw new Error("network down");
    });
    await rescueState.refresh();
    assert.equal(notified, 1);
    assert.equal(rescueState.data, null);
    rescueState.listeners.clear();
  });

  it("subscribe：立即刷新并在响应落地后按档位续表；退订归零即停", async () => {
    stubFetch(() => ({ ok: true, body: { ok: true, sessions: {} } }));
    let notified = 0;
    const unsub = rescueState.subscribe(() => {
      notified += 1;
    });
    // 自排循环的下一跳在 refresh 的 finally 里才排：此刻只有在飞标志，没有定时器。
    assert.ok(rescueState.inFlight, "订阅即刷新（在飞）");
    assert.equal(stateFetchCount(), 1, "首个订阅只发一发 /state");
    await flush();
    assert.ok(rescueState.timer !== null, "响应落地后应排好下一跳");
    assert.equal(notified, 1, "快照就绪才通知订阅者一次");
    unsub();
    assert.equal(rescueState.timer, null, "订阅归零应停表");
    // 二次订阅/退订不残留
    const unsub2 = rescueState.subscribe(() => {
      /* 只关心请求次数 */
    });
    await flush();
    // 上面那条 `assert.equal(rescueState.timer, null)` 走 `asserts actual is T`，会把
    // `rescueState.timer` 这一属性引用收窄成 null —— 而 `rescueState` 是模块单例，
    // 重新订阅后 refresh 的 finally 又赋回了定时器（类型面收窄跟不上可变状态）。
    // 这里改用 notEqual（同一判据、同等强度，且不带断言签名，不再污染后续 narrowing）。
    assert.notEqual(rescueState.timer, null, "二次订阅同样排好下一跳");
    unsub2();
    assert.equal(rescueState.timer, null);
  });

  it("档位：pending 走 1s、其余走 5s 兜底", () => {
    assert.equal(nextPollMs(null), IDLE_POLL_MS, "快照未就绪 → 慢档");
    assert.equal(nextPollMs({ ok: true }), IDLE_POLL_MS, "无 sessions → 慢档");
    assert.equal(
      nextPollMs({ ok: true, sessions: { s1: { count: 1, lastFireAt: 0, pending: null } } }),
      IDLE_POLL_MS,
      "有记录但无 pending → 慢档",
    );
    assert.equal(
      nextPollMs({
        ok: true,
        sessions: {
          s1: { count: 1, lastFireAt: 0, pending: null },
          s2: {
            count: 0,
            lastFireAt: 0,
            pending: { turn: 1, kind: "resume", fireAt: 0, remainingMs: 1 },
          },
        },
      }),
      ACTIVE_POLL_MS,
      "任一会话有 pending → 快档",
    );
  });

  it("订阅抖动不放大：在飞期间的订阅/退订不再各补一发", async () => {
    stubFetch(() => ({ ok: true, body: { ok: true, sessions: {} } }));
    const first = rescueState.subscribe(() => {
      /* 只关心请求次数 */
    });
    assert.equal(stateFetchCount(), 1, "首个订阅起一发");
    // 真机上 20:08:24.352~.372 的五连发就是这个形状：每次渲染 disposer 与新订阅
    // 交替，旧实现里每一轮都撞见 timer===null 而补发一发。
    first();
    const second = rescueState.subscribe(() => {
      /* 只关心请求次数 */
    });
    assert.equal(stateFetchCount(), 1, "在飞期间重新订阅不得补发");
    await flush();
    second();
  });

  it("refresh 重入：并发调用只发一发，不叠请求", async () => {
    stubFetch(() => ({ ok: true, body: { ok: true, sessions: {} } }));
    const first = rescueState.refresh();
    // 第二次撞在飞闸门：同步返回，不再 fetch——一次悬挂的 /state 不该叠出并发。
    const second = rescueState.refresh();
    await Promise.all([first, second]);
    assert.equal(stateFetchCount(), 1, "在飞期间的 refresh 不发第二发");
  });

  it("隐藏页签停表，回到可见补一跳（真实 visibilitychange 事件）", async () => {
    stubFetch(() => ({ ok: true, body: { ok: true, sessions: {} } }));
    const unsub = rescueState.subscribe(() => {
      /* 只关心请求次数 */
    });
    await flush();
    assert.ok(rescueState.timer !== null, "可见时有下一跳");
    const before = stateFetchCount();
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    try {
      // 走事件而不是直调 syncVisibility：绑定点（subscribe 里的 bindVisibility）
      // 与停表动作要一起被验到，直调只测到方法本身。
      win.document.dispatchEvent(new win.Event("visibilitychange"));
      assert.equal(rescueState.timer, null, "隐藏应撤掉下一跳");
      await sleep(ACTIVE_POLL_MS + 300);
      assert.equal(stateFetchCount(), before, "隐藏期间不再发");
    } finally {
      Reflect.deleteProperty(document, "hidden");
    }
    win.document.dispatchEvent(new win.Event("visibilitychange"));
    assert.equal(stateFetchCount(), before + 1, "回到可见补一跳");
    await flush();
    // 仍可见时再进一次事件：下一跳已排好，不该叠发（这条负路径防止循环被事件重复起速）。
    const afterResume = stateFetchCount();
    win.document.dispatchEvent(new win.Event("visibilitychange"));
    assert.equal(stateFetchCount(), afterResume, "已有下一跳时可见事件不补发");
    await flush();
    unsub();
  });
});

// ── postCancel / postToggle 的失败面 ─────────────────────────────────────

describe("postCancel / postToggle 失败降级", () => {
  beforeEach(resetDomEnv);
  afterEach(teardownDomEnv);

  it("fetch 抛错 → {ok:false}（不向上抛）", async () => {
    stubFetch(() => {
      throw new Error("boom");
    });
    assert.deepEqual(await postCancel("s1"), { ok: false });
    assert.deepEqual(await postToggle("s1"), { ok: false });
  });

  it("响应非 ok → {ok:false}", async () => {
    stubFetch(() => ({ ok: false, body: { ok: false, error: "403" } }));
    assert.deepEqual(await postCancel("s1"), { ok: false });
  });

  it("无 token 时不带 csrf 头；有 token 时回填", async () => {
    stubFetch(() => ({ ok: true, body: { ok: true, cancelled: true } }));
    await postCancel("s1");
    const call = fetchCalls[0]!;
    assert.deepEqual(call.init.headers, {}, "无 token 不带头");
    rescueCsrfStore.token = "tok-abc";
    await postToggle("s1");
    const call2 = fetchCalls[1]!;
    assert.equal((call2.init.headers as Record<string, string>)["x-rescue-csrf"], "tok-abc");
  });
});

// ── notifyHostConnected 的守卫面 ─────────────────────────────────────────

describe("notifyHostConnected 守卫", () => {
  beforeEach(resetDomEnv);
  afterEach(teardownDomEnv);

  it("ctx.on 缺失 → 静默不炸", () => {
    // 「不炸」是这条用例的判据本身：不抛错 + 一个 POST 都不发（缺 on 就连订阅都建不起来）。
    expect(() => {
      notifyHostConnected({} as never);
    }).not.toThrow();
    assert.equal(fetchCalls.length, 0, "ctx.on 缺失时不得发出任何 fetch");
  });

  it("token 为空（host 未就绪/已重启）→ 连接重置不裸发 POST", () => {
    const listeners = new Map<string, () => void>();
    notifyHostConnected({
      on: (event: string, listener: () => void) => {
        listeners.set(event, listener);
      },
    } as never);
    stubFetch(() => ({ ok: true, body: { ok: true, restored: 0 } }));
    listeners.get("connection/reset")?.();
    assert.equal(fetchCalls.length, 0, "无 token 跳过恢复通知");
  });
});

// ── apply 装配与 createActions 业务动作 ──────────────────────────────────

interface TestSlotReg {
  name: string;
  key?: string;
  order?: number;
  inject?: () => Record<string, unknown>;
  component: unknown;
  unregister: () => void;
}

interface MockClientCtx {
  effects: (() => void)[];
  listeners: Map<string, () => void>;
  registers: TestSlotReg[];
  setCalls: { field: string; value: unknown }[];
  /** 本条目那张共享表单的替身：**官方 `ConfigForm` 五成员全必选**（getSnapshot /
   *  subscribe / mutate / set / unset），快照 7 位全齐。旧的三成员 + `getSnapshot:
   *  () => {status?: unknown}` 投影已删——那正是让 src 里的 fieldOf 再解析得以
   *  存在的形状，官方面加/改一位这里就编译失败。 */
  scope: EntryForm;
  bindings: Map<string, unknown>;
  forkImpl?: (opts: unknown) => Promise<string>;
  setImpl?: (field: string, value: unknown) => Promise<boolean>;
  effect: (factory: () => (() => void) | undefined) => void;
  on: (event: string, listener: () => void) => void;
  slots: {
    inject: (name: string, factory: () => (() => void) | undefined) => void;
    register: (desc: TestSlotReg, component: unknown) => () => void;
    get: (name: string) => (() => (() => void) | undefined) | undefined;
    readonly size: number;
  };
  /**
   * `ctx.sessions` 的替身按官方 `ISessions` 的三位来：`binding()` 借出已 retain 的
   * binding（官方返回 `SessionBinding`，本包只读其 `.session`），`fork()` 交回子会话 id，
   * `using()` 在一段操作周围自持引用——拿不到引用即抛（生产侧把这次抛出映射成
   * `branch-unavailable`）。官方**没有** `open`：导航属 `ctx.uiWorkspace.openSession`。
   */
  sessions: {
    binding: (id: string) => { session: unknown } | undefined;
    fork: (opts: unknown) => Promise<string>;
    using: (
      target: string,
      options: unknown,
      operation: (reference: unknown) => Promise<unknown>,
    ) => Promise<unknown>;
  };
  /** apply 经 `ctx.get("uiWorkspace")` 拿到的导航替身被调过哪些目标（fork 后应切过去）。 */
  openSessionCalls: string[];
  /** 0.1.7 的配置表单服务（installed dsh-client-ui-settings/lib/types/client/
   *  config-form.d.ts:95-96 的 Context 增强）：取代已从宿主消失的 `settingsScope`。
   *  `get` 的入参是 **profile 条目 id**（同文件 :142），这里记下来供装配断言。 */
  configForms: { get: (entryId: string) => MockClientCtx["scope"] };
  /** apply 取表单时交出的条目 id（= settings 命名空间，见 cordis.patch.yml）。 */
  formEntryIds: string[];
  /** 注册进官方 locale 的入参（命名空间 + 一次交齐的两语字典），供双语断言。
   *  元素形状从生产侧的 register 签名派生，桩件与生产不会各自漂移。 */
  locales: { ns: Parameters<LocaleSeat["register"]>[0]; dicts: LocaleDictArg }[];
  /** 生产 `apply` 的那一位原样引用：桩件实现一改形状即编译期红。 */
  locale: LocaleSeat;
  /** 同上：可选服务读取面直接取生产签名（官方 cordis `Context['get']`）。 */
  get: ApplyCtx["get"];
  /** 覆盖 bind 交出的 translator（默认中文）：双语用例据此让 apply 整条装配链
   *  走英文，等价于宿主在「设置 → 常规」里切了语言。 */
  bindImpl?: Translate;
}

/** 生产 ClientCtx（未导出，但可从 apply 的入参取到）——桩件的 locale 面跟着它走。 */
type ApplyCtx = Parameters<typeof clientApply>[0];
/** 官方类型化 register 的字典参数（两语目录），同样从生产侧派生。 */
type LocaleDictArg = Parameters<ApplyCtx["locale"]["register"]>[1];
type LocaleSeat = ApplyCtx["locale"];

function makeClientCtx(): MockClientCtx {
  const effects: (() => void)[] = [];
  const listeners = new Map<string, () => void>();
  const slots = new Map<string, () => (() => void) | undefined>();
  const registers: TestSlotReg[] = [];
  const setCalls: { field: string; value: unknown }[] = [];
  /** apply 向 `configForms.get()` 要过哪些条目 id（装配断言用）。 */
  const formEntryIds: string[] = [];
  const bindings = new Map<string, unknown>();
  const locales: MockClientCtx["locales"] = [];
  const holder: { ctx: MockClientCtx | null } = { ctx: null };
  const scope: EntryForm = {
    getSnapshot: () => snap(),
    subscribe: (listener: () => void) => {
      listeners.set("scope-sub", listener);
      // 官方 subscribe 的 disposer 面是 `() => void`：写成表达式体会把 Map.delete 的
      // boolean 返回值带进 void 位（strict-void-return），故用语句体丢弃它。
      return () => {
        listeners.delete("scope-sub");
      };
    },
    async set(field: string, value: unknown): Promise<boolean> {
      if (holder.ctx?.setImpl) {
        return holder.ctx.setImpl(field, value);
      }
      holder.ctx?.setCalls.push({ field, value });
      // 桩件收下这次写入即「受理」；它不改建快照身份，所以卡片的事后复读数到的
      // 仍是旧值——正是这条复读把「受理但没落盘」与「真落盘」区分开（0.1.6 与 0.1.7
      // 同一条判据，见 src/client-entry.ts 的 setAndVerify）。
      return true;
    },
    // 官方 `ConfigForm` 的另两位：本卡只写不清（恢复默认不在设置卡面上）、也从不走
    // 批量原子写，但类型面要求它们在位——缺一位就编译不过，正是此次迁移要的防漂移。
    unset: (): Promise<boolean> => Promise.resolve(true),
    mutate: (): Promise<boolean> => Promise.resolve(true),
  };
  const openSessionCalls: string[] = [];
  function sessionFaceOf(id: string): unknown {
    return bindings.get(id);
  }
  const sessions = {
    binding: (id: string) => {
      const session = sessionFaceOf(id);
      return session === undefined ? undefined : { session };
    },
    fork: async (opts: unknown): Promise<string> => {
      if (holder.ctx?.forkImpl) {
        return holder.ctx.forkImpl(opts);
      }
      return `child-${(opts as { sessionId?: string }).sessionId ?? "?"}`;
    },
    // 官方 `using`：retain 一份引用、把 `SessionReference` 交给操作、结束后释放。
    // 替身里「引用」就是同一张 bindings 表——查不到即等价于 retain 失败（抛）。
    async using(
      target: string,
      _options: unknown,
      operation: (reference: unknown) => Promise<unknown>,
    ): Promise<unknown> {
      const session = sessionFaceOf(target);
      if (session === undefined) {
        throw new Error(`cannot retain ${target}`);
      }
      return operation({
        sessionId: target,
        binding: { session },
        ready: Promise.resolve({ session }),
        release: () => {
          void 0;
        },
      });
    },
  };
  const ctx: MockClientCtx = {
    effects,
    listeners,
    registers,
    setCalls,
    scope,
    bindings,
    openSessionCalls,
    effect(factory) {
      const disposer = factory();
      if (typeof disposer === "function") {
        effects.push(disposer);
      }
    },
    on(event, listener) {
      listeners.set(event, listener);
    },
    // 官方 `Context['get']` 是两条重载（已声明服务名 → `undefined | this[K]`，未声明名 →
    // `any`，installed cordis/lib/types/reflect.d.ts:11-16），单个箭头签名同时满足不了两条，
    // 故一次性投影到官方面（同 ctx-observe 的 effect 手法）。可选服务不建立依赖：本包只
    // `get("uiWorkspace")` 取导航，其它名字交回 undefined（等价宿主未装配该服务）。
    get: ((name: string): unknown =>
      name === "uiWorkspace"
        ? {
            openSession: (target: string) => {
              openSessionCalls.push(target);
            },
          }
        : undefined) as ApplyCtx["get"],
    slots: {
      inject(name, factory) {
        slots.set(name, factory);
      },
      // 自引用 mock：unregister 只在稍后被调用，读到的 entry 那时已初始化 ⇒
      // 声明期即完成绑定，`const` 一步到位，无需 prefer-const 豁免。
      register(desc, component) {
        const entry: TestSlotReg = {
          ...desc,
          component,
          unregister: () => {
            const idx = registers.indexOf(entry);
            if (idx !== -1) {
              registers.splice(idx, 1);
            }
          },
        };
        registers.push(entry);
        return entry.unregister;
      },
      get(name) {
        return slots.get(name);
      },
      get size() {
        return slots.size;
      },
    },
    sessions,
    configForms: {
      get: (entryId: string) => {
        formEntryIds.push(entryId);
        return scope;
      },
    },
    formEntryIds,
    locales,
    locale: {
      register(ns, dicts) {
        locales.push({ ns, dicts });
        return () => {
          void 0;
        };
      },
      // bind 交出的 translator 即中文假字典：装配类断言里所有既有中文串都走它。
      // 用例改 holder.ctx.bindImpl 后，重新装配即换语言（真实宿主的 locale.bind 同样
      // 是稳定身份，语言切换由宿主驱动 slot 重渲染，这里以重装配等价模拟）。
      bind: () => holder.ctx?.bindImpl ?? tZh,
    },
  };
  holder.ctx = ctx;
  return ctx;
}

/** 装配一份独立 ctx；translator 决定 apply 交出去的语言（默认中文，双语用例传 en）。 */
function applyWithCtx(translator: Translate = tZh): MockClientCtx {
  // 每次独立装配都重放（apply 幂等守卫按"一次 apply 一次装配"语义设计，
  // 同一用例内多次取独立 ctx 时需复位，否则后续 apply 直接 return）。
  globalThis.__sessionRescueApplied = undefined;
  stubFetch(() => ({ ok: true, body: { ok: true, sessions: {} } }));
  const ctx = makeClientCtx();
  ctx.bindImpl = translator;
  clientApply(ctx as never);
  return ctx;
}

describe("apply 装配（幂等守卫 / slot 注册 / css effect）", () => {
  beforeEach(resetDomEnv);
  afterEach(teardownDomEnv);

  it("注册 dock 与 settings 两个 slot；重复 apply 幂等", () => {
    const ctx = applyWithCtx();
    assert.equal(ctx.slots.size, 2);
    clientApply(ctx as never);
    assert.equal(ctx.slots.size, 2, "重复 apply 不得重复注册");
    assert.equal(ctx.registers.length, 0, "slot factory 未调用前不注册");
    // 触发 dock factory → 注册 conversation.input.dock
    ctx.slots.get(DOCK_SLOT)?.();
    assert.equal(ctx.registers.length, 1);
    assert.equal(ctx.registers[0]?.name, DOCK_SLOT);
    assert.equal(ctx.registers[0].order, 500);
    // config factory → 注册 plugins.bundle.config（0.1.6 新契约），cleanup 释放 scope
    const settingsFactory = ctx.slots.get(BUNDLE_CONFIG_SLOT);
    assert.ok(settingsFactory);
    const cleanup = settingsFactory();
    assert.equal(ctx.registers.length, 2);
    // 卡片注册项的 key 必须是 **bundle 包名**（宿主按包名派发 plugins.bundle.config，
    // 证据链见 test/profile-bundle.ts）；裸条目 id 只喂 configForms.get()（同文件
    // 「apply 取配置表单」那条用例）。dock 那行的 `id: "session-rescue"` 是 list 槽的
    // 条目 id，与本 key 无关。
    assert.equal(ctx.registers[1]?.key, profileBundleName(), "设置卡按 bundle 包名 keyed");
    assert.notEqual(ctx.registers[1].key, patchEntryId(), "key 写成裸条目 id = 插件页永不出卡");
    cleanup?.();
    assert.equal(ctx.registers.length, 1, "unregister 生效");
  });

  it("effect：apply claim 与 css 在卸载时清理", () => {
    const ctx = applyWithCtx();
    assert.equal(ctx.effects.length, 3, "apply claim + css + locale 字典 effect 各一个");
    for (const fn of ctx.effects) {
      fn();
    }
  });
});

function actionsOf(): {
  sendSameSession: (id: string, text: string) => Promise<unknown>;
  stopAndReask: (id: string, text: string) => Promise<unknown>;
  withdrawQueueItem: (id: string, itemId: string) => Promise<unknown>;
  editQueueItem: (id: string, itemId: string, text: string) => Promise<unknown>;
  forkAndSend: (id: string, atSeq: number | null, text: string) => Promise<unknown>;
} {
  const ctx = applyWithCtx();
  ctx.slots.get(DOCK_SLOT)?.();
  const reg = ctx.registers[0]!;
  const injected = reg.inject?.() as {
    actions: {
      sendSameSession: (id: string, text: string) => Promise<unknown>;
      stopAndReask: (id: string, text: string) => Promise<unknown>;
      withdrawQueueItem: (id: string, itemId: string) => Promise<unknown>;
      editQueueItem: (id: string, itemId: string, text: string) => Promise<unknown>;
      forkAndSend: (id: string, atSeq: number | null, text: string) => Promise<unknown>;
    };
  };
  return injected.actions;
}

describe("createActions 业务动作（经 apply 注入的 actions）", () => {
  beforeEach(resetDomEnv);
  afterEach(teardownDomEnv);

  it("binding 缺失 → 各动作返回 session-unavailable（不炸）", async () => {
    const actions = actionsOf();
    assert.deepEqual(await actions.sendSameSession("ghost", "x"), {
      ok: false,
      code: SESSION_UNAVAILABLE_CODE,
      message: "会话不可用",
    });
    assert.deepEqual(await actions.stopAndReask("ghost", "x"), {
      ok: false,
      code: SESSION_UNAVAILABLE_CODE,
      message: "会话不可用",
    });
    assert.deepEqual(await actions.withdrawQueueItem("ghost", "q1"), {
      ok: false,
      code: SESSION_UNAVAILABLE_CODE,
      message: "会话不可用",
    });
    assert.deepEqual(await actions.editQueueItem("ghost", "q1", "x"), {
      ok: false,
      code: SESSION_UNAVAILABLE_CODE,
      message: "会话不可用",
    });
    // fork 不经父会话 binding（按历史轮次切分）：ghost 无 binding → fork
    // stub 产出 child-ghost → 子 binding 缺失 → branch-unavailable。
    // fork-unavailable 仅用于首轮（atSeq null），由下方 forkAndSend 用例覆盖。
    assert.deepEqual(await actions.forkAndSend("ghost", 5, "x"), {
      ok: false,
      code: "branch-unavailable",
      message: "分支会话不可用",
    });
  });

  it("sendSameSession：prompt 成功/失败（failResult 透传 error 字段）", async () => {
    const ctx = applyWithCtx();
    const session = {
      prompt: async () => ({ ok: false, error: { code: "rejected", message: "no" } }),
      cancel: async () => ({ ok: true }),
      updateQueue: async () => ({ ok: true }),
    };
    ctx.bindings.set("s1", session);
    ctx.slots.get(DOCK_SLOT)?.();
    const { actions } = ctx.registers[0]!.inject!() as {
      actions: { sendSameSession: (sessionId: string, text: string) => Promise<unknown> };
    };
    assert.deepEqual(await actions.sendSameSession("s1", "t"), {
      ok: false,
      code: "rejected",
      message: "no",
    });
  });

  it("stopAndReask：prompt 失败短路；cancel 失败透传", async () => {
    const ctx = applyWithCtx();
    let promptOk = false;
    const session = {
      // 官方 `RemoteResult` 的失败支必带 `error`（`{ok:false, error: RemoteFailure}`，
      // dsh-typert-protocol/lib/types/types.d.ts:67-73）：桩件要交就交完整形状，
      // 空 `error` 正是生产侧「有失败、无 code/message」那一支的合法表达。
      prompt: async () => (promptOk ? { ok: true } : { ok: false, error: {} }),
      cancel: async () => ({ ok: false, error: { message: "cancel no" } }),
      updateQueue: async () => ({ ok: true }),
    };
    ctx.bindings.set("s1", session);
    ctx.slots.get(DOCK_SLOT)?.();
    const { actions } = ctx.registers[0]!.inject!() as {
      actions: { stopAndReask: (sessionId: string, text: string) => Promise<unknown> };
    };
    promptOk = false;
    assert.deepEqual(await actions.stopAndReask("s1", "t"), { ok: false });
    promptOk = true;
    assert.deepEqual(await actions.stopAndReask("s1", "t"), {
      ok: false,
      message: "cancel no",
    });
  });

  it("withdrawQueueItem / editQueueItem：成功与失败", async () => {
    const ctx = applyWithCtx();
    const calls: { kind: string; itemId: string }[] = [];
    const session = {
      prompt: async () => ({ ok: true }),
      cancel: async () => ({ ok: true }),
      updateQueue: async (itemId: string) => {
        calls.push({ kind: "update", itemId });
        return { ok: true };
      },
    };
    ctx.bindings.set("s1", session);
    ctx.slots.get(DOCK_SLOT)?.();
    const { actions } = ctx.registers[0]!.inject!() as {
      actions: {
        withdrawQueueItem: (sessionId: string, text: string) => Promise<unknown>;
        editQueueItem: (sessionId: string, text: string, itemId: string) => Promise<unknown>;
      };
    };
    assert.deepEqual(await actions.withdrawQueueItem("s1", "q1"), { ok: true });
    assert.deepEqual(await actions.editQueueItem("s1", "q1", "new"), { ok: true });
    assert.equal(calls.length, 2);
  });

  it("forkAndSend：fork 抛错 → fork-failed；分支 binding 缺失 → branch-unavailable", async () => {
    const ctx = applyWithCtx();
    ctx.forkImpl = async () => {
      throw new Error("fork exploded");
    };
    ctx.slots.get(DOCK_SLOT)?.();
    const { actions } = ctx.registers[0]!.inject!() as {
      actions: {
        forkAndSend: (sessionId: string, turn: number | null, text: string) => Promise<unknown>;
      };
    };
    const failed = (await actions.forkAndSend("s1", 5, "x")) as { code?: string; message?: string };
    assert.equal(failed.code, "fork-failed");
    assert.equal(failed.message, "fork exploded");

    // 分支创建成功但子会话 binding 缺失
    const ctx2 = applyWithCtx();
    ctx2.slots.get(DOCK_SLOT)?.();
    const actions2 = (
      ctx2.registers[0]!.inject!() as {
        actions: {
          forkAndSend: (sessionId: string, turn: number | null, text: string) => Promise<unknown>;
        };
      }
    ).actions;
    assert.deepEqual(await actions2.forkAndSend("s1", 5, "x"), {
      ok: false,
      code: "branch-unavailable",
      message: "分支会话不可用",
    });
  });

  it("forkAndSend 成功：fork 子会话 → prompt", async () => {
    const ctx = applyWithCtx();
    const prompts: { id: string; text: string }[] = [];
    ctx.bindings.set("child-s1", {
      prompt: async (content: { type: string; text: string }[]) => {
        prompts.push({ id: "child-s1", text: content[0]?.text ?? "" });
        return { ok: true };
      },
      cancel: async () => ({ ok: true }),
      updateQueue: async () => ({ ok: true }),
    });
    ctx.slots.get(DOCK_SLOT)?.();
    const { actions } = ctx.registers[0]!.inject!() as {
      actions: {
        forkAndSend: (sessionId: string, turn: number | null, text: string) => Promise<unknown>;
      };
    };
    assert.deepEqual(await actions.forkAndSend("s1", 5, "forked text"), { ok: true });
    assert.deepEqual(prompts, [{ id: "child-s1", text: "forked text" }]);
    // 这条就是此次改对的语义：「切到子会话」是 view owner 的导航（官方
    // `ctx.uiWorkspace.openSession(target)`），旧实现叫 `sessions.open(childId)` 在真宿主上
    // 是 undefined 成员 → TypeError → 整条 fork 分支被 catch 成一次失败。
    assert.deepEqual(ctx.openSessionCalls, ["child-s1"], "fork 后应把视图切到子会话");
  });
});

// ── dock 组件渲染（RescueDockView 经 apply slot 获取，真实 DOM 挂载）──────

interface DockActionsStub {
  sendSameSession: (id: string, text: string) => Promise<unknown>;
  stopAndReask: (id: string, text: string) => Promise<unknown>;
  withdrawQueueItem: (id: string, itemId: string) => Promise<unknown>;
  editQueueItem: (id: string, itemId: string, text: string) => Promise<unknown>;
  forkAndSend: (id: string, atSeq: number | null, text: string) => Promise<unknown>;
}

function makeDockStub(): { actions: DockActionsStub; calls: { name: string; args: unknown[] }[] } {
  const calls: { name: string; args: unknown[] }[] = [];
  const actions: DockActionsStub = {
    sendSameSession: async (id, text) => {
      calls.push({ name: "sendSameSession", args: [id, text] });
      return { ok: true };
    },
    stopAndReask: async (id, text) => {
      calls.push({ name: "stopAndReask", args: [id, text] });
      return { ok: true };
    },
    withdrawQueueItem: async (id, itemId) => {
      calls.push({ name: "withdrawQueueItem", args: [id, itemId] });
      return { ok: true };
    },
    editQueueItem: async (id, itemId, text) => {
      calls.push({ name: "editQueueItem", args: [id, itemId, text] });
      return { ok: true };
    },
    forkAndSend: async (id, atSeq, text) => {
      calls.push({ name: "forkAndSend", args: [id, atSeq, text] });
      return { ok: true };
    },
  };
  return { actions, calls };
}

function dockComponent(): unknown {
  const ctx = applyWithCtx();
  ctx.slots.get(DOCK_SLOT)?.();
  return ctx.registers[0]!.component;
}

interface DockNode {
  kind: string;
  seq: number;
  turn?: number;
  message?: string;
  code?: string;
  retryState?: string;
  interrupted?: boolean;
  content?: { type: string; text: string }[];
}

interface DockView {
  nodes: DockNode[];
  turnEnds: Map<number, number>;
  runningCalls: { turn?: number }[];
  running: boolean;
  removed: boolean;
  lastAgentError: string | null;
  /** 0.1.6：inbox "next-turn" 线格式（UserMessage 子集），经 projection 注入。 */
  queue: { id: string; content?: { type: string; text?: string }[] }[];
}

/** useSession 快照的真实形状（src DockProps 契约子集；0.1.6 起无 queue）。 */
interface SessionSnapshot {
  running: boolean;
  removed: boolean;
  lastAgentError: string | null;
}

interface DockPropsForTest {
  sessionId: string;
  actions: DockActionsStub;
  /** 官方 ctx.locale.bind 的结果由框架经 slot inject 下发（见 apply）：真实挂载
   *  必然带上，故测试替身同样按必填声明，避免漏传只在运行时才炸。 */
  t: Translate;
  useChat: <Out>(
    sel: (snap: {
      legacy: {
        nodes: DockNode[];
        turnEnds: Map<number, number>;
        runningCalls: { turn?: number }[];
      };
    }) => Out,
  ) => Out;
  useSession: <Out>(sel: (snap: SessionSnapshot) => Out) => Out;
  useProjection: (name: string) => unknown;
}

/** 框架不含 slots 契约的形态：useProjection 整个缺席（0.1.5 之前的宿主）。 */
type DockPropsWithoutProjection = Omit<DockPropsForTest, "useProjection">;

interface MountDockOptions {
  /** 覆盖用例侧 fetch 路由（默认只服务 STATE_URL）。 */
  route?: (url: string) => FetchRoute;
  /** 不注入 useProjection：验证 seat 缺席时 dock 回空队列而非抛错。 */
  noProjection?: boolean;
  /** 下发给 dock 的 translator（默认中文；双语用例传 en 走同一渲染路径）。 */
  t?: Translate;
}

/** 挂载 dock：先复位全局 store 再写入 sessionState（useSyncExternalStore 真实订阅
 *  轮询（快慢档见 nextPollMs），stub 需路由 STATE_URL 保证内容不漂移；每次挂载都重新起一根 root）。 */
async function mountDock(
  view: Partial<DockView>,
  sessionState: unknown,
  csrf = "",
  opts: MountDockOptions = {},
): Promise<{
  container: HTMLElement;
  stub: ReturnType<typeof makeDockStub>;
  rerender: (view2: Partial<DockView>) => Promise<void>;
}> {
  await unmountRoot();
  resetStateStore();
  const stub = makeDockStub();
  const body = sessionState as RescueStateBody | null;
  rescueState.data = body;
  rescueState.stableKey = JSON.stringify(body);
  rescueCsrfStore.token = csrf;
  // 先捕获组件（applyWithCtx 内部带默认 stub），再覆盖用例路由。
  const comp = dockComponent() as React.ComponentType<DockPropsForTest>;
  stubFetch(
    opts.route ??
      ((url) =>
        url === STATE_URL ? { ok: true, body } : { ok: true, body: { ok: true, sessions: {} } }),
  );
  const propsFor = (view2: Partial<DockView>): DockPropsWithoutProjection => ({
    sessionId: "s1",
    actions: stub.actions,
    t: opts.t ?? tZh,
    useChat: (sel) =>
      sel({
        legacy: {
          nodes: view2.nodes ?? [],
          turnEnds: view2.turnEnds ?? new Map<number, number>(),
          runningCalls: view2.runningCalls ?? [],
        },
      }),
    useSession: (sel) =>
      sel({
        running: view2.running ?? false,
        removed: view2.removed ?? false,
        lastAgentError: view2.lastAgentError ?? null,
      }),
  });
  const withProjection = (
    view2: Partial<DockView>,
  ): DockPropsForTest | DockPropsWithoutProjection =>
    opts.noProjection === true
      ? propsFor(view2)
      : {
          ...propsFor(view2),
          useProjection: (name) =>
            name === "inbox" ? { "next-turn": view2.queue ?? [] } : undefined,
        };
  await mount(React.createElement(comp, withProjection(view) as DockPropsForTest));
  return {
    container: mountHost,
    stub,
    rerender: async (view2: Partial<DockView>) => {
      await act(async () => {
        root!.render(React.createElement(comp, withProjection(view2) as DockPropsForTest));
      });
    },
  };
}

describe("RescueDockView 渲染决策", () => {
  beforeEach(resetDomEnv);
  afterEach(teardownDomEnv);

  it("pending 横幅：显示倒计时；点取消 → postCancel 带 csrf", async () => {
    const body: RescueStateBody = {
      ok: true,
      sessions: {
        s1: {
          count: 1,
          lastFireAt: 0,
          pending: { turn: 2, kind: "resume", fireAt: 0, remainingMs: 5000 },
          disabled: false,
        },
      },
    };
    const { container, stub } = await mountDock({}, body, "dock-tok");
    assert.match(container.textContent, /5s 后自动续跑/u, "倒计时文案");
    const cancelBtn = buttonByText(container, "取消");
    assert.ok(cancelBtn, "横幅带取消按钮");
    await act(async () => {
      cancelBtn.click();
    });
    await act(async () => {
      await flush();
    });
    const call = fetchCalls.find((entry) => entry.url.startsWith(CANCEL_URL));
    assert.ok(call, "取消走 cancel 端点");
    assert.equal((call.init.headers as Record<string, string>)["x-rescue-csrf"], "dock-tok");
    assert.equal(stub.calls.length, 0, "取消不触发业务动作");
  });

  it("suspended 横幅：文案为连接中断（不显示倒计时）", async () => {
    const body: RescueStateBody = {
      ok: true,
      sessions: {
        s1: {
          count: 1,
          lastFireAt: 0,
          pending: {
            turn: 2,
            kind: "unfinished",
            fireAt: 0,
            remainingMs: 999,
            suspended: true,
          },
          disabled: false,
        },
      },
    };
    const { container } = await mountDock({}, body);
    assert.match(container.textContent, /连接中断，重连后将自动补跑/u, "挂起文案用 kind=补跑");
  });

  it("turn-error 回合：可编辑 + 可重试；host 重试进行中按钮显示等待中", async () => {
    const base = {
      nodes: [
        { kind: "user", seq: 1, turn: 1, content: [{ type: "text", text: "hi" }] },
        { kind: "turn-error", seq: 2, turn: 1, message: "boom", code: "X" },
      ],
      turnEnds: new Map([[1, 3]]),
    };
    const { container, rerender } = await mountDock(base, null);
    assert.ok(buttonByText(container, "编辑"), "canEditDock");
    assert.ok(buttonByText(container, "重试"), "canRetryDock 渲染重试按钮");
    // host 重试进行中（同类失败回合有 model-retry 节点）→ 避让
    await rerender({
      ...base,
      nodes: [...base.nodes, { kind: "model-retry", seq: 3, turn: 1, retryState: "started" }],
    });
    assert.ok(buttonContaining(container, "重试等待中"), "isHostPending 文案");
  });

  it("max-tokens 回合：显示继续输出按钮", async () => {
    const { container } = await mountDock(
      {
        nodes: [
          { kind: "user", seq: 1, turn: 1, content: [{ type: "text", text: "hi" }] },
          { kind: "turn-max-tokens", seq: 2, turn: 1 },
        ],
        turnEnds: new Map([[1, 3]]),
      },
      null,
    );
    assert.ok(buttonByText(container, "继续输出"), "canContinueDock");
  });

  it("running + 有最后用户消息：停止重问行；重试/编辑隐藏", async () => {
    const { container, stub } = await mountDock(
      {
        nodes: [{ kind: "user", seq: 1, turn: 2, content: [{ type: "text", text: "go" }] }],
        turnEnds: new Map([[2, 5]]),
        running: true,
      },
      null,
    );
    const stopBtn = buttonContaining(container, "停止并重问");
    assert.ok(stopBtn, "running 时显示停止重问");
    await act(async () => {
      stopBtn.click();
    });
    await act(async () => {
      await flush();
    });
    assert.equal(stub.calls[0]?.name, "stopAndReask");
    assert.equal(stub.calls[0].args[1], "go", "重问文案用最后用户消息");
  });

  it("queued inbox：纯文本项可编辑、非文本块项无编辑按钮、编辑/撤回流程", async () => {
    const { container, stub } = await mountDock(
      {
        queue: [
          { id: "q1", content: [{ type: "text", text: "排队消息一" }] },
          { id: "q2", content: [{ type: "image" }] },
          { id: "q3", content: [{ type: "text", text: "排队消息三" }] },
        ],
      },
      null,
    );
    const full = container.textContent;
    assert.ok(full.includes("排队消息一"), "q1 预览渲染");
    assert.ok(full.includes("[image]"), "q2 非文本块以 [type] 占位");
    // q2 非纯文本 → 无编辑按钮
    const editButtons = allButtons(container).filter((btn) => btn.textContent.trim() === "编辑");
    assert.equal(editButtons.length, 2, "只有 q1/q3 可编辑");
    assert.ok(editButtons[0]);
    // 编辑 q1 → 输入草稿 → 保存
    await act(async () => {
      editButtons[0]!.click();
    });
    const textarea = container.querySelector("textarea");
    assert.ok(textarea, "编辑态出现输入框");
    await act(async () => {
      reactProps<{ onChange: (ev: { target: { value: string } }) => void }>(textarea).onChange({
        target: { value: "改后" },
      });
    });
    const saveBtn = buttonByText(container, "保存");
    assert.ok(saveBtn);
    await act(async () => {
      saveBtn.click();
    });
    await act(async () => {
      await flush();
    });
    assert.equal(stub.calls[0]?.name, "editQueueItem");
    assert.equal(stub.calls[0].args[2], "改后");
  });

  it("开关行：off 显示已关闭与开启按钮；unknown 时不显示行", async () => {
    const body: RescueStateBody = {
      ok: true,
      sessions: { s1: { count: 0, lastFireAt: 0, pending: null, disabled: true } },
    };
    const { container } = await mountDock({}, body);
    assert.ok(container.textContent.includes("已关闭"), "off 状态文案");
    assert.ok(buttonByText(container, "开启") !== null, "off 时按钮为开启");
    // rescue 快照未就绪（null）→ 无开关行
    const { container: v2 } = await mountDock({}, null);
    assert.ok(!v2.textContent.includes("自动续跑（本会话）"), "unknown 态不显示开关行");
  });

  it("编辑重发：打开编辑器 → Escape 关闭；⌘Enter 发送", async () => {
    const base = {
      nodes: [{ kind: "user", seq: 1, turn: 1, content: [{ type: "text", text: "hi" }] }],
      turnEnds: new Map([[1, 3]]),
    };
    const { container, stub } = await mountDock(base, null);
    const editBtn = buttonByText(container, "编辑");
    assert.ok(editBtn);
    await act(async () => {
      editBtn.click();
    });
    let textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    assert.ok(textarea, "编辑器含 textarea");
    // Escape 关闭：onDone → dockEditing false → 编辑器卸载
    await act(async () => {
      reactProps<{ onKeyDown: (ev: { key: string; preventDefault: () => void }) => void }>(
        textarea!,
      ).onKeyDown({ key: "Escape", preventDefault: () => void 0 });
    });
    textarea = container.querySelector("textarea");
    assert.equal(textarea, null, "Escape 后编辑器关闭（无 textarea）");
    // 重新打开编辑器 → 输入草稿 → ⌘Enter → sendSameSession
    const editBtn2 = buttonByText(container, "编辑");
    assert.ok(editBtn2);
    await act(async () => {
      editBtn2.click();
    });
    textarea = container.querySelector("textarea");
    assert.ok(textarea, "再次打开编辑器含 textarea");
    await act(async () => {
      reactProps<{ onChange: (ev: { target: { value: string } }) => void }>(textarea!).onChange({
        target: { value: "重发内容" },
      });
    });
    textarea = container.querySelector("textarea");
    assert.ok(textarea, "重渲染后仍含 textarea");
    await act(async () => {
      reactProps<{
        onKeyDown: (ev: { key: string; metaKey: boolean; preventDefault: () => void }) => void;
      }>(textarea).onKeyDown({ key: "Enter", metaKey: true, preventDefault: () => void 0 });
    });
    await act(async () => {
      await flush();
    });
    assert.equal(stub.calls[0]?.name, "sendSameSession");
    assert.equal(stub.calls[0].args[1], "重发内容");
  });
});

// ── 设置卡渲染（RescueSettingsCard / NumberRow / ToggleRow / 保存条）──────

interface SettingsPropsForTest {
  view: "summary" | "page";
  /** 框架把 hooks.card 映射成 useCard prop：快照形状即 src 的 CardSnapshot
   *  （status/writable 都是官方必选位，不再用 unknown 假装它们会缺）。 */
  useCard: (sel: (snap: CardSnapshotView) => unknown) => unknown;
  /** 真实契约的 set 返回 promise（写后复读的结论由它带回）；测试替身可以不返回。 */
  set: (field: string, value: unknown) => unknown;
  /** 官方 ctx.locale.bind 的结果（经 slot inject 下发）：卡片全部界面文案取自它。 */
  t: Translate;
}

function settingsCardComponent(): unknown {
  const ctx = applyWithCtx();
  const factory = ctx.slots.get(BUNDLE_CONFIG_SLOT);
  assert.ok(factory);
  factory();
  // 该 ctx 只执行了 config factory：registers[0] 即配置组件
  return ctx.registers[0]!.component;
}

/** 挂载配置表单（plugins.bundle.config 的 page 视图：表单直渲，无折叠外壳）。 */
async function mountSettingsCard(
  value: Record<string, unknown>,
  opts: { status?: CardSnapshotView["status"]; writable?: boolean; t?: Translate } = {},
  setImpl?: (field: string, val: unknown) => unknown,
  route?: (url: string) => FetchRoute,
): Promise<{ container: HTMLElement; setCalls: { field: string; value: unknown }[] }> {
  // 先捕获组件（applyWithCtx 内部带默认 stub），再覆盖用例路由。
  const comp = settingsCardComponent() as React.ComponentType<SettingsPropsForTest>;
  stubFetch(route ?? (() => ({ ok: true, body: { ok: false, error: NO_PROVIDERS_ERROR } })));
  const setCalls: { field: string; value: unknown }[] = [];
  await mount(
    React.createElement(comp, {
      view: "page",
      t: opts.t ?? tZh,
      useCard: (sel) =>
        sel({
          status: opts.status ?? "ready",
          writable: opts.writable ?? true,
          value,
        }),
      set:
        setImpl ??
        ((field: string, val: unknown) => {
          setCalls.push({ field, value: val });
        }),
    }),
  );
  // page 视图直挂 RetryPolicySection，异步拉 providers，flush 让状态落定。
  await act(async () => {
    await flush();
  });
  return { container: mountHost, setCalls };
}

describe("RescueSettingsCard 设置卡", () => {
  beforeEach(resetDomEnv);
  afterEach(teardownDomEnv);

  it("summary 视图：渲染一行摘要，不渲染表单", async () => {
    const comp = settingsCardComponent() as React.ComponentType<SettingsPropsForTest>;
    stubFetch(() => ({ ok: true, body: { ok: false, error: NO_PROVIDERS_ERROR } }));
    await mount(
      React.createElement(comp, {
        view: "summary",
        t: tZh,
        useCard: (sel) => sel({ status: "ready", writable: true, value: {} }),
        set: () => {
          /* summary 不触达 set */
        },
      }),
    );
    const full = mountHost.textContent;
    assert.ok(full.includes("自动续跑"), "summary 摘要文案");
    assert.equal(
      mountHost.querySelector(SAVE_BUTTON_SELECTOR),
      null,
      "summary 不渲染保存按钮（表单只在 page 视图）",
    );
  });

  it("渲染全字段；无改动时保存禁用", async () => {
    const { container } = await mountSettingsCard({
      enabled: true,
      resumeDelayMs: 10_000,
      providerExcludes: ["baidu"],
    });
    const full = container.textContent;
    assert.ok(full.includes("启用自动续跑"));
    assert.ok(full.includes("续跑延迟 (ms)"));
    const saveBtn = container.querySelector<HTMLButtonElement>(SAVE_BUTTON_SELECTOR);
    assert.ok(saveBtn);
    assert.equal(saveBtn.disabled, true, "无改动保存禁用");
  });

  it("只读（status!==ready）→ 输入与按钮全部禁用", async () => {
    const { container } = await mountSettingsCard(
      { enabled: true },
      { status: "unavailable", writable: true },
    );
    const saveBtn = container.querySelector<HTMLButtonElement>(SAVE_BUTTON_SELECTOR);
    assert.equal(saveBtn!.disabled, true);
    const numInput = container.querySelector<HTMLInputElement>(RESUME_DELAY_INPUT_SELECTOR);
    assert.equal(numInput!.disabled, true);
    const sw = container.querySelector<HTMLButtonElement>('button[role="switch"]');
    assert.equal(sw!.disabled, true);
  });

  it("修改 providerExcludes 草稿 → 保存 → commitTouched 落盘数组", async () => {
    const { container, setCalls } = await mountSettingsCard({
      enabled: true,
      providerExcludes: [],
    });
    const input = container.querySelector<HTMLInputElement>('input[placeholder^="例如"]');
    assert.ok(input, "excludes 输入框存在");
    const save0 = container.querySelector<HTMLButtonElement>(SAVE_BUTTON_SELECTOR);
    assert.equal(save0!.disabled, true, "未改动保存禁用");
    await act(async () => {
      reactProps<{ onChange: (ev: { target: { value: string } }) => void }>(input).onChange({
        target: { value: "baidu-token-plan, xkiro" },
      });
    });
    const saveBtn = container.querySelector<HTMLButtonElement>(SAVE_BUTTON_SELECTOR);
    assert.equal(saveBtn!.disabled, false, "有改动保存可点");
    await act(async () => {
      saveBtn!.click();
    });
    await act(async () => {
      await flush();
    });
    const excludes = setCalls.find((entry) => entry.field === "providerExcludes");
    assert.deepEqual(excludes?.value, ["baidu-token-plan", "xkiro"], "草稿串拆分成数组");
  });

  it("数值行：Enter 提交有效值（onCommit → touched）→ 保存落盘 setField", async () => {
    const { container, setCalls } = await mountSettingsCard({
      enabled: true,
      resumeDelayMs: 10_000,
    });
    let numInput = container.querySelector<HTMLInputElement>(RESUME_DELAY_INPUT_SELECTOR);
    assert.ok(numInput, "数值输入框存在");
    // onChange 更新草稿并 stage（范围内即入 touched）；真实 DOM 下 state 变化自动重渲染
    await act(async () => {
      reactProps<{ onChange: (ev: { target: { value: string } }) => void }>(numInput!).onChange({
        target: { value: "15000" },
      });
    });
    numInput = container.querySelector(RESUME_DELAY_INPUT_SELECTOR);
    await act(async () => {
      reactProps<{ onKeyDown: (ev: { key: string; preventDefault: () => void }) => void }>(
        numInput!,
      ).onKeyDown({ key: "Enter", preventDefault: () => void 0 });
    });
    const saveBtn = container.querySelector<HTMLButtonElement>(SAVE_BUTTON_SELECTOR);
    assert.equal(saveBtn!.disabled, false, "有改动保存可点");
    await act(async () => {
      saveBtn!.click();
    });
    await act(async () => {
      await flush();
    });
    const committed = setCalls.find((entry) => entry.field === "resumeDelayMs");
    assert.equal(committed?.value, 15_000);
  });

  it("开关行：点击切换（enabled → false 入 touched）", async () => {
    const { container, setCalls } = await mountSettingsCard({ enabled: true });
    const toggleBtn = container.querySelector<HTMLButtonElement>(ENABLE_TOGGLE_SELECTOR);
    assert.ok(toggleBtn, "switch 按钮存在");
    await act(async () => {
      toggleBtn.click();
    });
    const saveBtn = container.querySelector<HTMLButtonElement>(SAVE_BUTTON_SELECTOR);
    assert.equal(saveBtn!.disabled, false, "有改动保存可点");
    await act(async () => {
      saveBtn!.click();
    });
    await act(async () => {
      await flush();
    });
    assert.deepEqual(
      setCalls.find((entry) => entry.field === "enabled")?.value,
      false,
      "toggle 提交 false",
    );
  });

  it("撤销：清空 touched 草稿", async () => {
    const { container } = await mountSettingsCard({ enabled: true, providerExcludes: [] });
    const input = container.querySelector<HTMLInputElement>('input[placeholder^="例如"]');
    assert.ok(input);
    await act(async () => {
      reactProps<{ onChange: (ev: { target: { value: string } }) => void }>(input).onChange({
        target: { value: "a, b" },
      });
    });
    const save0 = container.querySelector<HTMLButtonElement>(SAVE_BUTTON_SELECTOR);
    assert.equal(save0!.disabled, false, "有改动保存可点");
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-field="discard"]')!.click();
    });
    const saveAfter = container.querySelector<HTMLButtonElement>(SAVE_BUTTON_SELECTOR);
    assert.equal(saveAfter!.disabled, true, "撤销后回到无改动");
  });

  it("保存抛错 → saveError 显示（commitTouched catch 面）", async () => {
    // commitTouched 同步调用 props.set；同步 throw 走 catch 面（async throw 只会
    // 产生 rejected promise，catch 面抓不到）。
    const { container } = await mountSettingsCard(
      { enabled: true, resumeDelayMs: 10_000 },
      {},
      () => {
        throw new Error(SETTINGS_REJECT_REASON);
      },
    );
    const numInput = container.querySelector<HTMLInputElement>(RESUME_DELAY_INPUT_SELECTOR);
    assert.ok(numInput);
    await act(async () => {
      reactProps<{ onChange: (ev: { target: { value: string } }) => void }>(numInput).onChange({
        target: { value: "15000" },
      });
    });
    // Enter 步：NumberRow 的 stage() 读同 tick 闭包里的旧 draft，onChange 一次调用
    // 不会直接入 touched（与数值行用例同款）；act 重渲染后新闭包读到 15000 才暂存。
    const fresh = container.querySelector<HTMLInputElement>(RESUME_DELAY_INPUT_SELECTOR);
    await act(async () => {
      reactProps<{ onKeyDown: (ev: { key: string; preventDefault: () => void }) => void }>(
        fresh!,
      ).onKeyDown({ key: "Enter", preventDefault: () => void 0 });
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(SAVE_BUTTON_SELECTOR)!.click();
    });
    await act(async () => {
      await flush();
    });
    assert.ok(container.textContent.includes(SETTINGS_REJECT_REASON), "保存失败文案可见");
  });
});

// ── RetryPolicySection（429 重试策略区块）────────────────────────────────

describe("RetryPolicySection 重试策略区块", () => {
  beforeEach(resetDomEnv);
  afterEach(teardownDomEnv);

  it("加载 → providers 行（档位推断）→ 改档位 → 保存落盘 POST", async () => {
    const { container } = await mountSettingsCard({ enabled: true }, {}, undefined, (url) => {
      if (url === PROVIDERS_URL) {
        return {
          ok: true,
          body: {
            ok: true,
            providers: [
              { provider: "xkiro", mode: "normal", maxRetries: 12, hasQuota: true },
              { provider: "openrouter", mode: "normal", maxRetries: 5, hasQuota: false },
              { provider: "ag", mode: "always", maxRetries: 999, hasQuota: false },
            ],
          },
        };
      }
      if (url === STATE_URL) {
        return { ok: true, body: { ok: true, csrf: "rp-tok", sessions: {} } };
      }
      if (url === POLICY_URL) {
        return { ok: true, body: { ok: true } };
      }
      return { ok: false, body: null };
    });
    const selects = [...container.querySelectorAll("select")] as HTMLSelectElement[];
    assert.equal(selects.length, 3);
    assert.equal(selects[0]!.value, "enhanced", "normal+12+QUOTA → enhanced");
    assert.equal(selects[1]!.value, "default", "normal+5 → default");
    assert.equal(selects[2]!.value, "always", "mode=always → always");
    // 改 openrouter 档位为 off
    await act(async () => {
      changeSelect(selects[1]!, "off");
    });
    assert.ok(container.textContent.includes("保存（1 个改动）"), "保存条计数");
    const saveBtn = container.querySelector<HTMLButtonElement>(RETRY_SAVE_BUTTON_SELECTOR);
    assert.ok(saveBtn);
    await act(async () => {
      saveBtn.click();
    });
    await act(async () => {
      await flush();
    });
    const post = fetchCalls.find((entry) => entry.url === POLICY_URL);
    assert.ok(post, "落盘走 retry-policy POST");
    assert.equal(
      (post.init.headers as Record<string, string>)["x-rescue-csrf"],
      "rp-tok",
      "csrf 回填",
    );
    assert.equal((post.init.body as string).includes('"preset":"off"'), true, "body 携带档位");
  });

  it("provider 列表不可用（ok:false）→ 错误文案", async () => {
    const { container } = await mountSettingsCard({ enabled: true }, {}, undefined, () => ({
      ok: true,
      body: { ok: false, error: "llm-pi-ai settings unavailable" },
    }));
    assert.ok(container.textContent.includes("不可用"), "错误态文案");
  });

  it("落盘抛错（POST reject）→ 保存失败文案", async () => {
    const { container } = await mountSettingsCard({ enabled: true }, {}, undefined, (url) => {
      if (url === PROVIDERS_URL) {
        return {
          ok: true,
          body: {
            ok: true,
            providers: [{ provider: "xkiro", mode: "normal", maxRetries: 5, hasQuota: false }],
          },
        };
      }
      if (url === POLICY_URL) {
        throw new Error(CARRIER_DOWN_MESSAGE);
      }
      return { ok: true, body: { ok: true, csrf: "t", sessions: {} } };
    });
    const sel0 = container.querySelector<HTMLSelectElement>("select");
    assert.ok(sel0);
    await act(async () => {
      changeSelect(sel0, "off");
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(RETRY_SAVE_BUTTON_SELECTOR)!.click();
    });
    await act(async () => {
      await flush();
    });
    assert.ok(container.textContent.includes("保存失败"), "落盘失败文案");
  });
});

// ── /state wire 载荷防御面与轮询循环（纯逻辑，不挂 DOM）────────────────────

describe("rescueState：/state 坏形状逐字段降级（wire 是唯一的外部输入面）", () => {
  beforeEach(resetDomEnv);
  afterEach(teardownDomEnv);

  it("pending 非对象/字段类型不符 → null；count·lastFireAt 非数字 → 0；非对象会话条目丢弃", async () => {
    stubFetch(() => ({
      ok: true,
      body: {
        ok: true,
        sessions: {
          badPending: { count: "3", lastFireAt: null, pending: NOT_A_RECORD_VALUE },
          badPendingField: {
            count: 1,
            lastFireAt: 2,
            pending: { turn: "2", kind: "resume", fireAt: 0, remainingMs: 100 },
          },
          flagged: {
            pending: {
              turn: 3,
              kind: "continue",
              fireAt: 9,
              remainingMs: 10,
              chained: true,
              suspended: true,
            },
          },
          dropped: NOT_A_RECORD_VALUE,
        },
      },
    }));
    await rescueState.refresh();
    assert.deepEqual(rescueState.data, {
      ok: true,
      sessions: {
        badPending: { count: 0, lastFireAt: 0, pending: null },
        badPendingField: { count: 1, lastFireAt: 2, pending: null },
        flagged: {
          count: 0,
          lastFireAt: 0,
          pending: {
            turn: 3,
            kind: "continue",
            fireAt: 9,
            remainingMs: 10,
            chained: true,
            suspended: true,
          },
        },
      },
    });
  });

  it("sessions 非对象 → 只认 ok（不带着坏数据渲染横幅）", async () => {
    stubFetch(() => ({ ok: true, body: { ok: true, sessions: "nope" } }));
    await rescueState.refresh();
    assert.deepEqual(rescueState.data, { ok: true });
  });

  it("pending 走快档：下一跳在一秒内补发", async () => {
    const pendingBody: RescueStateBody = {
      ok: true,
      sessions: {
        s1: {
          count: 1,
          lastFireAt: 0,
          pending: { turn: 2, kind: "resume", fireAt: 0, remainingMs: 5000 },
        },
      },
    };
    stubFetch(() => ({ ok: true, body: pendingBody }));
    const unsubscribe = rescueState.subscribe(() => {
      /* 只关心定时器是否再拉 */
    });
    await flush();
    assert.equal(stateFetchCount(), 1, "订阅即首跳");
    await sleep(ACTIVE_POLL_MS + 300);
    assert.ok(stateFetchCount() > 1, "快档：一秒内应再发一次 /state");
    unsubscribe();
    assert.equal(rescueState.timer, null);
  });

  it("无 pending 走慢档：一秒后不再补发（旧实现正是这里的空转）", async () => {
    stubFetch(() => ({ ok: true, body: { ok: true, sessions: {} } }));
    const unsubscribe = rescueState.subscribe(() => {
      /* 计数无关 */
    });
    await flush();
    const first = stateFetchCount();
    await sleep(ACTIVE_POLL_MS + 300);
    assert.equal(stateFetchCount(), first, "慢档：一秒后不该再打一发");
    unsubscribe();
  });

  it("多订阅者共享一条循环；最后一个退订才停表", async () => {
    stubFetch(() => ({ ok: true, body: { ok: true, sessions: {} } }));
    const first = rescueState.subscribe(() => {
      /* 计数无关 */
    });
    await flush();
    const { timer } = rescueState;
    assert.ok(timer !== null, "首跳落定后排定下一跳");
    const second = rescueState.subscribe(() => {
      /* 计数无关 */
    });
    assert.equal(rescueState.timer, timer, "第二个订阅者不得另起循环");
    first();
    assert.equal(rescueState.timer, timer, "仍有订阅者 → 不停表");
    second();
    assert.equal(rescueState.timer, null, "订阅归零才停表");
  });

  it("喂给 useSyncExternalStore 的是模块级稳定引用", () => {
    // 写成内联箭头函数会让 React 每次渲染重跑订阅 effect（官方 React 18.3.1 的实现
    // 是 useEffect(bind(...),[subscribe])），重跑的 disposer→新订阅会多打一发 /state。
    assert.equal(typeof rescueStoreBinding.subscribe, "function");
    assert.equal(typeof rescueStoreBinding.getSnapshot, "function");
    assert.equal(rescueStoreBinding.getSnapshot(), rescueState.getSnapshot(), "读同一份快照");
    const bound = rescueStoreBinding.subscribe;
    const read = rescueStoreBinding.getSnapshot;
    assert.equal(rescueStoreBinding.subscribe, bound, "subscribe 引用恒定");
    assert.equal(rescueStoreBinding.getSnapshot, read, "getSnapshot 引用恒定");
  });

  it("dock 重渲染不触发额外 /state（订阅不随渲染抖动）", async () => {
    const { rerender } = await mountDock({}, null);
    const mounted = stateFetchCount();
    assert.equal(mounted, 1, "挂载只起一发");
    // 逐次 await（不写成 for + await：串行渲染没有并发可言，no-await-in-loop 的
    // 顾虑正是循环里 await 掩盖串行成本）。
    await rerender({ running: false });
    await rerender({ running: false });
    await rerender({ running: false });
    assert.equal(stateFetchCount(), mounted, "三次重渲染后仍只有一发 /state");
  });
});

// ── createActions 的成功支与残余失败支 ───────────────────────────────────

/** 取 dock slot 注入的 actions（真实 createActions 装配，不另起桩）。 */
function actionsFromCtx(ctx: MockClientCtx): DockActionsStub {
  ctx.slots.get(DOCK_SLOT)?.();
  const reg = ctx.registers[0]!;
  const injectFactory = reg.inject;
  assert.ok(injectFactory !== undefined, "dock slot 描述符应带 inject");
  return (injectFactory() as { actions: DockActionsStub }).actions;
}

/** 会话桩：三个动作各自固定结果并记调用。 */
function sessionStub(results: { prompt?: unknown; cancel?: unknown; updateQueue?: unknown } = {}): {
  calls: string[];
  session: Record<string, unknown>;
} {
  const calls: string[] = [];
  const session: Record<string, unknown> = {
    prompt: async (): Promise<unknown> => {
      calls.push("prompt");
      return results.prompt ?? { ok: true };
    },
    cancel: async (): Promise<unknown> => {
      calls.push("cancel");
      return results.cancel ?? { ok: true };
    },
    updateQueue: async (): Promise<unknown> => {
      calls.push("updateQueue");
      return results.updateQueue ?? { ok: true };
    },
  };
  return { calls, session };
}

describe("createActions 成功支与残余失败支", () => {
  beforeEach(resetDomEnv);
  afterEach(teardownDomEnv);

  it("sendSameSession / stopAndReask 成功 → {ok:true}（不走 failResult）", async () => {
    const ctx = applyWithCtx();
    const binding = sessionStub();
    ctx.bindings.set("s1", binding.session);
    const actions = actionsFromCtx(ctx);
    assert.deepEqual(await actions.sendSameSession("s1", "t"), { ok: true });
    assert.deepEqual(await actions.stopAndReask("s1", "t"), { ok: true });
    assert.deepEqual(binding.calls, ["prompt", "prompt", "cancel"]);
  });

  it("withdrawQueueItem / editQueueItem 失败 → failResult 透传 code 与 message", async () => {
    const ctx = applyWithCtx();
    ctx.bindings.set(
      "s1",
      sessionStub({ updateQueue: { ok: false, error: { code: "gone", message: "已被消费" } } })
        .session,
    );
    const actions = actionsFromCtx(ctx);
    assert.deepEqual(await actions.withdrawQueueItem("s1", "q1"), {
      ok: false,
      code: "gone",
      message: "已被消费",
    });
    assert.deepEqual(await actions.editQueueItem("s1", "q1", "t"), {
      ok: false,
      code: "gone",
      message: "已被消费",
    });
  });

  it("forkAndSend：第一轮（atSeq null）拒绝切分；子会话 prompt 失败透传", async () => {
    const ctx = applyWithCtx();
    const actions = actionsFromCtx(ctx);
    assert.deepEqual(await actions.forkAndSend("s1", null, "x"), {
      ok: false,
      code: "fork-unavailable",
      message: "第一轮消息不支持 fork",
    });
    ctx.bindings.set(
      "child-s1",
      sessionStub({ prompt: { ok: false, error: { code: "no" } } }).session,
    );
    assert.deepEqual(await actions.forkAndSend("s1", 7, "x"), { ok: false, code: "no" });
  });

  it("forkAndSend：fork 以非 Error reject → message 取原值串（不显示 undefined）", async () => {
    const ctx = applyWithCtx();
    const brokenFork = makeGate();
    brokenFork.reject("fork-broken");
    ctx.forkImpl = (): Promise<string> => brokenFork.promise as Promise<string>;
    const actions = actionsFromCtx(ctx);
    assert.deepEqual(await actions.forkAndSend("s1", 7, "x"), {
      ok: false,
      code: "fork-failed",
      message: "fork-broken",
    });
  });
});

// ── inbox 投影的宽容面（坏形状不得炸 dock）────────────────────────────────

/** 取某一标签的全部按钮（队列区每行都有同名控件）。 */
function buttonsNamed(container: HTMLElement, label: string): HTMLButtonElement[] {
  return allButtons(container).filter((btn) => btn.textContent.trim() === label);
}

function editableButtonCount(container: HTMLElement): number {
  return buttonsNamed(container, "编辑").length;
}

describe("inbox 投影的宽容面", () => {
  beforeEach(resetDomEnv);
  afterEach(teardownDomEnv);

  it("next-turn 非数组 / 非对象条目 / 非字符串 id → 逐项降级，不抛错", async () => {
    const { container: emptyRow } = await mountDock(
      {
        queue: [
          "nope",
          { content: [] },
          { id: 7, content: [] },
          { id: "q9" },
        ] as unknown as DockView["queue"],
      },
      null,
    );
    assert.ok(emptyRow.textContent.includes("撤回"), "带字符串 id 的行仍渲染");
    assert.equal(buttonsNamed(emptyRow, "撤回").length, 1, "无 id/坏 id 的行全部丢弃");
    assert.equal(editableButtonCount(emptyRow), 0, "无 content → 不可编辑");
    // next-turn 整个不是数组（跨版本投影换形）→ 空队列
    const { container } = await mountDock(
      { queue: "not-a-list" as unknown as DockView["queue"] },
      null,
    );
    assert.equal(buttonsNamed(container, "撤回").length, 0, "非数组投影按空队列处理");
  });

  it("content 里的非内容块被跳过；全空文本按空串预览（match 无命中）", async () => {
    const { container } = await mountDock(
      {
        queue: [
          {
            id: "q1",
            content: [42, { type: "text", text: "混块" }] as unknown as {
              type: string;
              text?: string;
            }[],
          },
          { id: "q2", content: [{ type: "text", text: "" }] },
        ],
      },
      null,
    );
    assert.ok(container.textContent.includes("混块"), "坏块跳过、好块照常预览");
    assert.equal(editableButtonCount(container), 2, "两条都是纯文本 → 都可编辑");
  });

  it("含非文本块的超长预览按码点截到 200 并加省略号", async () => {
    const long = "值".repeat(250);
    const { container } = await mountDock(
      {
        queue: [
          {
            id: "q1",
            content: [{ type: "image" }, { type: "text", text: long }],
          },
        ],
      },
      null,
    );
    const previewText = container.querySelector(".sr-queue-preview")?.textContent ?? "";
    assert.ok(previewText.startsWith("[image]"), "非文本块以 [type] 占位");
    assert.equal(previewText.length, 201, "200 码点 + 省略号");
    assert.ok(previewText.endsWith("…"));
  });

  it("宿主框架没有 useProjection seat → 队列按空处理", async () => {
    const { container } = await mountDock({}, null, "", { noProjection: true });
    assert.ok(container.querySelector(".sr-dock"), "dock 仍常驻挂载");
    assert.equal(buttonsNamed(container, "撤回").length, 0);
  });
});

// ── RescueEditor 全链路（发送 / fork / 键盘 / 失败呈现）───────────────────

/** 双回合 view：最后一条用户消息之前已有结束的轮 → target.forkAtSeq 非空。 */
const twoTurnView: Partial<DockView> = {
  nodes: [
    { kind: "user", seq: 1, turn: 1, content: [{ type: "text", text: "第一轮" }] },
    { kind: "user", seq: 4, turn: 2, content: [{ type: "text", text: "第二轮草稿" }] },
  ],
  turnEnds: new Map([
    [1, 3],
    [4, 6],
  ]),
};

/** 打开 dock 编辑器。 */
async function openEditor(container: HTMLElement): Promise<void> {
  const editBtn = buttonByText(container, "编辑");
  assert.ok(editBtn, "编辑按钮存在");
  await act(async () => {
    editBtn.click();
  });
}

/** 把 textarea 的键盘事件直接递给 React props（happy-dom 合成事件到不了 root）。 */
async function pressKey(
  area: Element,
  ev: { key: string; metaKey?: boolean; ctrlKey?: boolean },
): Promise<void> {
  const props = reactProps<{
    onKeyDown: (next: {
      key: string;
      metaKey: boolean;
      ctrlKey: boolean;
      preventDefault: () => void;
    }) => void;
  }>(area);
  await act(async () => {
    props.onKeyDown({
      key: ev.key,
      metaKey: ev.metaKey ?? false,
      ctrlKey: ev.ctrlKey ?? false,
      preventDefault: () => void 0,
    });
  });
}

describe("RescueEditor 发送 / fork / 键盘路径", () => {
  beforeEach(resetDomEnv);
  afterEach(teardownDomEnv);

  it("发送中禁重入；失败文案两态；reject 面两种", async () => {
    const { container, stub } = await mountDock(twoTurnView, null);
    await openEditor(container);
    const gate = makeGate();
    let sends = 0;
    stub.actions.sendSameSession = (): Promise<unknown> => {
      sends += 1;
      return gate.promise;
    };
    await act(async () => {
      buttonByText(container, "重发（本会话）")!.click();
    });
    const busyBtn = buttonContaining(container, "发送中…");
    assert.ok(busyBtn, "busy 态按钮文案");
    // React 19 不在 disabled 按钮上派发 click（探针实证）：重入闸门只能由 handler
    // 直调命中——它守的是「事件层漏过来时也只发一次」这条不变量。
    await act(async () => {
      reactProps<{ onClick: () => void }>(busyBtn).onClick();
    });
    assert.equal(sends, 1, "run 的 busy 闸门挡住第二次");
    gate.release({ ok: false, code: "rejected" });
    await act(async () => {
      await flush();
    });
    assert.ok(
      container.textContent.includes("rejected: 操作失败"),
      "errText：code 前缀 + 默认消息",
    );

    stub.actions.sendSameSession = async (): Promise<unknown> => ({ ok: false, message: "仅消息" });
    await act(async () => {
      buttonByText(container, "重发（本会话）")!.click();
    });
    await act(async () => {
      await flush();
    });
    const afterSecond = container.textContent;
    assert.ok(afterSecond.includes("仅消息"), "errText：无 code 时不加前缀");
    assert.equal(afterSecond.includes("rejected"), false, "错误条只呈现最近一次");

    stub.actions.sendSameSession = async (): Promise<unknown> => {
      throw new Error(CARRIER_DOWN_MESSAGE);
    };
    await act(async () => {
      buttonByText(container, "重发（本会话）")!.click();
    });
    await act(async () => {
      await flush();
    });
    assert.ok(container.textContent.includes(CARRIER_DOWN_MESSAGE), "reject(Error) 面");

    const rawGate = makeGate();
    stub.actions.sendSameSession = (): Promise<unknown> => rawGate.promise;
    await act(async () => {
      buttonByText(container, "重发（本会话）")!.click();
    });
    rawGate.reject("raw-string-fail");
    await act(async () => {
      await flush();
    });
    assert.ok(container.textContent.includes("raw-string-fail"), "reject(非 Error) 面");
  });

  it("forkAtSeq 非空才出 Fork 按钮；点击走 forkAndSend 并关闭编辑器", async () => {
    const { container, stub } = await mountDock(twoTurnView, null);
    assert.equal(buttonByText(container, FORK_RESEND_LABEL), null, "编辑器未开时没有 fork");
    await openEditor(container);
    const forkBtn = buttonByText(container, FORK_RESEND_LABEL);
    assert.ok(forkBtn, "forkAtSeq 非空 → 出按钮");
    await act(async () => {
      forkBtn.click();
    });
    await act(async () => {
      await flush();
    });
    assert.deepEqual(stub.calls[0]?.args, ["s1", 3, "第二轮草稿"]);
    assert.equal(container.querySelector("textarea"), null, "成功后关闭编辑器");
    // 第一轮（无更早的已结束轮）→ 不给 fork 入口
    const { container: firstTurn } = await mountDock(
      {
        nodes: [{ kind: "user", seq: 1, turn: 1, content: [{ type: "text", text: "第一轮" }] }],
        turnEnds: new Map([[1, 3]]),
      },
      null,
    );
    await openEditor(firstTurn);
    assert.equal(buttonByText(firstTurn, FORK_RESEND_LABEL), null, "第一轮禁止 fork");
  });

  it("键盘：⌘Enter 与 Ctrl+Enter 都发送；无关键与空白草稿不动作", async () => {
    const { container, stub } = await mountDock(twoTurnView, null);
    await openEditor(container);
    await pressKey(container.querySelector("textarea")!, { key: "a" });
    assert.equal(stub.calls.length, 0, "无关按键不动作");
    await pressKey(container.querySelector("textarea")!, { key: "Enter", metaKey: true });
    await act(async () => {
      await flush();
    });
    assert.equal(stub.calls[0]?.name, "sendSameSession", "⌘Enter 发送");
    await openEditor(container);
    await pressKey(container.querySelector("textarea")!, { key: "Enter", ctrlKey: true });
    await act(async () => {
      await flush();
    });
    assert.equal(stub.calls.length, 2, "Ctrl+Enter 同样发送");
    await openEditor(container);
    await act(async () => {
      reactProps<{ onChange: (ev: { target: { value: string } }) => void }>(
        container.querySelector("textarea")!,
      ).onChange({ target: { value: "   " } });
    });
    await pressKey(container.querySelector("textarea")!, { key: "Enter", metaKey: true });
    await act(async () => {
      await flush();
    });
    assert.equal(stub.calls.length, 2, "空白草稿不发送");
    assert.ok(container.querySelector("textarea"), "编辑器仍在");
  });
});

// ── 排队区：撤回 / 保存编辑 / 取消编辑的真实点击链路 ──────────────────────

const queueView: Partial<DockView> = {
  queue: [
    { id: "q1", content: [{ type: "text", text: "甲" }] },
    { id: "q2", content: [{ type: "text", text: "乙" }] },
  ],
};

describe("QueueSection 撤回与编辑保存", () => {
  beforeEach(resetDomEnv);
  afterEach(teardownDomEnv);

  it("撤回成功不留错误条；失败 / 抛错 / 非 Error 抛错都进错误条", async () => {
    const { container, stub } = await mountDock(queueView, null);
    let withdraws = 0;
    stub.actions.withdrawQueueItem = async (): Promise<unknown> => {
      withdraws += 1;
      return withdraws === 1 ? { ok: true } : { ok: false, code: "gone", message: "已被消费" };
    };
    await act(async () => {
      buttonsNamed(container, "撤回")[0]!.click();
    });
    await act(async () => {
      await flush();
    });
    assert.equal(container.textContent.includes("已被消费"), false, "成功撤回不报错");
    await act(async () => {
      buttonsNamed(container, "撤回")[0]!.click();
    });
    await act(async () => {
      await flush();
    });
    assert.ok(container.textContent.includes("gone: 已被消费"), "失败可见（错误条渲染）");

    stub.actions.withdrawQueueItem = async (): Promise<unknown> => {
      throw new Error("queue-busy");
    };
    await act(async () => {
      buttonsNamed(container, "撤回")[0]!.click();
    });
    await act(async () => {
      await flush();
    });
    assert.ok(container.textContent.includes("queue-busy"), "抛 Error 面");

    const rawWithdraw = makeGate();
    stub.actions.withdrawQueueItem = (): Promise<unknown> => rawWithdraw.promise;
    await act(async () => {
      buttonsNamed(container, "撤回")[0]!.click();
    });
    rawWithdraw.reject("raw-queue-fail");
    await act(async () => {
      await flush();
    });
    assert.ok(container.textContent.includes("raw-queue-fail"), "抛非 Error 面");
  });

  it("保存编辑：失败保留编辑态并显示原因；取消按钮直接退出", async () => {
    const { container, stub } = await mountDock(queueView, null);
    await act(async () => {
      buttonsNamed(container, "编辑")[0]!.click();
    });
    await act(async () => {
      reactProps<{ onChange: (ev: { target: { value: string } }) => void }>(
        container.querySelector("textarea")!,
      ).onChange({ target: { value: "改后" } });
    });
    stub.actions.editQueueItem = async (): Promise<unknown> => ({ ok: false, message: "只此一条" });
    await act(async () => {
      buttonsNamed(container, "保存")[0]!.click();
    });
    await act(async () => {
      await flush();
    });
    assert.ok(container.textContent.includes("只此一条"), "保存失败文案");
    assert.ok(container.querySelector("textarea"), "失败后仍在编辑态（不丢草稿）");

    stub.actions.editQueueItem = async (): Promise<unknown> => {
      throw new Error("edit-busy");
    };
    await act(async () => {
      buttonsNamed(container, "保存")[0]!.click();
    });
    await act(async () => {
      await flush();
    });
    assert.ok(container.textContent.includes("edit-busy"), "保存抛错面");

    const rawEdit = makeGate();
    stub.actions.editQueueItem = (): Promise<unknown> => rawEdit.promise;
    await act(async () => {
      buttonsNamed(container, "保存")[0]!.click();
    });
    rawEdit.reject(RAW_EDIT_REJECT_REASON);
    await act(async () => {
      await flush();
    });
    assert.ok(container.textContent.includes(RAW_EDIT_REJECT_REASON), "保存抛非 Error 面");

    await act(async () => {
      buttonsNamed(container, "取消")[0]!.click();
    });
    assert.equal(container.querySelector("textarea"), null, "取消退出编辑态");
    assert.ok(container.textContent.includes(RAW_EDIT_REJECT_REASON), "错误条不因退出编辑而消失");
  });
});

// ── dock 动作行与 host 写通道（取消 / 开关）的失败面 ──────────────────────

const turnErrorNodes: DockNode[] = [
  { kind: "turn-error", seq: 2, turn: 1, message: "boom", code: "X" },
];

describe("dock 动作行与 host 写通道", () => {
  beforeEach(resetDomEnv);
  afterEach(teardownDomEnv);

  it("重试发出续跑文案；失败进错误条；无 target 时不出编辑入口", async () => {
    const { container, stub } = await mountDock(
      { nodes: turnErrorNodes, turnEnds: new Map([[1, 3]]) },
      null,
    );
    assert.equal(buttonByText(container, "编辑"), null, "无用户消息 → 编辑按钮不渲染");
    let runs = 0;
    const gate = makeGate();
    stub.actions.sendSameSession = (id: string, text: string): Promise<unknown> => {
      runs += 1;
      assert.equal(id, "s1");
      assert.ok(text.includes("[重试]"), "重试发送 RETRY_TEXT");
      return gate.promise;
    };
    await act(async () => {
      buttonByText(container, "重试")!.click();
    });
    // 与编辑器同理：disabled 按钮收不到 click，重入闸门由 handler 直调命中。
    await act(async () => {
      reactProps<{ onClick: () => void }>(buttonByText(container, "重试")!).onClick();
    });
    assert.equal(runs, 1, "runAction 的 busy 闸门挡住第二次");
    gate.release({ ok: true });
    await act(async () => {
      await flush();
    });
    stub.actions.sendSameSession = async (): Promise<unknown> => ({
      ok: false,
      code: "no-binding",
      message: "会话不可用",
    });
    await act(async () => {
      buttonByText(container, "重试")!.click();
    });
    await act(async () => {
      await flush();
    });
    assert.ok(container.textContent.includes("no-binding: 会话不可用"), "错误条可见");

    stub.actions.sendSameSession = async (): Promise<unknown> => {
      throw new Error("dock-blast");
    };
    await act(async () => {
      buttonByText(container, "重试")!.click();
    });
    await act(async () => {
      await flush();
    });
    assert.ok(container.textContent.includes("dock-blast"), "动作 reject(Error) 面");

    const bareDock = makeGate();
    stub.actions.sendSameSession = (): Promise<unknown> => bareDock.promise;
    await act(async () => {
      buttonByText(container, "重试")!.click();
    });
    bareDock.reject("dock-bare");
    await act(async () => {
      await flush();
    });
    assert.ok(container.textContent.includes("dock-bare"), "动作 reject(非 Error) 面");
  });

  it("继续输出走同一外壳；成功时不显示错误条", async () => {
    const { container, stub } = await mountDock(
      {
        nodes: [
          { kind: "user", seq: 1, turn: 1, content: [{ type: "text", text: "长文" }] },
          { kind: "turn-max-tokens", seq: 2, turn: 1 },
        ],
        turnEnds: new Map([[1, 3]]),
      },
      null,
    );
    assert.ok(buttonByText(container, "编辑"), "有 target → 编辑按钮在");
    await act(async () => {
      buttonByText(container, "继续输出")!.click();
    });
    await act(async () => {
      await flush();
    });
    assert.equal(stub.calls[0]?.name, "sendSameSession");
    assert.ok(String(stub.calls[0].args[1]).includes("从截断处继续"), "续写文案");
    assert.equal(container.textContent.includes("sr-error"), false);
  });

  it("停止重问：busy 文案 + 重入闸门 + 失败文案", async () => {
    const { container, stub } = await mountDock(
      {
        nodes: [{ kind: "user", seq: 1, turn: 2, content: [{ type: "text", text: "go" }] }],
        turnEnds: new Map([[2, 5]]),
        running: true,
      },
      null,
    );
    const gate = makeGate();
    let stops = 0;
    stub.actions.stopAndReask = (): Promise<unknown> => {
      stops += 1;
      return gate.promise;
    };
    await act(async () => {
      buttonContaining(container, "停止并重问")!.click();
    });
    const waiting = buttonContaining(container, "停止中…");
    assert.ok(waiting, "busy 态文案");
    await act(async () => {
      reactProps<{ onClick: () => void }>(waiting).onClick();
    });
    assert.equal(stops, 1, "重入闸门只放行一次");
    gate.release({ ok: false, code: "busy", message: "稍后再试" });
    await act(async () => {
      await flush();
    });
    assert.ok(container.textContent.includes("busy: 稍后再试"), "stopError 渲染");
  });

  it("取消/开关被 host 拒绝（{ok:false}）→ 文案可见；成功时不留痕", async () => {
    const body: RescueStateBody = {
      ok: true,
      sessions: {
        s1: {
          count: 1,
          lastFireAt: 0,
          pending: { turn: 2, kind: "resume", fireAt: 0, remainingMs: 5000 },
          disabled: false,
        },
      },
    };
    const { container } = await mountDock({}, body, "tok", {
      route: (url) =>
        url.startsWith(CANCEL_URL) || url.startsWith(TOGGLE_URL)
          ? { ok: true, body: { ok: false, error: "invalid csrf token" } }
          : { ok: true, body },
    });
    await act(async () => {
      buttonByText(container, "取消")!.click();
    });
    await act(async () => {
      await flush();
    });
    assert.ok(container.textContent.includes("取消未生效"), "取消失败必须可见");
    await act(async () => {
      buttonByText(container, "关闭")!.click();
    });
    await act(async () => {
      await flush();
    });
    assert.ok(container.textContent.includes("开关切换未生效"), "开关失败必须可见");

    const { container: okHost } = await mountDock({}, body, "tok", {
      route: (url) =>
        url === STATE_URL
          ? { ok: true, body }
          : { ok: true, body: { ok: true, cancelled: true, disabled: true } },
    });
    await act(async () => {
      buttonByText(okHost, "取消")!.click();
    });
    await act(async () => {
      buttonByText(okHost, "关闭")!.click();
    });
    await act(async () => {
      await flush();
    });
    assert.equal(okHost.textContent.includes("未生效"), false, "成功路径不留错误条");
  });

  it("未知 kind 的 pending 用兜底文案（Map 查表，原型键无从命中）", async () => {
    const body: RescueStateBody = {
      ok: true,
      sessions: {
        s1: {
          count: 0,
          lastFireAt: 0,
          pending: { turn: 1, kind: "constructor", fireAt: 0, remainingMs: 4000 },
          disabled: false,
        },
      },
    };
    const { container } = await mountDock({}, body);
    assert.ok(
      container.textContent.includes("瞬时失败，将在 4s 后自动续跑"),
      "闭合集之外的 kind 走兜底文案",
    );
  });
});

// ── 真实注入面：cardStore 快照稳定化 + set 的写后复读 ─────────────────────

interface InjectedCardStore {
  /** 本卡渲染视模型：status/writable 在官方快照上是必选位，视图同样按必选声明。 */
  getSnapshot: () => CardSnapshotView;
  subscribe: (listener: () => void) => () => void;
}

/** 取 plugins.bundle.config 的注入面（真实 cardStore + 绑到 scope 的 setAndVerify）。 */
function settingsWiring(ctx: MockClientCtx): {
  card: InjectedCardStore;
  set: (field: string, value: unknown) => Promise<string | null>;
  /** apply 经 ctx.locale.bind 拿到、再由 slot payload 下发的 translator。 */
  t: Translate;
  component: unknown;
} {
  const factory = ctx.slots.get(BUNDLE_CONFIG_SLOT);
  assert.ok(factory, "配置 slot 工厂应已注册");
  factory();
  const reg = ctx.registers[0]!;
  const injected = reg.inject!() as {
    hooks: { card: InjectedCardStore };
    set: (field: string, value: unknown) => Promise<string | null>;
    t: Translate;
  };
  return { card: injected.hooks.card, set: injected.set, t: injected.t, component: reg.component };
}

/** 把 mock 的官方配置表单变成"宿主真会落盘"的形态：写入即换快照身份。
 *  accept=false 模拟宿主校验拒绝——快照纹丝不动，且受理位回 false（官方
 *  `ConfigForm.set`：拒绝/跳过回 false，不抛）。卡片的判定点仍是事后复读，
 *  故本桩件的失败路径与 0.1.6 完全同形。 */
function reflectingScope(
  ctx: MockClientCtx,
  initial: Record<string, unknown>,
  accept: boolean,
): void {
  let snapshot: FormSnapshot = snap({ value: { ...initial } });
  ctx.scope.set = async (field: string, value: unknown): Promise<boolean> => {
    if (!accept) {
      return false;
    }
    // 换代必须换**引用**：cardStore 的 memo 靠引用相等判「未换代」。
    snapshot = snap({
      value: { ...snapshot.value, [field]: value },
      revision: (snapshot.revision ?? 0) + 1,
    });
    return true;
  };
  ctx.scope.getSnapshot = () => snapshot;
}

/** 用真实注入面（hooks.card + set + t）挂载设置卡，而不是测试自己的 useCard 替身。 */
async function mountInjectedSettingsCard(ctx: MockClientCtx): Promise<HTMLElement> {
  const { card, set, t, component } = settingsWiring(ctx);
  const comp = component as React.ComponentType<SettingsPropsForTest>;
  stubFetch(() => ({ ok: true, body: { ok: false, error: NO_PROVIDERS_ERROR } }));
  await mount(
    React.createElement(comp, {
      view: "page",
      t,
      useCard: (sel) => sel(card.getSnapshot()),
      set,
    }),
  );
  await act(async () => {
    await flush();
  });
  return mountHost;
}

describe("cardStore：快照引用稳定化与投影降级", () => {
  beforeEach(resetDomEnv);
  afterEach(teardownDomEnv);

  it("同一宿主快照复用缓存对象；subscribe 直通宿主 scope", () => {
    const ctx = applyWithCtx();
    reflectingScope(ctx, { enabled: true }, true);
    const { card } = settingsWiring(ctx);
    const first = card.getSnapshot();
    assert.deepEqual(first, { status: "ready", writable: true, value: { enabled: true } });
    assert.equal(card.getSnapshot(), first, "宿主快照未换代 → 复用缓存（防无限重渲染）");
    const unsubscribe = card.subscribe(() => {
      /* 宿主通知即触发重渲染 */
    });
    assert.equal(typeof unsubscribe, "function", "subscribe 直通 scope");
    unsubscribe();
  });

  it("快照换代才重算；首个快照受理前（value 缺席）→ 空对象；memory 只读位独立", async () => {
    const ctx = applyWithCtx();
    reflectingScope(ctx, { enabled: true }, true);
    const { card } = settingsWiring(ctx);
    const first = card.getSnapshot();
    await ctx.scope.set("enabled", false);
    assert.notEqual(card.getSnapshot(), first, "换代 → 重算视图");
    assert.deepEqual(card.getSnapshot(), {
      status: "ready",
      writable: true,
      value: { enabled: false },
    });
    // 原用例在这里喂 `value:"坏形状"` 与整个快照 `null`，断言它们被归一成空值。那是
    // 生产面写 `getSnapshot: () => unknown` 才存在的补救；绑官方后这些形状**不可表示**
    // （provider 侧 decode/derive 已把住这一层），故改钉官方真会送来的两态：
    // ① 首个快照受理前 value/revision 缺席 → 视图落到空对象；② memory 模式 writable 假。
    ctx.scope.getSnapshot = () =>
      snap({ status: "loading", value: undefined, revision: undefined });
    assert.deepEqual(card.getSnapshot(), { status: "loading", writable: true, value: {} });

    const memory = applyWithCtx();
    memory.scope.getSnapshot = () =>
      snap({ status: "unavailable", writable: false, mode: "memory", value: undefined });
    assert.deepEqual(settingsWiring(memory).card.getSnapshot(), {
      status: "unavailable",
      writable: false,
      value: {},
    });
  });
});

describe("setAndVerify：写后复读才是唯一判定点", () => {
  beforeEach(resetDomEnv);
  afterEach(teardownDomEnv);

  it("复读一致 → null（false 这类假值也要按值比，不能按真假比）", async () => {
    const ctx = applyWithCtx();
    reflectingScope(ctx, { enabled: true }, true);
    const { set } = settingsWiring(ctx);
    assert.equal(await set("enabled", false), null, "落库成功 → 无错误");
    assert.deepEqual(ctx.scope.getSnapshot().value, { enabled: false });
  });

  it("宿主回退旧值 → 返回可见文案（被拒不得报「已保存」）", async () => {
    const ctx = applyWithCtx();
    reflectingScope(ctx, { maxResumes: 3 }, false);
    const { set } = settingsWiring(ctx);
    assert.match((await set("maxResumes", 9)) ?? "", /未被宿主接受/u);
  });

  it("undefined 与缺失等价；value 尚未受理（官方 undefined）时按 null 比较", async () => {
    const ctx = applyWithCtx();
    reflectingScope(ctx, {}, true);
    const { set } = settingsWiring(ctx);
    // 官方快照的 value 位是 `T | undefined`（首个快照受理前真的是 undefined），所以
    // 这里不再伪造「value 是非对象」那种宿主送不出的形状。
    ctx.scope.getSnapshot = () => snap({ status: "loading", value: undefined });
    assert.equal(await set("providerExcludes", undefined), null, "两侧都是 undefined → 视为一致");
    ctx.scope.getSnapshot = () => snap({ value: {} });
    assert.match((await set("providerExcludes", ["a"])) ?? "", /未被宿主接受/u);
  });
});

describe("设置卡保存闭环（真实 hooks.card + setAndVerify）", () => {
  beforeEach(resetDomEnv);
  afterEach(teardownDomEnv);

  it("改开关 → 保存 → 宿主落库 → 草稿清空回到无改动态", async () => {
    const ctx = applyWithCtx();
    reflectingScope(ctx, { enabled: true, providerExcludes: [] }, true);
    const container = await mountInjectedSettingsCard(ctx);
    const sw = container.querySelector<HTMLButtonElement>(ENABLE_TOGGLE_SELECTOR);
    assert.ok(sw);
    assert.equal(sw.getAttribute("aria-checked"), "true");
    await act(async () => {
      sw.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(SAVE_BUTTON_SELECTOR)!.click();
    });
    await act(async () => {
      await flush();
    });
    const full = container.textContent;
    assert.equal(full.includes("保存失败"), false, "落库成功不该报错");
    assert.equal(full.includes("未被宿主接受"), false);
    assert.equal(
      container.querySelector<HTMLButtonElement>(SAVE_BUTTON_SELECTOR)!.disabled,
      true,
      "touched 清空 → 回到无改动",
    );
    assert.equal(
      container
        .querySelector<HTMLButtonElement>(ENABLE_TOGGLE_SELECTOR)!
        .getAttribute("aria-checked"),
      "false",
      "显示值取自宿主快照回读",
    );
  });

  it("宿主拒绝写入 → 文案可见且草稿保留（可原地重试）", async () => {
    const ctx = applyWithCtx();
    reflectingScope(ctx, { enabled: true, providerExcludes: [] }, false);
    const container = await mountInjectedSettingsCard(ctx);
    await act(async () => {
      container.querySelector<HTMLButtonElement>(ENABLE_TOGGLE_SELECTOR)!.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(SAVE_BUTTON_SELECTOR)!.click();
    });
    await act(async () => {
      await flush();
    });
    assert.ok(container.textContent.includes("enabled 未被宿主接受"), "拒绝必须可见");
    assert.equal(
      container.querySelector<HTMLButtonElement>(SAVE_BUTTON_SELECTOR)!.disabled,
      false,
      "草稿保留 → 仍可点保存重试",
    );
  });

  it("数值行：非数字/越界不进 touched；无改动时保存直接返回", async () => {
    const ctx = applyWithCtx();
    reflectingScope(ctx, { enabled: true, resumeDelayMs: 10_000 }, true);
    const container = await mountInjectedSettingsCard(ctx);
    const saveBtn = (): HTMLButtonElement =>
      container.querySelector<HTMLButtonElement>(SAVE_BUTTON_SELECTOR)!;
    await act(async () => {
      reactProps<{ onChange: (ev: { target: { value: string } }) => void }>(
        container.querySelector<HTMLInputElement>(RESUME_DELAY_INPUT_SELECTOR)!,
      ).onChange({ target: { value: "abc" } });
    });
    await act(async () => {
      reactProps<{ onKeyDown: (ev: { key: string; preventDefault: () => void }) => void }>(
        container.querySelector<HTMLInputElement>(RESUME_DELAY_INPUT_SELECTOR)!,
      ).onKeyDown({ key: "Tab", preventDefault: () => void 0 });
    });
    assert.equal(saveBtn().disabled, true, "非 Enter 不提交");
    await act(async () => {
      reactProps<{ onKeyDown: (ev: { key: string; preventDefault: () => void }) => void }>(
        container.querySelector<HTMLInputElement>(RESUME_DELAY_INPUT_SELECTOR)!,
      ).onKeyDown({ key: "Enter", preventDefault: () => void 0 });
    });
    assert.equal(saveBtn().disabled, true, "abc 不是有效数值 → 不入 touched");
    const before = JSON.stringify(ctx.scope.getSnapshot().value);
    // disabled 按钮收不到 click（React 19），陈旧 handler 直调命中的正是 save 的
    // `!dirty` 早退闸门——它保证任何路径下都不会发出空写入。
    await act(async () => {
      reactProps<{ onClick: () => void }>(saveBtn()).onClick();
    });
    await act(async () => {
      await flush();
    });
    assert.equal(JSON.stringify(ctx.scope.getSnapshot().value), before, "无改动 → 一次都不写");
  });
});

// ── RetryPolicySection：传输面失败与暂存语义 ──────────────────────────────

function callsTo(url: string): number {
  return fetchCalls.filter((entry) => entry.url.startsWith(url)).length;
}

async function pickPreset(container: HTMLElement, index: number, preset: string): Promise<void> {
  const selects = [...container.querySelectorAll("select")] as HTMLSelectElement[];
  const picked = selects[index];
  assert.ok(picked, `第 ${String(index)} 行下拉存在`);
  await act(async () => {
    changeSelect(picked, preset);
  });
}

async function clickRetrySave(container: HTMLElement): Promise<void> {
  const saveBtn = container.querySelector<HTMLButtonElement>(RETRY_SAVE_BUTTON_SELECTOR);
  assert.ok(saveBtn);
  await act(async () => {
    saveBtn.click();
  });
  await act(async () => {
    await flush();
  });
}

const xkiroRow = { provider: "xkiro", mode: "normal", maxRetries: 5, hasQuota: false };

describe("RetryPolicySection 传输面与暂存语义", () => {
  beforeEach(resetDomEnv);
  afterEach(teardownDomEnv);

  it("档位推断含 off；坏字段按空值降级；非对象行直接丢弃", async () => {
    const { container } = await mountSettingsCard({ enabled: true }, {}, undefined, (url) =>
      url === PROVIDERS_URL
        ? {
            ok: true,
            body: {
              ok: true,
              providers: [
                { provider: "zero", mode: "normal", maxRetries: 0, hasQuota: false },
                { provider: 42, mode: 7, maxRetries: "x", hasQuota: "yes" },
                "not-a-row",
              ],
            },
          }
        : { ok: true, body: { ok: true, sessions: {} } },
    );
    const selects = [...container.querySelectorAll("select")] as HTMLSelectElement[];
    assert.equal(selects.length, 2, "非对象行丢弃");
    assert.equal(selects[0]!.value, "off", "maxRetries 0 → off 档");
    assert.equal(selects[1]!.value, "off", "坏字段降级后仍是 off");
    assert.ok(container.textContent.includes("normal · max 0 · QUOTA ✗"));
  });

  it("providers GET 非 2xx → HTTP 状态码；GET reject → 异常文案", async () => {
    const { container } = await mountSettingsCard({ enabled: true }, {}, undefined, (url) =>
      url === PROVIDERS_URL
        ? { ok: false, status: 502, body: null }
        : { ok: true, body: { ok: true, sessions: {} } },
    );
    assert.ok(container.textContent.includes("官方 retryPolicy 面不可用：HTTP 502"));
    await unmountRoot();
    const { container: thrown } = await mountSettingsCard(
      { enabled: true },
      {},
      undefined,
      (url) => {
        if (url === PROVIDERS_URL) {
          throw new Error("offline");
        }
        return { ok: true, body: { ok: true, sessions: {} } };
      },
    );
    assert.ok(thrown.textContent.includes("offline"), "拉取抛错也归不可用");
  });

  it("host 拒绝落盘 → 保留暂存并显示原因；重试不再裸拉 state", async () => {
    const { container } = await mountSettingsCard({ enabled: true }, {}, undefined, (url) => {
      if (url === PROVIDERS_URL) {
        return { ok: true, body: { ok: true, providers: [xkiroRow] } };
      }
      if (url === POLICY_URL) {
        return { ok: true, body: { ok: false, error: SETTINGS_REJECT_REASON } };
      }
      return { ok: true, body: { ok: true, csrf: "tok-1", sessions: {} } };
    });
    await pickPreset(container, 0, "off");
    await clickRetrySave(container);
    const full = container.textContent;
    assert.ok(full.includes("保存失败：xkiro→off: settings-rejected"), "host 文案可见");
    assert.ok(full.includes("保存（1 个改动）"), "失败的档位仍是用户意图");
    assert.equal(callsTo(STATE_URL), 1, "首轮无 token → 先回填");
    await clickRetrySave(container);
    assert.equal(callsTo(STATE_URL), 1, "token 已在 → 第二轮不再拉 state");
    assert.equal(callsTo(POLICY_URL), 2, "第二轮重发 POST");
  });

  it("落盘 503 且响应体非 JSON → 按状态码报告；非 Error reject → 原值入文案", async () => {
    let policyRoute: FetchRoute = { ok: false, status: 503, body: null, badJson: true };
    const { container } = await mountSettingsCard({ enabled: true }, {}, undefined, (url) => {
      if (url === PROVIDERS_URL) {
        return { ok: true, body: { ok: true, providers: [xkiroRow] } };
      }
      if (url === POLICY_URL) {
        return policyRoute;
      }
      return { ok: true, body: { ok: true, sessions: {} } };
    });
    rescueCsrfStore.token = "tok-1";
    await pickPreset(container, 0, "enhanced");
    await clickRetrySave(container);
    assert.ok(container.textContent.includes("xkiro→enhanced: HTTP 503"), "按状态码报告");
    policyRoute = { ok: true, body: null, rejectWith: "carrier-bare" };
    await clickRetrySave(container);
    assert.ok(
      container.textContent.includes("保存失败：carrier-bare"),
      "非 Error reject 也进文案（不显示 undefined）",
    );
  });

  it("csrf 回填失败（非 2xx / 非对象体）只降级不阻断：POST 仍照发", async () => {
    let stateRoute: FetchRoute = { ok: false, status: 500, body: null };
    const { container } = await mountSettingsCard({ enabled: true }, {}, undefined, (url) => {
      if (url === PROVIDERS_URL) {
        return {
          ok: true,
          body: {
            ok: true,
            providers: [
              xkiroRow,
              { provider: "ag", mode: "normal", maxRetries: 5, hasQuota: false },
            ],
          },
        };
      }
      if (url === STATE_URL) {
        return stateRoute;
      }
      return { ok: true, body: { ok: true } };
    });
    await pickPreset(container, 0, "off");
    await clickRetrySave(container);
    assert.equal(container.textContent.includes("保存（1 个改动）"), false, "落盘成功清空暂存");
    stateRoute = { ok: true, body: NOT_A_RECORD_VALUE };
    await pickPreset(container, 1, "always");
    await clickRetrySave(container);
    assert.equal(callsTo(POLICY_URL), 2, "回填失败仍发出 POST（host 自己判 403）");
  });

  it("撤销清空暂存；改回当前档位等同撤销；无暂存时保存直接返回", async () => {
    const { container } = await mountSettingsCard({ enabled: true }, {}, undefined, (url) => {
      if (url === PROVIDERS_URL) {
        return { ok: true, body: { ok: true, providers: [xkiroRow] } };
      }
      if (url === POLICY_URL) {
        return { ok: true, body: { ok: true } };
      }
      return { ok: true, body: { ok: true, csrf: "tok-1", sessions: {} } };
    });
    rescueCsrfStore.token = "tok-1";
    await pickPreset(container, 0, "off");
    assert.ok(container.textContent.includes("保存（1 个改动）"));
    await pickPreset(container, 0, "default");
    assert.equal(container.textContent.includes("保存（1 个改动）"), false, "改回原档位即无改动");
    const retrySave = container.querySelector<HTMLButtonElement>(RETRY_SAVE_BUTTON_SELECTOR);
    assert.ok(retrySave);
    assert.equal(retrySave.disabled, true);
    // 陈旧 handler 直调：saveAll 的 dirtyCount===0 早退兜住任何越过的点击。
    await act(async () => {
      reactProps<{ onClick: () => void }>(retrySave).onClick();
    });
    await act(async () => {
      await flush();
    });
    assert.equal(callsTo(POLICY_URL), 0, "无暂存时一个 POST 都不发");
    await pickPreset(container, 0, "always");
    const discard = container.querySelector<HTMLButtonElement>('[data-field="retry-discard"]');
    assert.ok(discard);
    await act(async () => {
      discard.click();
    });
    assert.equal(container.textContent.includes("保存（1 个改动）"), false, "撤销后回到无改动");
    assert.equal(callsTo(POLICY_URL), 0, "撤销不发 POST");
  });
});

describe("写通道自身的抛错面（save 的 catch）", () => {
  beforeEach(resetDomEnv);
  afterEach(teardownDomEnv);

  it("set 以非 Error reject → 原值进文案（不显示 undefined）", async () => {
    const bareWrite = makeGate();
    const { container } = await mountSettingsCard(
      { enabled: true, resumeDelayMs: 10_000 },
      {},
      (): Promise<unknown> => bareWrite.promise,
    );
    await act(async () => {
      reactProps<{ onChange: (ev: { target: { value: string } }) => void }>(
        container.querySelector<HTMLInputElement>(RESUME_DELAY_INPUT_SELECTOR)!,
      ).onChange({ target: { value: "15000" } });
    });
    await act(async () => {
      reactProps<{ onKeyDown: (ev: { key: string; preventDefault: () => void }) => void }>(
        container.querySelector<HTMLInputElement>(RESUME_DELAY_INPUT_SELECTOR)!,
      ).onKeyDown({ key: "Enter", preventDefault: () => void 0 });
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(SAVE_BUTTON_SELECTOR)!.click();
    });
    bareWrite.reject("bare-write-fail");
    await act(async () => {
      await flush();
    });
    assert.ok(
      container.textContent.includes("保存失败：bare-write-fail"),
      "非 Error 抛错同样要可见",
    );
  });
});

// ── i18n：dock 与卡片文案取自官方 locale 字典（切语言 = 换 translator）──────
describe("卡片双语（@deepseek-ai/dsh-client-locale 契约）", () => {
  beforeEach(resetDomEnv);
  afterEach(teardownDomEnv);

  /** 一条瞬时失败待办：横幅 + 取消按钮 + 开关行，覆盖 dock 三类文案面。 */
  const pendingBody: RescueStateBody = {
    ok: true,
    sessions: {
      s1: {
        count: 1,
        lastFireAt: 0,
        pending: { turn: 2, kind: "resume", fireAt: 0, remainingMs: 5000 },
        disabled: false,
      },
    },
  };

  it("apply 向官方 locale 一次性注册本包两语字典（内容即 UI_MESSAGES）", () => {
    const ctx = applyWithCtx();
    assert.deepEqual(
      ctx.locales.map((row) => row.ns),
      ["session-rescue"],
      "字典按本包命名空间注册进官方 locale，且只注册一次（官方类型化重载两语一次交齐）",
    );
    // 命名空间字面量必须就是 cordis.patch.yml 的裸 `- id:`：`LocaleNamespaceMap` 的 merge
    // 键位是字面量（见 src/ui-messages.ts），抄错一处 = bind 落回未类型化重载、运行时查不到字典。
    assert.equal(ctx.locales[0]?.ns, patchEntryId(), "locale 命名空间 = profile 条目 id");
    assert.equal(ctx.locales[0].dicts.zh.cardSummary, UI_MESSAGES.zh.cardSummary);
    assert.equal(ctx.locales[0].dicts.en.cardSummary, UI_MESSAGES.en.cardSummary);
  });

  it("apply 取配置表单用的是本条目的 profile id（= 0.1.7 的 settings 命名空间）", () => {
    // 0.1.7 没有 register 声明 ns 这一步：命名空间 = profile 条目 id（installed
    // dsh-settings/lib/index.js:443 的 `ns: entry.options.id`），而 client 侧
    // `configForms.get(entryId)`（installed config-form.d.ts:142）按同一个 id 取表单。
    // 取错 id 的形状是「卡片能打开、保存却写进别的条目」，两侧各写各的常量就会漂移，
    // 故这里把 client 取的 id 钉在 cordis.patch.yml 上（host.test.ts 用同一个 helper
    // 钉 host 侧），且只取一次。
    const ctx = applyWithCtx();
    assert.deepEqual(ctx.formEntryIds, [patchEntryId()]);
  });

  it("en 装配渲染整张设置卡：字段与按钮是英文，且不残留中文", async () => {
    // 走真实注入面：t 由 apply 的 ctx.locale.bind 产出、经 slot payload 下发到卡片 props。
    const ctx = applyWithCtx(tEn);
    reflectingScope(ctx, { enabled: true, providerExcludes: [] }, true);
    const container = await mountInjectedSettingsCard(ctx);
    const text = container.textContent;
    assert.match(text, /Enable auto-resume/u, "英文开关 label");
    assert.match(text, /Resume delay \(ms\)/u, "英文数值行 label");
    assert.match(text, /Save/u, "英文保存按钮");
    assert.doesNotMatch(text, /[一-鿿]/u, "整卡不该混进中文");
  });

  it("zh 装配渲染同一张设置卡：中文 label 在位（两语走同一渲染路径）", async () => {
    const ctx = applyWithCtx();
    reflectingScope(ctx, { enabled: true, providerExcludes: [] }, true);
    const container = await mountInjectedSettingsCard(ctx);
    assert.match(container.textContent, /启用自动续跑/u);
  });

  it("en 字典渲染 dock：横幅倒计时与按钮都是英文，不残留中文", async () => {
    const { container } = await mountDock({}, pendingBody, "", { t: tEn });
    const text = container.textContent;
    assert.match(text, /auto-resume in 5s/u, "英文倒计时横幅");
    assert.match(text, /Auto-resume \(this session\)/u, "英文开关行标题");
    assert.ok(buttonByText(container, "Cancel") !== null, "英文取消按钮");
    assert.doesNotMatch(text, /[一-鿿]/u, "整条 dock 不该混进中文");
  });

  it("zh 字典渲染同一条 dock 横幅：中文在位（同一渲染路径换语言）", async () => {
    const { container } = await mountDock({}, pendingBody, "", { t: tZh });
    assert.match(container.textContent, /5s 后自动续跑/u);
  });

  it("两语模板的 {占位符} 集合一致（翻译不会漏掉插值）", () => {
    for (const key of Object.keys(UI_MESSAGES.zh) as (keyof UiMessages)[]) {
      assert.deepEqual(
        placeholders(UI_MESSAGES.en[key]),
        placeholders(UI_MESSAGES.zh[key]),
        `${key} 占位符不一致`,
      );
    }
  });
});
