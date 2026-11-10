import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { brandString } from "@deepseek-ai/dsh-brand";
import type { MessageId, UserMessage } from "@deepseek-ai/dsh-llm";
import { performHostReask, ReaskSeen } from "../lib/reask-host.ts";
import type { ReaskAgent } from "../lib/reask-host.ts";

function idsOf(): () => MessageId {
  let seq = 0;
  return () => {
    seq += 1;
    return brandString<MessageId>(`test-${String(seq)}`);
  };
}

function agentOf(
  options: {
    cancelThrows?: boolean;
    prependThrows?: boolean;
    followupThrows?: boolean;
    inbox?: boolean;
  } = {},
): {
  agent: ReaskAgent;
  events: string[];
  prepended: UserMessage[];
  removed: MessageId[];
} {
  const events: string[] = [];
  const prepended: UserMessage[] = [];
  const removed: MessageId[] = [];
  const agent: ReaskAgent = {
    cancel: () => {
      events.push("cancel");
      if (options.cancelThrows === true) {
        throw new Error("cancel failed");
      }
    },
    followup: () => {
      events.push("followup");
      if (options.followupThrows === true) {
        throw new Error("wake failed");
      }
    },
    inbox:
      options.inbox === false
        ? null
        : {
            prepend: (_target, message) => {
              events.push("prepend");
              prepended.push(message);
              if (options.prependThrows === true) {
                throw new Error("prepend failed");
              }
            },
            remove: (messageId) => {
              events.push("remove");
              removed.push(messageId);
              return true;
            },
          },
  };
  return { agent, events, prepended, removed };
}

describe("performHostReask：cancel → prepend → 唤醒 → 移除唤醒消息", () => {
  it("正常路径按序执行，重问插在 next-turn 队首", () => {
    const rig = agentOf();
    const result = performHostReask(rig.agent, "换个问法", idsOf());
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(rig.events, ["cancel", "prepend", "followup", "remove"]);
    assert.equal(rig.prepended.at(0)?.content[0]?.type, "text");
    assert.deepEqual(rig.prepended.at(0)?.content, [{ type: "text", text: "换个问法" }]);
    // 唤醒消息是空的，随后被移除；移除的是第二条 id（m-2）。
    assert.deepEqual(rig.removed, ["test-2"]);
  });

  it("cancel 抛错：重问仍插队，半成功返回 cancel-failed", () => {
    const rig = agentOf({ cancelThrows: true });
    assert.deepEqual(performHostReask(rig.agent, "hi", idsOf()), {
      ok: true,
      warning: "cancel-failed",
    });
    assert.deepEqual(rig.events, ["cancel", "prepend", "followup", "remove"]);
  });

  it("inbox 没有写口：不动 cancel，直接报 inbox-unavailable", () => {
    const rig = agentOf({ inbox: false });
    assert.deepEqual(performHostReask(rig.agent, "hi", idsOf()), {
      ok: false,
      error: "inbox-unavailable",
    });
    assert.deepEqual(rig.events, []);
    const bare: ReaskAgent = {
      cancel: () => void 0,
      followup: () => void 0,
      inbox: {},
    };
    assert.deepEqual(performHostReask(bare, "hi", idsOf()), {
      ok: false,
      error: "inbox-unavailable",
    });
  });

  it("prepend 或 followup 抛错：不留下无人唤醒的重问", () => {
    const prepend = agentOf({ prependThrows: true });
    assert.deepEqual(performHostReask(prepend.agent, "hi", idsOf()), {
      ok: false,
      error: "Error: prepend failed",
    });
    assert.deepEqual(prepend.events, ["cancel", "prepend"]);

    const followup = agentOf({ followupThrows: true });
    assert.deepEqual(performHostReask(followup.agent, "hi", idsOf()), {
      ok: false,
      error: "Error: wake failed",
    });
    // 唤醒失败后撤掉刚插入的重问（m-1）。
    assert.deepEqual(followup.events, ["cancel", "prepend", "followup", "remove"]);
    assert.deepEqual(followup.removed, ["test-1"]);
  });
});

describe("reaskSeen：按会话与请求身份有界去重", () => {
  it("记录、查询、遗忘；会话与请求两个上限都裁最旧", () => {
    const seen = new ReaskSeen(1, 1);
    assert.equal(seen.has("s1", "r1"), false);
    seen.add("s1", "r1");
    assert.equal(seen.has("s1", "r1"), true);
    // 会话上限 1：s2 进来把 s1 整表淘汰。
    seen.add("s2", "r2");
    assert.equal(seen.has("s1", "r1"), false);
    assert.equal(seen.has("s2", "r2"), true);
    // 请求上限 1：同一会话里 r3 进来把 r2 淘汰。
    seen.add("s2", "r3");
    assert.equal(seen.has("s2", "r2"), false);
    assert.equal(seen.has("s2", "r3"), true);
    seen.forget("s2");
    assert.equal(seen.has("s2", "r3"), false);
  });

  it("上限为 0 时淘汰路径不炸（空表分支可达）", () => {
    const seen = new ReaskSeen(0, 0);
    seen.add("s1", "r1");
    seen.add("s1", "r2");
    assert.equal(seen.has("s1", "r1"), false);
    assert.equal(seen.has("s1", "r2"), true);
  });
});
