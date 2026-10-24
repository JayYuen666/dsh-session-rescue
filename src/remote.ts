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
/** 宿主侧提供 Remote 挂载能力的服务名。常量而非内联字面量：它在 ctx.get 里出现过一次，
 *  而这个文件其余两个宿主要求（RESCUE_NAMESPACE / RESCUE_SERVICE_KEY）都走常量，
 *  三种写法混着会让人以为它们不是同一类东西。 */
const REMOTE_SERVICE = "remote";
const RESCUE_SERVICE_KEY = `${REMOTE_SERVICE}.${RESCUE_NAMESPACE}`;
const PACKAGE_NAME = "@jayyuen66/dsh-session-rescue";

const SESSION_CODEC: TypertCodec<{ sessionId: string }> = {
  mode: "strict",
  typeSymbol: `${PACKAGE_NAME}#session-request`,
  create: () => ({
    parse(value: unknown): { sessionId: string } {
      // 空串要在这里挡掉：宿主侧那几个方法都按 sessionId 查表，空串永远查不到，
      // 返回的却是一条「找不到该会话」的业务失败，读起来像是会话没了而不是入参错了。
      if (
        !isRecord(value) ||
        typeof value["sessionId"] !== "string" ||
        value["sessionId"].trim() === ""
      ) {
        throw new TypeError("session request requires a non-empty string sessionId");
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
        value["provider"].trim() === "" ||
        typeof value["preset"] !== "string" ||
        value["preset"].trim() === ""
      ) {
        throw new TypeError("policy request requires non-empty string provider and preset");
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
    // code 进 message 的**前缀**而不是后半句：调用方靠 `message.startsWith("…")` 或正则
    // 分辨失败类型时，拼在句中的 code 会被正文里的冒号切碎。结构化字段仍留在 error 上
    // （下面那枚 cause），所以想要 code 的调用方不必解析文案。
    throw Object.assign(new Error(`${result.error.code}: ${result.error.message}`), {
      cause: result.error,
    });
  }
  return result.value;
};

function buildRescueReader(ctx: RemoteHost, remote: RemoteMounter): RescueReader {
  let mounted: Promise<unknown> | undefined;
  const namespaceOf = async (): Promise<RescueNamespace> => {
    // 失败不留缓存：`mounted ??=` 只判 undefined，一次 $mount 失败会把那枚已 reject 的
    // Promise 永久留在这里，此后每次读面都立刻以同一个旧错误失败——网关晚一步就绪
    // 也会让整张卡永久「读不到」，只能刷新页面重来。失败时清掉，下一次调用重新尝试。
    mounted ??= remote.$mount({
      package: PACKAGE_NAME,
      descriptors: RESCUE_DESCRIPTORS,
    });
    const attempt = mounted;
    try {
      await attempt;
    } catch (error) {
      if (mounted === attempt) {
        mounted = undefined;
      }
      throw error;
    }
    const namespace = ctx.get?.(RESCUE_SERVICE_KEY, false);
    if (!isNamespace(namespace)) {
      throw new Error(`${RESCUE_SERVICE_KEY} 未提供：宿主网关没有挂上这枚命名空间`);
    }
    return namespace;
  };
  // 六个端点共用的那段「取命名空间 → 调用 → unwrap」：模板只剩一次，新增/删除端点时
  // 不会漏掉其中一步（少 unwrap 会把 {ok:false} 当成功值交给调用方，少 namespaceOf 就
  // 直接调到一个还没挂上的对象）。每个端点的差异只剩「调哪个方法、传什么参数」。
  const invoke = async (
    call: (namespace: RescueNamespace) => Promise<RemoteResult<unknown>>,
  ): Promise<unknown> => {
    const namespace = await namespaceOf();
    return unwrap(await call(namespace));
  };
  return {
    state: async () => invoke((namespace) => namespace.state()),
    cancel: async (sessionId) => invoke((namespace) => namespace.cancel({ sessionId })),
    toggle: async (sessionId) => invoke((namespace) => namespace.toggle({ sessionId })),
    resume: async () => invoke((namespace) => namespace.resume()),
    retryProviders: async () => invoke((namespace) => namespace.retryProviders()),
    retryPolicy: async (provider, preset) =>
      invoke((namespace) => namespace.retryPolicy({ provider, preset })),
  };
}

/** 造读取器；当前部署没有远程面时 undefined（卡片只显示读不到）。 */
export function createRescueReader(ctx: RemoteHost): RescueReader | undefined {
  const remote = ctx.get?.(REMOTE_SERVICE);
  return isMounter(remote) ? buildRescueReader(ctx, remote) : undefined;
}
