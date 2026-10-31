// test/projection-reader.test.ts —— 双协议挂载的形状分流、释放与失败路径。
//
// 这一段此前没有任何用例：它只在真宿主里被走到，而三条失败路径（判序接错、dispose 拒绝、
// publish 抛错）在真宿主里都不会显形——读口恒 undefined 的表现是「判定退回全量扫描」，
// 而 unhandledRejection 与注册泄漏只在长会话里才看得出来。判据因此都钉在可观察的量上：
// 谁被调用、读口返回什么、账本里记了哪条日志。
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { describe, it } from "vitest";

import { mountFactsReader } from "../lib/projection-reader.ts";
import type { ProjectionsRegistry } from "../lib/projection-reader.ts";
import { rescueFactsProjection } from "../lib/turn-facts.ts";
import { loggedText } from "./setup-logs.ts";

const SESSION = { id: "s" };
/** 两条协议各自交回的读口取值；用例按它们判「谁被调到」。 */
const LEGACY_VALUE = "legacy-value";
const HANDLE_VALUE = "handle-value";
/** 用例只等一个宏任务，够 `unhandledRejection` 落地（Node 在这一轮微任务之后报）。 */
const UNHANDLED_GRACE_MS = 20;

/** 一次挂载里发生的事；用例只断言这些可观察量。 */
interface Trace {
  /** `registry.register` 收到的定义。 */
  definition: unknown;
  /** 旧协议读口被调用的次数。 */
  legacyReads: number;
  /** 新协议读口被调用的次数。 */
  handleReads: number;
  /** 旧协议 disposer 被调用的次数。 */
  disposals: number;
}

function emptyTrace(): Trace {
  return { definition: undefined, legacyReads: 0, handleReads: 0, disposals: 0 };
}

/** 读口本身不是某些用例的判据面时的 publish。 */
function ignoreReader(): void {
  // 这些用例只观察释放与日志，读口交出去之后不再调用。
}

/** 旧宿主：`await register()` 得到 disposer，读口走 `registry.stateOf(session, KEY)`。 */
function legacyRegistry(trace: Trace): ProjectionsRegistry {
  return {
    register: (definition) => {
      trace.definition = definition;
      return () => {
        trace.disposals += 1;
      };
    },
    stateOf: () => {
      trace.legacyReads += 1;
      return LEGACY_VALUE;
    },
  };
}

/** 新宿主：`await register()` 得到 handle，读口走 `handle.stateOf(session)`。 */
function handleRegistry(
  trace: Trace,
  dispose: () => Promise<void> | undefined,
): ProjectionsRegistry {
  return {
    register: (definition) => {
      trace.definition = definition;
      return {
        stateOf: () => {
          trace.handleReads += 1;
          return HANDLE_VALUE;
        },
        dispose,
      };
    },
    stateOf: () => {
      trace.legacyReads += 1;
      return LEGACY_VALUE;
    },
  };
}

/** 可调用 handle 的底：一个不捕获任何外层变量的最简函数（形状由 `callableHandle` 挂上）。 */
function callableBase(): void {
  // 形态本身就是判据：这里只需要「可调用」，调用行为没有含义。
}

/** 一条"可调用 + 可等待"的合成值：新宿主 `register()` 的原始形状，await 之后也可能是它。 */
function callableHandle(trace: Trace): unknown {
  const handle = Object.assign(callableBase, {
    stateOf: (): unknown => {
      trace.handleReads += 1;
      return HANDLE_VALUE;
    },
    dispose: (): void => {
      trace.disposals += 1;
    },
  });
  return handle;
}

describe("mountFactsReader：形状分流", () => {
  it("旧宿主交给 disposer：读口走 registry.stateOf(session, KEY)，释放就是它本身", async () => {
    const trace = emptyTrace();
    const readers: ((session: unknown) => unknown)[] = [];
    const release = await mountFactsReader(legacyRegistry(trace), (reader) => {
      readers.push(reader);
    });

    assert.equal(trace.definition, rescueFactsProjection, "注册的定义必须是本包的投影");
    assert.equal(readers.length, 1, "注册成功后必须交出恰好一个读口");
    assert.equal(readers[0]?.(SESSION), LEGACY_VALUE);
    assert.equal(trace.legacyReads, 1);
    release();
    assert.equal(trace.disposals, 1, "disposer 必须被原样交回并调用");
  });

  it("新宿主交给 handle：读口走 handle.stateOf(session)，释放调 dispose", async () => {
    const trace = emptyTrace();
    const readers: ((session: unknown) => unknown)[] = [];
    const release = await mountFactsReader(
      handleRegistry(trace, () => {
        trace.disposals += 1;
      }),
      (reader) => {
        readers.push(reader);
      },
    );

    assert.equal(readers[0]?.(SESSION), HANDLE_VALUE);
    assert.equal(trace.handleReads, 1);
    assert.equal(trace.legacyReads, 0, "新协议下不得再按旧签名调 registry.stateOf");
    release();
    assert.equal(trace.disposals, 1);
  });

  it("可调用的合成值按 handle 分流（判序宽窄）", async () => {
    const trace = emptyTrace();
    const readers: ((session: unknown) => unknown)[] = [];
    const registry: ProjectionsRegistry = {
      register: () => callableHandle(trace),
      stateOf: () => {
        trace.legacyReads += 1;
        return LEGACY_VALUE;
      },
    };
    const release = await mountFactsReader(registry, (reader) => {
      readers.push(reader);
    });

    assert.equal(readers[0]?.(SESSION), HANDLE_VALUE, "可调用值不能按旧 disposer 接走");
    assert.equal(trace.legacyReads, 0);
    release();
    assert.equal(trace.disposals, 1);
  });

  it("既非 disposer 也非 handle：抛 TypeError 且不交出读口", async () => {
    const shapes: unknown[] = [null, "nope", 42, {}, { stateOf: () => "x" }];
    const published = await Promise.all(
      shapes.map(async (shape) => {
        const registry: ProjectionsRegistry = { register: () => shape, stateOf: () => "x" };
        let calls = 0;
        await assert.rejects(
          mountFactsReader(registry, () => {
            calls += 1;
          }),
          /既非 disposer 也非 handle/u,
        );
        return calls;
      }),
    );
    assert.deepEqual(
      published,
      shapes.map(() => 0),
      "形状不认识时不得交出读口",
    );
  });
});

describe("mountFactsReader：失败路径", () => {
  it("publish 抛错时释放这次注册再抛（两条协议各一条）", async () => {
    const legacy = emptyTrace();
    await assert.rejects(
      mountFactsReader(legacyRegistry(legacy), () => {
        throw new Error("publish boom");
      }),
      /publish boom/u,
    );
    assert.equal(legacy.disposals, 1, "旧协议：publish 抛错后 disposer 必须被调用");

    const fresh = emptyTrace();
    await assert.rejects(
      mountFactsReader(
        handleRegistry(fresh, () => {
          fresh.disposals += 1;
        }),
        () => {
          throw new Error("publish boom");
        },
      ),
      /publish boom/u,
    );
    assert.equal(fresh.disposals, 1, "新协议：publish 抛错后 dispose 必须被调用");
  });

  it("dispose 拒绝不产生 unhandledRejection，只记一条警告", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    // 负例控制由变异实测做过：把 release 里那段 try/catch 去掉（只 await disposed），这条用例
    // 当场红——拒绝漏成 unhandledRejection，vitest 自己就把用例判失败。所以「零条」不是空转。
    process.on("unhandledRejection", onUnhandled);
    try {
      const trace = emptyTrace();
      const release = await mountFactsReader(
        handleRegistry(trace, () => Promise.reject(new Error("dispose boom"))),
        ignoreReader,
      );
      release();
      await delay(UNHANDLED_GRACE_MS);

      assert.deepEqual(unhandled, [], "dispose 的拒绝漏成了 unhandledRejection");
      assert.match(loggedText(), /sessionProjections handle dispose failed .*dispose boom/u);

      // 非 Error 的拒绝同样只记警告（三元里 String(error) 那一支）。
      const nonErrorReason: unknown = "string boom";
      const trace2 = emptyTrace();
      const release2 = await mountFactsReader(
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- 非 Error 的拒绝就是这条用例的判据（String(error) 分支），换成 Error 就测不到
        handleRegistry(trace2, () => Promise.reject(nonErrorReason)),
        ignoreReader,
      );
      release2();
      await delay(UNHANDLED_GRACE_MS);

      assert.deepEqual(unhandled, [], "非 Error 的拒绝漏成了 unhandledRejection");
      assert.match(loggedText(), /handle dispose failed .*string boom/u);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
