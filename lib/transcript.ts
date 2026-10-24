/**
 * transcript — 会话转录纯函数（host/client 双端共用的浏览器安全模块）。
 *
 * 输入：一个普通 "view" 对象，由 client 组件从两个已验证的数据源合并而来：
 *   nodes / turnEnds / runningCalls   ← useChat((c) => c.legacy)
 *   running / removed / lastAgentError ← useSession((s) => ...)
 * installed 的 `SessionSnapshot`（dsh-api-session-controller 的
 * client/contract/snapshot.d.ts:58）没有 nodes 字段；chat-recovery 因从 useSession
 * 读 nodes 而损坏 —— 禁止复制它的数据源假设。
 *
 * 双模式消费：
 *   Node/测试: 直接 ESM import 本文件。
 *   Web:       build-client.mjs 经 rolldown 把 src/client-entry.ts 与本文件
 *              一起打包进 client.js（无 EXPORT-GUARD 拼接）。
 * 因此本文件必须是 Node 与浏览器都能安全求值的纯函数模块（无 I/O、无 DOM）。
 *
 * 「某一轮范围内有什么」那层读法（连同视图形状）在 lib/turn-scope.ts：本文件的
 * `failureOfLastTurn` 组合它们，形状必须待在那一层才不构成两个模块互相引用。
 */

import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import {
  interruptedAssistantInTurn,
  maxTokensInTurn,
  turnErrorInTurn,
  turnHasToolActivity,
} from "./turn-scope.ts";
import type { TranscriptNode, TranscriptView } from "./turn-scope.ts";

/** 用户消息内容块：直接取官方 `ContentBlock` 判别联合（`ContentBlockMap` 的并集）。
 *  dsh-client-ui-conversation 的 records 也从 `@deepseek-ai/dsh-llm/types` 取同一个
 *  类型，两侧真值同源——本地再把 `type` 写成裸 `string` 就等于自造宿主不认的第二套
 *  块词汇，非 text 块在类型面上不再可辨。 */
export type { ContentBlock } from "@deepseek-ai/dsh-llm";

/** 编辑重发目标：最后一条已完成轮的用户消息。 */
export interface CompletedUserTarget {
  text: string;
  seq: number;
  turn: number;
  turnEndSeq: number;
  forkAtSeq: number | null;
}

/** 最后完成轮的终态失败信息。 */
export interface TurnFailure {
  kind: "turn-error" | "max-tokens" | "interrupted";
  turn: number;
  turnEndSeq: number;
  message: string | null;
  code: string | null;
  hasTools: boolean;
}

export function userText(content: readonly ContentBlock[] | undefined): string | null {
  if (!content || content.length === 0) {
    return null;
  }
  let text = "";
  for (const block of content) {
    // 官方联合按 type 收窄：非 text 块（图片/文件/工具块）不可安全重发 → 整条拒绝。
    // text 位仍留运行时守卫：view 由 client 从宿主数据合并而来，类型是文档不是保证。
    if (block.type !== "text" || typeof block.text !== "string") {
      return null;
    }
    text += block.text;
  }
  // 拼完仍是空白：整条没有可重发的内容。返回空串会让调用方拿到「有文本」的假信号，
  // 把一条什么都没有的消息原样发回去，或拿它去比对历史。与「没有文本块」同解。
  return text.trim() === "" ? null : text;
}

export function lastUserNode(view: TranscriptView): TranscriptNode | null {
  let last: TranscriptNode | null = null;
  for (const node of view.nodes) {
    if (node.kind === "user") {
      last = node;
    }
  }
  return last;
}

/** 编辑重发目标：最后一条用户消息，要求会话非 running/removed 且该轮已结束。
 *  steering/context/system 节点永不参与。 */
export function lastCompletedUserTarget(view: TranscriptView): CompletedUserTarget | null {
  if (view.running || view.removed) {
    return null;
  }
  const last = lastUserNode(view);
  if (last === null) {
    return null;
  }
  let turn = -1;
  let turnEndSeq = -1;
  for (const [turnId, end] of view.turnEnds) {
    if (end > last.seq && (turn === -1 || turnId < turn)) {
      turn = turnId;
      turnEndSeq = end;
    }
  }
  if (turn === -1) {
    return null;
  }
  const text = userText(last.content);
  if (text === null) {
    return null;
  }
  let forkAtSeq: number | null = null;
  for (const [, end] of view.turnEnds) {
    if (end < last.seq && (forkAtSeq === null || end > forkAtSeq)) {
      forkAtSeq = end;
    }
  }
  return { text, seq: last.seq, turn, turnEndSeq, forkAtSeq };
}

/** host 内置重试（llm/retry）是否仍持有该轮：scheduled/started 期间客户端必须避让。 */
export function hostRetryPending(view: TranscriptView, turn: number): boolean {
  return view.nodes.some(
    (node) =>
      node.kind === "model-retry" &&
      node.turn === turn &&
      (node.retryState === "scheduled" || node.retryState === "started"),
  );
}

/** 该轮的失败类别与它独有的两个字段；不构成失败时返回 null。 */
function classifyFailureOfTurn(
  view: TranscriptView,
  turn: number,
): Pick<TurnFailure, "kind" | "message" | "code"> | null {
  const error = turnErrorInTurn(view, turn);
  if (error !== null) {
    return { kind: "turn-error", message: error.message ?? null, code: error.code ?? null };
  }
  if (maxTokensInTurn(view, turn)) {
    return { kind: "max-tokens", message: null, code: "turn-max-tokens" };
  }
  if (interruptedAssistantInTurn(view, turn) !== null) {
    return { kind: "interrupted", message: view.lastAgentError, code: null };
  }
  return null;
}
/** 最后完成轮的终态失败；running 与 removed 会话永不产生失败。
 *  轮次择优就地完成：判据要的除了轮号还有它自己的 end seq，单列一份「取最大轮号」
 *  的导出只会多出一条只被单测取用的出口（同一条判据由本函数的用例钉住）。
 *
 *  removed 与 running 同判：会话已被移除时它的日志只是历史残留，dock 上任何「重发/继续」
 *  动作都会打到一个不存在的会话上。`lastCompletedUserTarget` 一直是这样挡的，两条判据
 *  出自同一个 view、喂给同一排按钮，挡的边界不一致时会出现「编辑入口关着、重试入口开着」。 */
export function failureOfLastTurn(view: TranscriptView): TurnFailure | null {
  if (view.running || view.removed) {
    return null;
  }
  let turn = -1;
  let end = 0;
  for (const [turnId, endId] of view.turnEnds) {
    if (turnId > turn) {
      turn = turnId;
      end = endId;
    }
  }
  if (turn === -1) {
    return null;
  }
  // 先定「是不是失败、是哪一类」，再一次性填充公共字段：三个分支原本各自复制一份
  // {turn, turnEndSeq, hasTools} 并各调一次 turnHasToolActivity，加字段时要改三处、
  // 而 hasTools 对同一个 turn 也白扫三遍（它与失败类别无关，只取决于该轮有没有工具活动）。
  const head: Pick<TurnFailure, "kind" | "message" | "code"> | null = classifyFailureOfTurn(
    view,
    turn,
  );
  if (head === null) {
    return null;
  }
  return {
    ...head,
    turn,
    turnEndSeq: end,
    hasTools: turnHasToolActivity(view, turn),
  };
}
