// src/client-entry.ts — session-rescue client UI 主体（rolldown 打包入口）。
// 打包：pnpm build:client → build-client.mjs 把本文件 + lib/transcript.ts 一起
// 打成 client.js（window.__ModuleLoader__.load UMD factory）。react 外部化：
// factory 的 require('react') 由模块系统提供。React 只用 createElement；
// 颜色只走 --dsw-alias-* token。
//
// 数据源纪律（0.1.2-alpha.1 实测）：
//   nodes/turnEnds/runningCalls ← useChat((c) => c.legacy)
//   running/removed/lastAgentError/queue ← useSession
// 组件合并成 view 后再调 transcript 函数。禁止从 useSession 读 nodes。

import { createElement, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { BuiltInLocaleId } from "@deepseek-ai/dsh-client-locale/client";
// plugin-manager 是 `plugins.bundle.config` 这条 keyed 槽的**属主**（installed
// `dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:111-116`，文件头明写
// 「A registrant merges this contract with `import type` and registers through `ctx.slots`;
// it never imports this package at runtime」）。本包不再手抄那份 merge 的形状，改为直接
// 用属主交出的两位：`PluginConfigViewProps['view']`（卡片的两视图判别位，见
// SettingsCardProps）与 `ConfigPageForm['state']`（配置页交给卡片的状态快照，见
// FormSnapshot）。属主一改形状，这两处当场红。
import type {
  ConfigPageForm,
  PluginConfigViewProps,
} from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
// dock 组件读的四位 standard kit 归两家所有，按官方成员类型绑定：
// `useSession` 的席位类型是 dsh-client-ui-session 交出的 `SessionSnapshotSelector`
//（其 lib/types/client/index.d.ts:9，同文件 :77-84 把它 merge 进 `SessionStandardProps`，
// 一并 merge 的还有 `sessionId: SessionId` 与 `useProjection`）；`useChat` 是
// dsh-client-ui-chat 的 `UseChat`（其 contract/slots.d.ts:20
// `= SnapshotSelectorHook<ChatSnapshot>`，:275-279 merge 进同一张表）。
// 引这两个名字同时起到「把那两条 `declare module` 载入本 program」的作用——
// 不载入的话 `SessionStandardProps` 上根本看不见这四位。
import type { UseChat } from "@deepseek-ai/dsh-client-ui-chat/client";
import type { SessionSnapshotSelector } from "@deepseek-ai/dsh-client-ui-session/client";
import type { LocaleDictOf, SessionStandardProps } from "@deepseek-ai/dsh-client-ui-slots";
// 会话对象层的官方面：`binding()` 借出**已被 retain** 的 binding（返回 `SessionBinding`
// 本身，其 `.session` 才是 `SessionFace`），`fork()` 交回 `SessionId`，`using()` 在一段
// 操作周围自己持有引用（新 fork 出的子会话此刻还没有任何视图引用它，故走 using 而不是
// binding）。全部按 `ISessions` 的成员索引，不再本地重述签名。
import type {
  ISessions,
  SessionBinding,
  SessionReferenceSource,
} from "@deepseek-ai/dsh-api-session-controller/client";
// Remote 调用的统一返回包（`prompt`/`cancel` 的返回都挂在它上面）。
import type { RemoteFailure, RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
// `openSession` 属主是 workspace 导航服务（`ctx.uiWorkspace`）——官方 `ISessions` 上
// **没有** `open`：`sessions.list` 的注释明写「navigation belongs to view owners」。
import type { UiWorkspace } from "@deepseek-ai/dsh-client-ui-workspace/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { TextBlock } from "@deepseek-ai/dsh-llm";
import type { SlotRegistry } from "@deepseek-ai/dsh-client-ui-renderer/client";
import type { ConfigForm } from "@deepseek-ai/dsh-client-ui-settings/client";
import {
  failureOfLastTurn,
  hostRetryPending,
  lastCompletedUserTarget,
  lastUserNode,
  userText,
} from "../lib/transcript.ts";
import type { CompletedUserTarget } from "../lib/transcript.ts";
// 视图形状在 lib/turn-scope.ts（transcript.ts 的 failureOfLastTurn 从那层读法往上组合，
// 形状必须留在读法那一层才不构成两个模块互相引用），本文件的 view 装箱与 dock 决策
// 吃的仍是同一份投影。
import type { TranscriptView } from "../lib/turn-scope.ts";
import { decideDockState, parseStateBody } from "../lib/dock-state.ts";
import type { RescuePending, RescueStateBody, ToggleState } from "../lib/dock-state.ts";
import { UI_MESSAGES } from "./ui-messages.ts";
import type { LocaleNs, Translate, UiMessages } from "./ui-messages.ts";
import { fieldOf, isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { z } from "zod";
import { claimApply } from "@jayyuen66/dsh-plugin-shared/lib/card-apply";
import { diffTouched } from "@jayyuen66/dsh-plugin-shared/lib/card-diff";
import {
  CARD_UI_CSS,
  CardForm,
  NumberField,
  SaveBar,
  Section,
  SelectField,
  TextField,
  ToggleField,
  splitHint,
} from "@jayyuen66/dsh-plugin-shared/lib/card-ui";
import type { SelectOption } from "@jayyuen66/dsh-plugin-shared/lib/card-ui";
import { createRescueReader } from "./remote.ts";
import type { RescueReader } from "./remote.ts";

// NS 的字面量形态是**承重**的：test/profile-bundle.ts 的漂移针从产物里按
// `const NS = "…"` 抓这条声明，再与 cordis.patch.yml 的裸 `- id:` 比对（写成别名
// 就让那条针取不到值）；类型标注不改变产物，针照旧抓得到。同一条串的另外两位（文案
// 命名空间本源、引用标签 REFERENCE_SOURCE_KEY）各自由 `LocaleNs` 与该常量本身钉住。
const NS: LocaleNs = "session-rescue";

// ⚠ 两个**不同**的标识，别混用（混用过的形状：卡片打不开 / 保存写进别的条目）：
//  - `NS` = loader 条目 id = settings 命名空间 = `configForms.get(NS)` 的入参，
//    真源是本包 cordis.patch.yml 的裸 `- id:`（宿主读 `entry.options.id`）。
//  - 下面这个常量 = 本包在 profile 里那条 bundle 的**包名**，只当槽位 key 用。
// `plugins.bundle.config` 是按 bundle 包名 keyed 的槽位：宿主把注册项的 key 与
// bundle 包名精确相等匹配后才渲染（installed
// dsh-client-ui-plugin-manager/lib/client.js:2762 的
// `renderSlot("plugins.bundle.config", { view: "page" }, { entryKey: pkg.name })` →
// dsh-client-ui-renderer/lib/client.js:1154 的 `e.options.key === opts?.entryKey`；
// 同文件 :3791 的 `configured: ledger.bundles.has(openPkg.name)` 读的就是这批 key），
// 契约文本 installed dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:111-113
// （"keyed by the bundle's package name"），首方先例
// dsh-experimental-client-ui-voice-input/lib/client.js:5659-5661。
// 写成裸条目 id（`session-rescue`）时 ledger 里没有这个键 → 插件页永不出卡。
// 包名真源：`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`；
// test/profile-bundle.ts 把真源读进测试，test/build-client.test.ts 的漂移针据此钉。
// 注意 dock 那侧的 `id: "session-rescue"` 是 list 槽的条目 id，与本常量无关，别一起改。

/**
 * 本包持有 Client 引用（retain）时使用的消费者标签。官方
 * `SessionReferenceSource = Extract<keyof SessionReferenceSourceMap, string>` 是
 * merge-extensible 表（installed dsh-api-session-controller/lib/types/client/index.d.ts:17-25
 * 「Consumer-owned reference labels; extend this map through the package's canonical
 * /client entry」），宿主自带各包就是这样自己并入一条（如 dsh-client-ui-session
 * 在其 client/index.d.ts:95）。本包是消费者，故按同一机制声明自己的那一条。
 */
declare module "@deepseek-ai/dsh-api-session-controller/client" {
  interface SessionReferenceSourceMap {
    /** session-rescue 的 fork 分支重发：在发送期间持有一份子会话引用。 */
    "session-rescue": null;
  }
}

/** 编译期契约：上面 merge 的键与本包条目 id 必须是同一个串——取 NS 而不是再抄一遍字面量，
 *  下一行的 `SessionReferenceSource` 赋值仍然钉得住（改了 merge 键或改了 NS 都当场红）。 */
export const REFERENCE_SOURCE_KEY = NS;
const SESSION_RESCUE_SOURCE: SessionReferenceSource = REFERENCE_SOURCE_KEY;
const BUNDLE_PKG = "@jayyuen66/dsh-session-rescue";

/** 从对象安全读字段：字面量键走变量参数，绕开 dot-notation 与
 *  noPropertyAccessFromIndexSignature（tsc 禁索引签名点访问）的互斥。 */
// 发给模型的重发/续写正文（dock 两个按钮产出）不再住在模块常量里，而是取自
// UI_MESSAGES 双语字典（语言由官方 ctx.locale 决定，见 apply 的 bind）。

const CSS = [
  ".sr-row{display:flex;align-items:center;gap:6px;padding:2px 0;align-self:flex-start}",
  ".sr-button{appearance:none;border:1px solid var(--dsw-alias-border,#d8dbe2);color:var(--dsw-alias-label-secondary,inherit);background:transparent;border-radius:4px;padding:0 8px;font:inherit;font-size:12px;line-height:20px;cursor:pointer}",
  ".sr-button:hover:not(:disabled){background:var(--dsw-alias-fill-secondary,rgba(0,0,0,.05))}",
  ".sr-button:disabled{opacity:.5;cursor:not-allowed}",
  ".sr-primary{border-color:var(--dsw-alias-brand-primary,#2f6fed);color:var(--dsw-alias-brand-primary,#2f6fed)}",
  ".sr-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2f6fed);outline-offset:1px}",
  ".sr-editor{display:flex;flex-direction:column;gap:6px;padding:6px 0}",
  ".sr-textarea{width:100%;min-height:72px;resize:vertical;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-fill-primary,transparent);border:1px solid var(--dsw-alias-border-l3,#d8dbe2);border-radius:6px;padding:8px;box-sizing:border-box}",
  ".sr-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f99)}",
  ".sr-error{font-size:12px;color:var(--dsw-alias-text-danger,#d33)}",
  // dock 宽度对齐会话内容列（与 ._0Z7gsa_column 同款居中约束）
  ".sr-dock{box-sizing:border-box;width:100%;max-width:var(--dsh-chat-content-width,748px);margin:0 auto;display:flex;flex-direction:column;gap:4px;padding:4px 0;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary,inherit)}",
  ".sr-banner{display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border,#d8dbe2);border-radius:6px;padding:4px 8px}",
].join("\n");

// ── host 状态轮询（自排循环：有 pending 走 1s、空闲走 5s；无订阅或页签隐藏即停）
// 快照引用稳定化：每一跳解析都产出新对象，若直接赋给 data，useSyncExternalStore
// 的 getSnapshot 每秒返回新引用 → dock 每秒强制重渲染（即使内容未变）。
// 稳定化策略：JSON 序列化对比，仅当内容实际变化才替换 data 引用。

/** kind → 横幅文案键（活跃态 = 带倒计时的整行模板，挂起态 = 断连待重连的整行）。
 *  新增 kind 只需在此加一行，避免 banner 里再堆叠三元表达式。用 Map 而非字面量对象：
 *  pending.kind 来自 host 载荷（不可信字符串），`PENDING_BANNERS["constructor"]` 这类
 *  原型键会命中 Object.prototype 上的成员并绕过 `??` 兜底，把 undefined 当文案键传给 t()。 */
interface PendingBanners {
  /** 正常待办（倒计时）整行模板键。 */
  readonly active: keyof UiMessages;
  /** 连接中断挂起态整行键。 */
  readonly suspended: keyof UiMessages;
}
const PENDING_BANNER_FALLBACK: PendingBanners = {
  active: "bannerResume",
  suspended: "bannerSuspendedResume",
};
const PENDING_BANNERS = new Map<string, PendingBanners>([
  ["resume", PENDING_BANNER_FALLBACK],
  ["continue", { active: "bannerContinue", suspended: "bannerSuspendedContinue" }],
  ["unfinished", { active: "bannerUnfinished", suspended: "bannerSuspendedUnfinished" }],
]);

// host 状态类型（RescuePending / RescueSessionState / RescueStateBody）统一
// 从 lib/dock-state.ts 导入——dock 渲染决策与类型定义同源，避免漂移。

export interface RescueStateStore {
  data: RescueStateBody | null;
  stableKey: string;
  listeners: Set<() => void>;
  /** 下一跳的一次性定时器句柄。自排循环而非 setInterval：周期要按快照档位变。 */
  timer: ReturnType<typeof setTimeout> | null;
  /** /state 是否在飞。在飞期间新订阅不补发——订阅抖动才不会放大成连发。 */
  inFlight: boolean;
  /** 官方 Remote 读面；`undefined` = 当前部署没有远程面（数据面显示读不到）。 */
  reader: RescueReader | undefined;
  /** 连着多少跳没读到有效快照（0=上一跳有效）。决定退避档位与快照是否过期。 */
  failStreak: number;
  refresh: () => Promise<void>;
  schedule: () => void;
  stop: () => void;
  subscribe: (listener: () => void) => () => void;
  syncVisibility: () => void;
  getSnapshot: () => RescueStateBody | null;
}

/** 有 pending 时的周期：横幅按秒走倒计时，慢档会让显示的剩余时间明显过期。 */
export const ACTIVE_POLL_MS = 1000;

/** 无 pending 时的兜底周期：没有倒计时在跑，轮询只为发现 host 侧新出现的
 *  pending。不分档位一律 1Hz 的老口径，空闲页签也每秒打一发 /state。 */
export const IDLE_POLL_MS = 5000;

/** 连着这么多跳读不到有效快照 ⇒ 手上那份判定为过期（交回 null = rescueKnown=false，
 *  开关行转中性态）。留三跳的余量：一次网络抖动不该把倒计时横幅清空。 */
const STALE_AFTER_FAILURES = 3;

/** 一直读不到时的周期上限。host 压根不在（网关态、host 已退出）时还按档打 /state，
 *  等于把「读不到」实现成本机端口上每秒一发的高频轰炸。 */
export const DEAD_POLL_CEILING_MS = 30_000;

/** 退避：连跳越多间隔越长（翻倍），封顶 DEAD_POLL_CEILING_MS（导出仅供单测）。
 *  `failStreak` 为 0/1 都交回原档：0 是「上一跳有效」，1 是「刚失败一次」，
 *  两者都不该让周期凭空减半或加倍。 */
export function backoffMs(base: number, failStreak: number): number {
  return failStreak <= 1 ? base : Math.min(base * 2 ** (failStreak - 1), DEAD_POLL_CEILING_MS);
}

/** 取一跳 /state（经官方 Remote 的 `sessionRescue.state()`）。交回非记录、`ok!==true`、
 *  sessions 坏形状、以及远程面拒绝/传输层 reject 全部归 null =「这一跳没读到有效快照」：
 *  读侧只按这个结论做退避与过期判定，不必分辨来路。 */
async function readStateHop(store: RescueStateStore): Promise<RescueStateBody | null> {
  const { reader } = store;
  if (reader === undefined) {
    return null;
  }
  try {
    const parsed: unknown = await reader.state();
    return isRecord(parsed) ? parseStateBody(parsed) : null;
  } catch {
    return null;
  }
}

/** 有效快照落表：内容变了才换引用（状态对象小，JSON 对比开销可忽略；不换引用 ⇒
 *  React 跳过重渲染）。返回是否该惊动订阅者。 */
function commitHop(store: RescueStateStore, data: RescueStateBody): boolean {
  store.failStreak = 0;
  const key = JSON.stringify(data);
  if (key === store.stableKey) {
    return false;
  }
  store.stableKey = key;
  store.data = data;
  return true;
}

/** 读不到有效快照：记连跳，到档则把手上那份判为过期。交回的是**是否发生了内容变化**
 *  ——只有「由有到过期」那一跳才该惊动订阅者，之后的空跳维持 null 不再重渲染。 */
function noteUnreachableHop(store: RescueStateStore): boolean {
  store.failStreak += 1;
  if (store.failStreak < STALE_AFTER_FAILURES || store.data === null) {
    return false;
  }
  store.data = null;
  store.stableKey = "";
  return true;
}

/** 下一跳周期：档位只由快照里有没有 pending 决定（导出仅供单测）。 */
export function nextPollMs(data: RescueStateBody | null): number {
  const sessions = data?.sessions;
  if (sessions === undefined) {
    return IDLE_POLL_MS;
  }
  // 遍历值而不是 `Object.keys` + 下标：下标读出的 `| undefined` 由
  // noUncheckedIndexedAccess 强加，而 `sessions` 的键值对恰是同一个对象自己的属性，
  // 运行时不可能缺位（快照解析只写 `{ok:true, sessions}`，见 parseState）。
  for (const entry of Object.values(sessions)) {
    if (entry.pending !== null) {
      return ACTIVE_POLL_MS;
    }
  }
  return IDLE_POLL_MS;
}

/** 页签不可见时没有观察者，不该继续轮询。无 DOM 的环境（node 单测）恒判不隐藏。
 *  这里不能折成 `document?.hidden ?? false`：全局 `document` **未声明**的环境里
 * `document?.hidden` 抛 ReferenceError，而 `typeof` 探测不抛——两者不等价，故保留
 *  typeof 判据。判据先落成布尔量再与，是因为直接写
 * `typeof document !== "undefined" && document.hidden` 会被 prefer-optional-chain
 *  误判成可折叠；写成早退 `if` 则给 node 环境那条路加一个无用例可达的代码块，
 *  踩 100% 覆盖门槛（v8 按块计数，`&&` 的短路侧原本不成块）。 */
function pageHidden(): boolean {
  const hasDocument = typeof document !== "undefined";
  return hasDocument && document.hidden;
}

let visibilityBoundDocument: Document | null = null;

/** visibilitychange 只挂一次（按 document 幂等）：store 是模块单例，退订不摘监听
 *  ——零订阅时 syncVisibility 自己按 listeners 规模短路，摘与不摘行为等价，少一份要
 *  清理的全局状态。store 由调用方传入（不在这里前向引用尚未声明的 rescueState）。 */
function bindVisibility(store: RescueStateStore): void {
  if (typeof document === "undefined" || visibilityBoundDocument === document) {
    return;
  }
  visibilityBoundDocument = document;
  document.addEventListener("visibilitychange", () => {
    store.syncVisibility();
  });
}

export const rescueState: RescueStateStore = {
  data: null,
  stableKey: "",
  listeners: new Set(),
  timer: null,
  inFlight: false,
  reader: undefined,
  failStreak: 0,
  async refresh(): Promise<void> {
    if (this.inFlight) {
      return;
    }
    this.inFlight = true;
    try {
      const data = await readStateHop(this);
      // 通知门控：只有快照内容**变了**（含「由有到过期」那一种）才惊动订阅者。每 tick
      // 无条件遍历 listeners 会把内容不变的每个订阅者都 schedule 进 React 一遍。
      const worthNotifying = data === null ? noteUnreachableHop(this) : commitHop(this, data);
      if (worthNotifying) {
        for (const listener of this.listeners) {
          // 逐个隔离：通知循环里的异常没有接收方，refresh() 的三个调用点全是
          // `void this.refresh()`（定时器回调、订阅补跳、可见性回补），抛出去就是一条
          // 无人接的 unhandled rejection；而且一个订阅者抛错会连带跳过后面的订阅者。
          // 把失败挡在单个订阅者边界内，轮询与其余订阅者照常。
          try {
            listener();
          } catch {
            // 订阅者是 React 的 schedule 回调，它的失败已由它自己的渲染边界处理，
            // 这里只负责不让它掀掉整轮通知与下一跳。
          }
        }
      }
    } finally {
      // 在飞标志与续排都必须在 finally 里：这个循环没有 setInterval 兜底，下一跳**只**
      // 在这里排。旧实现把两行都写在通知之后，任何一个订阅者抛错都会让定时器永久停表
      //（timer 保持 null、inFlight 已复位 ⇒ 连「订阅即补一跳」那条路也救不回来）：
      // 宿主横幅从那一刻起不再刷新，而页面看起来一切正常。
      this.inFlight = false;
      this.schedule();
    }
  },
  schedule(): void {
    this.stop();
    if (this.listeners.size === 0 || pageHidden()) {
      return;
    }
    const pollMs = backoffMs(nextPollMs(this.data), this.failStreak);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, pollMs);
  },
  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  },
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    bindVisibility(this);
    // 只在"没有任何排定的循环"时补一跳：已有定时器或在飞请求都不该再发一发
    // /state（渲染抖动放大成连发的正是这一步）。
    if (this.timer === null && !this.inFlight) {
      void this.refresh();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.stop();
      }
    };
  },
  syncVisibility(): void {
    if (pageHidden()) {
      this.stop();
      return;
    }
    if (this.listeners.size > 0 && this.timer === null && !this.inFlight) {
      void this.refresh();
    }
  },
  getSnapshot(): RescueStateBody | null {
    return this.data;
  },
};

/** useSyncExternalStore 的两个入参必须是**模块级稳定引用**。写成内联箭头函数
 *  会让每次渲染都重跑订阅 effect——官方 React 18.3.1 的实现是
 *  `useEffect(bind(...),[subscribe])`，依赖数组只收 subscribe。重跑的代价不是空转：
 *  disposer 把唯一订阅者摘干净 → stop() 撤表，新订阅 → timer===null → 立刻再发
 *  一发 /state。真机 20:08:24.352/.353/.358/.360/.372 那五连发即由此而来。
 *  导出仅供单测。 */
export const rescueStoreBinding = {
  subscribe: (listener: () => void): (() => void) => rescueState.subscribe(listener),
  getSnapshot: (): RescueStateBody | null => rescueState.getSnapshot(),
};

function useRescueState(): RescueStateBody | null {
  return useSyncExternalStore(rescueStoreBinding.subscribe, rescueStoreBinding.getSnapshot);
}

/** 写侧出口的统一结果：调用方只按成败分支，宿主交回的 cancelled/disabled 由
 *  快照轮询反映，不在这里另抄一份形状。 */
export interface JsonResult {
  ok: boolean;
}

/** 写一次并投影结果：只认 `{ok:true}`；远程面缺席或传输失败都算失败。 */
async function postSessionAction(
  action: "cancel" | "toggle",
  sessionId: string,
): Promise<JsonResult> {
  const { reader } = rescueState;
  if (reader === undefined) {
    return { ok: false };
  }
  try {
    const body =
      action === "cancel" ? await reader.cancel(sessionId) : await reader.toggle(sessionId);
    return { ok: isRecord(body) && body["ok"] === true };
  } catch {
    return { ok: false };
  }
}

// 两位都是纯转发，真正的等待在 postSessionAction 里的 Remote 调用。本包的三条 async
// 规则在此咬合：`require-await`（async 函数必须有 await）、`promise-function-async`
//（返回 promise 的函数必须是 async）与 `return-await`（不许 `return await`）。
// 因此把等待写成落地一跳再交回——语义与调用点完全一致（调用方要么 `await`（测试），
// 要么把返回值当 promise 交给 runHostAction）。
export async function postCancel(sessionId: string): Promise<JsonResult> {
  const result = await postSessionAction("cancel", sessionId);
  return result;
}
export async function postToggle(sessionId: string): Promise<JsonResult> {
  const result = await postSessionAction("toggle", sessionId);
  return result;
}

// ── 业务动作（全部经 sessions 服务；失败返回 {ok:false, code, message}）──

interface ActionResult {
  ok: boolean;
  error?: { code?: string; message?: string };
}

/**
 * `ctx.sessions` 在本包用到的三位上：直接索引官方 `ISessions`（installed
 * `dsh-api-session-controller/lib/types/client/contract/sessions.d.ts:43-157`）。
 * 直接索引官方 `ISessions` 而不是本地重述，因为重述容易在三处把标签标错：
 *  1. `binding(id)` 官方返回 **`SessionBinding | undefined`**（其 `.session` 是
 *     `SessionFace`），镜像写成 `{ session: SessionBinding }` 等于把 `SessionFace`
 *     标成了 `SessionBinding`——属性路径巧合，标签是错的；
 *  2. `fork` 官方返回 `Promise<SessionId>`（品牌串），镜像写成 `Promise<string>`；
 *  3. 镜像里的 `open(id)` **官方根本不存在**：`ISessions` 与实现 `ClientSessions`
 *     都没有该成员，且 `sessions.list` 的注释明写「navigation belongs to view owners」；
 *     首方 Chat 的 fork 流程是 `ctx.sessions.fork(...).then((childId) =>
 *     ctx.uiWorkspace.openSession(childId))`（installed
 *     `dsh-client-ui-chat/lib/client.js:13876-13886`）。本包跟着那份重述调 `sessions.open`
 *     会在真宿主上 TypeError，并被 `forkAndSend` 的 catch 收成一次「操作失败」，
 *     测试因为按同一份镜像造假 sessions 而永远看不见。
 */
export type SessionsService = Pick<ISessions, "binding" | "fork" | "using">;

/** 导航位按官方成员面投影（`UiWorkspace` 还有 openWorkspace/forkSession 等，本包只用一位）。 */
type WorkspaceNavigation = Pick<UiWorkspace, "openSession">;

/** 会话绑定取不到时的失败码：三条动作（重发/停止重问/fork 重发）的开手守卫同源。 */
const SESSION_UNAVAILABLE_CODE = "session-unavailable";

interface ActionFailure {
  ok: false;
  code?: string;
  message?: string;
}

/**
 * 本包对卡片交出的动作面。**会话标识用官方品牌**（`SessionId`），因为下游每一位都是
 * 官方 API 的形参——用裸 `string` 只是把不匹配推到运行时。
 */
interface Actions {
  sendSameSession: (sessionId: SessionId, text: string) => Promise<ActionResult | ActionFailure>;
  stopAndReask: (sessionId: SessionId, text: string) => Promise<ActionResult | ActionFailure>;
  forkAndSend: (
    sessionId: SessionId,
    forkAtSeq: number | null,
    text: string,
  ) => Promise<ActionResult | ActionFailure>;
}

/** 官方 `RemoteResult` 的失败支（`error` 在必选位上，故不再写 `?.`）。 */
type Rejected = Extract<RemoteResult<never>, { ok: false }>;

/**
 * `RemoteFailure` 的 code/message 两位按可选读。官方声明（installed
 * `dsh-typert-protocol/lib/types/remote-error.d.ts:10-21`）把它们钉在必选位上
 *（`readonly code: Code` + 继承自 Error 的 `message: string`），但交回本包的失败体在
 * 运行时真的可能缺这两位：`remoteErrorOf` 只按结构标记 `isDSHRemoteError` 认出失败对象、
 * 不核对字段（其文档同文件 :23-30），网关跨 realm 转发的是裸 JSON 体，本包桩件更直接交
 * `{ ok: false, error: {} }`（见 test/client-ui.test.ts 的 prompt/cancel 桩）。
 * ⇒ 类型在说谎：从属主类型派生、把这两位的声明改宽（属主一旦承认它们可缺，这里
 *  当场红），两个守卫原样保留 —— 缺字段仍走「不写这一位」的真分支。
 */
type FailureFields = Partial<Pick<RemoteFailure, "code" | "message">>;

function failResult(result: Rejected): ActionFailure {
  const error: FailureFields = result.error;
  return {
    ok: false,
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.message === undefined ? {} : { message: error.message }),
  };
}

/**
 * 一条纯文本块：官方 `TextBlock`（dsh-llm）。`prompt` 的 `PromptContentPart` text 支收它
 * ——写成 `PromptContentPart` 反而过不了形参（那是含 image/file 的联合，`TextBlock` 才是
 * 它的元素类型）。
 */
function textPart(text: string): TextBlock {
  return { type: "text", text };
}

function createActions(
  sessions: SessionsService,
  /** 现取而非 apply 时读一次：`uiWorkspace` 是可选服务且刻意不进 inject，
   *  它在 client 模块表里完全可以**晚于**本包激活（官方 ui-chat 同样在调用点解析，
   *  见 packages/client/ui-chat/src/client/apply.ts:292）。apply 时读一次的话，
   *  装配线里晚到的 workspace UI 永远读成 undefined ⇒ fork 重发再也不跳转。 */
  workspaceOf: () => WorkspaceNavigation | undefined,
  t: Translate,
): Actions {
  /** 官方 `binding()`：借出**已被视图 retain** 的 binding，不延长其生命周期。 */
  function bindingOf(sessionId: SessionId): SessionBinding | undefined {
    return sessions.binding(sessionId);
  }

  async function sendSameSession(
    sessionId: SessionId,
    text: string,
  ): Promise<ActionResult | ActionFailure> {
    const binding = bindingOf(sessionId);
    if (binding === undefined) {
      return { ok: false, code: SESSION_UNAVAILABLE_CODE, message: t("sessionUnavailable") };
    }
    const result = await binding.session.prompt([textPart(text)], "queue");
    return result.ok ? { ok: true } : failResult(result);
  }

  // 停止重问：先入队再 cancel()。client cancel() 保留排队工作并在
  // 取消收敛后 FIFO 恢复（session.d.ts 已验证），因此消息不会丢。
  async function stopAndReask(
    sessionId: SessionId,
    text: string,
  ): Promise<ActionResult | ActionFailure> {
    const binding = bindingOf(sessionId);
    if (binding === undefined) {
      return { ok: false, code: SESSION_UNAVAILABLE_CODE, message: t("sessionUnavailable") };
    }
    const queued = await binding.session.prompt([textPart(text)], "queue");
    if (!queued.ok) {
      return failResult(queued);
    }
    const stopped = await binding.session.cancel();
    return stopped.ok ? { ok: true } : failResult(stopped);
  }

  // fork 分支重发：从 forkAtSeq（上一轮 turn/end）切出子会话 → 导航过去 → 发送。
  // forkAtSeq === null（第一轮）禁止调用，UI 已隐藏该按钮。
  //
  // 官方两步：`fork()` 只创建子会话（返回 `SessionId`），「选中并显示」是 view owner 的
  // `uiWorkspace.openSession(target)`。发送则走 `sessions.using(childId, …)` 而不是
  // `binding(childId)`——`binding()` 只借出**已被 retain** 的引用，刚 fork 出来的子会话
  // 此刻可能还没有任何视图持有它，`using()` 在本操作周围自己持有一份引用（官方
  // `ISessions.using`，其 `retain` 文档同段）。
  async function forkAndSend(
    sessionId: SessionId,
    forkAtSeq: number | null,
    text: string,
  ): Promise<ActionResult | ActionFailure> {
    // 形参声明是 `number | null`（Actions 接口与 CompletedUserTarget.forkAtSeq 同源），
    // `undefined` 那半边没有类型面也没有调用点（唯一挂载点传 target.forkAtSeq），
    // 故只判 null。
    if (forkAtSeq === null) {
      return { ok: false, code: "fork-unavailable", message: t("forkFirstTurn") };
    }
    let childId: SessionId;
    try {
      childId = await sessions.fork({ sessionId, atSeq: forkAtSeq, increaseTitle: true });
    } catch (error) {
      return {
        ok: false,
        code: "fork-failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    // 导航是可选服务：`ctx.get` 读出不建立依赖（缺 workspace UI 的装配里，本客户端
    // 插件仍要能加载——fork 与发送是主功能，切过去只是顺带）。
    workspaceOf()?.openSession(childId);
    try {
      return await sessions.using(childId, { source: SESSION_RESCUE_SOURCE }, async (reference) => {
        const result = await reference.binding.session.prompt([textPart(text)], "queue");
        return result.ok ? { ok: true } : failResult(result);
      });
    } catch {
      // 子会话拿不到引用（retain 失败/生成期已 dispose）：用户看到的仍是「分支不可用」，
      // 与 `binding(childId)` 取空时的回执码同源。
      return { ok: false, code: "branch-unavailable", message: t("branchUnavailable") };
    }
  }

  return { sendSameSession, stopAndReask, forkAndSend };
}

// ── 合并 view：useChat.legacy + useSession 控制字段 ─────────────────────

/**
 * dock 组件的 props。**四位 standard kit 一律取官方合成面**，不再逐成员重述：
 * `SessionStandardProps`（installed `@deepseek-ai/dsh-client-ui-slots/lib/types/index.d.ts:191`）
 * 是一张由各方 merge 的空表——`sessionId` / `useSession` / `useProjection` 由
 * `@deepseek-ai/dsh-client-ui-session`（其 lib/types/client/index.d.ts:77-84）合入，
 * `useChat` 由 `@deepseek-ai/dsh-client-ui-chat`（其 contract/slots.d.ts:275-279）合入，
 * 于是本包 selector 读到的 `snap.running` / `snap.legacy.nodes` 等成员的形状、只读性、
 * 品牌（`sessionId: SessionId`）都由宿主侧的那份声明交出。把这四位手抄成
 * `sessionId: string` + 三个自造 selector 签名，`slots` 也因此只能跟着降级成本地面
 * （官方 `register` 会按 `ComposedProps` 反变校验组件形参，抄窄了就直接红，
 * 见下面 ClientCtx.slots 处记的那条 TS2769）。
 * 只有 `actions` / `t` 是本包自有的注入位（经 `slots.register` 的 inject 面下发）。
 */
interface DockProps extends Pick<SessionStandardProps, "sessionId"> {
  /** 官方席位类型（同 `SessionStandardProps['useSession']`，写成名字便于引用属主导出）。 */
  useSession: SessionSnapshotSelector;
  /** 官方席位类型（同 `SessionStandardProps['useChat']`）。 */
  useChat: UseChat;
  actions: Actions;
  /** 取文案（官方 ctx.locale.bind 的结果，见 apply）。 */
  t: Translate;
}

function useTranscriptView(props: DockProps): TranscriptView {
  const legacy = props.useChat((snap) => snap.legacy);
  const running = props.useSession((snap) => snap.running);
  const removed = props.useSession((snap) => snap.removed);
  const lastAgentError = props.useSession((snap) => snap.lastAgentError);
  return {
    nodes: legacy.nodes,
    turnEnds: legacy.turnEnds,
    runningCalls: legacy.runningCalls,
    running,
    removed,
    lastAgentError,
  };
}

interface ErrShape {
  ok?: boolean;
  code?: string;
  message?: string;
}

/** 失败结果的可见文案。入参是调用方**已判过 `ok === false`** 的那条结果对象：
 *  四个调用点全在 `if (result.ok) … else …` 的 else 分支里，null/undefined 与
 *  `ok === true` 三条降级在此装配下不可达（原守卫已删，签名即文档）。
 *  宿主没带 message 时的兜底文案取自双语字典（语言由调用点的 t 决定）。 */
function errText(result: ErrShape, t: Translate): string {
  const prefix = result.code === undefined ? "" : `${result.code}: `;
  return prefix + (result.message ?? t("actionFailed"));
}

// ── 编辑 / 重试 / 续写统一入口：只放 dock（list 槽无链冲突；也避免与一方
//    deliverables/better-sidebar 的 turnTail 链冲突、按钮重复出现）────────

interface EditorProps {
  sessionId: SessionId;
  actions: Actions;
  target: CompletedUserTarget;
  onDone: () => void;
  t: Translate;
}

/** 共享编辑器：编辑重发（同会话）+ Fork 重发（新分支）+ 取消 */
function RescueEditor(props: EditorProps): ReactNode {
  const { sessionId, actions, target, onDone, t } = props;
  // target 由 dock 的唯一挂载点在 `target !== null` 分支内给出，且
  // CompletedUserTarget.text 是必填 string：`target?.text ?? ""` 的两条降级
  // 在该装配线下不可达（空草稿由 textarea 自身处理），故直接读属性。
  const [draft, setDraft] = useState(target.text);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const run = async (
    promiseFactory: () => Promise<ActionResult | ActionFailure>,
  ): Promise<void> => {
    if (busy) {
      return;
    }
    setBusy(true);
    setSaveError(null);
    try {
      const result = await promiseFactory();
      setBusy(false);
      if (result.ok) {
        onDone();
      } else {
        setSaveError(errText(result, t));
      }
    } catch (error) {
      setBusy(false);
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  };
  const onKeyDown = (ev: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      onDone();
    } else if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      if (draft.trim() !== "") {
        void run(() => actions.sendSameSession(sessionId, draft));
      }
    }
  };
  const sendButton = createElement(
    "button",
    {
      type: "button",
      className: "sr-button sr-primary",
      disabled: busy || draft.trim() === "",
      onClick: () => void run(() => actions.sendSameSession(sessionId, draft)),
    },
    busy ? t("sending") : t("resendInSession"),
  );
  // `target` 由 EditorProps 声明成必选的 CompletedUserTarget，dock 的唯一挂载点
  //（`if (dockEditing && target !== null)`）已在门外判过——旧的 `target !== null &&`
  // 在这里是第二次判同一件事，类型面上没有可判的空值。只剩 forkAtSeq 这一位真会空，
  // 判它并把正分支写在前（no-negated-condition）。
  const forkButton =
    target.forkAtSeq === null
      ? null
      : createElement(
          "button",
          {
            type: "button",
            className: "sr-button",
            disabled: busy || draft.trim() === "",
            onClick: () => void run(() => actions.forkAndSend(sessionId, target.forkAtSeq, draft)),
          },
          t("forkResend"),
        );
  const cancelButton = createElement(
    "button",
    {
      type: "button",
      className: "sr-button",
      disabled: busy,
      onClick: onDone,
    },
    t("cancel"),
  );
  const editorRow = createElement(
    "div",
    { className: "sr-editor" },
    createElement("textarea", {
      className: "sr-textarea",
      value: draft,
      autoFocus: true,
      onChange: (ev: React.ChangeEvent<HTMLTextAreaElement>) => {
        setDraft(ev.target.value);
      },
      onKeyDown,
    }),
    createElement("div", { className: "sr-row" }, sendButton, forkButton, cancelButton),
    saveError === null ? null : createElement("div", { className: "sr-error" }, saveError),
    createElement("div", { className: "sr-hint" }, t("editorHint")),
  );
  return editorRow;
}

/** 倒计时横幅（pending 为 null 则不渲染）。 */
function bannerElement(
  pending: RescuePending | null,
  onCancel: () => void,
  t: Translate,
): ReactNode | null {
  if (pending === null) {
    return null;
  }
  const copy = PENDING_BANNERS.get(pending.kind) ?? PENDING_BANNER_FALLBACK;
  const bannerText =
    pending.suspended === true
      ? t(copy.suspended)
      : t(copy.active, { secs: Math.max(1, Math.ceil(pending.remainingMs / 1000)) });
  return createElement(
    "div",
    { key: "banner", className: "sr-banner" },
    createElement("span", null, bannerText),
    createElement(
      "button",
      { type: "button", className: "sr-button", onClick: onCancel },
      t("cancel"),
    ),
  );
}

/** 停止重问行。 */
function stopReaskElement(
  busyStop: boolean,
  stopError: string | null,
  onStop: () => void,
  t: Translate,
): ReactNode {
  return createElement(
    "div",
    { key: "stop", className: "sr-row" },
    createElement(
      "button",
      { type: "button", className: "sr-button", disabled: busyStop, onClick: onStop },
      busyStop ? t("stopping") : t("stopAndReask"),
    ),
    stopError === null ? null : createElement("span", { className: "sr-error" }, stopError),
  );
}

/** 编辑/重试/续写操作行。 */
interface DockActionsProps {
  canEditDock: boolean;
  canRetryDock: boolean;
  canContinueDock: boolean;
  isHostPending: boolean;
  busy: boolean;
  error: string | null;
  onEdit: () => void;
  onRetry: () => void;
  onContinue: () => void;
  t: Translate;
}

/** 重试按钮的 title / 文本：两态各一条文案，提成模块级函数是为了不把 t() 嵌进
 *  createElement 的参数位（unicorn/max-nested-calls 上限 3）。 */
function retryButtonTitle(unit: DockActionsProps): string {
  return unit.isHostPending ? unit.t("hostRetryPendingTitle") : unit.t("retryTitle");
}

function retryButtonText(unit: DockActionsProps): string {
  return unit.isHostPending ? unit.t("retryWaiting") : unit.t("retry");
}

function dockActionsElement(unit: DockActionsProps): ReactNode {
  const { t } = unit;
  const editButton = unit.canEditDock
    ? createElement(
        "button",
        { type: "button", className: "sr-button", onClick: unit.onEdit },
        t("edit"),
      )
    : null;
  const retryButton = unit.canRetryDock
    ? createElement(
        "button",
        {
          type: "button",
          className: "sr-button",
          disabled: unit.busy || unit.isHostPending,
          title: retryButtonTitle(unit),
          onClick: unit.onRetry,
        },
        retryButtonText(unit),
      )
    : null;
  const continueButton = unit.canContinueDock
    ? createElement(
        "button",
        {
          type: "button",
          className: "sr-button",
          disabled: unit.busy,
          title: t("continueTitle"),
          onClick: unit.onContinue,
        },
        t("continueOutput"),
      )
    : null;
  return createElement(
    "div",
    { key: "dock-actions", className: "sr-row" },
    editButton,
    retryButton,
    continueButton,
    unit.error === null ? null : createElement("span", { className: "sr-error" }, unit.error),
  );
}

/** 开关行三态文案（action=false → 状态展示，action=true → 按钮动作名）。
 *  用 `Record<ToggleState, …>` 查表而不是 if/三元链：`unknown` 只出现在
 *  `rescueKnown === false` 的那一帧，而 decideDockState 里 `showToggleRow ===
 *  rescueKnown`，所以开关行在 unknown 态根本不渲染——分支写法的那几条 unknown
 *  支永远测不到。查表既保留三态文案（将来行显示出来也仍是中性 “—” + 等待提示），
 *  又不存在不可达分支。三张表按 t 现取（语言切换即时生效，不必重挂载组件）。 */
function toggleStatusTexts(t: Translate): Record<ToggleState, string> {
  return { on: t("toggleStateOn"), off: t("toggleStateOff"), unknown: t("toggleNeutral") };
}
function toggleActionTexts(t: Translate): Record<ToggleState, string> {
  return { on: t("toggleTurnOff"), off: t("toggleStateOn"), unknown: t("toggleNeutral") };
}
function toggleWaitingTitles(t: Translate): Record<ToggleState, string> {
  // on/off 没有等待提示（空 title 即不显气泡），只有快照未就绪才提示稍后再试。
  return { on: "", off: "", unknown: t("toggleWaiting") };
}

function toggleLabel(t: Translate, toggle: ToggleState, action: boolean): string {
  return (action ? toggleActionTexts(t) : toggleStatusTexts(t))[toggle];
}

/** 每会话开关行（三态：on=开启 / off=已关闭 / unknown=快照未就绪）。
 *  unknown 时按钮禁用、文案取中性 "—"，避免把「还没同步到」显示成「已关闭」。 */
function toggleRowElement(toggle: ToggleState, onToggle: () => void, t: Translate): ReactNode {
  // 三处取文案先落成变量：嵌进 createElement 参数位会超 max-nested-calls 上限。
  const label = t("sessionToggleLabel", { state: toggleLabel(t, toggle, false) });
  const actionLabel = toggleLabel(t, toggle, true);
  const waitingTitle = toggleWaitingTitles(t)[toggle];
  return createElement(
    "div",
    { key: "toggle", className: "sr-row" },
    createElement("span", { className: "sr-hint" }, label),
    createElement(
      "button",
      {
        type: "button",
        className: "sr-button",
        disabled: toggle === "unknown",
        title: waitingTitle,
        onClick: onToggle,
      },
      actionLabel,
    ),
  );
}

/** 动作状态写入口（busy/error 两个 setter 由调用方提供，本地态形态不同名）。 */
interface ActionSink {
  setBusy: (busy: boolean) => void;
  setError: (message: string | null) => void;
}

/** 一次业务动作的通用外壳（停止重问 / 编辑重发 / 重试 / 续写共用同一套
 *  busy-重入保护与错误呈现；原本 dock 里两份逐字重复的实现）。
 *  失败面两条都要覆盖：结果 `{ok:false}`（宿主拒绝）与 reject（服务抛错）。 */
async function runAction(
  busy: boolean,
  sink: ActionSink,
  t: Translate,
  promiseFactory: () => Promise<ActionResult | ActionFailure>,
): Promise<void> {
  if (busy) {
    return;
  }
  sink.setBusy(true);
  sink.setError(null);
  try {
    const result = await promiseFactory();
    sink.setBusy(false);
    if (!result.ok) {
      sink.setError(errText(result, t));
    }
  } catch (error) {
    sink.setBusy(false);
    sink.setError(error instanceof Error ? error.message : String(error));
  }
}

/** dock：倒计时横幅 / 停止重问 / 编辑重试续写 / 每会话开关。
 *  排队行不在这里：官方 `dsh-client-ui-conversation` 自己就往同一道
 *  `conversation.input.dock` 注册了 QueueDock（id="queue"，逐行编辑/删除/插话都有），
 *  本包再列一遍就是同一批消息显示两次。 */
function RescueDockView(props: DockProps): ReactNode {
  const { sessionId, actions, t } = props;
  const view = useTranscriptView(props);
  const rescue = useRescueState();

  const [busyStop, setBusyStop] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [dockEditing, setDockEditing] = useState(false);
  const [dockBusy, setDockBusy] = useState(false);
  const [dockError, setDockError] = useState<string | null>(null);
  // 取消/开关两条 host 写通道的失败面：postCancel/postToggle 返回
  // {ok:false}（宿主拒绝、网关不可达、传输中断）时**什么都没发生**——倒计时
  // 照跑、待办照发。把它当成功（`void postCancel(...)`）会让用户按了取消却仍被
  // 自动注入。这里必须把结果消费掉并显式报错。
  const [hostActionError, setHostActionError] = useState<string | null>(null);

  const runHostAction = async (
    action: (sessionId: string) => Promise<JsonResult>,
    label: string,
  ): Promise<void> => {
    setHostActionError(null);
    const result = await action(sessionId);
    if (!result.ok) {
      setHostActionError(t("hostActionFailed", { label }));
    }
  };

  const target = lastCompletedUserTarget(view);
  const failure = failureOfLastTurn(view);
  const isHostPending = failure !== null && hostRetryPending(view, failure.turn);
  const canEditDock = target !== null && !view.running;
  const canRetryDock = failure !== null && !view.running && failure.kind === "turn-error";
  const canContinueDock = failure !== null && !view.running && failure.kind === "max-tokens";

  const lastNode = lastUserNode(view);
  const lastText = lastNode === null ? null : userText(lastNode.content);
  const canStopReask = view.running && lastText !== null;

  // 竞态修复的支点：渲染决策全部走纯函数 decideDockState（lib/dock-state.ts）——
  // 轮询快照未就绪/会话切换缺状态时 toggle=unknown（中性态），
  // hasContent 只控容器显隐，同一会话内常驻挂载（本地状态不丢）。
  const decision = decideDockState(
    {
      canStopReask,
      canEdit: canEditDock,
      canRetry: canRetryDock,
      canContinue: canContinueDock,
      // 本地状态那两位：它们渲染在 dock 容器里，漏算就会让容器藏起自己正在显示的内容
      // （编辑态在中途转成运行中时 `canEdit` 变假；写通道失败时 pending 可能已不在）。
      editing: dockEditing && target !== null,
      hostActionFailed: hostActionError !== null,
    },
    rescue,
    sessionId,
  );
  const { pending, toggle, showToggleRow, hasContent } = decision;

  const doStopReask = async (reaskText: string): Promise<void> => {
    await runAction(busyStop, { setBusy: setBusyStop, setError: setStopError }, t, () =>
      actions.stopAndReask(sessionId, reaskText),
    );
  };
  const dockRun = (promiseFactory: () => Promise<ActionResult | ActionFailure>): Promise<void> =>
    runAction(dockBusy, { setBusy: setDockBusy, setError: setDockError }, t, promiseFactory);

  const children: ReactNode[] = [];

  const banner = bannerElement(
    pending,
    () => {
      void runHostAction(postCancel, t("cancel"));
    },
    t,
  );
  if (banner !== null) {
    children.push(banner);
  }

  if (canStopReask) {
    // canStopReask 是 `view.running && lastText !== null` 的 const 别名，
    // TS 据此把 lastText 收窄为 string（`doStopReask` 内那处 null 早退
    // 因此永远走不到：唯一的调用点就在本分支内）。
    children.push(stopReaskElement(busyStop, stopError, () => void doStopReask(lastText), t));
  }

  // 编辑 / 重试 / 续写主入口（唯一入口，dock 常驻）
  if (dockEditing && target !== null) {
    children.push(
      createElement(
        "div",
        { key: "dock-edit", style: { padding: "4px 0" } },
        createElement(RescueEditor, {
          // key 带上会话与目标轮：草稿是 `useState(target.text)` 只初始化一次的局部状态，
          // 而 dock 是常驻挂载点、React 按 key 复用组件实例。固定 key 下同一个实例会先后
          // 服务不同会话/不同轮次，草稿于是留着上一轮（甚至上一会话）的文本——用户在 A
          // 会话打了一半切到 B，B 的编辑框里显示的是 A 的内容，一点「重发」就把它发进 B。
          key: `dock-edit:${sessionId}:${target.seq}`,
          sessionId,
          actions,
          target,
          t,
          onDone: () => {
            setDockEditing(false);
            setDockError(null);
          },
        }),
      ),
    );
  } else if (canEditDock || canRetryDock || canContinueDock) {
    children.push(
      dockActionsElement({
        canEditDock,
        canRetryDock,
        canContinueDock,
        isHostPending,
        busy: dockBusy,
        error: dockError,
        t,
        onEdit: () => {
          setDockError(null);
          setDockEditing(true);
        },
        onRetry: () => void dockRun(() => actions.sendSameSession(sessionId, t("retryText"))),
        onContinue: () => void dockRun(() => actions.sendSameSession(sessionId, t("continueText"))),
      }),
    );
  }

  // 开关行三态：on=开启 / off=已关闭 / unknown=快照未就绪（中性"—"，按钮禁用）
  if (showToggleRow) {
    children.push(
      toggleRowElement(
        toggle,
        () => {
          void runHostAction(postToggle, t("switchAction"));
        },
        t,
      ),
    );
  }

  // host 写通道失败面（取消/开关）：紧随其操作行显示，不静默吞掉。
  if (hostActionError !== null) {
    children.push(
      createElement("div", { key: "host-action-error", className: "sr-error" }, hostActionError),
    );
  }

  // dock 容器常驻挂载（本地状态不随轮询 tick 丢失）；hasContent=false 时
  // 用 hidden 属性隐藏而非卸载组件——会话切换/快照空窗草稿不随轮次刷新而丢与 busy 标志。
  return createElement("div", { className: "sr-dock", hidden: !hasContent }, children);
}

// ── 配置入口（plugins.bundle.config，key = bundle 包名；0.1.6 起取代已删除的
//    settings.plugin.item）────────────────────────────────────────────────

/** 本卡自己的渲染视模型（官方 `ConfigFormSnapshot` 的有用子集 + 兜底值）。
 *  `status` 与 `writable` 在官方快照上是**必选**（status 恒为 loading/ready/unavailable
 *  之一；writable 是独立于 status 的「Host 文档是否接受写入」位，memory 模式永假），
 *  两者都满足才允许写，故这里同样声明为必选，不再用 `unknown`/可选位假装它们会缺。 */
interface CardSnapshot {
  status: "loading" | "ready" | "unavailable";
  writable: boolean;
  value: Record<string, unknown>;
}

/**
 * 本条目在客户端的共享配置表单 = 官方声明
 * `@deepseek-ai/dsh-client-ui-settings/client` 交出的 `ConfigForm<T>`
 * （`getSnapshot` / `subscribe` / `mutate` / `set` / `unset` 五成员全必选），快照面
 * `ConfigFormSnapshot<T>`（status / value / base / user / revision / writable / mode
 * 七成员全必选）。原先这里手抄了一份 `getSnapshot: () => unknown` 的三成员投影，
 * 快照字段全靠 `fieldOf(snap,"status")` 逐位再解析一遍——那个解析器只是丢失类型的
 * 补救，不是宿主契约（provider 侧已 decode/derive 过），故随类型回归官方一并删除。
 * ⚠ 旧 `ctx.settingsScope.bind({ namespace })` 连同 `settingsScope` 服务已被宿主
 * 移除（installed 全树零命中），入口换成 `ctx.configForms.get(entryId)`
 * （installed `config-form.d.ts:142`，服务本身由 :95-96 的 Context 增强交出）。
 * ⚠ 消费者面上没有 `dispose`：`get()` 交回的是 provider 持有的共享表单
 * （installed `config-form.d.ts:138-142`），销毁由 provider 在自己的 teardown 统一做。
 */
export type EntryForm = ConfigForm<Record<string, unknown>>;

/**
 * 本条目那张表单的官方快照面（值面是任意 JSON 形状，由 host 半的 Config 把关）。
 * 锚在**槽位属主包**交给配置页的那份状态上（`ConfigPageForm['state']`，installed
 * `dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:166-171`——它本身就是
 * `ConfigFormSnapshot<Record<string, unknown>>` 的具名投影），而不是本地再写一遍泛型实参：
 * 宿主换表单快照形状时这一位跟着红，本地重述的泛型则会悄悄继续编译。
 */
type FormSnapshot = ConfigPageForm["state"];

function cardStore(scope: EntryForm): {
  getSnapshot: () => CardSnapshot;
  subscribe: (listener: () => void) => () => void;
} {
  // 缓存必须 per-scope（闭包内）：模块全局会在多 scope 交错 getSnapshot 时互相
  // 冲 memo，导致 useSyncExternalStore 每次拿到新引用 → 无限重渲染
  //（与 zvec-grep lib/card-logic.ts 同一条纪律）。
  let cachedSnap: FormSnapshot | null = null;
  const EMPTY_SNAPSHOT: CardSnapshot = { status: "loading", writable: false, value: {} };
  // 初值直接就是空快照：getSnapshot 首次调用必落进重算分支，返回处再兜一次
  // `?? EMPTY_SNAPSHOT` 是不可达分支（本包 100% 分支门禁下永远缺一口）。
  let cachedView: CardSnapshot = EMPTY_SNAPSHOT;
  return {
    getSnapshot(): CardSnapshot {
      const snap = scope.getSnapshot();
      if (snap !== cachedSnap) {
        cachedSnap = snap;
        // 官方成员直读：status/writable 必选，只有 value 真的可能是 undefined
        //（首个快照受理前），那一态落到空对象供渲染。
        cachedView = {
          status: snap.status,
          writable: snap.writable,
          value: snap.value ?? {},
        };
      }
      return cachedView;
    },
    subscribe(listener: () => void): () => void {
      return scope.subscribe(listener);
    },
  };
}

/** 官方 `ConfigForm.mutate` 的一次写入 op（从官方签名派生，不本地重抄）。 */
type SettingsPathOp = Parameters<EntryForm["mutate"]>[0][number];
/** op 的取值位（官方 `JsonValue`）：表单草稿本就来自 schemastery 校验过的字段。 */
type SettingsPathValue = Extract<SettingsPathOp, { op: "set" }>["value"];

interface SettingsCardProps {
  /** plugins.bundle.config owner 两视图派发：summary=标题下一行摘要，page=配置表单。
   *  判别位取**槽位属主包**的官方声明（installed
   *  `dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:20-24`
   *  `PluginConfigViewProps['view']`），不再本地抄一份字面量联合：属主增删视图（例如补
   *  'row'）时这里当场红，本地抄件只会悄悄继续编译。 */
  view: PluginConfigViewProps["view"];
  useCard: <Out>(selector: (snap: CardSnapshot) => Out) => Out;
  /** 保存时固定一次的命名空间 revision（官方 `mutate` 的 expectedRevision 栅栏）。 */
  revision: () => number | undefined;
  /** 一次原子命名空间写入：全部字段共享同一 revision 栅栏与一次恢复读取。 */
  mutate: (
    ops: readonly SettingsPathOp[],
    expectedRevision: number | undefined,
  ) => Promise<boolean>;
  /** 取文案（官方 ctx.locale.bind 的结果，见 apply）。 */
  t: Translate;
}

// ── 429 重试策略区块（官方 llm-retry provider 级 retryPolicy 配置）────────────
// 数据流：remote.sessionRescue.retryProviders()（host 读 llm-pi-ai namespace）
// → 每 provider 一行下拉；选择 → remote.sessionRescue.retryPolicy() → host 经
// 官方 settings.mutate 落盘（validator 在写处把关）→ 重拉列表。
// 档位：default（官方默认 5 次码表）/ enhanced（12 次 + QUOTA + 8s→60s，
// settings.yaml 四家现行同款）/ always（官方无限重试 + backoff）/ off（0 次）。

const RETRY_PROVIDER_SCHEMA = z.object({
  provider: z.preprocess((value) => (typeof value === "string" ? value : ""), z.string()),
  mode: z.preprocess((value) => (typeof value === "string" ? value : ""), z.string()),
  maxRetries: z.preprocess((value) => (typeof value === "number" ? value : 0), z.number()),
  hasQuota: z.preprocess((value) => value === true, z.boolean()),
});

type RetryProviderRow = z.infer<typeof RETRY_PROVIDER_SCHEMA>;

/** 一行 provider 的逐字段守卫投影（坏类型落回空串/0，`hasQuota` 只认显式 true）。
 *  坏行本身由调用侧的 isRecord 挡下。 */
function parseProviderRow(rowRaw: Record<string, unknown>): RetryProviderRow {
  return RETRY_PROVIDER_SCHEMA.parse(rowRaw);
}

/** preset → 下拉档位文案键（顺序即下拉顺序；文案本体在 UI_MESSAGES 双语字典里）。 */
const RETRY_PRESET_KEYS: Record<string, keyof UiMessages> = {
  default: "presetDefault",
  enhanced: "presetEnhanced",
  always: "presetAlways",
  off: "presetOff",
};

/** 由 provider 行推导下拉当前档位（与 host preset 语义对齐的只读展示推断）。 */
function presetOfRow(row: RetryProviderRow): string {
  if (row.mode === "always") {
    return "always";
  }
  if (row.maxRetries === 0) {
    return "off";
  }
  if (row.mode === "normal" && row.hasQuota && row.maxRetries >= 12) {
    return "enhanced";
  }
  return "default";
}

/** 单行 provider 的档位下拉（选择先暂存，点「保存」批量落盘）。 */
function retryRowElement(
  row: RetryProviderRow,
  pending: Record<string, string>,
  disabled: boolean,
  onChange: (row: RetryProviderRow, next: string) => void,
  t: Translate,
): ReactNode {
  const options: SelectOption[] = Object.entries(RETRY_PRESET_KEYS).map(([value, labelKey]) => ({
    value,
    label: t(labelKey),
  }));
  // 原型链防护：row.provider 来自 host 载荷，取到的名字是 "constructor"、
  // "toString" 这类自有属性名时 `pending[...]` 会返回原型上的函数，`??` 也就
  // 不再回落到当前档位——下拉框把函数当 value 渲染成空串。只认自有键。
  const staged = Object.hasOwn(pending, row.provider) ? pending[row.provider] : undefined;
  return createElement(SelectField, {
    key: row.provider,
    label: row.provider,
    hint: `${row.mode} · max ${row.maxRetries} · QUOTA ${row.hasQuota ? "✓" : "✗"}`,
    value: staged ?? presetOfRow(row),
    options,
    disabled,
    onChange: (next: string): void => {
      onChange(row, next);
    },
  });
}

/** 单个 provider 的落盘（经官方 Remote 的 `sessionRescue.retryPolicy`）。返回 null=已落盘，
 *  返回文案=host 拒绝。失败可能是 `{ok:false, error}` 业务结果，也可能是远程面拒绝；
 *  两者都不得落到"成功"分支，否则 pending 被清空、用户以为档位已保存。 */

const applyPreset = async (
  t: Translate,
  provider: string,
  preset: string,
): Promise<string | null> => {
  const target = `${provider}→${preset}`;
  const { reader } = rescueState;
  if (reader === undefined) {
    return t("remoteUnavailable", { target });
  }
  try {
    const body = await reader.retryPolicy(provider, preset);
    if (isRecord(body) && body["ok"] === true) {
      return null;
    }
    const error = fieldOf(body, "error");
    // host 给了原因就用原因（它是写给用户看的原文），没给才回落到本包的措辞。
    return typeof error === "string" ? `${target}: ${error}` : t("hostRejected", { target });
  } catch (error) {
    return `${target}: ${String(error)}`;
  }
};

/** 重试面板的加载状态（判别联合：`ok:true` 必带 providers 数组，load() 的两个 setState
 *  都遵守），因此读侧不再需要 `state.providers ?? []` 的降级——那条 `??` 右支在 ok===true
 *  时结构上不可能命中，是可证明的死分支。 */
type RetryPanelState =
  | { ok: true; providers: RetryProviderRow[] }
  | { ok: false; error?: string }
  | null;

/** 列表主体的三态渲染（加载中 / 逐 provider 一行 / 面板不可用）。 */
function retryProvidersBody(
  state: RetryPanelState,
  pending: Record<string, string>,
  saving: boolean,
  onChange: (row: RetryProviderRow, next: string) => void,
  t: Translate,
): ReactNode {
  if (state === null) {
    return createElement("div", { className: "sr-hint" }, t("presetLoading"));
  }
  if (state.ok) {
    return createElement(
      "div",
      {},
      state.providers.map((row) => retryRowElement(row, pending, saving, onChange, t)),
    );
  }
  return createElement(
    "div",
    { className: "sr-hint" },
    t("presetFaceUnavailable", { detail: state.error ?? "" }),
  );
}

/** 保存条（保存/丢弃/状态提示）：保存中或脏数为 0 时两个按钮一起禁点。 */
function retrySaveBar(props: {
  saving: boolean;
  dirtyCount: number;
  saveError: string | null;
  t: Translate;
  onSave: () => void;
  onDiscard: () => void;
}): ReactNode {
  const { saving, dirtyCount, saveError, t, onSave, onDiscard } = props;
  let saveLabel: string;
  if (saving) {
    saveLabel = t("saving");
  } else if (dirtyCount > 0) {
    saveLabel = t("saveCount", { count: dirtyCount });
  } else {
    saveLabel = t("save");
  }
  const saveButton = createElement(
    "button",
    {
      type: "button",
      className: "dsu-btn dsu-btnPrimary",
      "data-field": "retry-save",
      disabled: saving || dirtyCount === 0,
      onClick: onSave,
    },
    saveLabel,
  );
  const discardButton = createElement(
    "button",
    {
      type: "button",
      className: "dsu-btn",
      "data-field": "retry-discard",
      disabled: saving || dirtyCount === 0,
      onClick: onDiscard,
    },
    t("discard"),
  );
  const statusClass = saveError === null ? "dsu-status" : "dsu-status dsu-statusError";
  return createElement(
    "div",
    { className: "dsu-savebar" },
    saveButton,
    discardButton,
    createElement(
      "span",
      { className: statusClass },
      saveError ?? (dirtyCount > 0 ? t("presetDirty") : ""),
    ),
  );
}

function RetryPolicySection(props: { t: Translate }): ReactNode {
  const { t } = props;
  const [state, setState] = useState<RetryPanelState>(null);
  // 保存条模式：改档位先暂存（provider → preset），点「保存」批量落盘
  const [pending, setPending] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // load 依赖 t（文案走 UI_MESSAGES），所以用 useCallback 把身份固定下来：它同时被挂载
  // 那一次和「保存成功后重读」调用，写成裸函数会让 useEffect 的依赖数组没法写对。
  const load = useCallback(async (): Promise<void> => {
    try {
      const parsed: unknown = await rescueState.reader?.retryProviders();
      if (!isRecord(parsed)) {
        setState({ ok: false, error: t("retryProvidersUnavailable") });
        return;
      }
      // 逐字段守卫投影 providers（坏行直接丢弃，防御纵深；不经 any 断言）
      const providers: RetryProviderRow[] = [];
      const tasks = fieldOf(parsed, "providers");
      if (Array.isArray(tasks)) {
        for (const rowRaw of tasks) {
          if (isRecord(rowRaw)) {
            providers.push(parseProviderRow(rowRaw));
          }
        }
      }
      setState(fieldOf(parsed, "ok") === true ? { ok: true, providers } : { ok: false });
    } catch (error) {
      setState({ ok: false, error: String(error) });
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirtyCount = Object.keys(pending).length;
  const saveAll = async (): Promise<void> => {
    if (dirtyCount === 0) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    const entries = Object.entries(pending);
    const outcomes = await Promise.all(
      entries.map(([provider, preset]) => applyPreset(t, provider, preset)),
    );
    setSaving(false);
    const failures = outcomes.filter((outcome): outcome is string => outcome !== null);
    if (failures.length > 0) {
      // 保留 pending：失败的档位仍是用户选的意图，重试点一次即可（已成功的
      // 档位重复写是幂等的——host 侧同一 preset 写同一 retryPolicy）。
      const detail = failures.join(t("failureJoiner"));
      setSaveError(t("saveFailed", { detail }));
      return;
    }
    setPending({});
    void load();
  };
  const discardAll = (): void => {
    setPending({});
    setSaveError(null);
  };

  const changePreset = (row: RetryProviderRow, next: string): void => {
    setPending((prev) => {
      const merged = { ...prev, [row.provider]: next };
      if (next === presetOfRow(row)) {
        // 选回当前档位 → 从暂存中移除该 provider（等价原 delete，但不用动态 key delete）
        return Object.fromEntries(Object.entries(merged).filter(([key]) => key !== row.provider));
      }
      return merged;
    });
  };

  return createElement(
    Section,
    { title: t("retrySectionTitle"), hint: t("retrySectionHint") },
    retryProvidersBody(state, pending, saving, changePreset, t),
    retrySaveBar({
      saving,
      dirtyCount,
      saveError,
      t,
      onSave: () => {
        void saveAll();
      },
      onDiscard: discardAll,
    }),
  );
}

/** providerExcludes 快照值 → 显示串（非数组按空串降级；数组直接 join）。 */
function excludesText(value: Record<string, unknown>): string {
  const raw = fieldOf(value, "providerExcludes");
  return Array.isArray(raw) ? raw.join(", ") : "";
}

/** providerExcludes 草稿串 → 存储数组（逗号分隔、去空白、去空项）。 */
function excludesDraftToArray(draft: string): string[] {
  return draft
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/** 落盘当前 touched 草稿：逐字段异步写入（宿主 schema 在写处把关），并把
 *  「复读确认未落地」的字段汇总成用户可见的失败文案（null=全部落地）。
 *  set 的失败只体现在返回值，且必须 await：让它自己 catch 并 console.error 的话，
 *  这里的 try 永远看不到失败，被宿主拒绝的值也会报"已保存"。 */
async function commitTouched(
  props: SettingsCardProps,
  touched: Record<string, SettingsPathValue>,
  excludesDraft: string,
  value: Record<string, unknown>,
  revision: number | undefined,
): Promise<string | null> {
  const changed = new Set(diffTouched(touched, value));
  const ops: SettingsPathOp[] = Object.entries(touched)
    .filter(([field]) => changed.has(field))
    .map(([field, next]) => ({ op: "set", path: [field], value: next }));
  if (excludesDraft !== excludesText(value)) {
    ops.push({ op: "set", path: ["providerExcludes"], value: excludesDraftToArray(excludesDraft) });
  }
  // 一次原子写：全部字段共享同一个 revision 栅栏。宿主拒绝（含并发改动导致的栅栏失效）
  // 时表单已按官方契约做过一次恢复读取，这里只负责把失败如实报给用户——不谎报保存成功，
  // 也不逐字段重试（那会把一次被拒的批量拆成多次 last-write-wins）。
  const accepted = await props.mutate(ops, revision);
  return accepted ? null : props.t("saveFailed", { detail: props.t("saveRejected") });
}

interface SectionInputs {
  t: Translate;
  disabled: boolean;
  /** 渲染取值：touched 优先，快照兜底。 */
  eff: (field: string) => unknown;
  setField: (field: string, value: SettingsPathValue) => void;
}

interface SecondsSpec {
  label: keyof UiMessages;
  hint: keyof UiMessages;
  field: string;
  min: number;
  max: number;
  fallbackMs: number;
}

/** 毫秒存储字段以秒显示；写回时取整到毫秒（宿主 schema 是 natural()）。 */
function secondsField(inputs: SectionInputs, spec: SecondsSpec): ReactNode {
  const raw = inputs.eff(spec.field);
  // 存储侧是毫秒整数；区间与 host schema 的 natural().min/max 同源，秒数只负责显示。
  const parsed = z
    .int()
    .min(spec.min * 1000)
    .max(spec.max * 1000)
    .safeParse(raw);
  return createElement(NumberField, {
    label: inputs.t(spec.label),
    ...splitHint(inputs.t(spec.hint)),
    field: spec.field,
    value: parsed.success ? parsed.data / 1000 : spec.fallbackMs / 1000,
    min: spec.min,
    max: spec.max,
    step: 0.5,
    unit: inputs.t("unitSeconds"),
    invalidHint: inputs.t("outOfRange"),
    disabled: inputs.disabled,
    onChange: (next: number | undefined): void => {
      if (next === undefined) {
        return;
      }
      inputs.setField(spec.field, Math.round(next * 1000));
    },
  });
}

interface CountSpec {
  label: keyof UiMessages;
  hint: keyof UiMessages;
  field: string;
  fallback: number;
}

/** 次数上限字段：0–20 的整数。 */
function countField(inputs: SectionInputs, spec: CountSpec): ReactNode {
  const raw = inputs.eff(spec.field);
  const parsed = z.int().min(0).max(20).safeParse(raw);
  return createElement(NumberField, {
    label: inputs.t(spec.label),
    ...splitHint(inputs.t(spec.hint)),
    field: spec.field,
    value: parsed.success ? parsed.data : spec.fallback,
    min: 0,
    max: 20,
    step: 1,
    unit: inputs.t("unitTimes"),
    invalidHint: inputs.t("outOfRange"),
    disabled: inputs.disabled,
    onChange: (next: number | undefined): void => {
      if (next === undefined) {
        return;
      }
      inputs.setField(spec.field, Math.round(next));
    },
  });
}

interface ToggleSpec {
  label: keyof UiMessages;
  hint: keyof UiMessages;
  field: string;
}

/** 布尔字段：快照缺省按开处理（宿主 schema 的缺省值同为 true）。 */
function toggleField(inputs: SectionInputs, spec: ToggleSpec): ReactNode {
  return createElement(ToggleField, {
    label: inputs.t(spec.label),
    ...splitHint(inputs.t(spec.hint)),
    field: spec.field,
    checked: inputs.eff(spec.field) !== false,
    disabled: inputs.disabled,
    onChange: (next: boolean): void => {
      inputs.setField(spec.field, next);
    },
  });
}

/** 自动续跑小节：总开关与瞬时失败路径的四个参数。 */
function buildResumeSection(inputs: SectionInputs): ReactNode {
  return createElement(
    Section,
    { title: inputs.t("resumeSection"), hint: inputs.t("formLead") },
    toggleField(inputs, { label: "enabledLabel", hint: "enabledHint", field: "enabled" }),
    secondsField(inputs, {
      label: "resumeDelayLabel",
      hint: "resumeDelayHint",
      field: "resumeDelayMs",
      min: 1,
      max: 300,
      fallbackMs: 10_000,
    }),
    secondsField(inputs, {
      label: "resumeCooldownLabel",
      hint: "resumeCooldownHint",
      field: "resumeCooldownMs",
      min: 5,
      max: 3600,
      fallbackMs: 120_000,
    }),
    countField(inputs, {
      label: "maxResumesLabel",
      hint: "maxResumesHint",
      field: "maxResumes",
      fallback: 3,
    }),
    secondsField(inputs, {
      label: "chainDelayLabel",
      hint: "chainDelayHint",
      field: "chainResumeDelayMs",
      min: 1,
      max: 300,
      fallbackMs: 60_000,
    }),
  );
}

/** 截断续写小节。 */
function buildContinueSection(inputs: SectionInputs): ReactNode {
  return createElement(
    Section,
    { title: inputs.t("maxTokensSection") },
    secondsField(inputs, {
      label: "continueDelayLabel",
      hint: "continueDelayHint",
      field: "continueDelayMs",
      min: 0.5,
      max: 300,
      fallbackMs: 3000,
    }),
    secondsField(inputs, {
      label: "continueCooldownLabel",
      hint: "continueCooldownHint",
      field: "continueCooldownMs",
      min: 5,
      max: 3600,
      fallbackMs: 60_000,
    }),
    countField(inputs, {
      label: "maxContinuesLabel",
      hint: "maxContinuesHint",
      field: "maxContinues",
      fallback: 3,
    }),
  );
}

/** 待办补跑小节。 */
function buildUnfinishedSection(inputs: SectionInputs): ReactNode {
  return createElement(
    Section,
    { title: inputs.t("unfinishedSection") },
    toggleField(inputs, {
      label: "openTodosLabel",
      hint: "openTodosHint",
      field: "resumeOnOpenTodos",
    }),
    secondsField(inputs, {
      label: "unfinishedDelayLabel",
      hint: "unfinishedDelayHint",
      field: "unfinishedDelayMs",
      min: 1,
      max: 300,
      fallbackMs: 5000,
    }),
    secondsField(inputs, {
      label: "unfinishedCooldownLabel",
      hint: "unfinishedCooldownHint",
      field: "unfinishedCooldownMs",
      min: 5,
      max: 3600,
      fallbackMs: 120_000,
    }),
    countField(inputs, {
      label: "maxUnfinishedLabel",
      hint: "maxUnfinishedHint",
      field: "maxUnfinished",
      fallback: 2,
    }),
  );
}

/** providerExcludes 的草稿输入区（显示形态 'a, b' 与存储形态 string[] 不同构，
 *  diff 因此单独判定）。 */
function buildExcludesSection(
  inputs: SectionInputs & { draft: string; onDraft: (next: string) => void },
): ReactNode {
  const hint = splitHint(inputs.t("excludesHint"));
  return createElement(
    Section,
    { title: inputs.t("excludesSection") },
    createElement(TextField, {
      label: inputs.t("excludesFieldLabel"),
      ...hint,
      field: "providerExcludes",
      value: inputs.draft,
      placeholder: inputs.t("excludesPlaceholder"),
      monospace: true,
      disabled: inputs.disabled,
      onChange: inputs.onDraft,
    }),
  );
}

function RescueSettingsForm(props: SettingsCardProps): ReactNode {
  const { t } = props;
  const snap = props.useCard((view) => view);
  const { value } = snap;
  // settings-scope 真实契约：status==='ready' 且 writable 才可写（unavailable 时
  // writable 可能仍为 true——workspace 级可写位独立于命名空间状态，二者都要满足）。
  const disabled = snap.status !== "ready" || !snap.writable;
  // 保存条状态：touched = 用户动过的字段；providerExcludes 单独存草稿串
  // （显示形态 'a, b' 与存储形态 string[] 不同构，diff 单独判定）。
  const [touched, setTouched] = useState<Record<string, SettingsPathValue>>({});
  // 排除名单草稿：`null` = 「这边没动过」。存成「用户输入的文本」而不是「当前显示值」，
  // 未动过的字段就恒等于快照——另一页签/另一次 apply 写同名空间时，快照换了而这边
  // 还揣着挂载那帧的旧文本，会把别人的值覆盖回去（last-write-wins），而且保存条显示
  // 「有改动」，用户看不出改动其实来自外部。
  const [excludesEdit, setExcludesEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const eff = (field: string): unknown => (field in touched ? touched[field] : value[field]);
  const excludesBaseline = excludesText(value);
  const excludesDraft = excludesEdit ?? excludesBaseline;
  const excludesDirty = excludesEdit !== null && excludesEdit !== excludesBaseline;
  const dirtyCount = diffTouched(touched, value).length + (excludesDirty ? 1 : 0);
  const dirty = dirtyCount > 0;
  const setField = (field: string, val: SettingsPathValue): void => {
    setTouched((prev) => ({ ...prev, [field]: val }));
  };
  const save = async (): Promise<void> => {
    if (!dirty) {
      return;
    }
    setBusy(true);
    setSaveError(null);
    let failure: string | null;
    try {
      failure = await commitTouched(props, touched, excludesDraft, value, props.revision());
    } catch (error) {
      // 写通道本身抛错（远端 reject / scope 已失效）：同样必须可见。
      failure = t("saveFailed", {
        detail: String(error instanceof Error ? error.message : error),
      });
    }
    setBusy(false);
    if (failure !== null) {
      setSaveError(failure);
      return;
    }
    // 宿主已受理整批写入 → 交回「没动过」态，草稿跟着快照走。
    setTouched({});
    setExcludesEdit(null);
  };
  const discard = (): void => {
    setTouched({});
    setExcludesEdit(null);
    setSaveError(null);
  };

  const inputs: SectionInputs = { t, disabled, eff, setField };
  const saveBar = createElement(SaveBar, {
    dirty,
    busy,
    writable: !disabled,
    error: saveError,
    saveLabel: t("save"),
    savingLabel: t("saving"),
    revertLabel: t("discard"),
    dirtyLabel: t("dirtyCount", { count: dirtyCount }),
    cleanLabel: t("statusClean"),
    readOnlyLabel: t("statusReadOnly"),
    onSave: () => {
      void save();
    },
    onDiscard: discard,
  });
  const retrySection = createElement(RetryPolicySection, { key: "retry-policy", t });

  // 0.1.6：page 视图只渲染表单主体——标题/描述/卡片外壳由插件管理页统一绘制，
  // 不再自绘 RescuePluginCard（旧自绘壳属于已删除的 settings.plugin.item）。
  return createElement(
    CardForm,
    null,
    buildResumeSection(inputs),
    buildContinueSection(inputs),
    buildUnfinishedSection(inputs),
    buildExcludesSection({ ...inputs, draft: excludesDraft, onDraft: setExcludesEdit }),
    saveBar,
    retrySection,
  );
}

/**
 * 配置入口：按 owner 的 view 派发。分支在所有 hooks 之前，两个视图各自
 * 独立挂载，互不共享 hook 序列（React 纪律）。
 */
function RescueSettingsCard(props: SettingsCardProps): ReactNode {
  if (props.view === "summary") {
    return props.t("cardSummary");
  }
  return createElement(RescueSettingsForm, props);
}

// ── 装配 ────────────────────────────────────────────────────────────────

export interface ClientCtx {
  /** cordis 官方效应面（installed `@deepseek-ai/cordis/lib/types/fiber.d.ts` 的
   *  `interface Context extends Pick<Fiber, 'effect'>`，两个重载）。 */
  effect: Context["effect"];
  /** 官方反射面：可选服务（`uiWorkspace`）经 `get` 读出不建立 inject 依赖，
   *  已声明的名字返回 `undefined | this[K]`——`get("uiWorkspace")` 因此直接是
   *  官方 `UiWorkspace | undefined`，不需要本地投影也不需要断言。 */
  get: Context["get"];
  on?: (event: string, listener: () => void) => unknown;
  /**
   * 官方 `SlotRegistry`（renderer 把它增强进 cordis `Context`）的**方法面投影**。取
   * `Pick` 而不是 `Context["slots"]` 整类型：`SlotRegistry` 是带 private 字段的 cordis
   * `Service` 类（installed `dsh-client-ui-renderer` 的 `lib/types/client/registry.d.ts` 里那份
   * `declare class SlotRegistry`），
   * TS 对它做名义比较，测试桩件永远满足不了整类型；`register` 逐字复用
   * `SlotCore['register']` 的两个重载，`inject` 是「按槽位声明生命周期装 effect」那一位
   *（collapse 跑 disposer、再次声明重跑工厂，契约写在同一份 `registry.d.ts` 里 `register` 的
   * 文档注释上）。
   * 于是本包的两位槽名都是**编译期受检**的：`conversation.input.dock` 由属主包
   * `dsh-client-ui-conversation` merge（其 `contract/slots.d.ts` 的 `SlotMap` 里那条，list / scope
   * session / owner `InputZone`），`plugins.bundle.config` 由 `dsh-client-ui-plugin-manager`
   * merge（经 `ConfigPageForm` 那一条 import 载入）。list 槽必须给 `id`、keyed 槽必须给
   * `key`——官方 `KindOptions` 按 `SlotMap[K]['kind']` 分发（旧本地镜像把两者都写成可选）。
   *
   * 为什么这一步现在才做得成（此前两条实测阻塞）：官方 `register` 的 component 形参按
   * `ComposedProps<K, …>` **反变**校验，而 dock 组件真正读的 `sessionId` / `useSession` /
   * `useProjection` / `useChat` 四位合并在 `dsh-client-ui-session` / `dsh-client-ui-chat`
   * 两家手里。两包不在类型图里时报的是
   * `TS2769: … 'InputZone & SessionStandardProps & GlobalStandardProps & …' is not
   * assignable to type 'DockProps' … missing: sessionId, useChat, useSession, useProjection`。
   * 现在两包进来了、`DockProps` 也改成按官方席位类型声明，注册点即通过；顺带被官方契约
   * 挑出并修掉两处真漂移：`legacy.runningCalls` 的元素（本包抄成
   * `{ turn?: number; [key: string]: unknown }`，官方 `RunningToolCall` 的 `turn`/`step`/
   * `argsRaw`/`time`/`subCalls` 全必选且**没有**索引签名，赋不进来）与
   * `TranscriptNode.kind`（原 `string`，现为官方 `ConversationNode["kind"]` 判别键）。
   */
  slots: Pick<SlotRegistry, "inject" | "register">;
  sessions: SessionsService;
  /** 0.1.7 的配置表单服务（installed
   *  `dsh-client-ui-settings/lib/types/client/config-form.d.ts:95-96` 的
   *  `Context.configForms` 增强，`get:142` 按 profile 条目 id 取那张共享表单）：
   *  取代已随宿主移除的 `settingsScope`（installed 全树零命中）。注入只需
   *  `configForms` 本身——写侧的 `remote.settings` 由 provider 自己的 fiber 承担
   *  （同文件 :114-117 明写「letting a shared form write through the caller's
   *  context would make every caller declare `remote.settings`」，故此处不必声明）。
   *  ⚠ 只用 `get` 这一位，故按方法面投影——官方 `ConfigForms` 是带 private 字段的
   *  Service 类，TS 对其做名义比较，测试桩件无法满足，**不得**写成 `ConfigForms`。
   *  返回类型 `EntryForm` 即官方 `ConfigForm<Record<string, unknown>>`（见其声明处），
   *  快照或写侧成员一名一改，这里就会编译失败。 */
  configForms: {
    get: (entryId: string) => EntryForm;
  };
  /**
   * 官方 `@deepseek-ai/dsh-client-locale`（`LocaleRuntime`）在本包用到的那两条**类型化**
   * 重载上的投影，命名空间取在 `typeof NS` 上——本包已 merge 进 `LocaleNamespaceMap`
   * （见 ui-messages.ts）。于是：
   * - `register` 的字典参数是官方 `LocaleDictOf<NS>` 的两语目录，缺一门语言即编译期红；
   *   不再用官方那条三参未类型化重载（`dict: LocaleDict = Record<string, string>`），因为
   *   `UiMessages` 按 lint 的 `consistent-type-definitions` 必须是 interface，而 interface
   *   拿不到隐式索引签名（本包实测：`Type 'UiMessages' is not assignable to type
   *   'Record<string, string>'. Index signature for type 'string' is missing in type
   *   'UiMessages'`）。走有限键映射那条既满足官方契约、又让「少一门语言」在编译期红。
   * - `bind` 是官方 `TranslateNS<NS>`，dock 与卡片不再自带一份手抄的取文案签名。
   * ⚠ 两位都不写成 `LocaleRuntime['register'|'bind']`：官方每条都是双重载，把未类型化
   * 那条一起带进目标类型后，任何单一实现都满足不了（本包实测两条分别回
   * `Type 'string' is not assignable to type 'LocaleKeysOf<"session-rescue">'` 与
   * `Type 'string' is not assignable to type 'Record<"en" | "zh", LocaleDictOf<…>>'`）。
   */
  locale: {
    register: (ns: typeof NS, dicts: LocaleCatalog) => () => void;
    bind: (ns: typeof NS) => Translate;
  };
}

/** 官方 register 类型化重载的字典参数在本包命名空间上的实例化（两语必须齐）。 */
export type LocaleCatalog = Record<BuiltInLocaleId, LocaleDictOf<typeof NS>>;

const inject = ["slots", "sessions", "configForms", "locale"];
// 注：`uiWorkspace` 刻意**不进** inject（可选服务，缺了不该让整张卡挂不上），
// 由 apply 里 `ctx.get("uiWorkspace")` 读出。

/**
 * dsh 0.1.2-alpha.2 连接感知（connection/reset）：网关每次重建连接时 emit
 * （client 侧全局事件，session-controller / ui-settings 等同类订阅）。自动续跑
 * 定时器在 host 侧，断连窗口里 fire 会抛错空发。此钩子在连接重置时通知 host
 * "传输已就绪"——host 若在挂起态（suspendSession 未恢复）就重新武装定时器。
 * 断开本身不做臆测挂起：断连瞬间 host fire 失败已 settle 'skipped'，后续
 * 仍会由下一次 agent/error 重新调度，因此这里只做恢复方向。
 * 导出仅供单测（断言连接重置会调用读面的 resume）。
 */
export function notifyHostConnected(ctx: ClientCtx): void {
  if (typeof ctx.on !== "function") {
    return;
  }
  ctx.on("connection/reset", () => {
    void (async (): Promise<void> => {
      try {
        await rescueState.reader?.resume();
      } catch {
        // 读面不可达时降级：host 定时器照旧，仅丢失暂停恢复优化。
      }
    })();
  });
}

function apply(ctx: ClientCtx): void {
  if (!claimApply(ctx, "__sessionRescueApplied", "session-rescue: apply claim")) {
    return;
  }

  rescueState.reader = createRescueReader(ctx);

  // 连接感知：重连就绪时通知 host 恢复挂起的自动续跑定时器。
  notifyHostConnected(ctx);

  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.id = "session-rescue-css";
    tag.textContent = `${CSS}\n${CARD_UI_CSS}`;
    document.head.append(tag);
    return () => {
      tag.remove();
    };
  }, "session-rescue: styles");

  // 卡片与 dock 的文案交给官方 locale：两语一次性交给**类型化**的 register（官方要求每个
  // 内置 locale 都在，缺一门即编译期红；disposer 随 effect 回收），再 bind 出稳定的取文案
  // 函数交给两个槽位。语言切换由宿主驱动 slot 重渲染，无需重载页面（dock 与设置卡共用
  // 同一个 t，切语言时两处一起变）。
  ctx.effect(
    () => ctx.locale.register(NS, UI_MESSAGES),
    "session-rescue-card: locale dictionaries",
  );
  const t = ctx.locale.bind(NS);

  // 官方 `Context['get']` 对已声明的服务名直接交出 `UiWorkspace | undefined`
  //（installed cordis/lib/types/reflect.d.ts:14），无需断言也无需本地投影。
  const actions = createActions(ctx.sessions, () => ctx.get("uiWorkspace"), t);

  // 注册不加静默 try/catch：失败必须可见（chat-recovery 静默吞错是反模式）
  // 编辑/重试/续写统一只在 dock（conversation.input.dock，list 槽无链冲突）
  ctx.slots.inject("conversation.input.dock", () =>
    ctx.slots.register(
      {
        name: "conversation.input.dock",
        // dock 条目按本包条目 id（NS）登记——它既不是 bundle 包名（BUNDLE_PKG，
        // 见文件头「两个标识」纪律），也不是引用标签（REFERENCE_SOURCE_KEY）。
        id: NS,
        order: 500,
        inject: () => ({ actions, t }),
      },
      RescueDockView,
    ),
  );

  const scope = ctx.configForms.get(NS);
  const store = cardStore(scope);
  // 0.1.6：设置卡槽位迁移——settings.plugin.item 已随旧设置页删除，新契约是
  // 插件管理页的 plugins.bundle.config（keyed，key=bundle 包名；owner 按
  // view='summary'|'page' 两次派发：summary=标题下一行摘要，page=配置表单）。
  // 0.1.7 复核：该槽位仍在（installed dsh-client-ui-plugin-manager/lib/types/client/
  // slot-contract.d.ts:100 的 `plugins.bundle.config`），故本段不动——但 key 必须是
  // BUNDLE_PKG（bundle 包名）而不是 NS：见文件头那条「两个标识」纪律。
  ctx.slots.inject("plugins.bundle.config", () => {
    const unregister = ctx.slots.register(
      {
        name: "plugins.bundle.config",
        key: BUNDLE_PKG,
        inject: () => ({
          t,
          hooks: { card: store },
          // 批量原子写 + 保存时固定的 revision：卡片一次保存只发一次 mutation。
          mutate: (ops: readonly SettingsPathOp[], expectedRevision: number | undefined) =>
            scope.mutate(ops, expectedRevision),
          revision: (): number | undefined => scope.getSnapshot().revision,
        }),
      },
      RescueSettingsCard,
    );
    // disposer 只 unregister()，**不 dispose 表单**：0.1.7 的 `configForms.get(entryId)`
    // 交回的是 provider 自己持有的共享表单（installed config-form.d.ts:138-142
    // "The entry's form, owned by this provider"），消费者拿它只读/排队写入，没有
    // 属于本卡片的 dispose 可登记。slot collapse 会调用本 disposer 并在再次声明时
    // **重跑工厂**（ui-renderer registry inject 契约："Collapse disposes the effect
    // and a later declaration runs it again"）——表单是共享且长活的，所以重跑后写入
    // 依然落盘；旧 `settingsScope` 那种「离开插件页一次之后 scope 永久 disposed、
    // 每次保存被静默丢弃」的坑（0.1.6 的 fiber 级 dispose）随该服务一起消失。
    return unregister;
  });
}

export { inject, apply };

// 类型补充：globalThis 上的幂等标记（浏览器运行时由本文件声明）。
declare global {
  var __sessionRescueApplied: boolean | symbol | undefined;
}
