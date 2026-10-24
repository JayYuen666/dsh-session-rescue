import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  failureOfLastTurn,
  hostRetryPending,
  lastCompletedUserTarget,
  lastUserNode,
  userText,
} from "../lib/transcript.ts";
import type { ContentBlock } from "../lib/transcript.ts";
// 轮内读法与视图形状在 lib/turn-scope.ts（transcript.ts 的 failureOfLastTurn 从这层读法往上组合）。
import {
  interruptedAssistantInTurn,
  maxTokensInTurn,
  turnErrorInTurn,
  turnHasToolActivity,
} from "../lib/turn-scope.ts";
import type { TranscriptNode, TranscriptView } from "../lib/turn-scope.ts";
// 官方 `ToolCallHead.args`（installed dsh-client-ui-conversation 的
// client/contract/records.d.ts:270）是必选位，类型 `ToolArgs` = `PartialArguments`——一个带
// private 字段的**类**，造不出字面量，只能走静态工厂（测试期依赖，生产面不引）。
import { PartialArguments } from "@deepseek-ai/dsh-util-values";

/** 投影里「本回合带模型错误」的节点 kind：fixture 与断言共用同一个字形。 */
const TURN_ERROR_KIND = "turn-error";

// ---- fixture helpers（形状出处：dsh-client-ui-conversation records.d.ts）----
function mkView(overrides: Partial<TranscriptView> = {}): TranscriptView {
  return {
    nodes: [],
    turnEnds: new Map(),
    runningCalls: [],
    running: false,
    removed: false,
    lastAgentError: null,
    ...overrides,
  };
}
const asNode = (node: unknown): TranscriptNode => node as TranscriptNode;
const user = (seq: number, text: string): TranscriptNode =>
  asNode({ kind: "user", seq, time: 0, content: [{ type: "text", text }], source: {} });
const userWithImage = (seq: number): TranscriptNode =>
  asNode({
    kind: "user",
    seq,
    time: 0,
    content: [
      { type: "text", text: "look" },
      { type: "image", attachment: {} },
    ],
    source: {},
  });
const assistant = (
  seq: number,
  turn: number,
  extra: Record<string, unknown> = {},
): TranscriptNode =>
  asNode({ kind: "assistant", seq, time: 0, turn, step: 0, blocks: [], ...extra });
const turnError = (seq: number, turn: number, message: string, code?: string): TranscriptNode =>
  asNode({
    kind: TURN_ERROR_KIND,
    seq,
    time: 0,
    turn,
    step: 0,
    message,
    ...(code === undefined ? {} : { code }),
  });
const maxTokens = (seq: number, turn: number): TranscriptNode =>
  asNode({ kind: "turn-max-tokens", seq, time: 0, turn, step: 0 });
const modelRetry = (seq: number, turn: number, retryState: string): TranscriptNode =>
  asNode({
    kind: "model-retry",
    seq,
    time: 0,
    turn,
    step: 0,
    retryId: "r1",
    provider: "p",
    mode: "normal",
    retryState,
  });
const toolResult = (seq: number): TranscriptNode =>
  asNode({ kind: "tool-result", seq, time: 0, callId: "c1", call: null });
const command = (seq: number): TranscriptNode => asNode({ kind: "command", seq, time: 0 });

describe("userText", () => {
  it("拼接全部 text 块", () => {
    assert.equal(
      userText([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
      "ab",
    );
  });

  it("空 content → null", () => {
    assert.equal(userText([]), null);
  });

  it("缺 content → null", () => {
    assert.equal(userText(undefined), null);
  });

  it("含非 text 块 → null（图片/推理等不可安全重发）", () => {
    // 块取官方 ContentBlock 的合法成员（原夹具 {type:"image"} 缺 attachment，
    // 不是宿主真会送来的形状；reasoning 块同样落在 text 分支之外）。
    assert.equal(
      userText([
        { type: "text", text: "a" },
        { type: "reasoning", text: "r" },
      ]),
      null,
    );
  });

  it("text 非字符串 → null", () => {
    assert.equal(userText([{ type: "text", text: 42 } as unknown as ContentBlock]), null);
  });

  it("全是空白 → null（拼出来没有可重发的内容）", () => {
    // 空串与非空空白同解：返回它们等于告诉调用方「这条消息有正文」，
    // 于是会原样发回一条什么都没有的消息。
    assert.equal(userText([{ type: "text", text: "" }]), null);
    assert.equal(
      userText([
        { type: "text", text: "  " },
        { type: "text", text: "\n\t" },
      ]),
      null,
    );
  });
});

describe("lastCompletedUserTarget（编辑重发目标）", () => {
  it("running → null", () => {
    const view = mkView({ running: true, nodes: [user(1, "hi")], turnEnds: new Map([[1, 5]]) });
    assert.equal(lastCompletedUserTarget(view), null);
  });

  it("removed → null", () => {
    const view = mkView({ removed: true, nodes: [user(1, "hi")], turnEnds: new Map([[1, 5]]) });
    assert.equal(lastCompletedUserTarget(view), null);
  });

  it("无用户消息 → null", () => {
    const view = mkView({ turnEnds: new Map([[1, 5]]) });
    assert.equal(lastCompletedUserTarget(view), null);
  });

  it("用户消息所在轮未结束 → null", () => {
    const view = mkView({ nodes: [user(1, "hi")], turnEnds: new Map() });
    assert.equal(lastCompletedUserTarget(view), null);
  });

  it("第二轮消息：turn/turnEndSeq/forkAtSeq 正确", () => {
    const view = mkView({
      nodes: [user(1, "first"), assistant(3, 1), user(7, "second"), assistant(9, 2)],
      turnEnds: new Map([
        [1, 5],
        [2, 12],
      ]),
    });
    assert.deepEqual(lastCompletedUserTarget(view), {
      text: "second",
      seq: 7,
      turn: 2,
      turnEndSeq: 12,
      forkAtSeq: 5,
    });
  });

  it("第一轮消息：forkAtSeq 为 null（禁用 fork 的依据）", () => {
    const view = mkView({ nodes: [user(2, "first")], turnEnds: new Map([[1, 9]]) });
    assert.deepEqual(lastCompletedUserTarget(view), {
      text: "first",
      seq: 2,
      turn: 1,
      turnEndSeq: 9,
      forkAtSeq: null,
    });
  });

  it("图片消息不可编辑 → null", () => {
    const view = mkView({ nodes: [userWithImage(2)], turnEnds: new Map([[1, 9]]) });
    assert.equal(lastCompletedUserTarget(view), null);
  });
});

describe("本轮 seq 窗口（边界判据经唯一读者 turnHasToolActivity 钉住）", () => {
  // 窗口 = (上一轮 end, 本轮 end]。turnStartSeq 在本包只有一个同文件调用方，已不导出，
  // 两侧边界改用一条 tool-result 的命中/不命中来钉——比直接读那个数更能挡住"窗口算错"。
  const turnEnds = new Map([
    [1, 5],
    [2, 12],
  ]);

  it("第一轮下界是 0：seq 1 落在 turn 1 的窗口内", () => {
    const view = mkView({ nodes: [toolResult(1)], turnEnds });
    assert.equal(turnHasToolActivity(view, 1), true);
  });

  it("turnEnds 倒挂（start >= end）时窗口无可信边界，一律判「没跑过工具」", () => {
    // 乱序条目下窗口为空或倒挂：这时按 start < seq <= end 取会取到空集，
    // 但更糟的是把「上一轮的 end」当本轮的 start 用，会让后续轮的节点混进来。
    const inverted = new Map([
      [1, 5],
      [2, 3],
    ]);
    const view = mkView({ nodes: [toolResult(4)], turnEnds: inverted });
    assert.equal(turnHasToolActivity(view, 2), false);
  });

  it("后续轮下界是上一轮 end：seq 5 出界、seq 6 入界", () => {
    const atBoundary = mkView({ nodes: [toolResult(5)], turnEnds });
    const inside = mkView({ nodes: [toolResult(6)], turnEnds });
    assert.equal(turnHasToolActivity(atBoundary, 2), false);
    assert.equal(turnHasToolActivity(inside, 2), true);
  });
});

describe("轮内失败节点识别", () => {
  it("turnErrorInTurn", () => {
    const view = mkView({ nodes: [turnError(12, 2, "boom", "SERVER")] });
    assert.equal(turnErrorInTurn(view, 2)?.message, "boom");
    assert.equal(turnErrorInTurn(view, 1), null);
  });

  it("maxTokensInTurn", () => {
    const view = mkView({ nodes: [maxTokens(12, 2)] });
    assert.equal(maxTokensInTurn(view, 2), true);
    assert.equal(maxTokensInTurn(view, 1), false);
  });

  it("hostRetryPending：scheduled/started 命中，cancelled 不命中", () => {
    const pendingScheduled = mkView({ nodes: [modelRetry(11, 2, "scheduled")] });
    const pendingStarted = mkView({ nodes: [modelRetry(11, 2, "started")] });
    const pendingCancelled = mkView({ nodes: [modelRetry(11, 2, "cancelled")] });
    assert.equal(hostRetryPending(pendingScheduled, 2), true);
    assert.equal(hostRetryPending(pendingStarted, 2), true);
    assert.equal(hostRetryPending(pendingCancelled, 2), false);
  });

  it("interruptedAssistantInTurn", () => {
    const view = mkView({ nodes: [assistant(9, 2, { interrupted: true })] });
    const plainView = mkView({ nodes: [assistant(9, 2)] });
    assert.equal(interruptedAssistantInTurn(view, 2)?.seq, 9);
    assert.equal(interruptedAssistantInTurn(plainView, 2), null);
  });

  it("turnHasToolActivity：窗口内 tool-result/command 或运行中调用", () => {
    const v1 = mkView({
      nodes: [toolResult(8)],
      turnEnds: new Map([
        [1, 5],
        [2, 12],
      ]),
    });
    assert.equal(turnHasToolActivity(v1, 2), true);
    assert.equal(turnHasToolActivity(v1, 1), false);
    // seq 8 不在 (0,5] 窗口
    const v2 = mkView({ nodes: [command(3)], turnEnds: new Map([[1, 5]]) });
    assert.equal(turnHasToolActivity(v2, 1), true);
    // 官方 `RunningToolCall` 的必选成员齐备：time/subCalls/args 都不能少，argsRaw 只在这一支。
    // 该类型是 `PreparingToolCall | StartedToolCall`，判别字段 `phase` 必选
    //（带 argsRaw 的这一支是 'start'）；`args` 的类型是官方 `PartialArguments` 这个类，
    // 所以走静态工厂而不是字面量。
    // 官方件再改形状，这条夹具就会红——那正是它该做的：生产面是原样透传 legacy.runningCalls，
    // 不构造这些对象（透传处见 src/client-entry.ts）。
    const v3 = mkView({
      runningCalls: [
        {
          callId: "c",
          name: "bash",
          phase: "start",
          argsRaw: "{}",
          args: PartialArguments.fromText("{}"),
          turn: 4,
          step: 0,
          time: 0,
          subCalls: [],
        },
      ],
    });
    assert.equal(turnHasToolActivity(v3, 4), true);
  });

  it("turnHasToolActivity：同轮号之后的活动不因上界缺失被算进窗口", () => {
    // turnEnds 里没有该轮（窗口上界无界）时，退化成「start 之后全是本轮的」会把
    // 后续轮次的活动全算进来，`hasTools` 于是把「没跑过工具的一轮」报成跑过，
    // 续跑文案会去叮嘱「别重复副作用」——而那一轮其实什么都没跑。
    const view = mkView({
      nodes: [command(3), command(40)],
      turnEnds: new Map([[1, 5]]),
    });
    // 轮 2 既没有 turn/end，也没有运行中调用：窗口不可信，不当工具活动。
    assert.equal(turnHasToolActivity(view, 2), false);
  });
});

describe("failureOfLastTurn", () => {
  it("running → null", () => {
    const view = mkView({ running: true, turnEnds: new Map([[1, 5]]) });
    assert.equal(failureOfLastTurn(view), null);
  });

  it("removed → null（与 lastCompletedUserTarget 同判：两条判据喂同一排按钮）", () => {
    // 会话已移除时日志只是残留，任何「重发/继续」都会打到一个不存在的会话上。
    // 挡的边界若与 lastCompletedUserTarget 不一致，就会出现「编辑入口关着、重试入口开着」。
    const view = mkView({
      removed: true,
      nodes: [user(1, "a"), turnError(5, 1, "boom")],
      turnEnds: new Map([[1, 5]]),
    });
    assert.equal(failureOfLastTurn(view), null);
    assert.equal(lastCompletedUserTarget(view), null, "两条判据在这里必须同判");
  });

  it("无轮 → null", () => {
    assert.equal(failureOfLastTurn(mkView()), null);
  });

  it("干净的最后一轮 → null", () => {
    const view = mkView({ nodes: [user(1, "a"), assistant(3, 1)], turnEnds: new Map([[1, 5]]) });
    assert.equal(failureOfLastTurn(view), null);
  });

  it("turn-error：kind/code/message/hasTools", () => {
    const view = mkView({
      nodes: [user(1, "a"), toolResult(3), turnError(5, 1, "HTTP 429", "QUOTA")],
      turnEnds: new Map([[1, 5]]),
    });
    assert.deepEqual(failureOfLastTurn(view), {
      kind: TURN_ERROR_KIND,
      turn: 1,
      turnEndSeq: 5,
      message: "HTTP 429",
      code: "QUOTA",
      hasTools: true,
    });
  });

  it("max-tokens：code 固定 turn-max-tokens", () => {
    const view = mkView({ nodes: [user(1, "a"), maxTokens(5, 1)], turnEnds: new Map([[1, 5]]) });
    const failure = failureOfLastTurn(view);
    // 首条 `failure?.kind` 走 node:assert 的 `asserts actual is T`：断言成立即证明
    // failure 非 null，之后的 `?.` 就是冗余守卫（属性名不变、断言强度不变）。
    assert.equal(failure?.kind, "max-tokens");
    assert.equal(failure.code, "turn-max-tokens");
    assert.equal(failure.message, null);
    assert.equal(failure.hasTools, false);
  });

  it("interrupted：message 取 lastAgentError", () => {
    const view = mkView({
      nodes: [user(1, "a"), assistant(3, 1, { interrupted: true })],
      turnEnds: new Map([[1, 5]]),
      lastAgentError: "crashed",
    });
    const failure = failureOfLastTurn(view);
    assert.equal(failure?.kind, "interrupted");
    assert.equal(failure.message, "crashed");
    assert.equal(failure.code, null);
  });

  it("只看最后一轮（更早轮的失败不报）", () => {
    const view = mkView({
      nodes: [turnError(5, 1, "old", "SERVER"), user(7, "b"), assistant(9, 2)],
      turnEnds: new Map([
        [1, 5],
        [2, 12],
      ]),
    });
    assert.equal(failureOfLastTurn(view), null);
  });

  it("优先级 turn-error > max-tokens > interrupted", () => {
    const view = mkView({
      nodes: [maxTokens(4, 1), turnError(5, 1, "boom", "SERVER")],
      turnEnds: new Map([[1, 5]]),
    });
    assert.equal(failureOfLastTurn(view)?.kind, TURN_ERROR_KIND);
  });
});

describe("failureOfLastTurn 的轮次择优 / lastUserNode", () => {
  it("取最大轮号那一条轮，并带出它自己的 end seq；无轮则无失败", () => {
    const view = mkView({
      nodes: [turnError(9, 3, "boom", "SERVER")],
      turnEnds: new Map([
        [1, 5],
        [3, 9],
      ]),
    });
    assert.equal(failureOfLastTurn(view)?.turn, 3, "3 是最大轮号");
    assert.equal(failureOfLastTurn(view)?.turnEndSeq, 9);
    assert.equal(failureOfLastTurn(mkView()), null, "无轮 → null");
  });

  it("lastUserNode 不受轮完成状态影响（停止重问用）", () => {
    const view = mkView({ nodes: [user(1, "a"), user(7, "b")] });
    assert.equal(lastUserNode(view)?.seq, 7);
    assert.equal(lastUserNode(mkView()), null);
  });
});

describe("轮表非升序遍历（Map 插入序 ≠ turnId 序）的择优分支", () => {
  // 三处择优（lastCompletedUserTarget 的两处、failureOfLastTurn 的取最大轮号）都要在
  // "后面的键更小"时才走到 `turnId < turn` / `end > forkAtSeq` / `turnId > turn`
  // 的否定侧——只测升序 Map 等于漏测一半。
  it("lastCompletedUserTarget：取「结束最靠后但轮号最小」的候选轮", () => {
    const view = mkView({
      nodes: [user(10, "hi")],
      turnEnds: new Map([
        [5, 50],
        [3, 30],
      ]),
    });
    const target = lastCompletedUserTarget(view);
    assert.equal(target?.turn, 3, "更小的轮号胜出");
    assert.equal(target.turnEndSeq, 30);
  });

  it("lastCompletedUserTarget：升序轮表下后来的更大轮号不覆盖已选", () => {
    const view = mkView({
      nodes: [user(10, "hi")],
      turnEnds: new Map([
        [3, 30],
        [5, 50],
      ]),
    });
    assert.equal(lastCompletedUserTarget(view)?.turn, 3);
  });

  it("lastCompletedUserTarget：fork 边界取最后一个早于该消息的轮尾", () => {
    const view = mkView({
      nodes: [user(10, "hi")],
      turnEnds: new Map([
        [1, 5],
        [2, 8],
        [4, 20],
        [3, 6],
      ]),
    });
    const target = lastCompletedUserTarget(view);
    assert.equal(target?.turn, 4);
    assert.equal(target.forkAtSeq, 8, "6 晚于 8 之前的最大值不覆盖");
  });

  it("failureOfLastTurn：非升序轮表按 turnId 取最大轮", () => {
    const view = mkView({
      nodes: [turnError(21, 2, "boom", "RATE_LIMIT")],
      turnEnds: new Map([
        [2, 20],
        [1, 10],
      ]),
    });
    const failure = failureOfLastTurn(view);
    assert.equal(failure?.turn, 2);
    assert.equal(failure.message, "boom");
    assert.equal(failure.code, "RATE_LIMIT");
  });

  it("failureOfLastTurn：turn-error 缺 message/code → 双双归 null", () => {
    const bare = asNode({ kind: TURN_ERROR_KIND, seq: 21, time: 0, turn: 1, step: 0 });
    const view = mkView({ nodes: [bare], turnEnds: new Map([[1, 20]]) });
    const failure = failureOfLastTurn(view);
    assert.equal(failure?.message, null);
    assert.equal(failure.code, null);
  });
});
