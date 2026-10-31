// 会话事件读取的共享判据：投影折叠（turn-facts）与回退扫描（turn-review）必须对同一串
// 事件逐项同解；两处各抄一份时，任何一侧被单独微调都会让投影读与回退读给出不同答案。
import { fieldOf, isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

export const USER_QUESTION_TOOL = "ask_user_question";
export const SCHEDULE_SOURCE_KIND = "schedule";

/** 官方 `TodoItem.status` 的全部取值（`@deepseek-ai/dsh-tool-todo` 的
 *  `'pending' | 'in_progress' | 'completed'`）。这里按**白名单**收未闭合项，
 *  不按「status !== "completed"` 收：后者把任何别的串（宿主将来新增的
 *  `cancelled`、载荷里拼错的 `compelted`、甚至一个空串）都算成没做完，于是
 *  一次正常收尾的回合被读成「还有活没干」，自动续跑就会追着用户问「继续」。
 *  白名单遇到不认识的取值时不计入——未知状态不等于未完成。 */
export const OPEN_TODO_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress"]);

/** 事件类型（非对象/缺 type → 空串）。 */
export function typeOf(ev: unknown): string {
  const type = fieldOf(ev, "type");
  return typeof type === "string" ? type : "";
}

/** 事件 `data` 里的 number 字段（缺字段/坏形状 → undefined）。
 *  只收**安全整数**：`NaN` 与 `1.5` 都是 `typeof === "number"`，但折叠一旦把它们存进
 *  状态，turn-facts 的 `stateSchema` 就拒收这份回填；两侧同一条判据才不会在这里分叉。 */
export function numIn(ev: unknown, key: string): number | undefined {
  const raw = fieldOf(fieldOf(ev, "data"), key);
  return typeof raw === "number" && Number.isSafeInteger(raw) ? raw : undefined;
}

/** 事件 `data.<group>.<key>` 的 string 字段（reason.kind / source.kind 等）。 */
export function nestedStr(ev: unknown, group: string, key: string): string | undefined {
  const raw = fieldOf(fieldOf(fieldOf(ev, "data"), group), key);
  return typeof raw === "string" ? raw : undefined;
}

/** 事件 `data.<key>` 的 string 字段（tool/call 的 name 等）。 */
export function directStr(ev: unknown, key: string): string | undefined {
  const raw = fieldOf(fieldOf(ev, "data"), key);
  return typeof raw === "string" ? raw : undefined;
}

/** 从 todo/write 载荷算未闭合条数；载荷非法返回 undefined（表示"这份快照不可用"）。 */
export function openCountOf(todos: unknown): number | undefined {
  let open = 0;
  let applicable = false;
  if (Array.isArray(todos)) {
    applicable = true;
    for (const item of todos) {
      if (isRecord(item)) {
        const { status } = item;
        if (typeof status === "string" && OPEN_TODO_STATUSES.has(status)) {
          open += 1;
        }
      }
    }
  }
  return applicable ? open : undefined;
}
