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

import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { z } from "zod";

/** host 状态快照的最小投影（来自官方 Remote 的 state 读面）。
 *  `ok` 写死 `true`：host 侧只产出成功形状，失败走 Remote 的 rejection 通道
 *  （见 `STATE_SCHEMA` 的 `z.literal(true)` 与 `parseStateBody` 的唯一出口）。
 *  写宽成 `boolean` 会让下游多出一个「ok:false 该怎么办」的不可测分支。 */
export interface RescueStateBody {
  ok: true;
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

/** 有限数：NaN / ±Infinity 同样通不过 `typeof === "number"`，而它们的下游是渲染文案，
 *  坏值会一直漂到用户眼前才被发现。 */
const FINITE_NUMBER = z.number().refine(Number.isFinite, { error: "必须是有限数" });

/** 只认显式 true；false/缺位一律折成 undefined，输出时自然缺席。 */
const TRUE_ONLY = z.preprocess(
  (value) => (value === true ? true : undefined),
  z.literal(true).optional(),
);

/** pending 的线上形状：字段不全/类型不符 → null（防御纵深）。 */
const PENDING_SCHEMA = z.object({
  turn: FINITE_NUMBER,
  kind: z.string(),
  fireAt: FINITE_NUMBER,
  remainingMs: FINITE_NUMBER,
  chained: TRUE_ONLY,
  suspended: TRUE_ONLY,
});

/** 一条会话的逐字段守卫投影：非数字落回 0，pending 只认显式 `null` 与可投影对象。 */
const SESSION_ENTRY_SCHEMA = z.object({
  count: z.preprocess(
    (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0),
    z.number(),
  ),
  lastFireAt: z.preprocess(
    (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0),
    z.number(),
  ),
  // `z.unknown()` 不等于「键可以缺席」：缺 `pending` 的行会报 nonoptional 而不是降级，
  // 整条 `/state` 解析随之抛错。`.optional()` 让缺席回到 null 那条既有路径。
  pending: z.unknown().optional(),
  disabled: TRUE_ONLY,
});

/** 把 zod 的 optional 输出收成接口要求的「缺席或有值」（exactOptionalPropertyTypes）。 */
function projectPending(pending: z.infer<typeof PENDING_SCHEMA>): RescuePending {
  return {
    turn: pending.turn,
    kind: pending.kind,
    fireAt: pending.fireAt,
    remainingMs: pending.remainingMs,
    ...(pending.chained === true ? { chained: true } : {}),
    ...(pending.suspended === true ? { suspended: true } : {}),
  };
}

/** 从原始 /state 载荷投影 pending（字段不全/类型不符 → null；防御纵深）。 */
function parsePending(raw: unknown): RescuePending | null {
  const parsed = PENDING_SCHEMA.safeParse(raw);
  return parsed.success ? projectPending(parsed.data) : null;
}

/** 一条会话计数的逐字段守卫投影（坏形状降级而非丢给断言）。 */
function parseSessionEntry(entry: Record<string, unknown>): RescueSessionState {
  const { count, lastFireAt, pending, disabled } = SESSION_ENTRY_SCHEMA.parse(entry);
  return {
    count,
    lastFireAt,
    pending: parsePending(pending),
    ...(disabled === true ? { disabled: true } : {}),
  };
}

/**
 * /state 载荷信封：`ok` 必须是字面量 true；`sessions` 用 `z.custom` 保留原始对象，
 * 不用 `z.record` —— 后者会按服务端给的键重建表，`"__proto__"` 那一行会命中原型 setter。
 * 条目仍在下面逐条按 schema 投影。
 */
const STATE_SCHEMA = z.object({
  ok: z.literal(true),
  sessions: z
    .custom<Record<string, unknown>>(isRecord, { error: "sessions 必须是对象" })
    .optional(),
});

/** 解析 /state 载荷为本模块的快照类型：逐字段守卫投影，坏形状降级而非丢给断言。
 *  ok!==true → null。`sessions` **缺位**与**形状损坏**要分开判：
 *    - 缺位 ⇒ `{ ok: true }`：宿主那一路 `state()` 总会带上 sessions，缺位只可能是更早
 *      版本的载荷，当作「就绪但没有会话」；
 *    - 存在但不是记录（数组/字符串/数字）⇒ null：这一跳读到的是坏载荷，调用方按
 *      「没读到有效快照」退避。若也折成 `{ ok: true }`，dock 会把它读成一份**确信的**
 *      空快照——开关行照常显示，每个会话都按「没关过」判成 on。把「读坏了」显示成
 *      「读到了，一切正常」是最难查的那类失败。
 *  wire 是本包唯一的外部输入面，读法因此住在这里而不是渲染侧。 */
export function parseStateBody(parsed: Record<string, unknown>): RescueStateBody | null {
  const envelope = STATE_SCHEMA.safeParse(parsed);
  if (!envelope.success) {
    return null;
  }
  const { sessions } = envelope.data;
  if (sessions === undefined) {
    return { ok: true };
  }
  // 键来自服务端 JSON：`{}` 上 `"__proto__"` 命中的是原型 setter，那一行不进表、
  // 还把整张表的原型换掉。entries 数组 + Object.fromEntries 按数据属性写入，没有那个 setter。
  const entries: [string, RescueSessionState][] = [];
  for (const sessionId of Object.keys(sessions)) {
    const entry = sessions[sessionId];
    if (isRecord(entry)) {
      entries.push([sessionId, parseSessionEntry(entry)]);
    }
  }
  return { ok: true, sessions: Object.fromEntries(entries) };
}

/** dock 的渲染信号：动作位由实时 view 推出，另外两位是本组件的本地状态。
 *  全部与轮询快照是否在场无关——它们一旦为真，容器就必须显形。 */
export interface DockActionSignals {
  /** 「停止并重新提问」：会话在跑且有一条可复发的用户文本。 */
  readonly canStopReask: boolean;
  readonly canEdit: boolean;
  readonly canRetry: boolean;
  readonly canContinue: boolean;
  /** 编辑态编辑器正在渲染（`dockEditing && target !== null`）。
   *  单列而不是复用 `canEdit`：进入编辑后会话可能转成运行中，`canEdit` 随之变假，
   *  而编辑器仍挂在树上——只按 `canEdit` 算会让容器藏起一个正在显示的编辑器。 */
  readonly editing: boolean;
  /** host 写通道（取消/开关）刚失败，错误行正在渲染。 */
  readonly hostActionFailed: boolean;
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
 *  2. 快照就绪但 sessionState 缺该会话 → toggle=on：host 快照只收调度过与被
 *     toggle 关闭的会话，没记录就是没关过；只有快照整个未就绪才是 unknown；
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
  // 原型链防护：`sessions` 是 JSON 对象，但键来自 host 载荷里的 sessionId，
  // 直接索引普通对象时 `"constructor"` / `"toString"` 会取到原型成员，
  // 而不是「该会话没有记录」。只有自有键才算记录。
  const sessions = rescue?.sessions;
  const sessionState =
    sessions !== undefined && Object.hasOwn(sessions, sessionId) ? sessions[sessionId] : undefined;

  const pending = sessionState?.pending ?? null;
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
  // 本地状态那两块必须算进来：它们渲染在同一个容器里，容器一藏，编辑器与失败提示
  // 就一起消失。`hostActionFailed` 尤其要紧——那正是「用户按了取消但宿主拒绝了」的
  // 那一刻，此时 pending 可能已经不在、动作位也可能全假，唯一要说的就是那行错误。
  const hasContent =
    pending !== null ||
    actions.canStopReask ||
    hasActions ||
    actions.editing ||
    actions.hostActionFailed ||
    showToggleRow;
  return { rescueKnown, pending, toggle, showToggleRow, hasContent };
}
