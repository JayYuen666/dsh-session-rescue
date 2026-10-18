// 客户端读面（官方 Typert Remote）的直测：descriptor 与宿主标记对质、边界码器、
// 命名空间缺口的报错面，以及六个读方法的位置传参。真实卡片链路在 test/client-ui.test.ts。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol";
import type { InvocationDescriptor, TypertCodec } from "@deepseek-ai/dsh-typert-protocol";

import { installSessionRescueRemote, SessionRescueRemoteService } from "../host.ts";
import { createRescueReader, RESCUE_DESCRIPTORS } from "../src/remote.ts";

const PACKAGE_NAME = "@jayyuen66/dsh-session-rescue";
const NAMESPACE = "sessionRescue";
const SERVICE_KEY = `remote.${NAMESPACE}`;

function runtimeOf(): never {
  return {
    scheduler: { cancel: () => ({ cancelled: true }) },
    disabledSessions: new Set<string>(),
    suspendedSnapshots: { value: [] },
  } as never;
}

function descriptorOf(method: string): InvocationDescriptor {
  const found = RESCUE_DESCRIPTORS.find((descriptor) => descriptor.method === method);
  assert.ok(found !== undefined, `${method} 必须有 descriptor`);
  return found;
}

function codecOf(method: string): TypertCodec {
  const [parameter] = descriptorOf(method).parameters;
  assert.ok(parameter !== undefined, `${method} 必须有业务参数`);
  assert.equal(parameter.codec.mode, "strict");
  return parameter.codec;
}

function strictOf(method: string): TypertCodec & { mode: "strict" } {
  const codec = codecOf(method);
  if (codec.mode !== "strict") {
    throw new Error(`${method} 的码器不是 strict`);
  }
  return codec;
}

interface RecordedCall {
  method: string;
  args: unknown[];
}

function namespaceOf(overrides: Record<string, unknown> = {}): {
  namespace: Record<string, unknown>;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const ok =
    (method: string, value: unknown, args: unknown[] = []): (() => Promise<unknown>) =>
    async () => {
      calls.push({ method, args });
      return { ok: true, value };
    };
  const namespace: Record<string, unknown> = {
    state: ok("state", { sessions: { s1: { status: "running" } } }),
    cancel: async (request: unknown) => {
      calls.push({ method: "cancel", args: [request] });
      return { ok: true, value: { cancelled: true } };
    },
    toggle: async (request: unknown) => {
      calls.push({ method: "toggle", args: [request] });
      return { ok: true, value: { disabled: true } };
    },
    resume: ok("resume", { restored: 1 }),
    retryProviders: ok("retryProviders", { providers: [] }),
    retryPolicy: async (request: unknown) => {
      calls.push({ method: "retryPolicy", args: [request] });
      return { ok: true, value: { provider: "p", preset: "normal" } };
    },
    ...overrides,
  };
  return { namespace, calls };
}

function readerOf(
  namespace: unknown,
  mount: () => Promise<unknown> = async () => ({}),
): {
  reader: NonNullable<ReturnType<typeof createRescueReader>>;
  mounts: number[];
} {
  const mounts: number[] = [];
  const remote = {
    $mount: async (): Promise<unknown> => {
      mounts.push(1);
      return mount();
    },
  };
  const ctx = {
    get: (name: string): unknown => {
      if (name === "remote") {
        return remote;
      }
      return name === SERVICE_KEY ? namespace : undefined;
    },
  };
  const reader = createRescueReader(ctx);
  assert.ok(reader !== undefined);
  return { reader, mounts };
}

describe("客户端读面（官方 Typert Remote）", () => {
  it("六条 descriptor 与宿主标记逐项对质", () => {
    const service = new SessionRescueRemoteService(new Context(), runtimeOf());
    const markers = remoteMethods(service)
      .map((marker) => marker.method)
      .toSorted();
    assert.deepEqual(RESCUE_DESCRIPTORS.map((descriptor) => descriptor.method).toSorted(), markers);
    for (const descriptor of RESCUE_DESCRIPTORS) {
      assert.equal(descriptor.id, `${PACKAGE_NAME}#${NAMESPACE}/${descriptor.method}`);
      assert.equal(descriptor.service, NAMESPACE);
      assert.equal(descriptor.namespace, NAMESPACE);
      assert.equal(descriptor.invocation.kind, "direct");
      assert.equal(descriptor.result.mode, "src-json");
    }
    assert.deepEqual(
      RESCUE_DESCRIPTORS.filter((descriptor) => descriptor.parameters.length === 0)
        .map((descriptor) => descriptor.method)
        .toSorted(),
      ["resume", "retryProviders", "state"],
    );
  });

  it("边界码器只收字符串字段，且丢掉未声明字段", () => {
    const session = strictOf("cancel");
    assert.deepEqual(session.create().parse({ sessionId: "s1", extra: 1 }), { sessionId: "s1" });
    for (const bad of [null, [], {}, { sessionId: 42 }]) {
      assert.throws(() => session.create().parse(bad), /string sessionId/u);
    }
    assert.equal(strictOf("toggle"), session, "cancel 与 toggle 共用一枚码器");

    const policy = strictOf("retryPolicy");
    assert.deepEqual(policy.create().parse({ provider: "p", preset: "normal", extra: true }), {
      provider: "p",
      preset: "normal",
    });
    for (const bad of [
      null,
      {},
      { provider: "p" },
      { provider: 1, preset: "normal" },
      { provider: "p", preset: 2 },
    ]) {
      assert.throws(() => policy.create().parse(bad), /string provider and preset/u);
    }
  });

  it("宿主上下文没有注册口 → 只少掉读面，不抛错", () => {
    assert.equal(installSessionRescueRemote({} as never, runtimeOf()), false);
  });

  it("没有 remote 读面或它没有挂载口 → undefined", () => {
    assert.equal(createRescueReader({}), undefined);
    assert.equal(createRescueReader({ get: () => null }), undefined);
    assert.equal(createRescueReader({ get: () => ({ $mount: 42 }) }), undefined);
  });

  it("六个读方法只挂一次命名空间，并把参数按位置传下去", async () => {
    const { namespace, calls } = namespaceOf();
    const { reader, mounts } = readerOf(namespace);
    assert.deepEqual(await reader.state(), { sessions: { s1: { status: "running" } } });
    assert.deepEqual(await reader.cancel("s1"), { cancelled: true });
    assert.deepEqual(await reader.toggle("s1"), { disabled: true });
    assert.deepEqual(await reader.resume(), { restored: 1 });
    assert.deepEqual(await reader.retryProviders(), { providers: [] });
    assert.deepEqual(await reader.retryPolicy("p", "normal"), {
      provider: "p",
      preset: "normal",
    });
    assert.equal(mounts.length, 1, "六次调用共用同一次 $mount");
    assert.deepEqual(calls, [
      { method: "state", args: [] },
      { method: "cancel", args: [{ sessionId: "s1" }] },
      { method: "toggle", args: [{ sessionId: "s1" }] },
      { method: "resume", args: [] },
      { method: "retryProviders", args: [] },
      { method: "retryPolicy", args: [{ provider: "p", preset: "normal" }] },
    ]);
  });

  it("命名空间缺席或任一方法不像函数 → 点名读不到的键", async () => {
    const broken: unknown[] = [undefined, null, "not-a-namespace", {}, { state: 42 }];
    const { namespace } = namespaceOf();
    for (const key of Object.keys(namespace)) {
      broken.push({ ...namespace, [key]: 42 });
    }
    const readers = broken.map((candidate) => readerOf(candidate).reader);
    await Promise.all(
      readers.map((reader) => assert.rejects(reader.state(), /remote\.sessionRescue 未提供/u)),
    );
  });

  it("失败结果折成带 code 与 message 的 Error", async () => {
    const { reader } = readerOf({
      ...namespaceOf().namespace,
      state: async () => ({
        ok: false,
        error: { code: "unavailable", message: "gateway down" },
      }),
    });
    await assert.rejects(reader.state(), /unavailable: gateway down/u);
  });

  it("$mount 拒绝 → 原样抛给调用方，且不重试第二次挂载", async () => {
    let attempts = 0;
    const remote = {
      $mount: async (): Promise<unknown> => {
        attempts += 1;
        throw new Error("mount failed");
      },
    };
    const reader = createRescueReader({
      get: (name: string): unknown => (name === "remote" ? remote : undefined),
    });
    assert.ok(reader !== undefined);
    await assert.rejects(reader.state(), /mount failed/u);
    await assert.rejects(reader.resume(), /mount failed/u);
    assert.equal(attempts, 1, "已失败的挂载承诺被复用，不重复撞网关");
  });
});
