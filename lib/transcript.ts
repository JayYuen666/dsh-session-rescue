/**
 * transcript — 会话转录纯函数（host/client 双端共用的浏览器安全模块）。
 *
 * 输入：一个普通 "view" 对象，由 client 组件从两个已验证的 0.1.2-alpha.1
 * 数据源合并而来（见计划 Global Constraint 10）：
 *   nodes / turnEnds / runningCalls   ← useChat((c) => c.legacy)
 *   running / removed / lastAgentError ← useSession((s) => ...)
 * 本版本 SessionSnapshot 没有 nodes 字段；chat-recovery 0.3.5 因从 useSession
 * 读 nodes 而损坏 —— 禁止复制它的数据源假设。
 *
 * 双模式消费：
 *   Node/测试: 直接 ESM import 本文件。
 *   Web:       build-client.mjs 经 rolldown 把 src/client-entry.ts 与本文件
 *              一起打包进 client.js（无 EXPORT-GUARD 拼接，旧 hack 已废除）。
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
  return text;
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

/** 最后完成轮的终态失败；running 会话永不产生失败。
 *  轮次择优就地完成：判据要的除了轮号还有它自己的 end seq，单列一份「取最大轮号」
 *  的导出只会多出一条只被单测取用的出口（原有 `lastTurnOf` 已按此删除，同一条判据
 *  由本函数的用例钉住）。 */
export function failureOfLastTurn(view: TranscriptView): TurnFailure | null {
  if (view.running) {
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
  const error = turnErrorInTurn(view, turn);
  if (error !== null) {
    return {
      kind: "turn-error",
      turn,
      turnEndSeq: end,
      message: error.message ?? null,
      code: error.code ?? null,
      hasTools: turnHasToolActivity(view, turn),
    };
  }
  if (maxTokensInTurn(view, turn)) {
    return {
      kind: "max-tokens",
      turn,
      turnEndSeq: end,
      message: null,
      code: "turn-max-tokens",
      hasTools: turnHasToolActivity(view, turn),
    };
  }
  if (interruptedAssistantInTurn(view, turn) !== null) {
    return {
      kind: "interrupted",
      turn,
      turnEndSeq: end,
      message: view.lastAgentError,
      code: null,
      hasTools: turnHasToolActivity(view, turn),
    };
  }
  return null;
}
