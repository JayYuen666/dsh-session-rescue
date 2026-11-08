// 客户端读取接口（官方 Typert Remote）的直测：descriptor 与宿主标记对质、边界码器、
// 命名空间缺口的报错内容，以及六个读方法的位置传参。真实卡片链路在 test/client-ui.test.ts。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol";
import type { InvocationDescriptor, TypertCodec } from "@deepseek-ai/dsh-typert-protocol";

import { installSessionRescueRemote, SessionRescueRemoteService } from "../host.ts";
import { createRescueReader, RESCUE_DESCRIPTORS } from "../src/remote.ts";

const PACKAGE_NAME = "@jayyuen66/dsh-session-rescue";
const NAMESPACE = "sessionRescue";
const MOUNT_FAILED = /mount failed/u;
const SERVICE_KEY = `remote.${NAMESPACE}`;

/** 替身只造 createRescueReader / SessionRescueRemoteService 读得到的那几个成员；
 *  返回 unknown 把「形状未全量校验的替身」摆在明处上（never 会假装对任何形参都成立，
 *  宿主 ApplyRuntime 增删字段时这里得不到任何反馈）。调用点显式收窄。 */
function runtimeOf(): unknown {
  return {
    scheduler: { cancel: () => ({ cancelled: true }) },
    disabledSessions: new Set<string>(),
    suspendedSnapshots: { value: [] },
  };
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
  // 读方法不收参（参数在码器层验，调用点全是零参）：不设 args 形参，免得读代码的人
  // 以为 state/resume/retryProviders 能带参。
  const ok =
    (method: string, value: unknown): (() => Promise<unknown>) =>
    async () => {
      calls.push({ method, args: [] });
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
  mounts: unknown[];
} {
  const mounts: unknown[] = [];
  const remote = {
    $mount: async (contribution: unknown): Promise<unknown> => {
      mounts.push(contribution);
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

describe("客户端读取接口（官方 Typert Remote）", () => {
  it("六条 descriptor 与宿主标记逐项对质", () => {
    const service = new SessionRescueRemoteService(new Context(), runtimeOf() as never);
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
    // 两侧空白必须先洗掉再交给宿主：只判空不 trim 时 " s1 " 会带着空白去查表，
    // 宿主回的是「找不到该会话」，看起来像会话没了。
    assert.deepEqual(session.create().parse({ sessionId: " s1 " }), { sessionId: "s1" });
    for (const bad of [null, [], {}, { sessionId: 42 }, { sessionId: "" }, { sessionId: "   " }]) {
      assert.throws(() => session.create().parse(bad), /non-empty string sessionId/u);
    }
    // cancel 与 toggle 的参数同形：按**行为**断言等价，不绑对象同一性——
    // 将来拆成两枚语义等价的码器也是正确实现，绑身份会误报。
    const toggleCodec = strictOf("toggle");
    assert.deepEqual(toggleCodec.create().parse({ sessionId: " t2 " }), { sessionId: "t2" });
    assert.throws(
      () => toggleCodec.create().parse({ sessionId: "" }),
      /non-empty string sessionId/u,
    );

    const policy = strictOf("retryPolicy");
    assert.deepEqual(policy.create().parse({ provider: "p", preset: "normal", extra: true }), {
      provider: "p",
      preset: "normal",
    });
    assert.deepEqual(policy.create().parse({ provider: " p ", preset: " normal " }), {
      provider: "p",
      preset: "normal",
    });
    // custom 档携带码表：声明字段保留、未声明字段仍然丢掉。
    assert.deepEqual(
      policy.create().parse({
        provider: "p",
        preset: "custom",
        retryableCodes: ["PI_AI_ERROR", "MALFORMED_RESPONSE"],
        extra: true,
      }),
      {
        provider: "p",
        preset: "custom",
        retryableCodes: ["PI_AI_ERROR", "MALFORMED_RESPONSE"],
      },
    );
    for (const bad of [
      null,
      {},
      { provider: "p" },
      { provider: 1, preset: "normal" },
      { provider: "p", preset: 2 },
      { provider: "", preset: "normal" },
      { provider: "p", preset: "  " },
      { provider: "p", preset: "custom", retryableCodes: "PI_AI_ERROR" },
      { provider: "p", preset: "custom", retryableCodes: [1] },
    ]) {
      assert.throws(
        () => policy.create().parse(bad),
        /non-empty string provider and preset|policy/u,
      );
    }
  });

  it("宿主上下文没有注册口 → 只少掉读取接口，不抛错", () => {
    assert.equal(installSessionRescueRemote({} as never, runtimeOf() as never), false);
  });

  it("没有 remote 读取接口或它没有挂载口 → undefined", () => {
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
    // $mount 的载荷就是网关注册命名空间的契约：包名写错或描述符传空时，六个读方法
    // 会静默不可用——两枚字段在此点名。
    const contribution = mounts[0] as { package?: unknown; descriptors?: unknown };
    assert.equal(contribution.package, PACKAGE_NAME, "$mount 上报的包名");
    assert.deepEqual(contribution.descriptors, RESCUE_DESCRIPTORS, "$mount 上报的描述符");
    assert.deepEqual(calls, [
      { method: "state", args: [] },
      { method: "cancel", args: [{ sessionId: "s1" }] },
      { method: "toggle", args: [{ sessionId: "s1" }] },
      { method: "resume", args: [] },
      { method: "retryProviders", args: [] },
      { method: "retryPolicy", args: [{ provider: "p", preset: "normal" }] },
    ]);
  });

  it("retryPolicy 携带自定义码表时，码表随请求原样传给宿主", async () => {
    const { namespace, calls } = namespaceOf();
    const { reader } = readerOf(namespace);
    await reader.retryPolicy("p", "custom", ["PI_AI_ERROR", "MALFORMED_RESPONSE"]);
    assert.deepEqual(calls.at(-1), {
      method: "retryPolicy",
      args: [
        {
          provider: "p",
          preset: "custom",
          retryableCodes: ["PI_AI_ERROR", "MALFORMED_RESPONSE"],
        },
      ],
    });
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
      cancel: async () => ({
        ok: false,
        error: { code: "conflict", message: "session gone" },
      }),
    });
    const failure = await reader.state().catch((error: unknown) => error);
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /unavailable: gateway down/u);
    // 结构化字段在 cause 上：要 code 的调用方不必解析文案。
    assert.deepEqual((failure as { cause?: unknown }).cause, {
      code: "unavailable",
      message: "gateway down",
    });
    // 带参方法（cancel）的失败走同一条折算：端点规则一致，重构不得丢掉 cause。
    const cancelFailure = await reader.cancel("s1").catch((error: unknown) => error);
    assert.ok(cancelFailure instanceof Error);
    assert.match(cancelFailure.message, /conflict: session gone/u);
    assert.deepEqual((cancelFailure as { cause?: unknown }).cause, {
      code: "conflict",
      message: "session gone",
    });
  });

  it("$mount 拒绝 → 原样抛给调用方，且失败不进缓存、下次调用重新挂载", async () => {
    let attempts = 0;
    const remote = {
      $mount: async (): Promise<unknown> => {
        attempts += 1;
        throw new Error(MOUNT_FAILED.source);
      },
    };
    const reader = createRescueReader({
      get: (name: string): unknown => (name === "remote" ? remote : undefined),
    });
    assert.ok(reader !== undefined);
    await assert.rejects(reader.state(), /mount failed/u);
    await assert.rejects(reader.resume(), /mount failed/u);
    // 失败一旦被缓存，网关晚一步就绪就会把整张卡钉成永久「读不到」，只能刷新页面重来。
    assert.equal(attempts, 2, "一次失败不该钉死后续所有调用：每次调用重新尝试挂载");
  });

  it("并发等待同一次挂载：清缓存只发生在第一个看到失败的那次", async () => {
    let attempts = 0;
    const remote = {
      $mount: async (): Promise<unknown> => {
        attempts += 1;
        throw new Error(MOUNT_FAILED.source);
      },
    };
    const reader = createRescueReader({
      get: (name: string): unknown => (name === "remote" ? remote : undefined),
    });
    assert.ok(reader !== undefined);
    // 两次调用在同一个 tick 里起跑，`mounted ??=` 让它们共用同一枚在途 Promise：
    // 先跑到 catch 的那次负责清掉，后到的那次看到的是已经清空的 mounted。
    const settled = await Promise.allSettled([reader.state(), reader.resume()]);
    assert.deepEqual(
      settled.map((entry) => entry.status),
      ["rejected", "rejected"],
    );
    assert.equal(attempts, 1, "同一次在途挂载只问网关一遍");
    // 清空必须是有条件的（只清「自己看到失败的那一枚」）：后到的那次若也无条件清一遍，
    // 会把这段时间里别人刚建好的新挂载一并抹掉。用可手动落定的挂载把时序摆出来：
    // 第二个并发调用的失败在**新挂载已在途之后**才落地，此时第三次调用若还要重新挂载
    // （attempts 再涨、报错从「未提供」变「mount failed」）就是无条件清空的回归。
    // 这条判据的射程要说清：两个 catch 挂在同一枚共享 Promise 上，拒绝时两条续体排进
    // 同一个微任务队列，测试代码无从插到它们中间，所以「后到者抹掉新挂载」那一步在这里
    // 不可判别（把守卫改成无条件清，本用例仍绿——实测）。这段真正钉住的是另外两条：
    // 失败不进缓存（下一次调用重新挂载）与兑现过的挂载被复用（attempts 不再涨）。
    const gates: PromiseWithResolvers<unknown>[] = [];
    // 计数与本段绑定：前半段的可复现挂载已经把 attempts 用掉了。
    let deferredAttempts = 0;
    const deferredRemote = {
      $mount: (): Promise<unknown> => {
        deferredAttempts += 1;
        const gate = Promise.withResolvers<unknown>();
        gates.push(gate);
        return gate.promise;
      },
    };
    const deferredReader = createRescueReader({
      get: (name: string): unknown => (name === "remote" ? deferredRemote : undefined),
    });
    assert.ok(deferredReader !== undefined);
    const first = deferredReader.state();
    const second = deferredReader.resume();
    assert.equal(deferredAttempts, 1, "并发两次共用同一枚在途挂载");
    // 共享挂载的两个 catch 在同一轮微任务里先后执行：先到者看到 mounted === 自己那次
    // （清缓存），后到者看到 mounted 已空（实现里的 `mounted === attempt` 判等守卫
    // 让它不再动缓存）。两次失败各 reject 一次，缓存恰好清一遍。
    gates[0]?.reject(new Error(MOUNT_FAILED.source));
    await assert.rejects(first, MOUNT_FAILED);
    await assert.rejects(second, MOUNT_FAILED);
    // 此刻的新调用建出第二枚在途挂载：它不受前一轮失败的影响。
    const third = deferredReader.state();
    assert.equal(deferredAttempts, 2, "失败后的新调用重新挂载");
    // 第二枚挂载正常兑现 → third 走到命名空间读取（本桩没挂命名空间 ⇒「未提供」）；
    // 报错停在命名空间这一跳，而不是退回重新挂载失败。
    gates[1]?.resolve({ ok: true });
    await assert.rejects(third, /未提供/u);
    // 缓存里仍是那枚已兑现的挂载：下一次调用复用它（attempts 不再涨、同样停在命名空间）。
    const fourth = deferredReader.state();
    assert.equal(deferredAttempts, 2, "兑现过的挂载留在缓存里，下一次调用复用");
    await assert.rejects(fourth, /未提供/u);
  });
});
