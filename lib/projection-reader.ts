// lib/projection-reader.ts —— 会话投影的**双协议**挂载：旧宿主交回 disposer，新宿主交回 handle。
//
// 为什么单列：host.ts 顶着 `eslint/max-lines` 的行数预算，而这一段是自成一体的一次判断
//（一次注册、形状分流、交出读口），与判定链没有别的关系。
//
// ⚠ 判别只能发生在 **`await` 之后**：两版 `register()` 的原始返回值都是函数——新宿主那份是
// 「可调用 + 可等待」的合成值，旧宿主那份的 `fiber.effect` 结果同样带 `then`。await 之前
// 比较 `typeof`、查 `.then`、或 `instanceof Promise` 都分不开；await 之后旧版得到 disposer、
// 新版得到带 `stateOf`/`dispose` 的对象，那才是可靠的分流点。

import { RESCUE_FACTS_KEY, rescueFactsProjection } from "./turn-facts.ts";

/**
 * `ctx.sessionProjections` 的本包读面。`stateOf` 的第一参按 `unknown` 收（官方钉名义类
 * `Session`，替身会话永远满足不了）；`register` 的返回域按 `unknown` 收，理由见文件头。
 */
export interface ProjectionsRegistry {
  register: (definition: typeof rescueFactsProjection) => unknown;
  stateOf: (session: unknown, key: typeof RESCUE_FACTS_KEY) => unknown;
}

/** 新版注册的结果：`await register()` 之后拿到的那一枚。 */
interface ProjectionHandle {
  readonly stateOf: (session: unknown) => unknown;
  readonly dispose: () => Promise<void> | undefined;
}

/** 旧版注册的结果就是 disposer 本身。 */
const isDisposer = (value: unknown): value is () => void => typeof value === "function";

/**
 * 新版注册的结果：可读、可释放。
 *
 * 两条要点：①判序在 {@link isDisposer} **之前**；②**可调用的值也算对象**（`typeof === "function"`
 * 也要收）。旧判据只认 `typeof === "object"`，于是新宿主 `register()` 那个「可调用 + 可等待」的
 * 合成值一旦原样成为 handle，就会被宽判据 `typeof === "function"` 当旧 disposer 接走：读者改走
 * `registry.stateOf(session, KEY)`，新宿主没有那个签名，读口恒 `undefined`、判定却以为自己有
 * 投影——没有一条日志会提。真正的 disposer 是裸函数，不带 `stateOf`/`dispose`，不会被误收。
 */
const isProjectionHandle = (value: unknown): value is ProjectionHandle =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  typeof (value as { stateOf?: unknown }).stateOf === "function" &&
  typeof (value as { dispose?: unknown }).dispose === "function";

/**
 * 注册回合事实投影，**成功之后**才把读口交给 `publish`。
 *
 * 新宿主的注册可能异步失败，那时先交出去的读者会永远读到 `undefined`，判定却以为自己有
 * 投影。失败以抛出表达，由调用方决定怎么记（本仓的 `errorText` 在 host.ts 里）。
 *
 * @param registry 宿主注入的投影注册表
 * @param publish 交出读口；调用方负责在卸载时撤下
 * @returns 释放这次注册的函数
 */
export async function mountFactsReader(
  registry: ProjectionsRegistry,
  publish: (reader: (session: unknown) => unknown) => void,
): Promise<() => void> {
  const ready: unknown = await registry.register(rescueFactsProjection);
  let read: (session: unknown) => unknown;
  let release: () => void;
  if (isProjectionHandle(ready)) {
    read = (session) => ready.stateOf(session);
    release = () => {
      // 新版释放是异步的，但这条路径上没有东西需要等它：卸载之后本插件不再判定。
      // 拒绝必须接住：丢掉一个 rejected promise 会变成 unhandledRejection（Node 默认终止
      // 进程），而这条拒绝只说明注册已随宿主卸载被撤销，不是需要重启插件的错误。
      const disposed = ready.dispose();
      void (async () => {
        try {
          await disposed;
        } catch (error: unknown) {
          console.warn(
            `[session-rescue] sessionProjections handle dispose failed (registration already released): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      })();
    };
  } else if (isDisposer(ready)) {
    read = (session) => registry.stateOf(session, RESCUE_FACTS_KEY);
    release = ready;
  } else {
    throw new TypeError("sessionProjections.register 交回了既非 disposer 也非 handle 的形状");
  }
  try {
    publish(read);
  } catch (error: unknown) {
    // 调用方只在拿到返回的释放函数时才记账；`publish` 抛错时它会把这次挂载当成「没装上」，
    // 而注册其实已经成功——不在这里释放就是一条静默泄漏（旧宿主上还多一个常驻 effect）。
    release();
    throw error;
  }
  return release;
}
