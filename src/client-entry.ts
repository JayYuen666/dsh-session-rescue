// src/client-entry.ts — session-rescue client UI 主体（esbuild 打包入口）。
// 打包：pnpm build:client → build-client.mjs 把本文件 + lib/transcript.ts 一起
// 打成 client.js（window.__ModuleLoader__.load UMD factory）。react 外部化：
// factory 的 require('react') 由模块系统提供。React 只用 createElement；
// 颜色只走 --dsw-alias-* token。
//
// 数据源纪律（0.1.2-alpha.1 实测）：
//   nodes/turnEnds/runningCalls ← useChat((c) => c.legacy)
//   running/removed/lastAgentError/queue ← useSession
// 组件合并成 view 后再调 transcript 函数。禁止从 useSession 读 nodes。

import { createElement, useEffect, useState, useSyncExternalStore } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { BuiltInLocaleId } from "@deepseek-ai/dsh-client-locale/client";
// plugin-manager 是 `plugins.bundle.config` 这条 keyed 槽的**属主**（installed
// `dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:100-104`，文件头明写
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
// dsh-client-ui-chat 的 `UseChat`（其 contract/slots.d.ts:16
// `= SnapshotSelectorHook<ChatSnapshot>`，:179-182 merge 进同一张表）。
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
// `QueueAction` 是 `/types` 子路径上的官方线格式。
import type { QueueAction } from "@deepseek-ai/dsh-api-session-controller/types";
// Remote 调用的统一返回包（`prompt`/`cancel`/`updateQueue` 的返回都挂在它上面）。
import type { RemoteFailure, RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
// `openSession` 属主是 workspace 导航服务（`ctx.uiWorkspace`）——官方 `ISessions` 上
// **没有** `open`：`sessions.list` 的注释明写「navigation belongs to view owners」。
import type { UiWorkspace } from "@deepseek-ai/dsh-client-ui-workspace/client";
// 宿主交回的 id 是跨进程数据：先按形状守卫，再用官方 `brandString` 落回品牌类型
//（`@deepseek-ai/dsh-brand` 运行时恒等、零状态；本包 client.js 把它内联，不新增运行时载入）。
import { brandString } from "@deepseek-ai/dsh-brand";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
// `MessageId` 由 dsh-llm 拥有（`updateQueue(itemId: MessageId, …)` 的形参品牌）。
import type { MessageId, TextBlock } from "@deepseek-ai/dsh-llm";
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
import { decideDockState } from "../lib/dock-state.ts";
import type {
  RescuePending,
  RescueSessionState,
  RescueStateBody,
  ToggleState,
} from "../lib/dock-state.ts";
import { UI_MESSAGES } from "./ui-messages.ts";
import type { LocaleNs, Translate, UiMessages } from "./ui-messages.ts";
import { fieldOf, isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

// NS 的字面量形态是**承重**的：test/profile-bundle.ts 的漂移针从产物里按
// `const NS = "…"` 抓这条声明，再与 cordis.patch.yml 的裸 `- id:` 比对（写成别名
// 就让那条针取不到值）；类型标注不改变产物，针照旧抓得到。同一条串的另外两位（文案
// 命名空间本源、引用标签 REFERENCE_SOURCE_KEY）各自由 `LocaleNs` 与该常量本身钉住。
const NS: LocaleNs = "session-rescue";
const STATE_URL = "/_dsh/session-rescue/state";
const CANCEL_URL = "/_dsh/session-rescue/cancel";
const TOGGLE_URL = "/_dsh/session-rescue/toggle";

// ⚠ 两个**不同**的标识，别混用（混用过的形状：卡片打不开 / 保存写进别的条目）：
//  - `NS` = loader 条目 id = settings 命名空间 = `configForms.get(NS)` 的入参，
//    真源是本包 cordis.patch.yml 的裸 `- id:`（宿主读 `entry.options.id`）。
//  - 下面这个常量 = 本包在 profile 里那条 bundle 的**包名**，只当槽位 key 用。
// `plugins.bundle.config` 是按 bundle 包名 keyed 的槽位：宿主把注册项的 key 与
// bundle 包名精确相等匹配后才渲染（installed
// dsh-client-ui-plugin-manager/lib/client.js:1821 的
// `renderSlot("plugins.bundle.config", { view: "page" }, { entryKey: pkg.name })` →
// dsh-client-ui-renderer/lib/client.js:1154 的 `e.options.key === opts?.entryKey`；
// 同文件 :2698 的 `configured: ledger.bundles.has(openPkg.name)` 读的就是这批 key），
// 契约文本 installed dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:96-100
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
  ".sr-btn-solid{border-color:var(--dsw-alias-brand-primary,#2f6fed);background:var(--dsw-alias-brand-primary,#2f6fed);color:var(--dsw-alias-label-primary-foreground,#fff)}",
  ".sr-btn-solid:hover:not(:disabled){filter:brightness(.96)}",
  ".sr-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2f6fed);outline-offset:1px}",
  ".sr-editor{display:flex;flex-direction:column;gap:6px;padding:6px 0}",
  ".sr-textarea{width:100%;min-height:72px;resize:vertical;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-fill-primary,transparent);border:1px solid var(--dsw-alias-border-l3,#d8dbe2);border-radius:6px;padding:8px;box-sizing:border-box}",
  ".sr-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f99)}",
  ".sr-error{font-size:12px;color:var(--dsw-alias-text-danger,#d33)}",
  // dock 宽度对齐会话内容列（与 ._0Z7gsa_column 同款居中约束）
  ".sr-dock{box-sizing:border-box;width:100%;max-width:var(--dsh-chat-content-width,748px);margin:0 auto;display:flex;flex-direction:column;gap:4px;padding:4px 0;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary,inherit)}",
  ".sr-banner{display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border,#d8dbe2);border-radius:6px;padding:4px 8px}",
  ".sr-queue-row{display:flex;align-items:center;gap:8px}",
  ".sr-queue-preview{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#8a8f99)}",
].join("\n");

// ── JSX 内联样式里重复出现的那几位（CSS 数组之外的共用位）────────────────────
// 颜色只走 --dsw-alias-* token（文件头纪律）；同一个 token 在各组件里各抄一遍，
// 换 token 时必然漏抄，故在此一处定义。

/** 主文案色（label / 输入正文）。 */
const LABEL_PRIMARY_COLOR = "var(--dsw-alias-label-primary, inherit)";

/** 次级文案色（hint 行、档位摘要行）。 */
const LABEL_TERTIARY_COLOR = "var(--dsw-alias-label-tertiary, #8a8f99)";

/** 可编辑控件（number/text 输入框、provider 下拉）的描边。 */
const CONTROL_BORDER = "1px solid var(--dsw-alias-border-l3, #d8dbe2)";

/** 设置卡字段行的版式：标题+说明在左、控件在右，行间 9px 上间距。
 *  开关行（ToggleRow）与数字行（NumberField）逐字段同形，共用这一份。 */
const FIELD_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "9px 0",
};

// ── host 状态轮询（自排循环：有 pending 走 1s、空闲走 5s；无订阅或页签隐藏即停）
// 快照引用稳定化：fetch 每次产出新对象，若直接赋给 data，useSyncExternalStore
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
  refresh: () => Promise<void>;
  schedule: () => void;
  stop: () => void;
  subscribe: (listener: () => void) => () => void;
  syncVisibility: () => void;
  getSnapshot: () => RescueStateBody | null;
}

// ── CSRF 回填：host 的 mutating POST（cancel/toggle/resume）要求回填
// state GET 下发的 per-apply token（x-rescue-csrf 头）。token 只存内存（不进
// localStorage：apply 重启即换，与 host per-apply 生命周期一致）。导出仅供单测。
export const rescueCsrfStore: {
  token: string;
  remember: (body: unknown) => void;
} = {
  token: "",
  remember(body: unknown): void {
    if (!isRecord(body)) {
      return;
    }
    const { csrf } = body;
    if (typeof csrf === "string" && csrf !== "") {
      this.token = csrf;
    }
  },
};

/** 从原始 /state 载荷投影 pending（字段不全/类型不符 → null；防御纵深）。 */
function parsePending(raw: unknown): RescuePending | null {
  if (!isRecord(raw)) {
    return null;
  }
  const { turn, kind, fireAt, remainingMs, chained, suspended } = raw;
  if (
    typeof turn !== "number" ||
    typeof kind !== "string" ||
    typeof fireAt !== "number" ||
    typeof remainingMs !== "number"
  ) {
    return null;
  }
  return {
    turn,
    kind,
    fireAt,
    remainingMs,
    ...(chained === true ? { chained: true } : {}),
    ...(suspended === true ? { suspended: true } : {}),
  };
}

/** 一条会话计数的逐字段守卫投影：非数字落回 0，pending 只认显式 `null` 与可投影对象。
 *  `disabled` 只在显式 true 时出现在结果里（缺位 ⇒ 与 `false` 判定同解，见 dock 读侧）。 */
function parseSessionEntry(entry: Record<string, unknown>): RescueSessionState {
  const { count, lastFireAt, disabled, pending: pendingRaw } = entry;
  return {
    count: typeof count === "number" ? count : 0,
    lastFireAt: typeof lastFireAt === "number" ? lastFireAt : 0,
    pending: pendingRaw === null ? null : parsePending(pendingRaw),
    ...(disabled === true ? { disabled: true } : {}),
  };
}

/** 解析 /state 载荷为内部类型：逐字段守卫投影，坏形状降级而非丢给断言。
 *  ok!==true 或 sessions 非对象 → 返回 null（refresh 保持快照不动）。 */
function parseStateBody(parsed: Record<string, unknown>): RescueStateBody | null {
  if (fieldOf(parsed, "ok") !== true) {
    return null;
  }
  const sessions = fieldOf(parsed, "sessions");
  if (!isRecord(sessions)) {
    return { ok: true };
  }
  const entries: Record<string, RescueSessionState> = {};
  for (const sessionId of Object.keys(sessions)) {
    const entry = sessions[sessionId];
    if (isRecord(entry)) {
      entries[sessionId] = parseSessionEntry(entry);
    }
  }
  return { ok: true, sessions: entries };
}

/** 有 pending 时的周期：横幅按秒走倒计时，慢档会让显示的剩余时间明显过期。 */
export const ACTIVE_POLL_MS = 1000;

/** 无 pending 时的兜底周期：没有倒计时在跑，轮询只为发现 host 侧新出现的
 *  pending。旧实现不分档位一律 1Hz，空闲页签也每秒打一发 /state。 */
export const IDLE_POLL_MS = 5000;

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
  async refresh(): Promise<void> {
    if (this.inFlight) {
      return;
    }
    this.inFlight = true;
    // 通知门控：只有快照内容变了、或这一跳没读到有效载荷（HTTP 非 ok / 坏形状 /
    // 抛错）才惊动订阅者。旧实现在 finally 里无条件遍历 listeners，内容不变也每
    // tick 把每个订阅者 schedule 进 React 一遍。
    let worthNotifying = false;
    try {
      const res = await fetch(STATE_URL, { headers: { accept: "application/json" } });
      let data: RescueStateBody | null = null;
      if (res.ok) {
        // json() 返回 any：先经 unknown 再用 isRecord 收窄，避免从 any 断言
        const parsed: unknown = await res.json();
        if (isRecord(parsed)) {
          rescueCsrfStore.remember(parsed);
          data = parseStateBody(parsed);
        }
      }
      if (data === null || !data.ok) {
        worthNotifying = true;
      } else {
        // 状态对象小（每会话几个数字 + 布尔），JSON 对比开销可忽略。
        // 内容不变 → 保留旧引用 → React 跳过重渲染。
        const key = JSON.stringify(data);
        if (key !== this.stableKey) {
          this.stableKey = key;
          this.data = data;
          worthNotifying = true;
        }
      }
    } catch {
      // 轮询失败静默：保持旧引用，下一跳由 schedule 按档位补上。
      worthNotifying = true;
    } finally {
      this.inFlight = false;
      if (worthNotifying) {
        for (const listener of this.listeners) {
          listener();
        }
      }
      this.schedule();
    }
  },
  schedule(): void {
    this.stop();
    if (this.listeners.size === 0 || pageHidden()) {
      return;
    }
    const pollMs = nextPollMs(this.data);
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

export interface JsonResult {
  ok: boolean;
  cancelled?: boolean;
  disabled?: boolean;
  turn?: number;
}

async function postEmpty(url: string): Promise<JsonResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: rescueCsrfStore.token === "" ? {} : { "x-rescue-csrf": rescueCsrfStore.token },
    });
    const parsed: unknown = await res.json();
    if (!res.ok || !isRecord(parsed)) {
      return { ok: false };
    }
    // 只需 ok 布尔（调用方不消费 cancelled/disabled）；省略号投影避免断言
    const { ok } = parsed;
    return { ok: ok === true };
  } catch {
    return { ok: false };
  }
}
// 两位都是纯转发，真正的等待在 postEmpty 里（fetch + res.json）。本包的三条 async
// 规则在此咬合：`require-await`（async 函数必须有 await）、`promise-function-async`
//（返回 promise 的函数必须是 async）与 `return-await`（不许 `return await`）。
// 因此把等待写成落地一跳再交回——语义与调用点完全一致（调用方要么 `await`（测试），
// 要么把返回值当 promise 交给 runHostAction）。
export async function postCancel(sessionId: string): Promise<JsonResult> {
  const result = await postEmpty(`${CANCEL_URL}?sessionId=${encodeURIComponent(sessionId)}`);
  return result;
}
export async function postToggle(sessionId: string): Promise<JsonResult> {
  const result = await postEmpty(`${TOGGLE_URL}?sessionId=${encodeURIComponent(sessionId)}`);
  return result;
}

// ── 业务动作（全部经 sessions 服务；失败返回 {ok:false, code, message}）──

interface ActionResult {
  ok: boolean;
  error?: { code?: string; message?: string };
}

/**
 * `ctx.sessions` 在本包用到的三位上：直接索引官方 `ISessions`（installed
 * `dsh-api-session-controller/lib/types/client/contract/sessions.d.ts:43-153`）。
 * 旧镜像有三处与官方不符，都由这次改绑暴露：
 *  1. `binding(id)` 官方返回 **`SessionBinding | undefined`**（其 `.session` 是
 *     `SessionFace`），镜像写成 `{ session: SessionBinding }` 等于把 `SessionFace`
 *     标成了 `SessionBinding`——属性路径巧合，标签是错的；
 *  2. `fork` 官方返回 `Promise<SessionId>`（品牌串），镜像写成 `Promise<string>`；
 *  3. 镜像里的 `open(id)` **官方根本不存在**：`ISessions` 与实现 `ClientSessions`
 *     都没有该成员，且 `sessions.list` 的注释明写「navigation belongs to view owners」；
 *     首方 Chat 的 fork 流程是 `ctx.sessions.fork(...).then((childId) =>
 *     ctx.uiWorkspace.openSession(childId))`（installed
 *     `dsh-client-ui-chat/lib/client.js:11790-11798`）。本包照旧镜像调 `sessions.open`
 *     会在真宿主上 TypeError，并被 `forkAndSend` 的 catch 收成一次「操作失败」，
 *     测试因为按同一份镜像造假 sessions 而永远看不见。
 */
export type SessionsService = Pick<ISessions, "binding" | "fork" | "using">;

/** 导航位按官方成员面投影（`UiWorkspace` 还有 openWorkspace/forkSession 等，本包只用一位）。 */
type WorkspaceNavigation = Pick<UiWorkspace, "openSession">;

/** 会话绑定取不到时的失败码：四条动作（重发/停止重问/撤回/编辑）的开手守卫同源。 */
const SESSION_UNAVAILABLE_CODE = "session-unavailable";

interface ActionFailure {
  ok: false;
  code?: string;
  message?: string;
}

/**
 * 本包对卡片交出的动作面。**会话/消息标识用官方品牌**（`SessionId` / `MessageId`），
 * 因为下游每一位都是官方 API 的形参——用裸 `string` 只是把不匹配推到运行时。
 */
interface Actions {
  sendSameSession: (sessionId: SessionId, text: string) => Promise<ActionResult | ActionFailure>;
  stopAndReask: (sessionId: SessionId, text: string) => Promise<ActionResult | ActionFailure>;
  withdrawQueueItem: (
    sessionId: SessionId,
    itemId: MessageId,
  ) => Promise<ActionResult | ActionFailure>;
  editQueueItem: (
    sessionId: SessionId,
    itemId: MessageId,
    text: string,
  ) => Promise<ActionResult | ActionFailure>;
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
 * 一条纯文本块：官方 `TextBlock`（dsh-llm）。`prompt` 的 `PromptContentPart` text 支与
 * `QueueAction.edit.content` 的 `readonly TextBlock[]` 都收它——写成 `PromptContentPart`
 * 反而过不了 `updateQueue`（那是含 image/file 的联合，`TextBlock` 才是它的元素类型）。
 */
function textPart(text: string): TextBlock {
  return { type: "text", text };
}

function createActions(
  sessions: SessionsService,
  workspace: WorkspaceNavigation | undefined,
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

  async function withdrawQueueItem(
    sessionId: SessionId,
    itemId: MessageId,
  ): Promise<ActionResult | ActionFailure> {
    const binding = bindingOf(sessionId);
    if (binding === undefined) {
      return { ok: false, code: SESSION_UNAVAILABLE_CODE, message: t("sessionUnavailable") };
    }
    const result = await binding.session.updateQueue(itemId, { kind: "remove" });
    return result.ok ? { ok: true } : failResult(result);
  }

  async function editQueueItem(
    sessionId: SessionId,
    itemId: MessageId,
    text: string,
  ): Promise<ActionResult | ActionFailure> {
    const binding = bindingOf(sessionId);
    if (binding === undefined) {
      return { ok: false, code: SESSION_UNAVAILABLE_CODE, message: t("sessionUnavailable") };
    }
    const action: QueueAction = { kind: "edit", content: [textPart(text)] };
    const result = await binding.session.updateQueue(itemId, action);
    return result.ok ? { ok: true } : failResult(result);
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
    workspace?.openSession(childId);
    try {
      return await sessions.using(childId, { source: SESSION_RESCUE_SOURCE }, async (reference) => {
        const result = await reference.binding.session.prompt([textPart(text)], "queue");
        return result.ok ? { ok: true } : failResult(result);
      });
    } catch {
      // 子会话拿不到引用（retain 失败/生成期已 dispose）：用户看到的仍是「分支不可用」，
      // 与旧实现里 `binding(childId)` 取空时的回执码同源。
      return { ok: false, code: "branch-unavailable", message: t("branchUnavailable") };
    }
  }

  return { sendSameSession, stopAndReask, withdrawQueueItem, editQueueItem, forkAndSend };
}

// ── 合并 view：useChat.legacy + useSession 控制字段 ─────────────────────

/**
 * dock 组件的 props。**四位 standard kit 一律取官方合成面**，不再逐成员重述：
 * `SessionStandardProps`（installed `@deepseek-ai/dsh-client-ui-slots/lib/types/index.d.ts:191`）
 * 是一张由各方 merge 的空表——`sessionId` / `useSession` / `useProjection` 由
 * `@deepseek-ai/dsh-client-ui-session`（其 lib/types/client/index.d.ts:77-84）合入，
 * `useChat` 由 `@deepseek-ai/dsh-client-ui-chat`（其 contract/slots.d.ts:179-182）合入，
 * 于是本包 selector 读到的 `snap.running` / `snap.legacy.nodes` 等成员的形状、只读性、
 * 品牌（`sessionId: SessionId`）都由宿主侧的那份声明交出。旧实现把这四位手抄成
 * `sessionId: string` + 三个自造 selector 签名，`slots` 也因此只能跟着降级成本地面
 * （官方 `register` 会按 `ComposedProps` 反变校验组件形参，抄窄了就直接红，
 * 见下面 ClientCtx.slots 处记的那条 TS2769）。
 * 只有 `actions` / `t` 是本包自有的注入位（经 `slots.register` 的 inject 面下发）。
 */
interface DockProps extends Pick<SessionStandardProps, "sessionId" | "useProjection"> {
  /** 官方席位类型（同 `SessionStandardProps['useSession']`，写成名字便于引用属主导出）。 */
  useSession: SessionSnapshotSelector;
  /** 官方席位类型（同 `SessionStandardProps['useChat']`）。 */
  useChat: UseChat;
  actions: Actions;
  /** 取文案（官方 ctx.locale.bind 的结果，见 apply）。 */
  t: Translate;
}

/** 排队行的内部视图模型（inbox UserMessage 归一化后的形态）。 */
interface QueueItem {
  /** 官方 `UserMessage.id`（inbox 行的身份位），下游直接喂 `updateQueue(itemId)`。 */
  id: MessageId;
  /** 纯文本消息的原文（编辑回填用）；含非文本块时为 null（不可安全编辑）。 */
  text: string | null;
  /** 扁平化预览（非 text 块以 [type] 占位，200 字截断）。 */
  preview: string;
}

const QUEUE_PREVIEW_CHARS = 200;

/** 内容块守卫（inbox UserMessage.content 的元素）。 */
function isContentBlock(value: unknown): value is { type: string; text?: string } {
  return isRecord(value) && typeof fieldOf(value, "type") === "string";
}

/** inbox content 数组 → { text, preview }。逐元素守卫，坏形状跳过而非抛错。 */
function queueTextFromContent(content: unknown): { text: string | null; preview: string } {
  if (!Array.isArray(content)) {
    return { text: null, preview: "" };
  }
  const blocks: { type: string; text?: string }[] = [];
  for (const entry of content) {
    if (isContentBlock(entry)) {
      blocks.push(entry);
    }
  }
  const preview = blocks
    .map((block) =>
      block.type === "text" && typeof block.text === "string" ? block.text : `[${block.type}]`,
    )
    .join(" ")
    .replaceAll(/\s+/gu, " ")
    .trim();
  // 纯文本判定与拼接合并成一次遍历：原先 `every(判定)` + `map(b => b.text ?? "")`
  // 两处判据同源，`?? ""` 的右支在 allText 为真时不可达（每个块都已确认 text
  // 是字符串），而 noUncheckedIndexedAccess/可选属性又不允许直接 `block.text`。
  const texts: string[] = [];
  let allText = blocks.length > 0;
  for (const block of blocks) {
    const body = block.text;
    if (block.type === "text" && typeof body === "string") {
      texts.push(body);
    } else {
      allText = false;
    }
  }
  // 代码点截断（对齐官方 QueueDock 的 Array.from 语义）：`/./gu` 逐码点切，
  // emoji（代理对）不被劈半。不用 Array.from（unicorn/prefer-spread 拒）也不用
  // 展开（no-misused-spread 拒：字符串展开按 UTF-16 码元，会劈开代理对）。
  const chars = preview.match(/./gu) ?? [];
  return {
    text: allText ? texts.join("") : null,
    preview:
      chars.length > QUEUE_PREVIEW_CHARS
        ? `${chars.slice(0, QUEUE_PREVIEW_CHARS).join("")}…`
        : preview,
  };
}

/**
 * inbox "next-turn"（UserMessage 线格式）→ QueueItem[]。
 * 逐字段守卫投影，对任意输入宽容（非数组/缺 id 一律跳过），绝不抛错——
 * undefined/未就绪入参返回空数组正是防崩点。
 */
function queueItemsOfInbox(inbox: unknown): QueueItem[] {
  const list = fieldOf(inbox, "next-turn");
  if (!Array.isArray(list)) {
    return [];
  }
  const items: QueueItem[] = [];
  for (const message of list) {
    const id = isRecord(message) ? fieldOf(message, "id") : undefined;
    if (typeof id === "string") {
      const { text, preview } = queueTextFromContent(fieldOf(message, "content"));
      // 守卫过的宿主串落回官方品牌：`brandString` 运行时恒等（见文件头导入处）。
      items.push({ id: brandString<MessageId>(id), text, preview });
    }
  }
  return items;
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

/** 排队消息区：逐行渲染，含编辑/撤回（自带草稿与错误态）。 */
interface QueueSectionProps {
  sessionId: SessionId;
  actions: Actions;
  queue: QueueItem[];
  t: Translate;
}

function QueueSection(props: QueueSectionProps): ReactNode {
  const { sessionId, actions, queue, t } = props;
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [itemDraft, setItemDraft] = useState("");
  const [queueError, setQueueError] = useState<string | null>(null);

  const saveEdit = async (item: QueueItem): Promise<void> => {
    setQueueError(null);
    try {
      const result = await actions.editQueueItem(sessionId, item.id, itemDraft);
      if (result.ok) {
        setEditingItemId(null);
      } else {
        setQueueError(errText(result, t));
      }
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : String(error));
    }
  };
  const withdraw = async (item: QueueItem): Promise<void> => {
    setQueueError(null);
    try {
      const result = await actions.withdrawQueueItem(sessionId, item.id);
      if (!result.ok) {
        setQueueError(errText(result, t));
      }
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : String(error));
    }
  };

  const rows: ReactNode[] = [
    createElement("div", { key: "queue-label", className: "sr-hint" }, t("queueLabel")),
  ];
  for (const item of queue) {
    if (editingItemId === item.id) {
      const textarea = createElement("textarea", {
        className: "sr-textarea",
        value: itemDraft,
        autoFocus: true,
        onChange: (ev: React.ChangeEvent<HTMLTextAreaElement>) => {
          setItemDraft(ev.target.value);
        },
      });
      const saveButton = createElement(
        "button",
        {
          type: "button",
          className: "sr-button sr-primary",
          disabled: itemDraft.trim() === "",
          onClick: () => void saveEdit(item),
        },
        t("save"),
      );
      const discardButton = createElement(
        "button",
        {
          type: "button",
          className: "sr-button",
          onClick: () => {
            setEditingItemId(null);
          },
        },
        t("cancel"),
      );
      rows.push(
        createElement(
          "div",
          { key: `edit-${item.id}`, className: "sr-editor" },
          textarea,
          createElement("div", { className: "sr-row" }, saveButton, discardButton),
        ),
      );
    } else {
      // inbox UserMessage 无 placement（转向/上下文分类随旧 queue 模型移除）；
      // 纯文本项可编辑，含附件等非文本块项只展示预览。
      // editableText 是本行的不可变快照：编辑按钮只在它非空时出现，回填因此
      // 不需要第二次降级（原 `item.text ?? ""` 的右支在按钮已渲染的装配下不可达）。
      const editableText = item.text;
      const editButton =
        editableText === null
          ? null
          : createElement(
              "button",
              {
                type: "button",
                className: "sr-button",
                onClick: () => {
                  setEditingItemId(item.id);
                  setItemDraft(editableText);
                },
              },
              t("edit"),
            );
      const viewRow = createElement(
        "div",
        { key: `row-${item.id}`, className: "sr-queue-row" },
        createElement("span", { className: "sr-queue-preview" }, item.text ?? item.preview),
        editButton,
        createElement(
          "button",
          {
            type: "button",
            className: "sr-button",
            onClick: () => void withdraw(item),
          },
          t("withdraw"),
        ),
      );
      rows.push(viewRow);
    }
  }
  if (queueError !== null) {
    rows.push(createElement("div", { key: "queue-error", className: "sr-error" }, queueError));
  }
  return rows;
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

/** 每会话开关行（三态 v8：on=开启 / off=已关闭 / unknown=快照未就绪）。
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

/** dock：倒计时横幅 / 停止重问 / 排队行 / 每会话开关 */
function RescueDockView(props: DockProps): ReactNode {
  const { sessionId, actions, t } = props;
  const view = useTranscriptView(props);
  // 0.1.6：队列数据源 = inbox 投影（useSession.queue 已移除，直读会 undefined）。
  // useProjection 缺失（框架版本不含该 seat）时同样回空，不抛错。
  const inbox =
    typeof props.useProjection === "function" ? props.useProjection("inbox") : undefined;
  const queue = queueItemsOfInbox(inbox);
  const rescue = useRescueState();

  const [busyStop, setBusyStop] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [dockEditing, setDockEditing] = useState(false);
  const [dockBusy, setDockBusy] = useState(false);
  const [dockError, setDockError] = useState<string | null>(null);
  // 取消/开关两条 host 写通道的失败面（item 9）：postCancel/postToggle 返回
  // {ok:false}（403 csrf 过期、host 重启、网络中断）时**什么都没发生**——倒计时
  // 照跑、待办照发。原先 `void postCancel(...)` 把它当成功，用户按了取消却仍被
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

  // v8 竞态修复：渲染决策全部走纯函数 decideDockState（lib/dock-state.ts）——
  // 轮询快照未就绪/会话切换缺状态时 toggle=unknown（中性态），
  // hasContent 只控容器显隐，组件常驻挂载不卸载（本地状态不丢）。
  const decision = decideDockState(view, queue.length, rescue, sessionId, canStopReask);
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
    // TS 据此把 lastText 收窄为 string（旧实现里 doStopReask 内的 null 早退
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

  if (queue.length > 0) {
    children.push(createElement(QueueSection, { key: "queue", sessionId, actions, queue, t }));
  }

  // 开关行三态（v8）：on=开启 / off=已关闭 / unknown=快照未就绪（中性"—"，按钮禁用）
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

  // v8：dock 容器常驻挂载（本地状态不随轮询 tick 丢失）；hasContent=false 时
  // 用 hidden 属性隐藏而非卸载组件——会话切换/快照空窗不再销毁草稿与 busy 标志。
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
 * `dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:150-155`——它本身就是
 * `ConfigFormSnapshot<Record<string, unknown>>` 的具名投影），而不是本地再写一遍泛型实参：
 * 宿主换表单快照形状时这一位跟着红，本地重述的泛型则会悄悄继续编译。
 */
type FormSnapshot = ConfigPageForm["state"];

/**
 * 写入一个字段并**复读快照确认落地**（item 5）。
 *
 * 0.1.7 的 `ConfigForm.set` 在宿主校验拒绝时既不抛也不改快照：它走 recover 分支
 * 重载 Host 状态（installed `config-form.d.ts:83` 的 `private recover`），回
 * `false`；写入被跳过（memory 模式等）同样回 `false` 而不是抛（同文件
 * `config-form-types.d.ts`："false for refusal or skipped writes"）。本卡仍以事后
 * 复读为唯一判定点：快照里该字段仍是旧值 → 回一句 `fieldRejected`，由 commitTouched
 * 转成用户可见的失败——复读同时覆盖「拒绝」与「静默丢弃」两种形状，比只看受理位更强，
 * 故 0.1.6 那条纪律原样保留（受理位是新增信号，将来可直接改用，但不必在此次迁移里
 * 改行为）。
 */
async function setAndVerify(
  scope: EntryForm,
  field: string,
  next: unknown,
  t: Translate,
): Promise<string | null> {
  await scope.set(field, next);
  // 官方 value 在首个快照受理前是 undefined，那时读不到任何落库值（比较仍按「两侧都
  // 没有这个字段」成立），故不需要 isRecord 再筛一遍对象性。
  const snapshot = scope.getSnapshot().value;
  const landed = snapshot === undefined ? undefined : snapshot[field];
  if (JSON.stringify(landed ?? null) === JSON.stringify(next ?? null)) {
    return null;
  }
  return t("fieldRejected", { field, value: JSON.stringify(landed ?? null) });
}

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

interface ToggleRowProps {
  label: string;
  hint: string;
  /** 稳定锚点（测试/schema 门禁按字段定位控件）。 */
  field: string;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}

function ToggleRow(props: ToggleRowProps): ReactNode {
  const { label, hint, checked, disabled, onToggle } = props;
  return createElement(
    "div",
    { style: FIELD_ROW_STYLE },
    createElement(
      "div",
      { style: { minWidth: 0, marginRight: 12 } },
      createElement("div", { style: { fontSize: 13, color: LABEL_PRIMARY_COLOR } }, label),
      createElement(
        "div",
        {
          style: { fontSize: 12, color: LABEL_TERTIARY_COLOR, marginTop: 2 },
        },
        hint,
      ),
    ),
    createElement(
      "button",
      {
        type: "button",
        role: "switch",
        "aria-checked": checked,
        "aria-label": label,
        disabled,
        onClick: onToggle,
        style: {
          position: "relative",
          flex: "none",
          width: 36,
          height: 20,
          borderRadius: 10,
          border: "none",
          padding: 0,
          cursor: disabled ? "not-allowed" : "pointer",
          background: checked
            ? "var(--dsw-alias-brand-primary, #2f6fed)"
            : "var(--dsw-alias-border-l3, #d8dbe2)",
          opacity: disabled ? 0.5 : 1,
        },
      },
      createElement("span", {
        style: {
          position: "absolute",
          top: 2,
          left: checked ? 18 : 2,
          width: 16,
          height: 16,
          borderRadius: 8,
          background: "var(--dsw-alias-label-primary-foreground, #ffffff)",
          transition: "left .12s",
        },
      }),
    ),
  );
}

interface NumberRowProps {
  label: string;
  hint: string;
  /** 稳定锚点（schema-coverage 门禁按此识别绑定字段）。 */
  field: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onCommit: (num: number) => void;
}

function NumberRow(props: NumberRowProps): ReactNode {
  const { label, hint, value, min, max, disabled, onCommit } = props;
  void props.field;
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);
  // 保存条模式：有效输入只上报草稿（onCommit → touched），不直写。
  const stage = (): void => {
    const parsed = Number(draft);
    if (Number.isFinite(parsed) && parsed >= min && parsed <= max) {
      onCommit(Math.round(parsed));
    }
  };
  return createElement(
    "div",
    { style: FIELD_ROW_STYLE },
    createElement(
      "div",
      { style: { minWidth: 0, marginRight: 12 } },
      createElement("div", { style: { fontSize: 13, color: LABEL_PRIMARY_COLOR } }, label),
      createElement(
        "div",
        {
          style: { fontSize: 12, color: LABEL_TERTIARY_COLOR, marginTop: 2 },
        },
        hint,
      ),
    ),
    createElement("input", {
      type: "number",
      "data-field": props.field,
      value: draft,
      min,
      max,
      disabled,
      onChange: (ev: React.ChangeEvent<HTMLInputElement>) => {
        setDraft(ev.target.value);
        stage();
      },
      onKeyDown: (ev: React.KeyboardEvent<HTMLInputElement>) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          stage();
        }
      },
      style: {
        width: 110,
        font: "inherit",
        fontSize: 13,
        color: LABEL_PRIMARY_COLOR,
        background: "transparent",
        border: CONTROL_BORDER,
        borderRadius: 6,
        padding: "4px 8px",
      },
    }),
  );
}

interface SettingsCardProps {
  /** plugins.bundle.config owner 两视图派发：summary=标题下一行摘要，page=配置表单。
   *  判别位取**槽位属主包**的官方声明（installed
   *  `dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:20-24`
   *  `PluginConfigViewProps['view']`），不再本地抄一份字面量联合：属主增删视图（例如补
   *  'row'）时这里当场红，本地抄件只会悄悄继续编译。 */
  view: PluginConfigViewProps["view"];
  useCard: <Out>(selector: (snap: CardSnapshot) => Out) => Out;
  /** 单字段写入并复读确认：resolve(null)=已落地，resolve(文案)=被宿主拒绝。 */
  set: (field: string, value: unknown) => Promise<string | null>;
  /** 取文案（官方 ctx.locale.bind 的结果，见 apply）。 */
  t: Translate;
}

// ── 429 重试策略区块（官方 llm-retry provider 级 retryPolicy 配置）────────────
// 数据流：GET /_dsh/session-rescue/retry-providers（host 读 llm-pi-ai namespace）
// → 每 provider 一行下拉；选择 → POST /_dsh/session-rescue/retry-policy（带
// csrf）→ host 经官方 settings.mutate 落盘（validator 在写处把关）→ 重拉列表。
// 档位：default（官方默认 5 次码表）/ enhanced（12 次 + QUOTA + 8s→60s，
// settings.yaml 四家现行同款）/ always（官方无限重试 + backoff）/ off（0 次）。

interface RetryProviderRow {
  provider: string;
  mode: string;
  maxRetries: number;
  hasQuota: boolean;
}

/** 一行 provider 的逐字段守卫投影（坏类型落回空串/0，`hasQuota` 只认显式 true）。
 *  坏行本身由调用侧的 isRecord 挡下，不经 any 断言。 */
function parseProviderRow(rowRaw: Record<string, unknown>): RetryProviderRow {
  const { provider, mode, maxRetries, hasQuota } = rowRaw;
  return {
    provider: typeof provider === "string" ? provider : "",
    mode: typeof mode === "string" ? mode : "",
    maxRetries: typeof maxRetries === "number" ? maxRetries : 0,
    hasQuota: hasQuota === true,
  };
}

const RETRY_PROVIDERS_URL = "/_dsh/session-rescue/retry-providers";
const RETRY_POLICY_URL = "/_dsh/session-rescue/retry-policy";

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

/** 单行 provider 的下拉（档位选择，先暂存不落盘）。 */
function retryRowElement(
  row: RetryProviderRow,
  pending: Record<string, string>,
  disabled: boolean,
  onChange: (row: RetryProviderRow, next: string) => void,
  t: Translate,
): ReactNode {
  const options = Object.entries(RETRY_PRESET_KEYS).map(([key, labelKey]) =>
    createElement("option", { key, value: key }, t(labelKey)),
  );
  return createElement(
    "div",
    {
      key: row.provider,
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "6px 0",
      },
    },
    createElement(
      "div",
      { style: { minWidth: 0, flex: 1 } },
      createElement("div", { style: { fontSize: 13, color: LABEL_PRIMARY_COLOR } }, row.provider),
      createElement(
        "div",
        { style: { fontSize: 12, color: LABEL_TERTIARY_COLOR } },
        `${row.mode} · max ${row.maxRetries} · QUOTA ${row.hasQuota ? "✓" : "✗"}`,
      ),
    ),
    createElement(
      "select",
      {
        value: pending[row.provider] ?? presetOfRow(row),
        disabled,
        onChange: (ev: React.ChangeEvent<HTMLSelectElement>) => {
          onChange(row, ev.target.value);
        },
        style: {
          flex: "none",
          font: "inherit",
          fontSize: 12,
          color: LABEL_PRIMARY_COLOR,
          background: "var(--dsw-alias-bg-layer-2, transparent)",
          border: CONTROL_BORDER,
          borderRadius: 6,
          padding: "3px 6px",
        },
      },
      ...options,
    ),
  );
}

/** 区块标题。`bordered` 决定要不要那条分隔线与上边距：设置卡内的分区要（把长表单
 *  切成三段），429 区块不要——它的外壳容器自己已经画了一条 borderTop，再画就是双线。
 *  声明位置在首个调用点（RetryPolicySection）之前：函数声明虽提升，
 *  eslint/no-use-before-define 仍按书写顺序判定。 */
function settingsSectionTitle(text: string, bordered: boolean): ReactNode {
  return createElement(
    "div",
    {
      style: {
        fontSize: 13,
        color: LABEL_PRIMARY_COLOR,
        ...(bordered
          ? {
              marginTop: 8,
              borderTop: "1px solid var(--dsw-alias-border-l2)",
              paddingTop: 8,
            }
          : {}),
      },
    },
    text,
  );
}

/** 单个 provider 的落盘 POST。返回 null=已落盘，返回文案=host 拒绝（item 2）。
 *  fetch 只因网络/中止 reject，**不会因 4xx/5xx reject**——原注释说反了：
 *  403/400/500 全都落到"成功"分支清空 pending，用户以为档位已保存。 */
const applyPreset = async (provider: string, preset: string): Promise<string | null> => {
  if (rescueCsrfStore.token === "") {
    // csrf 缺失：先拉 state 回填；仍失败则 POST 裸发 403（不阻断，交由 host 判定）。
    try {
      const resp = await fetch(STATE_URL, { headers: { accept: "application/json" } });
      if (resp.ok) {
        const parsed: unknown = await resp.json();
        if (isRecord(parsed)) {
          rescueCsrfStore.remember(parsed);
        }
      }
    } catch {
      // 回填失败降级：继续走 POST（host 会以 403 拒绝，本函数把它归为落盘失败）。
    }
  }
  const res = await fetch(RETRY_POLICY_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-rescue-csrf": rescueCsrfStore.token,
    },
    body: JSON.stringify({ provider, preset }),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // 响应体非 JSON：只按状态码判定成败。
  }
  // 响应体读取一律经 fieldOf 投影：`body.ok` 这种点访问被 tsconfig 的
  // noPropertyAccessFromIndexSignature 拒，`body["ok"]` 又被 dot-notation 拒
  // ——两条规则只有第三条路（本文件统一的 fieldOf 读法）同时满足。
  const recorded = fieldOf(body, "ok") === true;
  if (res.ok && recorded) {
    return null;
  }
  const errorField = fieldOf(body, "error");
  const reason = typeof errorField === "string" ? errorField : `HTTP ${String(res.status)}`;
  return `${provider}→${preset}: ${reason}`;
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
    `${t("presetFaceUnavailable")}${state.error ?? ""}`,
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
      className: "sr-button sr-btn-solid",
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
      className: "sr-button",
      "data-field": "retry-discard",
      disabled: saving || dirtyCount === 0,
      onClick: onDiscard,
    },
    t("discard"),
  );
  const saveBarStatus =
    saveError === null
      ? createElement("span", { className: "sr-hint" }, dirtyCount > 0 ? t("presetDirty") : "")
      : createElement("span", { className: "sr-error" }, saveError);
  return createElement(
    "div",
    {
      style: {
        display: "flex",
        gap: 8,
        alignItems: "center",
        padding: "8px 0 2px",
        flexWrap: "wrap",
      },
    },
    saveButton,
    discardButton,
    saveBarStatus,
  );
}

function RetryPolicySection(props: { t: Translate }): ReactNode {
  const { t } = props;
  const [state, setState] = useState<RetryPanelState>(null);
  // 保存条模式：改档位先暂存（provider → preset），点「保存」批量落盘
  const [pending, setPending] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    try {
      const res = await fetch(RETRY_PROVIDERS_URL, { headers: { accept: "application/json" } });
      const parsed: unknown = await res.json();
      if (!res.ok || !isRecord(parsed)) {
        setState({ ok: false, error: `HTTP ${res.status}` });
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
  };

  useEffect(() => {
    void load();
  }, []);

  const dirtyCount = Object.keys(pending).length;
  const saveAll = async (): Promise<void> => {
    if (dirtyCount === 0) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const entries = Object.entries(pending);
      const outcomes = await Promise.all(
        entries.map(([provider, preset]) => applyPreset(provider, preset)),
      );
      setSaving(false);
      const failures = outcomes.filter((outcome): outcome is string => outcome !== null);
      if (failures.length > 0) {
        // 保留 pending：失败的档位仍是用户选的意图，重试点一次即可（已成功的
        // 档位重复 POST 是幂等的——host 侧同一 preset 写同一 retryPolicy）。
        setSaveError(`${t("saveFailed")}${failures.join(t("failureJoiner"))}`);
        return;
      }
      setPending({});
      void load();
    } catch (error) {
      setSaving(false);
      setSaveError(`${t("saveFailed")}${String(error instanceof Error ? error.message : error)}`);
    }
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
    "div",
    { style: { marginTop: 8, borderTop: "1px solid var(--dsw-alias-border-l2)", paddingTop: 8 } },
    settingsSectionTitle(t("retrySectionTitle"), false),
    createElement(
      "div",
      {
        style: {
          fontSize: 12,
          color: LABEL_TERTIARY_COLOR,
          paddingBottom: 4,
        },
      },
      t("retrySectionHint"),
    ),
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

/** touched 层与快照的差异字段（值语义比较；undefined 与缺失等价）。 */
export function diffTouched(
  touched: Record<string, unknown>,
  value: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  for (const key of Object.keys(touched)) {
    if (JSON.stringify(touched[key] ?? null) !== JSON.stringify(value[key] ?? null)) {
      out.push(key);
    }
  }
  return out;
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
 *  item 5：原先 set 自己 catch 并只 console.error，这里的 try 永远看不到失败，
 *  被宿主拒绝的值也会报"已保存"——现在 set 返回 promise 且必须 await。 */
async function commitTouched(
  props: SettingsCardProps,
  touched: Record<string, unknown>,
  excludesDraft: string,
  value: Record<string, unknown>,
): Promise<string | null> {
  const writes: { field: string; value: unknown }[] = diffTouched(touched, value).map((key) => ({
    field: key,
    value: touched[key],
  }));
  if (excludesDraft !== excludesText(value)) {
    writes.push({ field: "providerExcludes", value: excludesDraftToArray(excludesDraft) });
  }
  // 并发发起即可：harness 的 scope 自带串行写队列 + revision fence
  //（settings-scope.ts:126 mutate→enqueue），逐字段顺序 await 既无必要也触发
  // no-await-in-loop。
  const outcomes = await Promise.all(writes.map((item) => props.set(item.field, item.value)));
  const failures = outcomes.filter((outcome): outcome is string => outcome !== null);
  if (failures.length > 0) {
    return `${props.t("saveFailed")}${failures.join(props.t("failureJoiner"))}`;
  }
  return null;
}

/** 保存条提示文案（三态：只读 / 有改动 / 无改动 = 空串）。 */
function saveBarHint(disabled: boolean, dirty: boolean, t: Translate): string {
  if (disabled) {
    return t("statusReadOnly");
  }
  if (dirty) {
    return t("statusDirty");
  }
  return "";
}

interface NumLimits {
  min: number;
  max: number;
  fallback: number;
}

/** 数字行的建元签名（label/hint 成对取文案键，第三参是稳定的字段名锚点）。 */
type NumberRowBuilder = (
  labelKey: keyof UiMessages,
  hintKey: keyof UiMessages,
  fieldName: string,
  limits: NumLimits,
) => ReactNode;

/** 开关行的建元签名。 */
type ToggleRowBuilder = (
  labelKey: keyof UiMessages,
  hintKey: keyof UiMessages,
  fieldName: string,
) => ReactNode;

/** 两套行建元的装配：卡片只交出「现值读取口 + 草稿写入口 + 禁写位」，行的形状在这里单源。 */
function makeSettingRows(deps: {
  t: Translate;
  eff: (field: string) => unknown;
  setField: (field: string, val: unknown) => void;
  disabled: boolean;
}): { numberRow: NumberRowBuilder; toggleRow: ToggleRowBuilder } {
  const { t, eff, setField, disabled } = deps;
  const numberRow: NumberRowBuilder = (labelKey, hintKey, fieldName, limits) => {
    const candidate = eff(fieldName);
    const numValue = typeof candidate === "number" ? candidate : limits.fallback;
    return createElement(NumberRow, {
      label: t(labelKey),
      hint: t(hintKey),
      field: fieldName,
      value: numValue,
      min: limits.min,
      max: limits.max,
      disabled,
      onCommit: (num) => {
        setField(fieldName, num);
      },
    });
  };
  const toggleRow: ToggleRowBuilder = (labelKey, hintKey, fieldName) =>
    createElement(ToggleRow, {
      label: t(labelKey),
      hint: t(hintKey),
      field: fieldName,
      checked: eff(fieldName) !== false,
      disabled,
      onToggle: () => {
        setField(fieldName, eff(fieldName) === false);
      },
    });
  return { numberRow, toggleRow };
}

/** 卡片主体的行序（两段分区标题 + 全部字段行；顺序即卡片的视觉顺序）。
 *  行文案按 UI_MESSAGES 键取（label/hint 成对，字段名保持稳定锚点）：调用点只写
 *  键名，字典里换语言即整卡换文，不再有中英两份硬编码串散落。 */
function rescueFormRows(props: {
  t: Translate;
  numberRow: NumberRowBuilder;
  toggleRow: ToggleRowBuilder;
}): ReactNode[] {
  const { t, numberRow, toggleRow } = props;
  return [
    createElement(
      "div",
      {
        style: {
          fontSize: 12,
          color: LABEL_TERTIARY_COLOR,
          paddingBottom: 4,
        },
      },
      t("formLead"),
    ),
    toggleRow("enabledLabel", "enabledHint", "enabled"),
    numberRow("resumeDelayLabel", "resumeDelayHint", "resumeDelayMs", {
      min: 1000,
      max: 300_000,
      fallback: 10_000,
    }),
    numberRow("resumeCooldownLabel", "resumeCooldownHint", "resumeCooldownMs", {
      min: 5000,
      max: 3_600_000,
      fallback: 120_000,
    }),
    numberRow("maxResumesLabel", "maxResumesHint", "maxResumes", {
      min: 0,
      max: 20,
      fallback: 3,
    }),
    numberRow("chainDelayLabel", "chainDelayHint", "chainResumeDelayMs", {
      min: 1000,
      max: 300_000,
      fallback: 60_000,
    }),
    settingsSectionTitle(t("maxTokensSection"), true),
    numberRow("continueDelayLabel", "continueDelayHint", "continueDelayMs", {
      min: 500,
      max: 300_000,
      fallback: 3000,
    }),
    numberRow("continueCooldownLabel", "continueCooldownHint", "continueCooldownMs", {
      min: 5000,
      max: 3_600_000,
      fallback: 60_000,
    }),
    numberRow("maxContinuesLabel", "maxContinuesHint", "maxContinues", {
      min: 0,
      max: 20,
      fallback: 3,
    }),
    settingsSectionTitle(t("unfinishedSection"), true),
    toggleRow("openTodosLabel", "openTodosHint", "resumeOnOpenTodos"),
    numberRow("unfinishedDelayLabel", "unfinishedDelayHint", "unfinishedDelayMs", {
      min: 1000,
      max: 300_000,
      fallback: 5000,
    }),
    numberRow("unfinishedCooldownLabel", "unfinishedCooldownHint", "unfinishedCooldownMs", {
      min: 5000,
      max: 3_600_000,
      fallback: 120_000,
    }),
    numberRow("maxUnfinishedLabel", "maxUnfinishedHint", "maxUnfinished", {
      min: 0,
      max: 20,
      fallback: 2,
    }),
  ];
}

/** 卡片底部保存条（保存/丢弃/状态提示）：只读、保存中、无改动三处一起禁点。 */
function rescueSaveBar(props: {
  disabled: boolean;
  busy: boolean;
  dirty: boolean;
  saveError: string | null;
  t: Translate;
  onSave: () => void;
  onDiscard: () => void;
}): ReactNode {
  const { disabled, busy, dirty, saveError, t, onSave, onDiscard } = props;
  const saveButton = createElement(
    "button",
    {
      type: "button",
      className: "sr-button sr-btn-solid",
      "data-field": "save",
      disabled: disabled || busy || !dirty,
      onClick: onSave,
    },
    busy ? t("saving") : t("save"),
  );
  const discardButton = createElement(
    "button",
    {
      type: "button",
      className: "sr-button",
      "data-field": "discard",
      disabled: disabled || busy || !dirty,
      onClick: onDiscard,
    },
    t("discard"),
  );
  const saveBarStatus =
    saveError === null
      ? createElement("span", { className: "sr-hint" }, saveBarHint(disabled, dirty, t))
      : createElement("span", { className: "sr-error" }, saveError);
  return createElement(
    "div",
    {
      style: {
        display: "flex",
        gap: 8,
        alignItems: "center",
        padding: "6px 0",
        borderTop: "1px dashed var(--dsw-alias-border-l2)",
        flexWrap: "wrap",
      },
    },
    saveButton,
    discardButton,
    saveBarStatus,
  );
}

/** providerExcludes 的草稿输入区（显示形态 'a, b' 与存储形态 string[] 不同构，
 *  diff 因此单独判定）。 */
function rescueExcludesSection(props: {
  disabled: boolean;
  draft: string;
  onDraft: (next: string) => void;
  t: Translate;
}): ReactNode {
  const { disabled, draft, onDraft, t } = props;
  return createElement(
    "div",
    { style: { padding: "9px 0" } },
    createElement(
      "div",
      { style: { fontSize: 13, color: LABEL_PRIMARY_COLOR } },
      t("excludesLabel"),
    ),
    createElement(
      "div",
      { style: { fontSize: 12, color: LABEL_TERTIARY_COLOR, marginTop: 2 } },
      t("excludesHint"),
    ),
    createElement("input", {
      type: "text",
      value: draft,
      disabled,
      placeholder: t("excludesPlaceholder"),
      onChange: (ev: React.ChangeEvent<HTMLInputElement>) => {
        onDraft(ev.target.value);
      },
      style: {
        width: "100%",
        marginTop: 6,
        font: "inherit",
        fontSize: 13,
        color: LABEL_PRIMARY_COLOR,
        background: "transparent",
        border: CONTROL_BORDER,
        borderRadius: 6,
        padding: "4px 8px",
        boxSizing: "border-box",
      },
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
  const [touched, setTouched] = useState<Record<string, unknown>>({});
  const [excludesDraft, setExcludesDraft] = useState(excludesText(value));
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const eff = (field: string): unknown => (field in touched ? touched[field] : value[field]);
  const excludesBaseline = excludesText(value);
  const excludesDirty = excludesDraft !== excludesBaseline;
  const dirty = diffTouched(touched, value).length > 0 || excludesDirty;
  const setField = (field: string, val: unknown): void => {
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
      failure = await commitTouched(props, touched, excludesDraft, value);
    } catch (error) {
      // 写通道本身抛错（远端 reject / scope 已失效）：同样必须可见。
      failure = `${t("saveFailed")}${String(error instanceof Error ? error.message : error)}`;
    }
    setBusy(false);
    if (failure !== null) {
      setSaveError(failure);
      return;
    }
    // 快照已含新值（setAndVerify 复读确认过）→ 清空草稿即回到无改动态。
    setTouched({});
  };
  const discard = (): void => {
    setTouched({});
    setExcludesDraft(excludesBaseline);
    setSaveError(null);
  };

  const { numberRow, toggleRow } = makeSettingRows({ t, eff, setField, disabled });
  const rows = rescueFormRows({ t, numberRow, toggleRow });

  const saveBar = rescueSaveBar({
    disabled,
    busy,
    dirty,
    saveError,
    t,
    onSave: () => {
      void save();
    },
    onDiscard: discard,
  });
  const excludesSection = rescueExcludesSection({
    disabled,
    draft: excludesDraft,
    onDraft: setExcludesDraft,
    t,
  });
  const retrySection = createElement(RetryPolicySection, { key: "retry-policy", t });

  // 0.1.6：page 视图只渲染表单主体——标题/描述/卡片外壳由插件管理页统一绘制，
  // 不再自绘 RescuePluginCard（旧自绘壳属于已删除的 settings.plugin.item）。
  return createElement(
    "div",
    { style: { padding: "2px 0", display: "flex", flexDirection: "column", gap: 2 } },
    ...rows,
    excludesSection,
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
   * `Service` 类（installed `dsh-client-ui-renderer/lib/types/client/registry.d.ts:46`），
   * TS 对它做名义比较，测试桩件永远满足不了整类型；`register` 逐字复用
   * `SlotCore['register']` 的两个重载，`inject` 是「按槽位声明生命周期装 effect」那一位
   *（collapse 跑 disposer、再次声明重跑工厂，契约写在 `registry.d.ts:100`）。
   * 于是本包的两位槽名都是**编译期受检**的：`conversation.input.dock` 由属主包
   * `dsh-client-ui-conversation` merge（其 contract/slots.d.ts:214-218，list / scope
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

const RESUME_NOTIFY_URL = "/_dsh/session-rescue/resume";

/**
 * dsh 0.1.2-alpha.2 连接感知（connection/reset）：网关每次重建连接时 emit
 * （client 侧全局事件，session-controller / ui-settings 等同类订阅）。自动续跑
 * 定时器在 host 侧，断连窗口里 fire 会抛错空发。此钩子在连接重置时通知 host
 * "传输已就绪"——host 若在挂起态（suspendSession 未恢复）就重新武装定时器。
 * 断开本身不做臆测挂起：断连瞬间 host fire 失败已 settle 'skipped'，后续
 * 仍会由下一次 agent/error 重新调度，因此这里只做恢复方向。
 * 导出仅供单测（断言 resume 恢复通知回填 csrf）。
 */
export function notifyHostConnected(ctx: ClientCtx): void {
  if (typeof ctx.on !== "function") {
    return;
  }
  ctx.on("connection/reset", () => {
    // 无 token 时跳过：state 尚未拉取（首屏）或 host 已重启换 token，
    // 裸发必 403 且无意义——host 定时器照旧，仅丢暂停恢复优化。
    if (rescueCsrfStore.token === "") {
      return;
    }
    try {
      void fetch(RESUME_NOTIFY_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-rescue-csrf": rescueCsrfStore.token,
        },
        body: JSON.stringify({ connected: true }),
      });
    } catch {
      // 端点不可达时降级：host 定时器照旧（旧行为），仅丢失暂停恢复优化。
    }
  });
}

function apply(ctx: ClientCtx): void {
  // apply 幂等守卫（HMR/重复加载防护，chat-recovery 同款）
  if (globalThis.__sessionRescueApplied === true) {
    return;
  }
  globalThis.__sessionRescueApplied = true;
  ctx.effect(
    () => () => {
      globalThis.__sessionRescueApplied = undefined;
    },
    "session-rescue: apply claim",
  );

  // 连接感知：重连就绪时通知 host 恢复挂起的自动续跑定时器。
  notifyHostConnected(ctx);

  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.id = "session-rescue-css";
    tag.textContent = CSS;
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
  const actions = createActions(ctx.sessions, ctx.get("uiWorkspace"), t);

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
          // 写入 + 事后复读确认（见 setAndVerify）：错误以文案返回给卡片显示。
          set: (field: string, value: unknown) => setAndVerify(scope, field, value, t),
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
  var __sessionRescueApplied: boolean | undefined;
}
