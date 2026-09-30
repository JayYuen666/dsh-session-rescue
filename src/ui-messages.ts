// src/ui-messages.ts —— 卡片 / dock UI 文案字典（中英双语）。
//
// 键集一致由 tsc 保证：zh / en 两份都标注同一个 UiMessages 接口，少键多键在编译期红。
// 注册与取值走官方 @deepseek-ai/dsh-client-locale 的**类型化** register（两语一次性交
// `Record<BuiltInLocaleId, LocaleDictOf<NS>>`，缺一门语言即编译期红）+ bind(NS)，语言切换
// 由宿主驱动、无需重载页面（见 client-entry.ts 的 apply）。官方字典是扁平字符串表
// （`LocaleDictOf<NS> = Record<NS 的键, string>`），带变量的整句走官方 Translate 的
// `{name}` 插值（宿主 `LocaleRuntime.translate` 同语义：`{x}` 缺失时原样留占位符）。
import type { TranslateNS as OfficialTranslateNS } from "@deepseek-ai/dsh-client-ui-slots";
import type { MessagesCatalog } from "@jayyuen66/dsh-plugin-shared/lib/locale";

/** 本包 client 侧（dock + 设置卡）产出的全部界面文案。 */
export interface UiMessages {
  // ── 发给模型的重发/续写正文（dock 按钮产出） ──
  /** 重试按钮发出的正文（注入给模型）。 */
  readonly retryText: string;
  /** 继续输出按钮发出的正文（注入给模型）。 */
  readonly continueText: string;
  // ── 倒计时横幅（三类 kind × 两条状态） ──
  /** 瞬时失败待办横幅模板（`{secs}` 插值剩余秒数）。 */
  readonly bannerResume: string;
  /** 输出截断待办横幅模板。 */
  readonly bannerContinue: string;
  /** 待办未闭合待办横幅模板。 */
  readonly bannerUnfinished: string;
  /** 瞬时失败待办横幅（连接中断、挂起待重连）。 */
  readonly bannerSuspendedResume: string;
  /** 输出截断待办横幅（挂起态）。 */
  readonly bannerSuspendedContinue: string;
  /** 待办补跑待办横幅（挂起态）。 */
  readonly bannerSuspendedUnfinished: string;
  // ── 业务动作失败面（host/dock 共用） ──
  /** 会话绑定缺失。 */
  readonly sessionUnavailable: string;
  /** 第一轮消息没有可 fork 的前序边界。 */
  readonly forkFirstTurn: string;
  /** 分支出来的子会话打不开。 */
  readonly branchUnavailable: string;
  /** 宿主结果既无 code 也无 message 时的兜底文案。 */
  readonly actionFailed: string;
  /** host 写通道（取消/开关）被拒模板（`{label}` 插值动作名）。 */
  readonly hostActionFailed: string;
  /** 开关动作名（拼进 hostActionFailed 的 label）。 */
  readonly switchAction: string;
  // ── 编辑器（编辑重发 / Fork 重发） ──
  readonly sending: string;
  readonly resendInSession: string;
  readonly forkResend: string;
  readonly cancel: string;
  readonly editorHint: string;
  // ── 排队区 ──
  readonly queueLabel: string;
  readonly save: string;
  readonly edit: string;
  readonly withdraw: string;
  // ── 停止重问 / 重试 / 续写操作行 ──
  readonly stopping: string;
  readonly stopAndReask: string;
  readonly hostRetryPendingTitle: string;
  readonly retryTitle: string;
  readonly retryWaiting: string;
  readonly retry: string;
  readonly continueTitle: string;
  readonly continueOutput: string;
  // ── 每会话开关行 ──
  /** 状态展示：已开启。 */
  readonly toggleStateOn: string;
  /** 状态展示：已关闭。 */
  readonly toggleStateOff: string;
  /** 快照未就绪的中性占位。 */
  readonly toggleNeutral: string;
  /** 按钮动作名：当前开着 → 动作是关闭。 */
  readonly toggleTurnOff: string;
  /** 开关行标题模板（`{state}` 插值状态展示）。 */
  readonly sessionToggleLabel: string;
  /** 快照未就绪时按钮的等待提示。 */
  readonly toggleWaiting: string;
  // ── 设置卡：字段与保存条 ──
  /** 宿主拒绝落盘时的模板（`{field}`/`{value}` 插值）。 */
  readonly fieldRejected: string;
  /** 保存失败前缀（后接逐字段原因）。 */
  readonly saveFailed: string;
  /** 多条失败原因的连接符。 */
  readonly failureJoiner: string;
  readonly statusReadOnly: string;
  readonly statusDirty: string;
  readonly saving: string;
  readonly discard: string;
  /** 表单开头的一致性说明。 */
  readonly formLead: string;
  readonly enabledLabel: string;
  readonly enabledHint: string;
  readonly resumeDelayLabel: string;
  readonly resumeDelayHint: string;
  readonly resumeCooldownLabel: string;
  readonly resumeCooldownHint: string;
  readonly maxResumesLabel: string;
  readonly maxResumesHint: string;
  readonly chainDelayLabel: string;
  readonly chainDelayHint: string;
  readonly maxTokensSection: string;
  readonly continueDelayLabel: string;
  readonly continueDelayHint: string;
  readonly continueCooldownLabel: string;
  readonly continueCooldownHint: string;
  readonly maxContinuesLabel: string;
  readonly maxContinuesHint: string;
  readonly unfinishedSection: string;
  readonly openTodosLabel: string;
  readonly openTodosHint: string;
  readonly unfinishedDelayLabel: string;
  readonly unfinishedDelayHint: string;
  readonly unfinishedCooldownLabel: string;
  readonly unfinishedCooldownHint: string;
  readonly maxUnfinishedLabel: string;
  readonly maxUnfinishedHint: string;
  readonly excludesLabel: string;
  readonly excludesHint: string;
  readonly excludesPlaceholder: string;
  /** plugins.bundle.config 的 summary 视图（标题下一行摘要）。 */
  readonly cardSummary: string;
  // ── 429 重试策略区块 ──
  readonly presetDefault: string;
  readonly presetEnhanced: string;
  readonly presetAlways: string;
  readonly presetOff: string;
  readonly presetLoading: string;
  /** 官方 retryPolicy 面不可用前缀（后接原因）。 */
  readonly presetFaceUnavailable: string;
  /** 保存按钮（有改动时带条数，`{count}` 插值）。 */
  readonly saveCount: string;
  /** 档位区块的未保存提示。 */
  readonly presetDirty: string;
  readonly retrySectionTitle: string;
  readonly retrySectionHint: string;
}

/**
 * 本包的文案命名空间 merge 进官方的 `LocaleNamespaceMap`（installed
 * `dsh-client-ui-slots/lib/types/index.d.ts:23`「Dictionary owners extend via declaration
 * merging (exactly like SlotMap)」，声明位 :32）。这一段是**承重**的，不是美化：不 merge
 * 时 `ctx.locale.bind(NS)` 只能落到官方那条**未类型化**重载（installed
 * `dsh-client-locale/lib/types/client/index.d.ts:226` 的 `bind(ns: string): Translate`，
 * 返回 `Translate<string>`），卡片要的窄键集 `t` 就没有官方来源；而把 ClientCtx 那一位
 * 写成官方 `LocaleRuntime['bind']` 也走不通——官方每条都是双重载，目标类型同时含类型化
 * 与未类型化两条时，任何单一实现都满足不了（本包实测：`Type 'string' is not assignable to
 * type 'LocaleKeysOf<"session-rescue">'`）。merge 之后 `bind` 取在
 * `typeof NS` 上就是官方 `TranslateNS<'session-rescue'>`，本地不必再抄一份函数形状。
 * ⚠ interface 的键位必须是字面量，故下面的等式常量是本源，client-entry.ts 的 `NS` 按它的
 * 类型 `LocaleNs` 标注钉住（test/client-ui.test.ts 另断言注册时的 ns 与 cordis.patch.yml 的
 * 裸 `- id:` 同源）。
 */
declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    /** 本包 dock + 设置卡的全部界面文案键。 */
    "session-rescue": keyof UiMessages;
  }
}

/** 编译期契约：merge 里写死的命名空间键（`Translate` 由它取键集）就是卡片的条目 id。 */
const LOCALE_NS_KEY = "session-rescue" as const;

/**
 * 本源只以**类型**形态对外流通：`client-entry.ts` 的 `const NS: LocaleNs = "session-rescue"` 把条目
 * id 钉在本源上（分叉即编译期红），而产物漂移针仍要按字面量形状从 bundle 里抓 `NS`，所以那里
 * 保留字面量、只加类型标注——值导出不必存在（用例侧同理：要断言运行时那串就写字面量）。
 */
export type LocaleNs = typeof LOCALE_NS_KEY;

/**
 * 卡片与 dock 取文案的函数形状：官方 `TranslateNS<N> = Translate<LocaleKeysOf<N>>`
 * （installed `dsh-client-ui-slots/lib/types/index.d.ts:67`，而 `Translate<K> =
 * (key: K, params?: Record<string, unknown>) => string`，同文件 :45）。函数面归官方，
 * 键集就是上面 merge 的 `keyof UiMessages`（外加官方 `LocaleKeysOf` 一并放行的
 * `common` 命名空间键——那是宿主查不到键时的回落面，运行时行为见其 `lookup`）。
 */
export type Translate = OfficialTranslateNS<typeof LOCALE_NS_KEY>;

export const UI_MESSAGES: MessagesCatalog<UiMessages> = {
  zh: {
    retryText: "[重试] 上一条请求因瞬时失败未执行成功，请重新执行上面的请求。",
    continueText: "请从截断处继续输出，不要重复已输出的内容。",
    bannerResume: "瞬时失败，将在 {secs}s 后自动续跑",
    bannerContinue: "输出截断，将在 {secs}s 后自动继续",
    bannerUnfinished: "待办未闭合，将在 {secs}s 后自动补跑",
    bannerSuspendedResume: "连接中断，重连后将自动续跑",
    bannerSuspendedContinue: "连接中断，重连后将自动继续",
    bannerSuspendedUnfinished: "连接中断，重连后将自动补跑",
    sessionUnavailable: "会话不可用",
    forkFirstTurn: "第一轮消息不支持 fork",
    branchUnavailable: "分支会话不可用",
    actionFailed: "操作失败",
    hostActionFailed: "{label}未生效（host 拒绝了这次请求），请重试",
    switchAction: "开关切换",
    sending: "发送中…",
    resendInSession: "重发（本会话）",
    forkResend: "Fork 重发（新分支）",
    cancel: "取消",
    editorHint:
      "重发在本会话继续（失败回合保留在历史中）；Fork 从该消息之前切出干净分支。⌘/Ctrl+Enter 快速重发。",
    queueLabel: "排队中的消息：",
    save: "保存",
    edit: "编辑",
    withdraw: "撤回",
    stopping: "停止中…",
    stopAndReask: "停止并重问",
    hostRetryPendingTitle: "内置重试仍在进行，请稍候",
    retryTitle: "在本会话重发重试指令",
    retryWaiting: "重试等待中",
    retry: "重试",
    continueTitle: "发送续写指令，从截断处继续",
    continueOutput: "继续输出",
    toggleStateOn: "开启",
    toggleStateOff: "已关闭",
    toggleNeutral: "—",
    toggleTurnOff: "关闭",
    sessionToggleLabel: "自动续跑（本会话）：{state}",
    toggleWaiting: "状态同步中，稍后重试",
    fieldRejected: "{field} 未被宿主接受（值已回退到 {value}）",
    saveFailed: "保存失败：",
    failureJoiner: "；",
    statusReadOnly: "当前作用域只读",
    statusDirty: "有未保存的修改，点「保存」生效",
    saving: "保存中…",
    discard: "撤销",
    formLead: "失败分类为内置安全逻辑，不可配置；以下仅调自动续跑参数（改动点「保存」生效）。",
    enabledLabel: "启用自动续跑",
    enabledHint: "关闭后仅保留手动编辑/重试/撤回等 UI 能力",
    resumeDelayLabel: "续跑延迟 (ms)",
    resumeDelayHint: "内置重试耗尽后等待多久发送续跑消息（1000–300000）",
    resumeCooldownLabel: "冷却时间 (ms)",
    resumeCooldownHint: "同一会话两次自动续跑的最短间隔（5000–3600000）",
    maxResumesLabel: "每会话上限 (次)",
    maxResumesHint: "单个会话最多自动续跑次数（0–20）",
    chainDelayLabel: "链式重试延迟 (ms)",
    chainDelayHint:
      "续跑消息开出的回合再次失败时，跳过冷却按此延迟续跑（跨出限流窗口；1000–300000）",
    maxTokensSection: "输出截断自动继续（max-tokens）",
    continueDelayLabel: "继续延迟 (ms)",
    continueDelayHint: "回合因输出上限截断后等待多久自动补发续写指令（500–300000）",
    continueCooldownLabel: "继续冷却 (ms)",
    continueCooldownHint: "同一会话两次自动继续的最短间隔（5000–3600000）",
    maxContinuesLabel: "继续上限 (次)",
    maxContinuesHint: "单个会话最多自动继续次数（0–20）",
    unfinishedSection: "待办未闭合自动补跑（completed 回合）",
    openTodosLabel: "启用待办补跑",
    openTodosHint:
      "回合正常结束但本回合自己写的待办仍有未完成项时自动补跑；模型在等你回答（ask_user_question）或该回合由 goal 轮次驱动时不会注入",
    unfinishedDelayLabel: "补跑延迟 (ms)",
    unfinishedDelayHint: "检测到待办未闭合后等待多久发送补跑指令（1000–300000）",
    unfinishedCooldownLabel: "补跑冷却 (ms)",
    unfinishedCooldownHint: "同一会话两次待办补跑的最短间隔（5000–3600000）",
    maxUnfinishedLabel: "补跑上限 (次)",
    maxUnfinishedHint: "清单连续未闭合时最多补跑次数；清单闭合后配额自动恢复（0–20）",
    excludesLabel: "排除路由（provider）",
    excludesHint: "逗号分隔；列出的路由永不自动续跑（如已配置专属 retryPolicy 的路由）",
    excludesPlaceholder: "例如：baidu-token-plan, other-route",
    cardSummary: "瞬时失败自动续跑 + 编辑重发/重试/撤回/停止重问；429 重试策略可视化配置",
    presetDefault: "官方默认（normal 5 次，码表不含 QUOTA）",
    presetEnhanced: "增强（12 次 + QUOTA + 8s→60s 退避）",
    presetAlways: "always（无限重试 + 5s→60s 退避）",
    presetOff: "关闭（不自动重试）",
    presetLoading: "加载 llm-pi-ai providers…",
    presetFaceUnavailable: "官方 retryPolicy 面不可用：",
    saveCount: "保存（{count} 个改动）",
    presetDirty: "有未保存的档位改动",
    retrySectionTitle: "429 重试策略（官方 llm-retry，按平台）",
    retrySectionHint:
      "pi-ai 把 429+配额措辞归码 QUOTA；默认码表不含 QUOTA 时 llm-retry 放行。改档位后点「保存」经官方 settings 落盘，重启不丢。",
  },
  en: {
    retryText:
      "[retry] The previous request failed with a transient error and never succeeded; please run it again.",
    continueText:
      "Continue the output from where it was truncated; do not repeat what was already written.",
    bannerResume: "Transient failure — auto-resume in {secs}s",
    bannerContinue: "Output truncated — auto-continue in {secs}s",
    bannerUnfinished: "Open todos remain — auto re-run in {secs}s",
    bannerSuspendedResume: "Connection lost — will auto-resume after reconnect",
    bannerSuspendedContinue: "Connection lost — will auto-continue after reconnect",
    bannerSuspendedUnfinished: "Connection lost — will auto re-run after reconnect",
    sessionUnavailable: "session unavailable",
    forkFirstTurn: "the first message cannot be forked",
    branchUnavailable: "branch session unavailable",
    actionFailed: "action failed",
    hostActionFailed: "{label} had no effect (the host rejected this request) — try again",
    switchAction: "Toggle",
    sending: "Sending…",
    resendInSession: "Resend (this session)",
    forkResend: "Fork & resend (new branch)",
    cancel: "Cancel",
    editorHint:
      "Resend continues in this session (the failed turn stays in history); Fork cuts a clean branch before that message. ⌘/Ctrl+Enter resends quickly.",
    queueLabel: "Queued messages:",
    save: "Save",
    edit: "Edit",
    withdraw: "Withdraw",
    stopping: "Stopping…",
    stopAndReask: "Stop & re-ask",
    hostRetryPendingTitle: "Built-in retries are still running — hold on",
    retryTitle: "Re-send the retry instruction in this session",
    retryWaiting: "Retry pending",
    retry: "Retry",
    continueTitle: "Send the continue instruction to finish the truncated output",
    continueOutput: "Continue output",
    toggleStateOn: "On",
    toggleStateOff: "Off",
    toggleNeutral: "—",
    toggleTurnOff: "Turn off",
    sessionToggleLabel: "Auto-resume (this session): {state}",
    toggleWaiting: "State still syncing — try again shortly",
    fieldRejected: "{field} was not accepted by the host (value reverted to {value})",
    saveFailed: "save failed: ",
    failureJoiner: "; ",
    statusReadOnly: "This scope is read-only",
    statusDirty: "Unsaved changes — press Save to apply",
    saving: "Saving…",
    discard: "Revert",
    formLead:
      "Failure classification is built-in safety logic and is not configurable; the fields below only tune auto-resume (press Save to apply).",
    enabledLabel: "Enable auto-resume",
    enabledHint: "When off, only the manual edit / retry / withdraw UI stays available",
    resumeDelayLabel: "Resume delay (ms)",
    resumeDelayHint:
      "How long to wait before sending the resume message once built-in retries are exhausted (1000–300000)",
    resumeCooldownLabel: "Cooldown (ms)",
    resumeCooldownHint: "Minimum gap between two auto-resumes in one session (5000–3600000)",
    maxResumesLabel: "Per-session cap (times)",
    maxResumesHint: "Maximum auto-resumes in a single session (0–20)",
    chainDelayLabel: "Chain retry delay (ms)",
    chainDelayHint:
      "When the turn opened by a resume message fails again, skip the cooldown and resume at this delay (step out of the rate-limit window; 1000–300000)",
    maxTokensSection: "Auto-continue after output truncation (max-tokens)",
    continueDelayLabel: "Continue delay (ms)",
    continueDelayHint:
      "How long to wait before auto-sending the continue instruction after a turn is truncated by the output cap (500–300000)",
    continueCooldownLabel: "Continue cooldown (ms)",
    continueCooldownHint: "Minimum gap between two auto-continues in one session (5000–3600000)",
    maxContinuesLabel: "Continue cap (times)",
    maxContinuesHint: "Maximum auto-continues in a single session (0–20)",
    unfinishedSection: "Auto re-run when the todo list stays open (completed turns)",
    openTodosLabel: "Enable todo re-run",
    openTodosHint:
      "Re-run automatically when a turn ends normally but the todos it wrote itself still have open items; nothing is injected while the model waits for your answer (ask_user_question) or the turn is driven by goal rounds",
    unfinishedDelayLabel: "Re-run delay (ms)",
    unfinishedDelayHint:
      "How long to wait before sending the re-run instruction after an open todo list is detected (1000–300000)",
    unfinishedCooldownLabel: "Re-run cooldown (ms)",
    unfinishedCooldownHint: "Minimum gap between two todo re-runs in one session (5000–3600000)",
    maxUnfinishedLabel: "Re-run cap (times)",
    maxUnfinishedHint:
      "Maximum re-runs while the list stays open; the budget refills once the list closes (0–20)",
    excludesLabel: "Excluded routes (provider)",
    excludesHint:
      "Comma separated; listed routes are never auto-resumed (e.g. routes with their own retryPolicy)",
    excludesPlaceholder: "e.g. baidu-token-plan, other-route",
    cardSummary:
      "Auto-resume on transient failures + edit-resend / retry / withdraw / stop-and-re-ask; visual 429 retry-policy configuration",
    presetDefault: "Official default (normal 5 tries, code table without QUOTA)",
    presetEnhanced: "Enhanced (12 tries + QUOTA + 8s→60s backoff)",
    presetAlways: "always (unlimited retries + 5s→60s backoff)",
    presetOff: "Off (no automatic retries)",
    presetLoading: "loading llm-pi-ai providers…",
    presetFaceUnavailable: "official retryPolicy face unavailable: ",
    saveCount: "Save ({count} changes)",
    presetDirty: "Unsaved preset changes",
    retrySectionTitle: "429 retry policy (official llm-retry, per platform)",
    retrySectionHint:
      "pi-ai maps 429 + quota wording onto the QUOTA code; llm-retry passes through when the default code table omits QUOTA. After changing a preset, press Save to persist it through the official settings — it survives restarts.",
  },
};
