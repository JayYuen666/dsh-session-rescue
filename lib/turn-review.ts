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
 * 入参是宿主 `snapshotEvents()` 返回的**原始**只读数组（item 8）：此前签名要
 * `ReviewEvent[]`，调用方必须先把整份会话日志逐条投影复制一遍——每个回合收口
 * 一次 O(n)，一个会话累计 O(n²)。现在直接在宿主数组上就地扫，零分配。
 */

/** 会话事件的本插件读面：元素来自宿主（跨版本字段会缺），一律守卫投影，
 *  不声明成具体 interface——那只会把 `unknown` 换成需要断言的假精确。 */

/** 事件类型（非对象/缺 type → 空串）。 */
import { fieldOf, isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

function typeOf(ev: unknown): string {
  const type = fieldOf(ev, "type");
  return typeof type === "string" ? type : "";
}

/** 事件 `data` 里的 number 字段（缺字段/坏形状 → undefined）。 */
function numIn(ev: unknown, key: string): number | undefined {
  const raw = fieldOf(fieldOf(ev, "data"), key);
  return typeof raw === "number" ? raw : undefined;
}

/** 事件 `data.<group>.<key>` 的 string 字段（reason.kind / source.kind 等）。 */
function nestedStr(ev: unknown, group: string, key: string): string | undefined {
  const raw = fieldOf(fieldOf(fieldOf(ev, "data"), group), key);
  return typeof raw === "string" ? raw : undefined;
}

/** 事件 `data.<key>` 的 string 字段（tool/call 的 name 等）。 */
function directStr(ev: unknown, key: string): string | undefined {
  const raw = fieldOf(fieldOf(ev, "data"), key);
  return typeof raw === "string" ? raw : undefined;
}

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
  /** 最后回合由 goal 轮次开启 → 交 goal 机制驱动，本插件不得注入。 */
  goalDrivenTurn: boolean;
}

const USER_QUESTION_TOOL = "ask_user_question";
const GOAL_SOURCE_KIND = "goal";

/** 从 todo/write 载荷算未闭合条数；载荷非法返回 undefined（表示"这份快照不可用"）。 */
function openCountOf(todos: unknown): number | undefined {
  let open = 0;
  let applicable = false;
  if (Array.isArray(todos)) {
    applicable = true;
    for (const item of todos) {
      // Array.isArray 收窄为 any[]；isRecord 守卫经 typeof 收窄，不经 any 断言
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

/** 该 turn 的 turn/start 下标；找不到返回 -1（老日志/崩溃恢复等场景）。 */
function findTurnStart(
  events: readonly unknown[],
  lastEndIndex: number,
  lastTurn: number | null,
): number {
  for (let i = lastEndIndex; i >= 0; i -= 1) {
    const ev = events[i];
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
  let openTodos: number | null = null;
  let todoUpdatedInTurn = false;
  for (let i = 0; i <= lastEndIndex; i += 1) {
    const ev = events[i];
    if (typeOf(ev) === "todo/write") {
      const count = openCountOf(fieldOf(fieldOf(ev, "data"), "todos"));
      if (count !== undefined) {
        openTodos = count;
        todoUpdatedInTurn = inTurn(i);
      }
    }
  }
  return { openTodos, todoUpdatedInTurn };
}

/** 本回合内的 tool/call 里是否出现 ask_user_question（模型在等用户）。 */
function scanAwaitsUser(
  events: readonly unknown[],
  lastTurn: number | null,
  lastEndIndex: number,
  inTurn: (index: number) => boolean,
): boolean {
  for (let i = 0; i < lastEndIndex; i += 1) {
    const ev = events[i];
    if (
      typeOf(ev) === "tool/call" &&
      inTurn(i) &&
      (lastTurn === null || numIn(ev, "turn") === lastTurn) &&
      directStr(ev, "name") === USER_QUESTION_TOOL
    ) {
      return true;
    }
  }
  return false;
}

/** 该回合的首条 user/message 注入身份是否为 goal（只看首条）。 */
function scanGoalDriven(
  events: readonly unknown[],
  scanFrom: number,
  lastEndIndex: number,
): boolean {
  for (let i = scanFrom; i < lastEndIndex; i += 1) {
    const ev = events[i];
    if (typeOf(ev) === "user/message") {
      return nestedStr(ev, "source", "kind") === GOAL_SOURCE_KIND;
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
    goalDrivenTurn: false,
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

  // 4) 等待用户 + 5) goal 驱动。
  const awaitsUser = scanAwaitsUser(events, lastTurn, lastEndIndex, inTurn);
  const scanFrom = Math.max(turnStartIndex, 0);
  const goalDrivenTurn = scanGoalDriven(events, scanFrom, lastEndIndex);

  return { lastTurn, lastReasonKind, openTodos, todoUpdatedInTurn, awaitsUser, goalDrivenTurn };
}
