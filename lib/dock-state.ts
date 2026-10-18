// lib/dock-state.ts —— dock 区域渲染决策的纯函数（竞态修复的核心）。
//
// 背景（结构判据）：把 dock 整个区域的可见性全押在 `hasContent` 上，
// 而 hasContent 依赖 1Hz 轮询快照（rescue）与实时状态（view/queue）的混合，
// 且 `if (!hasContent) return null` 会让整个组件卸载——轮询 tick 导致的
// 短暂空窗会销毁本地状态（编辑草稿/busy 标志），会话切换窗口还会显示
// 错误状态。本模块把"该渲染什么"从"组件挂不挂"里拆出来：
//   - 组件常驻挂载（dock 区域始终存在）；
//   - 每个子区块（banner/停止重问/编辑重试续写/开关行）各自按本模块判定渲染；
//   - 轮询快照未就绪（rescue === null）时，pending 视为"未知"而非"无"，
//     开关行显示中性态而非错误地显示"开启"。
//
// 纯函数、无 React、无 I/O——可单测。组件侧只做投影与 createElement。

import { fieldOf, isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

/** host 状态快照的最小投影（来自官方 Remote 的 state 读面）。 */
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

/** 解析 /state 载荷为本模块的快照类型：逐字段守卫投影，坏形状降级而非丢给断言。
 *  ok!==true 或 sessions 非对象 → 返回 null（调用方保持快照不动，并按「这一跳没读到
 *  有效快照」记连跳）。wire 是本包唯一的外部输入面，读法因此住在这里而不是渲染侧。 */
export function parseStateBody(parsed: Record<string, unknown>): RescueStateBody | null {
  if (fieldOf(parsed, "ok") !== true) {
    return null;
  }
  const sessions = fieldOf(parsed, "sessions");
  if (!isRecord(sessions)) {
    return { ok: true };
  }
  // 键来自服务端 JSON：`{}` 上 `"__proto__"` 命中的是原型 setter，那一行不进表、
  // 还把整张表的原型换掉。按条目构造就没有那个 setter。
  const entries: [string, RescueSessionState][] = [];
  for (const sessionId of Object.keys(sessions)) {
    const entry = sessions[sessionId];
    if (isRecord(entry)) {
      entries.push([sessionId, parseSessionEntry(entry)]);
    }
  }
  return { ok: true, sessions: Object.fromEntries(entries) };
}

/** dock 四条动作按钮的可用性：全部由实时 view 推出，与轮询快照是否在场无关。 */
export interface DockActionSignals {
  /** 「停止并重新提问」：会话在跑且有一条可复发的用户文本。 */
  readonly canStopReask: boolean;
  readonly canEdit: boolean;
  readonly canRetry: boolean;
  readonly canContinue: boolean;
}

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
 * 由实时动作位 + 轮询快照，决策 dock 各区块渲染。
 * 这是旧 hasContent 判定的纯函数化——竞态修复的关键语义：
 *  1. rescue === null（首帧/快照丢失）→ rescueKnown=false，开关行不显示、
 *     toggle=unknown（中性），但停止/编辑/重试/续写这些实时区块照常渲染；
 *  2. sessionState 缺该会话 → toggle=unknown（不再默认"开启"）；
 *  3. hasContent 只决定容器显隐，不卸载组件（本地状态安全）；
 *  4. hasContent 必须把动作行自己算进去：动作位的可用性只取决于实时 view，
 *     与快照在不在场无关。漏算的那一帧（快照空窗 + 无 pending +
 *     有可重试的失败轮）会把容器藏起来，而容器里那三个按钮本该显示——
 *     用户看到的就是「失败了却没有任何入口」。
 *  排队行不在判据里：那一区归官方 QueueDock（同一道 conversation.input.dock），
 *  本包重复列一遍就是同一批消息显示两次。
 */
export function decideDockState(
  actions: DockActionSignals,
  rescue: RescueStateBody | null,
  sessionId: string,
): DockDecision {
  const rescueKnown = rescue !== null;
  const sessionState = rescue?.sessions === undefined ? undefined : rescue.sessions[sessionId];

  const pending =
    sessionState !== undefined && sessionState.pending !== null ? sessionState.pending : null;
  // 开关三态语义：
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
  const hasActions = actions.canEdit || actions.canRetry || actions.canContinue;
  const hasContent = pending !== null || actions.canStopReask || hasActions || showToggleRow;
  return { rescueKnown, pending, toggle, showToggleRow, hasContent };
}
