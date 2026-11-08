/**
 * 回合复盘：从会话事件流里读出「最后一个回合为什么结束、结束时工作是否闭合、
 * 是否在等用户、是否由 goal 轮次驱动」。纯函数，无 I/O、不持有状态，可独立单测。
 *
 * 存在动机（审查所得）：回合以 `completed` 结束时，事件层面与"任务真的
 * 做完"无法区分，所以不能对 completed 无脑续跑（会在每次正常回答后追问"继续"）。
 * 但有两类**结构化**信号是模型自己声明的，零猜测：
 *   - `todo/write` 是 whole-list 快照（last-wins）：清单里仍有 pending/in_progress
 *     = 模型自己承认没做完（dsh-tool-todo 的类型契约）。
 *   - `tool/call name='ask_user_question'` = 模型在等用户回答，此时**必须抑制**
 *     续跑，否则自动消息会打断澄清流程（实测同轮即配对 result，turn 字段可用）。
 *   - `user/message source.kind === 'goal'`：goal-round-driver 用
 *     `source: { kind: 'goal', ... }` 开轮（实测其注入身份），那类回合由 goal
 *     机制自己驱动续跑，本插件不得重复注入。
 *
 * 所有字段读取都是防御式的：缺字段/坏载荷只降级为"无从判断"，绝不抛错——
 * 本模块运行在事件热路径上。
 *
 * 入参是宿主 `snapshotEvents()` 返回的**原始**只读数组：签名若要 `ReviewEvent[]`，
 * 调用方必须先把整份会话日志逐条投影复制一遍——每个回合统一处理
 * 一次 O(n)，一个会话累计 O(n²)。这里直接在宿主数组上就地扫，零分配。
 */

/** 会话事件的本插件读取接口：元素来自宿主（跨版本字段会缺），一律守卫投影，
 *  不声明成具体 interface——那只会把 `unknown` 换成需要断言的假精确。 */

import { fieldOf } from "@jayyuen66/dsh-plugin-shared/lib/record";
import {
  directStr,
  nestedStr,
  numIn,
  openCountOf,
  SCHEDULE_SOURCE_KIND,
  typeOf,
  USER_QUESTION_TOOL,
} from "./event-fields.ts";

export interface TurnReview {
  /** 最后一条 turn/end 的回合号；无 turn/end 为 null。 */
  lastTurn: number | null;
  /** 最后一条 turn/end 的 reason.kind（completed/error/aborted/max-tokens/…）。 */
  lastReasonKind: string | null;
  /**
   * 会话当前 todo 清单里未闭合（pending/in_progress）的条数。
   * null = 本会话从未写过 todo/write（无从判断，调用方不得当作 0）。
   */
  openTodos: number | null;
  /**
   * 该清单快照是否由**最后一个回合自己**写下。false 表示陈旧（比如用户中途改了
   * 方向，旧清单还挂着未完成项），宿主不得据此判定"本回合没做完"。
   */
  todoUpdatedInTurn: boolean;
  /** 最后回合内调用过 ask_user_question → 模型在等用户，禁止自动注入。 */
  awaitsUser: boolean;
  /** 最后回合由官方 Schedule 提醒开启 → 交定时任务驱动，本插件不得注入。 */
  scheduleDrivenTurn: boolean;
}

interface TurnEndInfo {
  lastEndIndex: number;
  lastTurn: number | null;
  lastReasonKind: string | null;
}

/** 倒扫最后一条 turn/end；无则返回 null。 */
function findLastTurnEnd(events: readonly unknown[]): TurnEndInfo | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (typeOf(ev) === "turn/end") {
      const reasonKind = nestedStr(ev, "reason", "kind");
      return {
        lastEndIndex: i,
        lastTurn: numIn(ev, "turn") ?? null,
        lastReasonKind: reasonKind ?? null,
      };
    }
  }
  return null;
}

/** 该 turn 的 turn/start 下标；找不到返回 -1（老日志/崩溃恢复等场景）。
 *
 *  倒扫时不能见到 turn/start 就收：日志里可能缺本轮的 start，却留着更早轮的。
 *  那种情况下把更早轮的 start 当边界，`inTurn` 会把上一轮的事件也算进本轮——
 *  上一轮里若有 `ask_user_question`，本轮就被读成「在等用户」而抑制续跑；
 *  上一轮写过 todo，本轮「清单是否本回合写的」也会错判。
 *  所以倒扫途中碰到另一条 turn/end 就停：有 turn/end 夹在中间说明那个 start
 *  属于更早的轮，本轮没有 start。 */
function findTurnStart(
  events: readonly unknown[],
  lastEndIndex: number,
  lastTurn: number | null,
): number {
  // 从终态**之前**一条开始倒扫：events[lastEndIndex] 就是那条 turn/end 自己，
  // 从它开始的话第一轮就命中「碰到另一条 turn/end」直接返回 -1。
  for (let i = lastEndIndex - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (typeOf(ev) === "turn/end") {
      return -1;
    }
    if (typeOf(ev) === "turn/start" && (lastTurn === null || numIn(ev, "turn") === lastTurn)) {
      return i;
    }
  }
  return -1;
}

/** 会话当前 todo 清单（last-wins whole-list），并记录是否由本回合写出。 */
function todosSnapshot(
  events: readonly unknown[],
  lastEndIndex: number,
  inTurn: (index: number) => boolean,
): { openTodos: number | null; todoUpdatedInTurn: boolean } {
  // 清单快照（`todo/write`）是 last-wins：倒扫到第一条可用快照即可，常见情况下是 O(1)。
  for (let i = lastEndIndex; i >= 0; i -= 1) {
    const ev = events[i];
    if (typeOf(ev) === "todo/write") {
      const count = openCountOf(fieldOf(fieldOf(ev, "data"), "todos"));
      if (count !== undefined) {
        return { openTodos: count, todoUpdatedInTurn: inTurn(i) };
      }
    }
  }
  return { openTodos: null, todoUpdatedInTurn: false };
}

/** 单条事件是否构成本回合里的「等用户」调用。拆出来是为了让主循环只剩一件事：
 *  扫窗口、命中即真——把归属判据写在循环体里会让那个函数同时承担遍历与分类。 */
function isAwaitsUserCall(
  ev: unknown,
  lastTurn: number | null,
  inWindow: boolean,
  hasWindow: boolean,
): boolean {
  if (typeOf(ev) !== "tool/call") {
    return false;
  }
  if (directStr(ev, "name") !== USER_QUESTION_TOOL) {
    return false;
  }
  // `turn` 缺失不能判成「不是本轮」：`numIn` 返回 undefined 时等式恒 false，于是
  // 模型正在等用户的那条 call 被排除，本回合被判成「不在等用户」，自动续跑就插进
  // 了澄清流程。窗口可信时按窗口归属；窗口整段缺失（半截日志没有本轮 turn/start，
  // `findTurnStart` 返回 -1）时保守算本轮——这一路宁可多抑制一次，也不能打断澄清。
  const callTurn = numIn(ev, "turn");
  if (lastTurn === null) {
    return inWindow;
  }
  if (callTurn !== undefined) {
    return callTurn === lastTurn;
  }
  return hasWindow ? inWindow : true;
}

/** 等用户扫描的窗口：起点、终点、归属判据与「窗口是否可信」同属一份上下文。 */
interface AwaitsWindow {
  readonly startIndex: number;
  readonly lastEndIndex: number;
  readonly inTurn: (index: number) => boolean;
  readonly hasWindow: boolean;
}

/** 本回合内的 tool/call 里是否出现 ask_user_question（模型在等用户）。 */
function scanAwaitsUser(
  events: readonly unknown[],
  lastTurn: number | null,
  window: AwaitsWindow,
): boolean {
  for (let i = Math.max(0, window.startIndex); i < window.lastEndIndex; i += 1) {
    if (isAwaitsUserCall(events[i], lastTurn, window.inTurn(i), window.hasWindow)) {
      return true;
    }
  }
  return false;
}

/** 该回合的首条 user/message 注入身份是否为官方 Schedule（只看首条，判据与 goal 同）。
 *  `scanFrom < 0` = 找不到该回合的 turn/start（老日志/崩溃恢复只给半截日志）：此刻
 *  会话首条消息属于哪个回合未知，拿它判「本回合由 Schedule 开启」会把上一回合的身份
 *  串进来，故与 `turn-start` 缺失时其余两项判定同向，交回 false。 */
function scanScheduleDriven(
  events: readonly unknown[],
  scanFrom: number,
  lastEndIndex: number,
): boolean {
  if (scanFrom < 0) {
    return false;
  }
  for (let i = scanFrom; i < lastEndIndex; i += 1) {
    const ev = events[i];
    if (typeOf(ev) === "user/message") {
      return nestedStr(ev, "source", "kind") === SCHEDULE_SOURCE_KIND;
    }
  }
  return false;
}

/**
 * 复盘最后一个回合。events 为宿主 snapshotEvents() 的原始产物（按 seq 升序的
 * 完整日志）；本函数只就地扫，不复制、不改写。
 */
export function reviewLastTurn(events: readonly unknown[] | undefined | null): TurnReview {
  const empty: TurnReview = {
    lastTurn: null,
    lastReasonKind: null,
    openTodos: null,
    todoUpdatedInTurn: false,
    awaitsUser: false,
    scheduleDrivenTurn: false,
  };
  if (!Array.isArray(events) || events.length === 0) {
    return empty;
  }

  // 1) 最后一条 turn/end（倒扫，天然拿到最新 todo 之外的终态）。
  const endInfo = findLastTurnEnd(events);
  if (endInfo === null) {
    return empty;
  }
  const { lastEndIndex, lastTurn, lastReasonKind } = endInfo;

  // 2) 最后回合的左边界。三项判定都以 [边界, 终态) 为"本回合内"。
  const turnStartIndex = findTurnStart(events, lastEndIndex, lastTurn);
  const inTurn = (index: number): boolean => turnStartIndex >= 0 && index > turnStartIndex;

  // 3) 会话当前 todo 清单：正扫到终态为止（陈旧清单不能当"本回合没做完"的证据）。
  const { openTodos, todoUpdatedInTurn } = todosSnapshot(events, lastEndIndex, inTurn);

  // 4) 等待用户 + 5) Schedule 驱动。（goal 驱动不在这里判：goal 轮次的让路/接管要到
  //    触发侧读 round driver 自己的停机位，见 host.ts 的 goalTakeoverVerdict。）
  const awaitsUser = scanAwaitsUser(events, lastTurn, {
    startIndex: turnStartIndex >= 0 ? turnStartIndex + 1 : 0,
    lastEndIndex,
    inTurn,
    hasWindow: turnStartIndex >= 0,
  });
  const scheduleDrivenTurn = scanScheduleDriven(events, turnStartIndex, lastEndIndex);

  return {
    lastTurn,
    lastReasonKind,
    openTodos,
    todoUpdatedInTurn,
    awaitsUser,
    scheduleDrivenTurn,
  };
}

/** 开放回合（已 start、尚未 end）的复盘：steer 续跑模式的判据源。
 *  reviewLastTurn 只认「最后一条 turn/end」，而 steer 判定发生在回合收尾之前——
 *  那一刻本回合还没有 turn/end 可扫，两类判据天然是两个读法。 */
export interface OpenTurnReview {
  /** 开放回合的轮次号（turn/start 的 turn 位；读不出为 null，调用方放弃判）。 */
  turn: number | null;
  /** 开放回合窗口内最后一份 todo/write 快照的未闭合数；窗口内没写过清单为 null。 */
  openTodos: number | null;
  /** 该清单是否写于本开放回合内（窗口内写 ⇒ 恒真；字段与 TurnReview 同形便于调用方共用闸门）。 */
  todoUpdatedInTurn: boolean;
  /** 窗口内调用过 ask_user_question → 模型在等用户，禁止 steer。 */
  awaitsUser: boolean;
  /** 窗口首条 user/message 来自官方 Schedule → 交定时任务驱动。 */
  scheduleDrivenTurn: boolean;
}

/** 复盘当前开放的回合；没有开放回合（最后一条边界是 turn/end，或日志里没有 turn/start）
 *  交回 null。判定窗口 = 开放回合的 turn/start（含）到日志末尾。 */
export function reviewOpenTurn(
  events: readonly unknown[] | undefined | null,
): OpenTurnReview | null {
  if (!Array.isArray(events) || events.length === 0) {
    return null;
  }
  // 倒扫最后一条 turn/start：其后若还有 turn/end，说明这个回合已经收尾，没有开放回合。
  let startIndex = -1;
  let turn: number | null = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev: unknown = events[i];
    if (typeOf(ev) === "turn/end") {
      return null;
    }
    if (typeOf(ev) === "turn/start") {
      startIndex = i;
      turn = numIn(ev, "turn") ?? null;
      break;
    }
  }
  if (startIndex < 0) {
    return null;
  }
  // 清单快照（last-wins）只在开放回合窗口内找：窗口外更早的清单是陈旧证据，
  // 不能当「本回合没做完」的依据（与 todosSnapshot 的陈旧判据同向）。
  let windowTodos: number | null = null;
  for (let i = startIndex + 1; i < events.length; i += 1) {
    const ev: unknown = events[i];
    if (typeOf(ev) === "todo/write") {
      const count = openCountOf(fieldOf(fieldOf(ev, "data"), "todos"));
      if (count !== undefined) {
        windowTodos = count;
      }
    }
  }
  const awaitsUser = scanAwaitsUser(events, turn, {
    startIndex: startIndex + 1,
    lastEndIndex: events.length,
    inTurn: () => true,
    hasWindow: true,
  });
  const scheduleDrivenTurn = scanScheduleDriven(events, startIndex, events.length);
  return {
    turn,
    openTodos: windowTodos,
    // 窗口内的快照天然就是「本回合写的」。
    todoUpdatedInTurn: windowTodos !== null,
    awaitsUser,
    scheduleDrivenTurn,
  };
}
