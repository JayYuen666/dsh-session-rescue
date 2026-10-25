import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  rescueCsrfStore,
  rescueState,
  postCancel,
  postToggle,
  notifyHostConnected,
} from "../src/client-entry.ts";

function check(cond: boolean, msg: string): asserts cond {
  if (!cond) {
    throw new Error(`assert failed: ${msg}`);
  }
}

// 全部 mutating POST（cancel/toggle/resume）必须回填 state GET 下发的
// x-rescue-csrf。fetch 全局桩捕获调用断言。

interface CapturedCall {
  url: unknown;
  init: { method?: unknown; headers?: unknown; body?: unknown };
}

const captured: CapturedCall[] = [];
const origFetch = globalThis.fetch;

function stubFetch(body?: unknown): void {
  captured.length = 0;
  const payload = body ?? { ok: true };
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    captured.push({ url, init: init ?? {} });
    return { ok: true, json: async () => payload };
  }) as unknown as typeof fetch;
}

function headerOf(call: CapturedCall): Record<string, string> {
  const { headers } = call.init;
  check(headers !== null && typeof headers === "object", "mutating POST must carry headers");
  return headers as Record<string, string>;
}

function firstCall(): CapturedCall {
  const [call] = captured;
  check(call !== undefined, "expected one captured fetch call");
  return call;
}

// 测试辅助：让当前宏任务队列落空（fetch Promise 等后续微任务执行）。
// 用 Promise.withResolvers 而非 new Promise——后者触发 promise/avoid-new；
// DOM/测试无 node:timers，只能靠 setTimeout 宏任务让位。泛参用 undefined
// （Promise<undefined>）避免 void 出现在非返回位的 no-invalid-void-type。
const flush = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setTimeout(() => {
    resolve(undefined);
  }, 0);
  return promise;
};

describe("csrf 存取与回填", () => {
  beforeEach(() => {
    rescueCsrfStore.token = "";
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    rescueCsrfStore.token = "";
  });

  it("state GET 下发的 csrf 被记住（refresh 接线）", async () => {
    stubFetch({ ok: true, csrf: "tok123", sessions: {} });
    void rescueState.refresh();
    await flush();
    expect(rescueCsrfStore.token).toBe("tok123");
  });

  it("remember 忽略非法 csrf（缺失/非字符串/空串不覆盖已有值）", () => {
    rescueCsrfStore.remember({ ok: true, csrf: "keep" });
    rescueCsrfStore.remember({ ok: true });
    rescueCsrfStore.remember({ ok: true, csrf: 42 });
    rescueCsrfStore.remember({ ok: true, csrf: "" });
    rescueCsrfStore.remember(null);
    expect(rescueCsrfStore.token).toBe("keep");
  });

  it("postCancel 在 POST 上回填 x-rescue-csrf", async () => {
    rescueCsrfStore.token = "tok123";
    stubFetch({ ok: true, cancelled: true, turn: 3 });
    const result = await postCancel("s1");
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    const call = firstCall();
    expect(String(call.url)).toContain("/_dsh/session-rescue/cancel");
    expect(call.init.method).toBe("POST");
    expect(headerOf(call)["x-rescue-csrf"]).toBe("tok123");
  });

  it("postToggle 在 POST 上回填 x-rescue-csrf", async () => {
    rescueCsrfStore.token = "tok123";
    stubFetch({ ok: true, disabled: true });
    await postToggle("s1");
    expect(captured).toHaveLength(1);
    const call = firstCall();
    expect(String(call.url)).toContain("/_dsh/session-rescue/toggle");
    expect(call.init.method).toBe("POST");
    expect(headerOf(call)["x-rescue-csrf"]).toBe("tok123");
  });

  it("connection/reset 恢复通知（resume）在 POST 上回填 x-rescue-csrf", async () => {
    rescueCsrfStore.token = "tok123";
    stubFetch({ ok: true, restored: 0 });
    const listeners = new Map<string, () => void>();
    notifyHostConnected({
      on: (event: string, listener: () => void) => {
        listeners.set(event, listener);
      },
    } as never);
    listeners.get("connection/reset")?.();
    await flush();
    expect(captured).toHaveLength(1);
    const call = firstCall();
    expect(String(call.url)).toContain("/_dsh/session-rescue/resume");
    expect(call.init.method).toBe("POST");
    expect(headerOf(call)["x-rescue-csrf"]).toBe("tok123");
  });
});
