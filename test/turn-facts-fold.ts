// test/turn-facts-fold.ts —— 投影注册表替身的折叠口：把一串事件按序折成「日志就这么长」的当前态。
//
// 为什么在测试树里而不是 lib/turn-facts.ts：生产侧从不整串折——真注册表按
// `rescueFactsProjection.init` + 增量 `apply` 物化，host 只读 `stateOf()`。原先那份
// `foldEvents` 导出只被本包用例与 host 替身取用，是一张「只被测试养着」的导出面
// （owner 的裁定如此），于是搬到这里，并改走**同一个公开单元**：替身与生产
// 共用一份 init/apply，不会再各自漂出第二套折叠口径。
//
// 事件形参按 `unknown` 收（用例里的夹具只带本包读的字段，不是官方 SessionEvent 全形状），
// 折法与迁移前的 lib 版本逐字一致。

import { rescueFactsProjection } from "../lib/turn-facts.ts";
import type { RescueFacts } from "../lib/turn-facts.ts";

/** 与 host 替身 `stateOf` 同一形状：整串事件现折一份状态（真注册表增量折叠，同串同值）。 */
export function foldEvents(events: readonly unknown[]): RescueFacts {
  let state = rescueFactsProjection.init({} as never, 0 as never);
  for (const event of events) {
    state = rescueFactsProjection.apply(state, event as never);
  }
  return state;
}
