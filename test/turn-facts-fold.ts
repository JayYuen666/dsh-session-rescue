// test/turn-facts-fold.ts —— 投影注册表替身的折叠口（`foldEvents`）：把一串事件按序折成「日志就这么长」的当前态。
//
// 为什么在测试树里而不是 lib/turn-facts.ts：生产侧从不整串折——真注册表按
// `rescueFactsProjection.init` + 增量 `apply` 物化，host 只读 `stateOf()`。整串折叠只被
// 用例与 host 替身取用，是一条「只被测试养着」的导出名单，所以它留在这里，且走
// **同一个公开单元**：替身与生产共用一份 init/apply，不会再各自漂出第二套折叠规则。
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
 * 这里照样编译通过，只在运行时折出不一样的状态。所以在绕过类型之前先做一次形状探测：
 * 拿到的不是函数就立刻点名，而不是把「注册表接口变了」表现成「折叠结果不对」。
 * 绕过只发生在本文件：用例改用 `initFacts` / `applyOnce`，不再自己写 `as never`。
 */
/** 最小形状判据：init/apply 交回的必须还是 RescueFacts 的骨架（apply 改成原地
 *  mutate 返回 void 时，这里当场点名，而不是让后续折叠以莫名的读数漂下去）。 */
function isFacts(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && "openers" in value && "latestTurnStart" in value
  );
}

/** 折叠口的形状探测：`init`/`apply` 只要有一个不再是函数就点名，不往下走。
 *  返回整个单元而不是拆出的方法——宿主那侧的教训是拆方法会丢接收者。 */
function requireUnit(): typeof rescueFactsProjection {
  if (
    typeof rescueFactsProjection.init !== "function" ||
    typeof rescueFactsProjection.apply !== "function"
  ) {
    throw new TypeError(
      "turn-facts 投影缺 init 或 apply：ProjectionDefinition 的形状变了，折叠替身要先跟上",
    );
  }
  return rescueFactsProjection;
}

/** 投影的首值（空日志初态；夹具不带官方 SessionHeader）。 */
export function initFacts(): RescueFacts {
  const state = requireUnit().init({} as never, 0 as never);
  if (!isFacts(state)) {
    throw new TypeError("init 交回的不是 RescueFacts 形状（缺 openers/latestTurnStart）");
  }
  return state;
}

/** 一条事件的一次转移；`cause` 带着那条事件，所以不必再报第几位（折叠在首个坏位即停）。 */
export function applyOnce(state: RescueFacts, event: unknown): RescueFacts {
  const next = requireUnit().apply(state, event as never);
  if (!isFacts(next)) {
    throw new TypeError("apply 交回的不是 RescueFacts 形状（缺 openers/latestTurnStart）", {
      cause: event,
    });
  }
  return next;
}

export function foldEvents(events: readonly unknown[]): RescueFacts {
  let state = initFacts();
  for (const event of events) {
    state = applyOnce(state, event);
  }
  return state;
}
