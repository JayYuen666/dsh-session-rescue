/**
 * 回合事实投影：把本包原先「每次判定都重扫一遍会话日志」的三处同步读
 * （`reviewLastTurn`、`preFireCheck` 的 newer-turn veto、`turnOpenerSource` 的
 * 链式/goal 判定）折成一枚官方 `sessionProjections` 单元。
 *
 * 走投影而不是 `ctx.sessionQuery.observeSession()`（quality-gate 用的那条面）：后者是
 * **异步**的，而本包的「触发前校验」与紧随其后的注入同处一个同步块——那正是本包不变量
 * 的支点（quality-gate 能 await 是因为它的读点在 `@mode serial` 监听器内，本包的在宿主
 * 定时器回调里）。`stateOf()` 同步交出已物化的当前态（installed
 * @deepseek-ai/dsh-session-projection/lib/types/index.d.ts:167-175），时序与迁移前逐字一致，
 * 并顺带消掉 findings 记的「agent/status→idle 每次全量 readEvents 是 O(n)」那条 P2。
 *
 * 等价性是本模块的全部要害，做法是**只在能被精确复现时才采信投影**，否则交回
 * `undefined` 让调用方回退本文件同处的扫描函数（扫描 = 迁移前的实现，一字未改语义）：
 *   - `turn/end` 定稿时若对不上**最近一条** `turn/start`（轮次号不等、end 缺号、
 *     或折叠窗口里压根没见过 start——崩溃恢复/冷启动只给半截日志就是这个形状），
 *     该行的 `aligned` 为 false ⇒ `reviewFromFacts` 交回 undefined ⇒ 回退扫描。
 *     不采用「粘性 degenerate」：一次异常不该让整条会话永久失去投影，而读侧要的
 *     恰好只是**最后一条** end 的证据。
 *   - opener 落在 `OPENER_WINDOW` 之外（被窗口淘汰）⇒ `turnOpenerKind` 交回 undefined ⇒ 回退扫描。
 *   - `latestTurnStart` 与旧倒扫对「是否存在更大的 turn/start」这一问逐项同解，无需回退。
 *
 * 注册表缺席（未装 dsh-session-projection 的 profile / headless 组装 / 迟到）时，
 * `runtime.facts` 读口从未装上 ⇒ 三处判定一律走扫描，行为与迁移前完全相同。
 * test/turn-facts.test.ts 钉住两套读法在同一串事件上的逐项判定相同。
 */

import { z } from "zod";
import type { SessionEvent, SessionHeader, SessionLogOffset } from "@deepseek-ai/dsh-session";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import { fieldOf, isRecord } from "@jayyuen666/dsh-plugin-shared/lib/record";
import type { TurnReview } from "./turn-review.ts";

/** 本包投影单元的注册键（host-only：不声明 wire ⇒ 不进客户端快照）。 */
export const RESCUE_FACTS_KEY = "session-rescue.turnFacts";

/** 与 goal-round-driver 的注入身份对齐（turn-review.ts 同一位常量）。 */
const GOAL_SOURCE_KIND = "goal";

/** 等待用户澄清的工具名（turn-review.ts 同判据）。 */
const USER_QUESTION_TOOL = "ask_user_question";

/** 回合开启的日志事件名：折叠表（applyEvent 的 case）与两条回退扫描判的都是它。 */
const TURN_START_EVENT = "turn/start";

/** opener 窗口：只为最近这么多回合记住「该回合 start 之后首条 user/message 的 kind」。
 *  不在表里 ⇒ `turnOpenerKind` 交回 undefined ⇒ 调用方回退扫描（宁可多扫一次，
 *  不给出错答案）。 */
const OPENER_WINDOW = 64;

/** 最近一条 turn/start 的「本回合内」累加器（等价旧扫描在 (S, end] 区间里逐项判的东西）。 */
export interface StartRow {
  /** 该回合的轮次号；`null` = 这条 turn/start 不带 turn 字段（那已置 degenerate）。 */
  turn: number | null;
  /** 该 start 之后是否已出现首条 user/message。 */
  seenFirst: boolean;
  /** 首条 user/message 的 `source.kind`；`null` = 没有或不是字符串（旧扫描同样判 false）。 */
  kind: string | null;
  /** 该 start 之后出现过**同轮次号**的 ask_user_question（旧 awaitsUser 的判据）。 */
  ask: boolean;
  /** 该 start 之后写过可用的 todo/write（旧 `todoUpdatedInTurn` 的判据，无轮次号过滤）。 */
  todoWritten: boolean;
}

/** 某个回合的 opener（`turnOpenerKind` 的表项）。 */
export interface OpenerRow {
  turn: number;
  /** 该回合 start 之后是否已绑定过一条 user/message（未绑定 = 等下一条消息，跨回合照绑——
   *  旧 `turnOpenerSource` 的正扫到日志末尾同判据）。 */
  seen: boolean;
  kind: string | null;
}

/** 一次 turn/end 定稿的复盘（等价 `reviewLastTurn` 的返回，`lastTurn`/`lastReasonKind` 改名
 *  为 turn/reasonKind，读侧再映回 TurnReview 字段名）。 */
export interface EndRow {
  turn: number | null;
  reasonKind: string | null;
  openTodos: number | null;
  todoUpdatedInTurn: boolean;
  awaitsUser: boolean;
  goalDrivenTurn: boolean;
  /** 本行是否可信：定稿那一刻是否对得上最近一条 turn/start（false ⇒ 读侧回退扫描）。 */
  aligned: boolean;
}

/** 投影态：全平面 JSON 值（官方单元契约：持久化缓存前提），`stateSchema` 校验每一份回填。 */
export interface RescueFacts {
  /** 最后一条 turn/end 的定稿；从未 turn/end ⇒ null（等价 reviewLastTurn 的 empty）。 */
  end: EndRow | null;
  /** 见过的最大 `turn/start.turn`：preFireCheck 的 newer-turn veto 用它。与旧倒扫同解——
   *  「是否存在大于 failedTurn 的 turn/start」= 最大值是否大于它，与轮次号是否递增无关。 */
  latestTurnStart: number | null;
  /** 会话级 todo 快照（`todo/write` 是 whole-list ⇒ last-wins）；从未可用写 ⇒ null。 */
  todoOpen: number | null;
  /** 最近一条 turn/start 的累加器；turn/end 定稿后清空（下一段 end 若无新 start 即不可信）。 */
  start: StartRow | null;
  /** 最近 `OPENER_WINDOW` 个回合的 opener。 */
  openers: readonly OpenerRow[];
}

// 叶子 schema 先落成常量：`z.array(z.object({ turn: z.number().int() … }))` 三层嵌套
// 会撞 unicorn/max-nested-calls，且这几个值域本来就该只有一个名字。
const nullableInt = z.number().int().nullable();
const nullableCount = z.number().int().nonnegative().nullable();
const nullableString = z.string().nullable();
const intKey = z.number().int();

const startRowSchema = z.object({
  turn: nullableInt,
  seenFirst: z.boolean(),
  kind: nullableString,
  ask: z.boolean(),
  todoWritten: z.boolean(),
});

const endRowSchema = z.object({
  turn: nullableInt,
  reasonKind: nullableString,
  openTodos: nullableCount,
  todoUpdatedInTurn: z.boolean(),
  awaitsUser: z.boolean(),
  goalDrivenTurn: z.boolean(),
  aligned: z.boolean(),
});

const openerRowSchema = z.object({ turn: intKey, seen: z.boolean(), kind: nullableString });

const rescueFactsSchema: z.ZodType<RescueFacts> = z.object({
  end: endRowSchema.nullable(),
  latestTurnStart: nullableInt,
  todoOpen: nullableCount,
  start: startRowSchema.nullable(),
  openers: z.array(openerRowSchema),
});

declare module "@deepseek-ai/dsh-session-projection/types" {
  interface SessionProjectionStateMap {
    "session-rescue.turnFacts": RescueFacts;
  }
}

// ── 事件读取：防御式，与 turn-review.ts / host.ts 的读法同一判据 ───────────────

function typeOf(ev: unknown): string {
  const type = fieldOf(ev, "type");
  return typeof type === "string" ? type : "";
}

/** 事件 `data` 里的 number 字段（缺字段/坏形状 → undefined）。 */
function numIn(ev: unknown, key: string): number | undefined {
  const raw = fieldOf(fieldOf(ev, "data"), key);
  return typeof raw === "number" ? raw : undefined;
}

/** 事件 `data.<group>.<key>` 的 string 字段（`reason.kind`）。 */
function nestedStr(ev: unknown, group: string, key: string): string | undefined {
  const raw = fieldOf(fieldOf(fieldOf(ev, "data"), group), key);
  return typeof raw === "string" ? raw : undefined;
}

/** 事件 `data.<key>` 的 string 字段（tool/call 的 name 等）。 */
function directStr(ev: unknown, key: string): string | undefined {
  const raw = fieldOf(fieldOf(ev, "data"), key);
  return typeof raw === "string" ? raw : undefined;
}

/** user/message 的 `source.kind`：跨边界载荷，非对象/非字符串一律按「没有 kind」判。 */
function sourceKindOf(ev: unknown): string | null {
  const source = fieldOf(fieldOf(ev, "data"), "source");
  if (!isRecord(source)) {
    return null;
  }
  const { kind } = source;
  return typeof kind === "string" ? kind : null;
}

/** todo/write 载荷里的未闭合条数；载荷不是数组 ⇒ undefined（这份快照不采信）。
 *  单条 return 收口（`typescript/consistent-return` 把 `return undefined` 记作无值返回）。 */
function openCountOf(todos: unknown): number | undefined {
  let open = 0;
  let applicable = false;
  if (Array.isArray(todos)) {
    applicable = true;
    for (const item of todos) {
      if (isRecord(item)) {
        const { status } = item;
        if (typeof status === "string" && status !== "completed") {
          open += 1;
        }
      }
    }
  }
  return applicable ? open : undefined;
}

/** 只留最近 OPENER_WINDOW 个回合（淘汰的回合由读侧回退扫描兜住）。 */
function trim(openers: readonly OpenerRow[]): readonly OpenerRow[] {
  return openers.length <= OPENER_WINDOW ? openers : openers.slice(-OPENER_WINDOW);
}

// ── 折叠 ────────────────────────────────────────────────────────────────────
// 折叠侧一律按 `unknown` 读事件（守卫投影），不把 `SessionEvent` 当既成事实：官方类型
// 说的是宿主承诺什么，日志条目跨版本缺字段是真事（与 host.ts / turn-review.ts 同一纪律）。

function foldTurnStart(state: RescueFacts, event: unknown): RescueFacts {
  const turn = numIn(event, "turn");
  // 轮次号重复/不增不需要特判：旧倒扫找的是「最后一条 turn/start(turn)」，本累加器同样
  // 以最后一条为准（下表按回合号覆写旧行），latestTurnStart 取的是最大值而非最后值。
  const { latestTurnStart, openers } = state;
  const latest = turn === undefined ? latestTurnStart : Math.max(turn, latestTurnStart ?? turn);
  const nextOpeners =
    turn === undefined
      ? openers
      : trim([...openers.filter((row) => row.turn !== turn), { turn, seen: false, kind: null }]);
  return {
    ...state,
    latestTurnStart: latest,
    openers: nextOpeners,
    // 缺 turn 字段的 start：turn 记 null ⇒ 其后任何 end 都对不上号 ⇒ end 不可信 ⇒ 回退扫描。
    start: { turn: turn ?? null, seenFirst: false, kind: null, ask: false, todoWritten: false },
  };
}

function foldUserMessage(state: RescueFacts, event: unknown): RescueFacts {
  const kind = sourceKindOf(event);
  const { start, openers } = state;
  const nextStart =
    start !== null && !start.seenFirst ? { ...start, seenFirst: true, kind } : start;
  // 未绑定的回合一律绑上这条消息：旧 `turnOpenerSource` 的正扫跑到**日志末尾**，
  // 跨回合照绑（某回合 start 之后一直没有消息时，它读到的是更晚那条的 source）。
  const nextOpeners = openers.some((row) => !row.seen)
    ? openers.map((row) => (row.seen ? row : { turn: row.turn, seen: true, kind }))
    : openers;
  if (nextStart === start && nextOpeners === openers) {
    return state;
  }
  return { ...state, start: nextStart, openers: nextOpeners };
}

function foldToolCall(state: RescueFacts, event: unknown): RescueFacts {
  const { start } = state;
  if (start === null || directStr(event, "name") !== USER_QUESTION_TOOL) {
    return state;
  }
  // 旧 awaitsUser 另带一条 `event.turn === lastTurn` 的等式判据（lastTurn 即该 end 的轮次号；
  // 采信路径上它与 start.turn 同一个值）。缺 turn 的事件：undefined !== 号码 ⇒ 不计数，同旧。
  if (start.turn === null || numIn(event, "turn") !== start.turn) {
    return state;
  }
  return start.ask ? state : { ...state, start: { ...start, ask: true } };
}

function foldTodoWrite(state: RescueFacts, event: unknown): RescueFacts {
  const count = openCountOf(fieldOf(fieldOf(event, "data"), "todos"));
  if (count === undefined) {
    // 快照不可用：既不采信，也不清掉上一份可用值（与旧实现 last-wins 同判据）。
    return state;
  }
  const { start } = state;
  const nextStart = start === null || start.todoWritten ? start : { ...start, todoWritten: true };
  if (count === state.todoOpen && nextStart === start) {
    return state;
  }
  return { ...state, todoOpen: count, start: nextStart };
}

function foldTurnEnd(state: RescueFacts, event: unknown): RescueFacts {
  const turn = numIn(event, "turn");
  const { start } = state;
  // 采信条件：end 的轮次号对得上**最近一条** turn/start（旧倒扫找的就是它）。对不上、
  // 或折叠窗口里压根没见过 start（冷启动只读到半截日志/崩溃恢复截断）⇒ 本行不可信，
  // 三项回合内判定一律留 false，读侧凭 aligned 回退扫描。
  const aligned = start !== null && turn !== undefined && start.turn === turn;
  const inTurn = aligned
    ? {
        todoUpdatedInTurn: start.todoWritten,
        awaitsUser: start.ask,
        goalDrivenTurn: start.seenFirst && start.kind === GOAL_SOURCE_KIND,
      }
    : { todoUpdatedInTurn: false, awaitsUser: false, goalDrivenTurn: false };
  return {
    ...state,
    end: {
      turn: turn ?? null,
      reasonKind: nestedStr(event, "reason", "kind") ?? null,
      // 旧实现在 [0, endIdx] 正扫 todo/write，取最后一份可用快照：本行按定稿那一刻的
      // todoOpen，落在 end 之后的写本来也不在那段区间里。
      openTodos: state.todoOpen,
      ...inTurn,
      aligned,
    },
    start: null,
  };
}

/**
 * 一条已提交事件的转移。官方「整值事件」规则（包头 file comment）：状态携带型日志事件
 * 自带变更后的完整值，故折叠只就地更新。无变化的事件返回**同一引用**
 * （官方 Object.is 判据：相同引用 = 零下游变更通知）。
 */
function applyEvent(state: RescueFacts, event: unknown): RescueFacts {
  switch (typeOf(event)) {
    case TURN_START_EVENT: {
      return foldTurnStart(state, event);
    }
    case "user/message": {
      return foldUserMessage(state, event);
    }
    case "tool/call": {
      return foldToolCall(state, event);
    }
    case "todo/write": {
      return foldTodoWrite(state, event);
    }
    case "turn/end": {
      return foldTurnEnd(state, event);
    }
    default: {
      return state;
    }
  }
}

export const rescueFactsProjection = {
  key: RESCUE_FACTS_KEY,
  stateVersion: 1,
  stateSchema: rescueFactsSchema,
  // 空日志的初态就地给出（此前是一份 `rescueFactsInit` 导出，生产侧只有这一个调用方，
  // 其余消费者全是测试——那正是要消掉的「只被测试养着的出口」）。官方 `init` 交回 header
  // 与 fork 继承前缀长度，本包两位都不需要：判定全由事件流自身推出，与迁移前的扫描口径一致。
  init: (_header: SessionHeader, _inherited: SessionLogOffset): RescueFacts => ({
    end: null,
    latestTurnStart: null,
    todoOpen: null,
    start: null,
    openers: [],
  }),
  apply: (state: RescueFacts, event: SessionEvent): RescueFacts => applyEvent(state, event),
} satisfies ProjectionDefinition<typeof RESCUE_FACTS_KEY, RescueFacts>;

// ── 读侧：把状态换算成三处判定原本各自要的答案 ──────────────────────────────

/**
 * `stateOf()` 的返回值 → 形状可用的投影态（结构读口交回 unknown：官方 `Session` 是名义类，
 * 本包的替身永远满足不了，见 host.ts 的 ProjectionsRegistry）。形状不符 = key 未注册/
 * 持久缓存回填坏值/宿主漂移 ⇒ undefined ⇒ 调用方回退扫描。
 * 序列层面的可信度不在这里判，而在各读函数自己的 undefined 分支。
 */
export function asFacts(value: unknown): RescueFacts | undefined {
  const parsed = rescueFactsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * 等价 `reviewLastTurn(events)`。交回 `undefined` = 最后一条 end 对不上它自己的 start
 * （折叠窗口里没有那条 start）⇒ 调用方回退扫描。
 */
export function reviewFromFacts(state: RescueFacts): TurnReview | undefined {
  const { end } = state;
  if (end === null) {
    // 从未 turn/end：与旧实现的空结论逐项同解。
    return {
      lastTurn: null,
      lastReasonKind: null,
      openTodos: null,
      todoUpdatedInTurn: false,
      awaitsUser: false,
      goalDrivenTurn: false,
    };
  }
  // 不可采信（end 对不上它自己的 start）⇒ undefined ⇒ 调用方回退扫描。
  return end.aligned
    ? {
        lastTurn: end.turn,
        lastReasonKind: end.reasonKind,
        openTodos: end.openTodos,
        todoUpdatedInTurn: end.todoUpdatedInTurn,
        awaitsUser: end.awaitsUser,
        goalDrivenTurn: end.goalDrivenTurn,
      }
    : undefined;
}

/** 等价 preFireCheck 的 newer-turn veto：出现过比 failedTurn 更大的 turn/start ⇒ true。 */
export function hasNewerTurn(state: RescueFacts, failedTurn: number): boolean {
  return state.latestTurnStart !== null && state.latestTurnStart > failedTurn;
}

/**
 * 等价 `scanOpenerKind(events, turn)`。
 * 交回 `undefined` = 该回合不在 opener 窗口内 ⇒ 调用方回退扫描。
 */
export function turnOpenerKind(state: RescueFacts, turn: number): string | null | undefined {
  const row = state.openers.find((entry) => entry.turn === turn);
  return row === undefined ? undefined : row.kind;
}

// ── 回退扫描（迁移前的实现，语义基准） ──────────────────────────────────────
// 留在本文件而不是 host.ts：等价用例两侧同处一屏可读，host.ts 只保留接线。

/** 是否存在 `turn/start` 的轮次号大于 failedTurn（旧 preFireCheck 的倒扫循环）。 */
export function scanNewerTurn(events: readonly unknown[], failedTurn: number): boolean {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (typeOf(ev) === TURN_START_EVENT) {
      const turn = numIn(ev, "turn");
      if (turn !== undefined && turn > failedTurn) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 该回合 opener 的 `source.kind`（旧 `turnOpenerSource` + 两位读取器的合并形态）。
 * 倒扫定位**最后一条** turn/start(turn)，再正扫到日志末尾找首条 user/message；
 * 找不到、或 source 不是对象/kind 不是字符串 ⇒ null（旧实现同样判成「既非 goal 也非 rescue」）。
 */
export function scanOpenerKind(events: readonly unknown[], turn: number): string | null {
  let startIndex = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (typeOf(ev) === TURN_START_EVENT && numIn(ev, "turn") === turn) {
      startIndex = i;
      break;
    }
  }
  if (startIndex < 0) {
    return null;
  }
  for (let i = startIndex + 1; i < events.length; i += 1) {
    if (typeOf(events[i]) === "user/message") {
      return sourceKindOf(events[i]);
    }
  }
  return null;
}
