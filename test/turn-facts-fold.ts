// test/turn-facts-fold.ts —— 投影注册表替身的折叠口：把一串事件按序折成「日志就这么长」的当前态。
//
// 为什么在测试树里而不是 lib/turn-facts.ts：生产侧从不整串折——真注册表按
// `rescueFactsProjection.init` + 增量 `apply` 物化，host 只读 `stateOf()`。整串折叠只被
// 用例与 host 替身取用，是一条「只被测试养着」的导出面，所以它留在这里，且走
// **同一个公开单元**：替身与生产共用一份 init/apply，不会再各自漂出第二套折叠口径。
//
// 事件形参按 `unknown` 收（用例里的夹具只带本包读的字段，不是官方 SessionEvent 全形状）。

import { rescueFactsProjection } from "../lib/turn-facts.ts";
import type { RescueFacts } from "../lib/turn-facts.ts";

/**
 * 与 host 替身 `stateOf` 同一形状：整串事件现折一份状态（真注册表增量折叠，同串同值）。
 *
 * 两处 `as never` 都是「替身交不出官方名义类型」的老问题（见 host.ts 的 ProjectionsRegistry
 * 注释）：`init` 要 SessionHeader，`apply` 要 SessionEvent，而夹具只带本包读的那几位。
 * 但 `as never` 也让**签名漂移**不可见——`init` 改成收三个参数、`apply` 改名或换形状，
 * 这里照样编译通过，只在运行时折出不一样的状态。所以在绕过类型之前先做一次形状探针：
 * 拿到的不是函数就立刻点名，而不是把「注册表接口变了」表现成「折叠结果不对」。
 */
export function foldEvents(events: readonly unknown[]): RescueFacts {
  if (
    typeof rescueFactsProjection.init !== "function" ||
    typeof rescueFactsProjection.apply !== "function"
  ) {
    throw new TypeError(
      "turn-facts 投影缺 init 或 apply：ProjectionDefinition 的形状变了，折叠替身要先跟上",
    );
  }
  let state = rescueFactsProjection.init({} as never, 0 as never);
  for (const event of events) {
    state = rescueFactsProjection.apply(state, event as never);
  }
  return state;
}
