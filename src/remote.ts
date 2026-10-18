// src/remote.ts —— 设置卡读/写**宿主侧救援状态**的那一面（官方 Typert Remote 的消费侧）。
//
// 六条 HTTP 端点的方法版：state / cancel / toggle / resume / retryProviders / retryPolicy。
// descriptor 手写、参数走 strict 形状校验，结果走 src-json；宿主侧由源模式按方法签名
// 推参数名。`remote` 是可选读面：没有它时卡片照常渲染，只把数据面显示为读不到。
import type {
  InvocationDescriptor,
  RemoteResult,
  TypertCodec,
} from "@deepseek-ai/dsh-typert-protocol";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

const RESCUE_NAMESPACE = "sessionRescue";
const RESCUE_SERVICE_KEY = `remote.${RESCUE_NAMESPACE}`;
const PACKAGE_NAME = "@jayyuen66/dsh-session-rescue";

const SESSION_CODEC: TypertCodec<{ sessionId: string }> = {
  mode: "strict",
  typeSymbol: `${PACKAGE_NAME}#session-request`,
  create: () => ({
    parse(value: unknown): { sessionId: string } {
      if (!isRecord(value) || typeof value["sessionId"] !== "string") {
        throw new TypeError("session request requires a string sessionId");
      }
      return { sessionId: value["sessionId"] };
    },
  }),
};

const POLICY_CODEC: TypertCodec<{ provider: string; preset: string }> = {
  mode: "strict",
  typeSymbol: `${PACKAGE_NAME}#policy-request`,
  create: () => ({
    parse(value: unknown): { provider: string; preset: string } {
      if (
        !isRecord(value) ||
        typeof value["provider"] !== "string" ||
        typeof value["preset"] !== "string"
      ) {
        throw new TypeError("policy request requires string provider and preset");
      }
      return { provider: value["provider"], preset: value["preset"] };
    },
  }),
};

export const RESCUE_DESCRIPTORS: readonly InvocationDescriptor[] = [
  {
    id: `${PACKAGE_NAME}#${RESCUE_NAMESPACE}/state`,
    service: RESCUE_NAMESPACE,
    namespace: RESCUE_NAMESPACE,
    method: "state",
    invocation: { kind: "direct" },
    parameters: [],
    result: { mode: "src-json" },
  },
  {
    id: `${PACKAGE_NAME}#${RESCUE_NAMESPACE}/cancel`,
    service: RESCUE_NAMESPACE,
    namespace: RESCUE_NAMESPACE,
    method: "cancel",
    invocation: { kind: "direct" },
    parameters: [{ name: "request", wire: "request", source: "json", codec: SESSION_CODEC }],
    result: { mode: "src-json" },
  },
  {
    id: `${PACKAGE_NAME}#${RESCUE_NAMESPACE}/toggle`,
    service: RESCUE_NAMESPACE,
    namespace: RESCUE_NAMESPACE,
    method: "toggle",
    invocation: { kind: "direct" },
    parameters: [{ name: "request", wire: "request", source: "json", codec: SESSION_CODEC }],
    result: { mode: "src-json" },
  },
  {
    id: `${PACKAGE_NAME}#${RESCUE_NAMESPACE}/resume`,
    service: RESCUE_NAMESPACE,
    namespace: RESCUE_NAMESPACE,
    method: "resume",
    invocation: { kind: "direct" },
    parameters: [],
    result: { mode: "src-json" },
  },
  {
    id: `${PACKAGE_NAME}#${RESCUE_NAMESPACE}/retryProviders`,
    service: RESCUE_NAMESPACE,
    namespace: RESCUE_NAMESPACE,
    method: "retryProviders",
    invocation: { kind: "direct" },
    parameters: [],
    result: { mode: "src-json" },
  },
  {
    id: `${PACKAGE_NAME}#${RESCUE_NAMESPACE}/retryPolicy`,
    service: RESCUE_NAMESPACE,
    namespace: RESCUE_NAMESPACE,
    method: "retryPolicy",
    invocation: { kind: "direct" },
    parameters: [{ name: "request", wire: "request", source: "json", codec: POLICY_CODEC }],
    result: { mode: "src-json" },
  },
];

export interface RescueReader {
  state: () => Promise<unknown>;
  cancel: (sessionId: string) => Promise<unknown>;
  toggle: (sessionId: string) => Promise<unknown>;
  resume: () => Promise<unknown>;
  retryProviders: () => Promise<unknown>;
  retryPolicy: (provider: string, preset: string) => Promise<unknown>;
}

interface RemoteHost {
  get?: (name: string, strict?: boolean) => unknown;
}

interface RemoteMounter {
  $mount: (contribution: {
    package: string;
    descriptors: readonly InvocationDescriptor[];
  }) => Promise<unknown>;
}

interface RescueNamespace {
  state: () => Promise<RemoteResult<unknown>>;
  cancel: (request: { sessionId: string }) => Promise<RemoteResult<unknown>>;
  toggle: (request: { sessionId: string }) => Promise<RemoteResult<unknown>>;
  resume: () => Promise<RemoteResult<unknown>>;
  retryProviders: () => Promise<RemoteResult<unknown>>;
  retryPolicy: (request: { provider: string; preset: string }) => Promise<RemoteResult<unknown>>;
}

const isMounter = (value: unknown): value is RemoteMounter =>
  isRecord(value) && typeof value["$mount"] === "function";

const isNamespace = (value: unknown): value is RescueNamespace =>
  isRecord(value) &&
  typeof value["state"] === "function" &&
  typeof value["cancel"] === "function" &&
  typeof value["toggle"] === "function" &&
  typeof value["resume"] === "function" &&
  typeof value["retryProviders"] === "function" &&
  typeof value["retryPolicy"] === "function";

const unwrap = (result: RemoteResult<unknown>): unknown => {
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  return result.value;
};

function buildRescueReader(ctx: RemoteHost, remote: RemoteMounter): RescueReader {
  let mounted: Promise<unknown> | undefined;
  const namespaceOf = async (): Promise<RescueNamespace> => {
    mounted ??= remote.$mount({ package: PACKAGE_NAME, descriptors: RESCUE_DESCRIPTORS });
    await mounted;
    const namespace = ctx.get?.(RESCUE_SERVICE_KEY, false);
    if (!isNamespace(namespace)) {
      throw new Error(`${RESCUE_SERVICE_KEY} 未提供：宿主网关没有挂上这枚命名空间`);
    }
    return namespace;
  };
  return {
    state: async () => {
      const namespace = await namespaceOf();
      return unwrap(await namespace.state());
    },
    cancel: async (sessionId) => {
      const namespace = await namespaceOf();
      return unwrap(await namespace.cancel({ sessionId }));
    },
    toggle: async (sessionId) => {
      const namespace = await namespaceOf();
      return unwrap(await namespace.toggle({ sessionId }));
    },
    resume: async () => {
      const namespace = await namespaceOf();
      return unwrap(await namespace.resume());
    },
    retryProviders: async () => {
      const namespace = await namespaceOf();
      return unwrap(await namespace.retryProviders());
    },
    retryPolicy: async (provider, preset) => {
      const namespace = await namespaceOf();
      return unwrap(await namespace.retryPolicy({ provider, preset }));
    },
  };
}

/** 造读取器；当前部署没有远程面时 undefined（卡片只显示读不到）。 */
export function createRescueReader(ctx: RemoteHost): RescueReader | undefined {
  const remote = ctx.get?.("remote");
  return isMounter(remote) ? buildRescueReader(ctx, remote) : undefined;
}
