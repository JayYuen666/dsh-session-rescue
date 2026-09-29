/**
 * turn-scope —— 转录视图的形状 + 「某一轮（turn）范围内有什么节点」的四条读法。
 *
 * 为什么从 lib/transcript.ts 拆出来：这四条读法共同回答的是「这一轮的窗口里有哪些节点」，
 * 消费方是同目录的 transcript.ts——它的公开判据 `failureOfLastTurn` 逐条组合它们。
 * 视图形状跟着读法下来，是因为 transcript.ts 反过来要 import 本模块：形状留在上面那层
 * 就成了两个模块互相引用（依赖环）；它本身仍是 host/client 双端共用的那一份投影。
 * 此前这些读法的 export 只因单测也按这层边界取用，`fallow --production` 因此把它们判成
 * 「只被测试养着的导出」（与 zvec-grep/lib/argv-guard.ts 同一处理）。`turnStartSeq` 只有
 * 一个同文件调用方，故不再 export：窗口边界的判据由 `turnHasToolActivity` 的用例钉住。
 *
 * 浏览器安全：与 lib/transcript.ts 同一纪律——纯函数、无 I/O、无 DOM，build-client.mjs
 * 把本文件与 transcript.ts 一起打进 client.js。
 */

import type {
  ConversationNode,
  RunningToolCall,
} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";

/**
 * 会话转录节点：本包读取的**字段子集投影**，但 `kind` 直接取官方判别键
 *（installed `@deepseek-ai/dsh-client-ui-conversation/lib/types/client/contract/records.d.ts`
 * 里 `ConversationNode` 各变体的 `kind` 字面量联合）。于是 `node.kind === "turn-error"`
 * 这类判定是编译期受检的——旧写法 `kind: string` 让任何拼错的事件名都静默走到「不匹配」，
 * 而本包的重试/续写判定全押在这些串上。
 * 官方节点上多出来的成员本包不读，投影掉是有意的；缺成员（如 `turn?`）由官方交出的
 * 变体保证可得，写错的必选性会在 `useChat` 的赋值方向红。
 */
export interface TranscriptNode {
  kind: ConversationNode["kind"];
  seq: number;
  turn?: number;
  message?: string;
  code?: string;
  content?: readonly ContentBlock[];
  interrupted?: boolean;
  retryState?: string;
}

/**
 * 运行中工具调用：直接用官方类型（`RunningToolCall`，同文件 :248-260，`turn`/`step`/
 * `argsRaw`/`time`/`subCalls` 全是必选）。旧镜像写成 `{ turn?: number; [key: string]:
 * unknown }`——那是自造了一份宿主交不出来的形状（官方 interface 没有隐式索引签名，
 * 赋不进带索引签名的目标），实测 TS2322 就是这条：本包只读 `.turn`，官方版它还更准。
 */
export type RunningCall = RunningToolCall;

/** 合并后的 transcript view（普通对象，可被测试 fixtures 构造）。 */
export interface TranscriptView {
  /** 宿主 `useChat` 交出的是只读冻结视图（`LegacyConversationSlice`），本包全为读取
   *  （`.get` / `.keys` / `.some` / 展开），故形参也声明为只读：可变声明会允许把写
   *  操作漏进宿主状态。 */
  readonly nodes: readonly TranscriptNode[];
  readonly turnEnds: ReadonlyMap<number, number>;
  readonly runningCalls: readonly RunningCall[];
  running: boolean;
  removed: boolean;
  lastAgentError: string | null;
}

/** 给定轮开始前的边界 seq（上一轮 end；第一轮为 0）。
 *  不 export：本模块内只有 `turnHasToolActivity` 读它，窗口判据由那条读法的用例钉住。 */
function turnStartSeq(view: TranscriptView, turn: number): number {
  let start = 0;
  for (const [turnId, end] of view.turnEnds) {
    if (turnId < turn && end > start) {
      start = end;
    }
  }
  return start;
}

/** 该轮是否跑过工具/命令：重跑会重复副作用，自动续跑文案需避免重做。 */
export function turnHasToolActivity(view: TranscriptView, turn: number): boolean {
  const end = view.turnEnds.get(turn) ?? Number.POSITIVE_INFINITY;
  const start = turnStartSeq(view, turn);
  for (const node of view.nodes) {
    if (
      (node.kind === "tool-result" || node.kind === "command") &&
      node.seq > start &&
      node.seq <= end
    ) {
      return true;
    }
  }
  return view.runningCalls.some((call) => call.turn === turn);
}

export function interruptedAssistantInTurn(
  view: TranscriptView,
  turn: number,
): TranscriptNode | null {
  for (const node of view.nodes) {
    if (node.kind === "assistant" && node.turn === turn && node.interrupted === true) {
      return node;
    }
  }
  return null;
}

export function turnErrorInTurn(view: TranscriptView, turn: number): TranscriptNode | null {
  for (const node of view.nodes) {
    if (node.kind === "turn-error" && node.turn === turn) {
      return node;
    }
  }
  return null;
}

export function maxTokensInTurn(view: TranscriptView, turn: number): boolean {
  return view.nodes.some((node) => node.kind === "turn-max-tokens" && node.turn === turn);
}
