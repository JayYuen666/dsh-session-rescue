// dock-state.test.ts —— dock 区域渲染决策纯函数单测（v8 竞态修复）。
// 覆盖四个竞态场景：首帧快照未就绪 / 会话切换缺状态 / disabled 状态 /
// hasContent 多源合并（实时区块在快照缺失时仍可见）。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { decideDockState } from "../lib/dock-state.ts";
import type { RescueStateBody, RescueSessionState } from "../lib/dock-state.ts";

const view = { running: false };
const sessionId = "s1";

/** 造一个 host 快照（sessions 只含给定会话）。 */
function mkRescue(sessions: Record<string, RescueSessionState> = {}): RescueStateBody {
  return { ok: true, sessions };
}
const session = (overrides: Partial<RescueSessionState> = {}): RescueSessionState => ({
  count: 0,
  lastFireAt: 0,
  pending: null,
  ...overrides,
});
const pending = { turn: 1, kind: "resume", fireAt: Date.now() + 30_000, remainingMs: 30_000 };

describe("decideDockState：快照未就绪（首帧 rescue=null）", () => {
  it('rescueKnown=false、toggle=unknown、不显示开关行（不再默认"开启"）', () => {
    const decision = decideDockState(view, 0, null, sessionId, false);
    assert.equal(decision.rescueKnown, false);
    assert.equal(decision.toggle, "unknown");
    assert.equal(decision.showToggleRow, false);
    assert.equal(decision.hasContent, false);
  });

  it("快照未就绪但实时区块存在（停止重问/排队）→ 区域仍显示内容", () => {
    const decisionStop = decideDockState(view, 0, null, sessionId, true);
    assert.equal(decisionStop.hasContent, true, "停止重问按钮是实时状态，不该被轮询空窗吞掉");
    const decisionQueue = decideDockState(view, 2, null, sessionId, false);
    assert.equal(decisionQueue.hasContent, true, "排队消息是实时状态");
  });
});

describe("decideDockState：会话未在快照中（从未调度续跑/未 toggle 过）", () => {
  it('快照就绪但该会话无记录 → toggle=on（未关闭 = 默认开启，不显示"—"误导）', () => {
    const decision = decideDockState(view, 0, mkRescue({}), sessionId, false);
    assert.equal(decision.rescueKnown, true);
    assert.equal(decision.toggle, "on", "host 快照只含调度/关闭过的会话；未记录即未关闭，默认开启");
    assert.equal(decision.showToggleRow, true, "快照已就绪，开关行可显示");
  });
});

describe("decideDockState：disabled 状态", () => {
  it("disabled=true → toggle=off（已关闭）", () => {
    const decision = decideDockState(
      view,
      0,
      mkRescue({ [sessionId]: session({ disabled: true }) }),
      sessionId,
      false,
    );
    assert.equal(decision.toggle, "off");
  });

  it("disabled=false → toggle=on（开启）", () => {
    const decision = decideDockState(
      view,
      0,
      mkRescue({ [sessionId]: session({ disabled: false }) }),
      sessionId,
      false,
    );
    assert.equal(decision.toggle, "on");
  });
});

describe("decideDockState：pending 与 hasContent 合并", () => {
  it("pending 非空 → 快照就绪 + 区域有内容", () => {
    const decision = decideDockState(
      view,
      0,
      mkRescue({ [sessionId]: session({ pending }) }),
      sessionId,
      false,
    );
    assert.equal(decision.pending, pending);
    assert.equal(decision.hasContent, true);
  });

  it("pending 为 null + 无实时区块 + 无开关行 → 区域无内容（组件仍常驻，仅容器隐藏）", () => {
    const decision = decideDockState(view, 0, null, sessionId, false);
    assert.equal(decision.hasContent, false);
  });
});
