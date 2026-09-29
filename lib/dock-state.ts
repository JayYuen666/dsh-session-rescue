// lib/dock-state.ts —— dock 区域渲染决策的纯函数（v8：竞态修复核心）。
//
// 背景（本会话取证）：旧实现把 dock 整个区域的可见性押在 `hasContent` 上，
// 而 hasContent 依赖 1Hz 轮询快照（rescue）与实时状态（view/queue）的混合，
// 且 `if (!hasContent) return null` 会让整个组件卸载——轮询 tick 导致的
// 短暂空窗会销毁本地状态（编辑草稿/busy 标志），会话切换窗口还会显示
// 错误状态。本模块把"该渲染什么"从"组件挂不挂"里拆出来：
//   - 组件常驻挂载（dock 区域始终存在）；
//   - 每个子区块（banner/停止/编辑重试/排队/开关行）各自按本模块判定渲染；
//   - 轮询快照未就绪（rescue === null）时，pending 视为"未知"而非"无"，
//     开关行显示中性态而非错误地显示"开启"。
//
// 纯函数、无 React、无 I/O——可单测。组件侧只做投影与 createElement。

import type { TranscriptView } from "./turn-scope.ts";

/** host 状态快照的最小投影（来自 /_dsh/session-rescue/state）。 */
export interface RescueStateBody {
  ok: boolean;
  sessions?: Record<string, RescueSessionState>;
}

export interface RescuePending {
  turn: number;
  kind: string;
  fireAt: number;
  remainingMs: number;
  chained?: boolean;
  suspended?: boolean;
}

export interface RescueSessionState {
  count: number;
  lastFireAt: number;
  pending: RescuePending | null;
  disabled?: boolean;
}

/** 会话开关三态：on=开启 / off=已关闭 / unknown=快照未就绪（中性显示）。 */
export type ToggleState = "on" | "off" | "unknown";

export interface DockDecision {
  /** host 快照是否已就绪（首帧未就绪时 pending 不能当作"没有"）。 */
  rescueKnown: boolean;
  /** 当前会话的续跑 pending（未知时为 null，配合 rescueKnown=false 使用）。 */
  pending: RescuePending | null;
  /** 会话开关三态。 */
  toggle: ToggleState;
  /** 是否显示开关行（host 路由已响应过才显示）。 */
  showToggleRow: boolean;
  /** 整个 dock 区域是否有任何可见内容（组件仍常驻，只控制容器显隐）。 */
  hasContent: boolean;
}

/**
 * 由实时 view/queue + 轮询 rescue 快照，决策 dock 各区块渲染。
 * 这是旧 hasContent 判定的纯函数化——竞态修复的关键语义：
 *  1. rescue === null（首帧/快照丢失）→ rescueKnown=false，开关行不显示、
 *     toggle=unknown（中性），但停止/编辑/排队等实时区块照常渲染；
 *  2. sessionState 缺该会话 → toggle=unknown（不再默认"开启"）；
 *  3. hasContent 只决定容器显隐，不卸载组件（本地状态安全）。
 */
export function decideDockState(
  _view: Pick<TranscriptView, "running">,
  queueLength: number,
  rescue: RescueStateBody | null,
  sessionId: string,
  hasStopReask: boolean,
): DockDecision {
  const rescueKnown = rescue !== null;
  const sessionState = rescue?.sessions === undefined ? undefined : rescue.sessions[sessionId];

  const pending =
    sessionState !== undefined && sessionState.pending !== null ? sessionState.pending : null;
  // 开关三态语义（v8.1 修正）：
  //   - 快照未就绪（首帧 rescue=null）→ unknown（中性"—"，行此时也不显示）；
  //   - 快照就绪但该会话无记录 → on：host 快照只含调度过/被 toggle 关闭的会话，
  //     未记录即未关闭（disabledSessions 空集），默认开启——不能显示"—"；
  //   - 有记录 → 按 disabled 判 off/on。
  let toggle: ToggleState;
  if (rescueKnown) {
    toggle = sessionState?.disabled === true ? "off" : "on";
  } else {
    toggle = "unknown";
  }

  const showToggleRow = rescueKnown;
  const hasContent = pending !== null || hasStopReask || queueLength > 0 || showToggleRow;
  return { rescueKnown, pending, toggle, showToggleRow, hasContent };
}
