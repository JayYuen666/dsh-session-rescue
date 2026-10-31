// 调度器的模型化属性测试：随机指令序列驱动的**状态机不变量**。
//
// 为什么这一层值得单独存在：调度器是纯状态机，但它的每条规则都只在**序列**里才成立
// （冷却看的是上一次 fire 的时刻、配额看的是本 kind 的累计、淘汰看的是「这条记录空闲吗」、
// 定时器泄漏看的是 attach/cancel/settle/suspend/dispose 的配对）。单测按「一条规则一个用例」
// 写，天然测不到「规则 A 与规则 B 交错时谁赢」——那正是长跑 daemon 里真正会坏的地方。
//
// 断言的是不变量而不是逐步等式：模型只维护「外部可观测的状态」（快照 + 我持有的 disposer
// 计数），不重算每一条决策的 reason——把实现照抄一遍的模型只会永远通过。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import fc from "fast-check";
import { ResumeScheduler } from "../../lib/resume-scheduler.ts";
import type {
  FailureDecision,
  PendingRecord,
  RescueKind,
  SessionSnapshot,
} from "../../lib/resume-scheduler.ts";

/** 与实现同一道闸门的会话数上限（这里当作**判据**用：越满越要证明空闲判定没错）。 */
const MAX_SESSIONS = 200;
const KINDS: RescueKind[] = ["resume", "continue", "unfinished"];
/** 单个 kind 在任何指令里被给到的最大配额（不变量用它判「计数不得越界」）。 */
const MAX_QUOTA_SEEN = 4;
/** 指令流里出现的会话数：刻意越过上限，逼出淘汰路径。 */
const SESSION_COUNT = MAX_SESSIONS + 60;

/** 时钟模型：只前进，冷却与 fireAt 都按它算。 */
interface Model {
  now: number;
  /** 每个 kind 的最近一次 fire 时刻（0 = 从没 fire 过）。 */
  lastFireAt: Map<string, Record<RescueKind, number>>;
  /** 每个 kind 的累计次数。 */
  counts: Map<string, Record<RescueKind, number>>;
  /** 每个 kind 由 restore 补发后新增的次数：restorePending 不校验配额，上界要把它加回来。 */
  restored: Map<string, Record<RescueKind, number>>;
  /** 当前待办（按会话）。 */
  pending: Map<string, PendingRecord>;
  /** 已处理过的最大回合号。 */
  handled: Map<string, number>;
}

interface TimerDisposerBox {
  calls: number;
}

/** 一次跑批里我持有的定时器记账。 */
interface Attachments {
  /** 会话 → 当前挂着且尚未释放的 disposer 调用次数盒。 */
  live: Map<string, TimerDisposerBox>;
  /** 累计被创建 / 被调用的 disposer 数（判「放大了没有」）。 */
  created: number;
  disposed: number;
}

/** 一条指令。 */
type Cmd =
  | {
      op: "failure";
      session: number;
      kind: RescueKind;
      turn: number;
      delayMs: number;
      cooldownMs: number;
      maxResumes: number;
      chainDelayMs: number;
    }
  | { op: "attach"; session: number }
  | { op: "settle"; session: number; outcome: "fired" | "skipped" }
  | { op: "cancel"; session: number }
  | { op: "success"; session: number }
  | { op: "todosClosed"; session: number }
  | { op: "noteTurn"; session: number; turn: number }
  | { op: "suspend"; session: number }
  | { op: "restore"; session: number }
  | { op: "release"; session: number }
  | { op: "tick"; ms: number };

/** 一批指令里真实走过的路径计数：不变量只在特定形态下才有内容，这里负责证明那些
 *  形态确实出现过（否则「越界时不许淘汰忙记录」会退化成一句永真话）。 */
interface Stats {
  /** 表满且全忙时新会话被拒（capacity）的次数：硬上限判据确实被走到过。 */
  capacitySkips: number;
  /** 观测到的记录淘汰次数（淘汰判据的前提）。 */
  evictions: number;
}

/** 跑批现场：调度器 + 模型 + 四类记账。 */
interface Run {
  scheduler: ResumeScheduler;
  model: Model;
  live: Attachments;
  /** 本序列里被挂起、等 restore 的快照（按会话）。 */
  suspended: Map<string, PendingRecord>;
  /** 会话 → 模型侧的 suspended 位。 */
  suspendedFlag: Map<string, boolean>;
  stats: Stats;
  /** 上一步快照的会话键集合：键消失 = 发生了一次淘汰。 */
  prevKeys: Set<string>;
}

/** restore 无挂起快照那一支用的占位待办。 */
function dummyPending(): PendingRecord {
  return { turn: 1, kind: "resume", fireAt: 0, announcedAt: 0 };
}

function zeroCounts(): Record<RescueKind, number> {
  return { resume: 0, continue: 0, unfinished: 0 };
}

function sessionKey(id: number): string {
  return `s${String(id)}`;
}

/** 建一次跑批：调度器的时钟闭包取的是模型上的活值，故在一次装配里接到位。 */
function makeRun(stats: Stats): Run {
  const model: Model = {
    now: 1_000_000,
    lastFireAt: new Map(),
    counts: new Map(),
    restored: new Map(),
    pending: new Map(),
    handled: new Map(),
  };
  return {
    scheduler: new ResumeScheduler({ now: () => model.now }),
    model,
    live: { live: new Map(), created: 0, disposed: 0 },
    suspended: new Map(),
    suspendedFlag: new Map(),
    stats,
    prevKeys: new Set(),
  };
}

/** 记录数有界：**除非**这一步真新建了一条记录、而当时没有可淘汰的对象。上限是
 *  「新建前腾位」的容量，不是硬天花板：表满且全忙时只能越界；已经越界之后腾出的空闲位
 *  也不回填压缩（没有新建就没有腾位的时机），所以这一支只在发生新建的那一步判，
 *  且刚插上的那条本身除外（`rec()` 先建后填，它此刻必然还空闲）。
 *  带待办的会话绝不能被淘汰：被丢掉后 `restorePending()` 会重建一枚 counts 全 0
 *  的新记录，等于把 maxResumes 这道防失控闸门静默复位。 */
function checkEviction(run: Run, snapshot: Record<string, SessionSnapshot>): void {
  for (const key of run.model.pending.keys()) {
    assert.ok(Object.hasOwn(snapshot, key), `带待办的会话 ${key} 被淘汰了`);
  }
}

/** 配额上限、待办与模型双向一致、快照字段可用、计数不被静默清零。 */
function checkEntry(run: Run, key: string, entry: SessionSnapshot): void {
  const { pending } = entry;
  if (pending === null) {
    // 模型说有、实现说没有 ⇒ 只能是被淘汰（在位性判据已挡）或漏了一次状态转移。
    assert.equal(
      run.model.pending.has(key),
      false,
      `${key}：模型仍有 pending 而实现已清空（漏了一次状态转移）`,
    );
  } else {
    // remainingMs 永远非负（客户端拿它做倒计时，负数会渲染成「-3s」）。
    assert.ok(pending.remainingMs >= 0, "remainingMs 不得为负");
    assert.ok(
      Number.isSafeInteger(pending.turn),
      `待办轮次号必须是安全整数，读到 ${String(pending.turn)}`,
    );
    assert.ok(KINDS.includes(pending.kind), `待办 kind 越界：${pending.kind}`);
    assert.ok(run.model.pending.has(key), `${key}：实现有 pending 而模型没有`);
  }

  for (const kind of KINDS) {
    // restorePending 是「此前已批准、因连接问题挂起」的那条待办，不重新校验配额；
    // 上界要加上这一路补发，否则测试自己注入的合法状态会被判成越界。
    const restored = run.model.restored.get(key)?.[kind] ?? 0;
    assert.ok(
      entry.counts[kind] <= MAX_QUOTA_SEEN + restored,
      `${key}/${kind} 计数 ${String(entry.counts[kind])} 超过上限`,
    );
  }

  const modelCounts = run.model.counts.get(key);
  if (modelCounts !== undefined && !run.model.pending.has(key)) {
    assert.deepEqual(entry.counts, modelCounts, `${key}：kind 计数与模型漂移`);
  }
}

/** 定时器配对：在挂数不得超过有 pending 的会话数（`onFailure` 与 `attachTimer` 之间
 *  的窗口本就没有定时器，所以这里只能判「不超过」），且每一枚都对应仍存在的待办。 */
function checkTimers(run: Run, pendingKeys: Set<string>, withPending: number): void {
  assert.ok(
    run.live.live.size <= withPending,
    `在挂定时器 ${String(run.live.live.size)} > 有待办的会话 ${String(withPending)}（重复挂载或漏放）`,
  );
  for (const [key, box] of run.live.live) {
    assert.ok(pendingKeys.has(key), `会话 ${key} 的待办已不在快照里，定时器却还挂着（泄漏）`);
    assert.ok(box.calls <= 1, `disposer 被调用 ${String(box.calls)} 次（重复释放）`);
  }
}

/** 淘汰的正面判据：快照里少掉的键只能是淘汰，而被淘汰的那条此刻必须真的空闲——
 *  有待办/有定时器/欠着补发的记录一旦被丢掉，`restorePending()` 就会重建一枚 counts
 *  全 0 的新记录，等于把 maxResumes 这道防失控闸门静默复位。 */
function noteEvictions(run: Run, currentKeys: Set<string>): void {
  for (const key of run.prevKeys) {
    if (!currentKeys.has(key)) {
      run.stats.evictions += 1;
      assert.equal(run.model.pending.has(key), false, `${key}：被淘汰的会话仍有待办`);
      assert.equal(run.live.live.has(key), false, `${key}：被淘汰的会话定时器还挂着`);
      assert.notEqual(run.suspendedFlag.get(key), true, `${key}：被淘汰的会话正欠着一次补发`);
      // 淘汰即失忆：实现把 kind 配额、冷却时刻和回合水位连同记录一起丢了（这是有界内存
      // 的代价，也是它明说的取舍）。模型不跟着丢，就会把「同一会话号被淘汰后重建」这条
      // 合法路径判成缺陷。
      run.model.counts.delete(key);
      run.model.lastFireAt.delete(key);
      run.model.handled.delete(key);
      run.suspendedFlag.delete(key);
    }
  }
}

/** 每一步之后都必须成立的一组不变量。 */
function checkInvariants(run: Run): void {
  const snapshot = run.scheduler.stateSnapshot();
  const currentKeys = new Set(Object.keys(snapshot));
  noteEvictions(run, currentKeys);
  const pendingKeys = new Set<string>();
  for (const [key, entry] of Object.entries(snapshot)) {
    if (entry.pending !== null) {
      pendingKeys.add(key);
    }
  }
  checkEviction(run, snapshot);
  for (const [key, entry] of Object.entries(snapshot)) {
    checkEntry(run, key, entry);
  }
  checkTimers(run, pendingKeys, pendingKeys.size);
  run.prevKeys = currentKeys;
}

/** 排期指令：只在实现真排上时登记待办，并把三条判序各自撞一遍。 */
function applyFailure(run: Run, cmd: Extract<Cmd, { op: "failure" }>): void {
  const key = sessionKey(cmd.session);
  const decision: FailureDecision = run.scheduler.onFailure({
    sessionId: key,
    turn: cmd.turn,
    kind: cmd.kind,
    delayMs: cmd.delayMs,
    cooldownMs: cmd.cooldownMs,
    maxResumes: cmd.maxResumes,
    chainDelayMs: cmd.chainDelayMs,
  });
  if (decision.action === "skip") {
    if (decision.reason === "capacity") {
      run.stats.capacitySkips += 1;
    }
    assert.ok(
      ["pending", "max-resumes", "cooldown", "invalid-session", "capacity"].includes(
        decision.reason,
      ),
      `未预期的 skip 理由：${decision.reason}`,
    );
    return;
  }
  // 排期只发生在无待办时；计数只在该 kind 未达上限时才允许。
  assert.equal(run.model.pending.has(key), false, `${key}：已有待办还能排第二发`);
  const counts = run.model.counts.get(key) ?? zeroCounts();
  assert.ok(
    counts[cmd.kind] < cmd.maxResumes,
    `${key}/${cmd.kind}：计数 ${String(counts[cmd.kind])} 已达上限仍排期`,
  );
  // 非链式那一发必须已过冷却窗口。
  const firedAt = (run.model.lastFireAt.get(key) ?? zeroCounts())[cmd.kind];
  if (cmd.chainDelayMs <= 0 && firedAt > 0) {
    assert.ok(
      run.model.now - firedAt >= cmd.cooldownMs,
      `${key}：冷却未过就排期（${String(run.model.now - firedAt)} < ${String(cmd.cooldownMs)}）`,
    );
  }
  // 链式那一发必须把延迟抬到 chainDelayMs。
  if (cmd.chainDelayMs > 0) {
    assert.ok(decision.chained, "带链式延迟的排期必须标成 chained");
    assert.ok(decision.delayMs >= Math.max(cmd.delayMs, cmd.chainDelayMs), "链式延迟取两者之大");
  }
  run.model.pending.set(key, {
    turn: cmd.turn,
    kind: cmd.kind,
    fireAt: decision.fireAt,
    announcedAt: run.model.now,
    ...(decision.chained ? { chained: true } : {}),
  });
}

function applyAttach(run: Run, cmd: Extract<Cmd, { op: "attach" }>): void {
  const key = sessionKey(cmd.session);
  const box: TimerDisposerBox = { calls: 0 };
  const disposer = (): void => {
    box.calls += 1;
    run.live.disposed += 1;
    run.live.live.delete(key);
  };
  const attached = run.scheduler.attachTimer(key, disposer);
  run.live.created += 1;
  if (attached) {
    // 同一会话已有在挂定时器时，实现必须先释放旧的那一枚：直接覆盖会让旧 disposer
    // 的引用丢失，而它的定时器还留在宿主计时器表里（泄漏，且到点还会多发一次注入）。
    const replaced = run.live.live.get(key);
    if (replaced !== undefined) {
      assert.equal(replaced.calls, 1, `${key}：重复挂载时旧定时器的 disposer 未被调用`);
    }
    run.live.live.set(key, box);
    // 挂上定时器的前提是这条会话仍有待办。
    assert.ok(run.model.pending.has(key), `${key}：无待办却挂上了定时器`);
  } else {
    // 拒绝挂载时实现必须同步释放刚建的 disposer；否则宿主定时器表里会留下一条
    // 没有待办对应的定时器。
    assert.equal(box.calls, 1, `${key}：attachTimer 拒绝挂载时没有释放刚建的 disposer`);
  }
}

function applySettle(run: Run, cmd: Extract<Cmd, { op: "settle" }>): void {
  const key = sessionKey(cmd.session);
  const settled = run.scheduler.settle(key, cmd.outcome);
  assert.equal(settled, run.model.pending.has(key), `${key}：settle 的结果与待办在位性不符`);
  if (!settled) {
    return;
  }
  const pending = run.model.pending.get(key)!;
  run.model.pending.delete(key);
  run.live.live.delete(key);
  const counts = run.model.counts.get(key) ?? zeroCounts();
  const last = run.model.lastFireAt.get(key) ?? zeroCounts();
  const kind = pending.kind === "" ? "resume" : pending.kind;
  if (cmd.outcome === "fired") {
    counts[kind] += 1;
    last[kind] = run.model.now;
  }
  run.model.counts.set(key, counts);
  run.model.lastFireAt.set(key, last);
}

/** 收掉待办前确认挂着的 disposer 真被调用过：只从 live 表删掉不等于释放。 */
function assertBoxReleased(run: Run, key: string): void {
  const box = run.live.live.get(key);
  if (box !== undefined) {
    assert.equal(box.calls, 1, `${key}：待办收掉时挂着的定时器没有释放（泄漏）`);
  }
  run.live.live.delete(key);
}

function applyCancel(run: Run, cmd: Extract<Cmd, { op: "cancel" }>): void {
  const key = sessionKey(cmd.session);
  const had = run.model.pending.has(key);
  const result = run.scheduler.cancel(key);
  assert.equal(result.cancelled, had, `${key}：cancel 结果与待办在位性不符`);
  if (had) {
    run.model.pending.delete(key);
    assertBoxReleased(run, key);
  }
}

/** 成功信号只复位 resume/continue：unfinished 留着（否则「注入→仍不闭合→再注入」自激）。 */
function applySuccess(run: Run, cmd: Extract<Cmd, { op: "success" }>): void {
  const key = sessionKey(cmd.session);
  run.scheduler.onSuccess(key);
  const counts = run.model.counts.get(key);
  if (counts !== undefined) {
    counts.resume = 0;
    counts.continue = 0;
  }
  const snapshot = run.scheduler.stateSnapshot()[key];
  if (snapshot !== undefined && counts !== undefined) {
    assert.equal(snapshot.counts.unfinished, counts.unfinished, "unfinished 配额不得被成功复位");
  }
}

function applyTodosClosed(run: Run, cmd: Extract<Cmd, { op: "todosClosed" }>): void {
  const key = sessionKey(cmd.session);
  run.scheduler.onTodosClosed(key);
  const counts = run.model.counts.get(key);
  if (counts !== undefined) {
    counts.unfinished = 0;
  }
}

/** 水位单调：只有严格更大才算新轮。 */
function applyNoteTurn(run: Run, cmd: Extract<Cmd, { op: "noteTurn" }>): void {
  const key = sessionKey(cmd.session);
  const before = run.model.handled.get(key) ?? 0;
  const accepted = run.scheduler.noteTurnHandled(key, cmd.turn);
  assert.equal(accepted, cmd.turn > before, `${key}：旧轮重放闸门判错`);
  if (accepted) {
    run.model.handled.set(key, cmd.turn);
  }
}

function applySuspend(run: Run, cmd: Extract<Cmd, { op: "suspend" }>): void {
  const key = sessionKey(cmd.session);
  const snap = run.scheduler.suspendSession(key);
  assert.equal(snap !== null, run.model.pending.has(key), `${key}：suspend 结果与待办在位性不符`);
  if (snap === null) {
    return;
  }
  const pending = run.model.pending.get(key)!;
  // 挂起快照保原 fireAt（不重头计时）。
  assert.equal(snap.fireAt, pending.fireAt, "挂起必须保原 fireAt");
  run.suspended.set(key, pending);
  run.model.pending.delete(key);
  assertBoxReleased(run, key);
  run.suspendedFlag.set(key, true);
}

/** 记一次 restore 补发；配额上界按它放宽（restorePending 不重新校验配额）。 */
function bumpRestored(run: Run, key: string, pending: PendingRecord): void {
  const kind = pending.kind === "" ? "resume" : pending.kind;
  const row = run.model.restored.get(key) ?? zeroCounts();
  row[kind] += 1;
  run.model.restored.set(key, row);
}

/** 恢复一条挂起快照；本序列里没有快照时，唯一该判的是「不得凭空造记录」。 */
function applyRestore(run: Run, cmd: Extract<Cmd, { op: "restore" }>): void {
  const key = sessionKey(cmd.session);
  const pending = run.suspended.get(key);
  if (pending === undefined) {
    // 记录本来就在（此前被 onFailure/noteTurn 建过且此刻无待办）时恢复是合法路径，
    // 所以这里不能一概断 false——那会把实现自己的合法行为报成缺陷。
    const hadRecord = Object.hasOwn(run.scheduler.stateSnapshot(), key);
    const planted = dummyPending();
    if (run.scheduler.restorePending(key, planted)) {
      assert.ok(hadRecord, "restore 为未知会话凭空造出了一条记录");
      run.model.pending.set(key, planted);
      bumpRestored(run, key, planted);
    }
    return;
  }
  const restored = run.scheduler.restorePending(key, pending);
  assert.equal(restored, !run.model.pending.has(key), `${key}：restore 结果与待办在位性不符`);
  if (restored) {
    run.model.pending.set(key, pending);
    bumpRestored(run, key, pending);
    run.suspended.delete(key);
    run.suspendedFlag.set(key, false);
  }
}

function applyRelease(run: Run, cmd: Extract<Cmd, { op: "release" }>): void {
  const key = sessionKey(cmd.session);
  run.scheduler.releaseSuspended(key);
  run.suspendedFlag.set(key, false);
  // releaseSuspended 的语义是「宿主已经把这份挂起快照丢了」（调度器的类注释与 host.ts 的
  // 四个调用点都是这个用法）。模型要是继续留着它，就等于让宿主事后拿一份自己声明已丢弃的
  // 快照去 restore——而那条路在实现里合法地会失败（记录此时已空闲、可能被淘汰），
  // 于是「在位性」双向断言守的就不再是调度的不变量，而是一条不存在的契约。
  run.suspended.delete(key);
}

function applyTick(run: Run, cmd: Extract<Cmd, { op: "tick" }>): void {
  run.model.now += cmd.ms;
}

/** 按 op 分派。表的键由 `Cmd["op"]` 映射出来，穷尽性交给类型面：漏一个 op 就编译不过——
 *  比 switch 补一个空 default 可靠（也让每条判序各自可读，不再挤进一个高复杂度函数）。 */
type CmdHandler<Op extends Cmd["op"]> = (run: Run, cmd: Extract<Cmd, { op: Op }>) => void;

const HANDLERS: { [Op in Cmd["op"]]: CmdHandler<Op> } = {
  failure: applyFailure,
  attach: applyAttach,
  settle: applySettle,
  cancel: applyCancel,
  success: applySuccess,
  todosClosed: applyTodosClosed,
  noteTurn: applyNoteTurn,
  suspend: applySuspend,
  restore: applyRestore,
  release: applyRelease,
  tick: applyTick,
};

function dispatchCmd(run: Run, cmd: Cmd): void {
  const loose = HANDLERS[cmd.op] as (run: Run, cmd: Cmd) => void;
  loose(run, cmd);
}

const sessionArbitrary = fc.integer({ min: 0, max: SESSION_COUNT - 1 });
const failureCmdArbitrary = fc.record({
  op: fc.constant("failure" as const),
  session: sessionArbitrary,
  kind: fc.constantFrom(...KINDS),
  turn: fc.integer({ min: 0, max: 40 }),
  delayMs: fc.constantFrom(0, 1, 500, 10_000, 300_000),
  cooldownMs: fc.constantFrom(0, 1, 5000, 120_000),
  maxResumes: fc.integer({ min: 0, max: MAX_QUOTA_SEEN }),
  chainDelayMs: fc.constantFrom(0, 0, 60_000),
});
const attachCmdArbitrary = fc.record({
  op: fc.constant("attach" as const),
  session: sessionArbitrary,
});
const settleCmdArbitrary = fc.record({
  op: fc.constant("settle" as const),
  session: sessionArbitrary,
  outcome: fc.constantFrom("fired" as const, "skipped" as const),
});
const cancelCmdArbitrary = fc.record({
  op: fc.constant("cancel" as const),
  session: sessionArbitrary,
});
const successCmdArbitrary = fc.record({
  op: fc.constant("success" as const),
  session: sessionArbitrary,
});
const todosCmdArbitrary = fc.record({
  op: fc.constant("todosClosed" as const),
  session: sessionArbitrary,
});
const noteTurnCmdArbitrary = fc.record({
  op: fc.constant("noteTurn" as const),
  session: sessionArbitrary,
  turn: fc.integer({ min: 0, max: 60 }),
});
const suspendCmdArbitrary = fc.record({
  op: fc.constant("suspend" as const),
  session: sessionArbitrary,
});
const restoreCmdArbitrary = fc.record({
  op: fc.constant("restore" as const),
  session: sessionArbitrary,
});
const releaseCmdArbitrary = fc.record({
  op: fc.constant("release" as const),
  session: sessionArbitrary,
});
const tickCmdArbitrary = fc.record({
  op: fc.constant("tick" as const),
  ms: fc.constantFrom(0, 1, 400, 6000, 200_000),
});

const cmdArbitrary: fc.Arbitrary<Cmd> = fc.oneof(
  { weight: 6, arbitrary: failureCmdArbitrary },
  { weight: 3, arbitrary: attachCmdArbitrary },
  { weight: 2, arbitrary: settleCmdArbitrary },
  { weight: 2, arbitrary: cancelCmdArbitrary },
  { weight: 1, arbitrary: successCmdArbitrary },
  { weight: 1, arbitrary: todosCmdArbitrary },
  { weight: 2, arbitrary: noteTurnCmdArbitrary },
  { weight: 1, arbitrary: suspendCmdArbitrary },
  { weight: 1, arbitrary: restoreCmdArbitrary },
  { weight: 1, arbitrary: releaseCmdArbitrary },
  { weight: 3, arbitrary: tickCmdArbitrary },
);

/** 先把状态机灌到会话数上限之上：上限以下根本碰不到淘汰，属性层就退化成单测的复读。
 *  前 `MAX_SESSIONS + 8` 条会话各排一枚待办（不挂定时器、不 settle），表满且全忙时新建
 *  记录只能越界（越界判据那支）；随后把偶数号 settle 掉腾出空闲记录，随机段一进来得到的
 *  就是「有可淘汰记录」的真淘汰（淘汰判据那支）。两条判序都不靠概率去撞。 */
function warmPastCapacity(): Cmd[] {
  const cmds: Cmd[] = [];
  for (let session = 0; session < MAX_SESSIONS + 8; session += 1) {
    cmds.push({
      op: "failure",
      session,
      kind: "resume",
      turn: 1,
      delayMs: 0,
      cooldownMs: 0,
      maxResumes: MAX_QUOTA_SEEN,
      chainDelayMs: 0,
    });
  }
  for (let session = 0; session < MAX_SESSIONS; session += 2) {
    cmds.push({ op: "settle", session, outcome: "fired" });
  }
  return cmds;
}

describe("调度器的状态机不变量（随机指令序列）", () => {
  it("任意指令序列下，快照、配额、冷却与定时器配对始终自洽", () => {
    // `size: "max"` 是必需的：fast-check 默认按 baseSize 抽长度，`maxLength` 只是上界
    // （实测 400 的上界默认只到 12 条），冷却/配额/淘汰这些只在长序列里才交错的规则
    // 就永远碰不到——下面的 reached 断言正是为了把「碰不到」变成红灯。
    const scriptArbitrary = fc.array(cmdArbitrary, {
      minLength: 1,
      maxLength: 400,
      size: "max",
    });
    const reached: Stats = { capacitySkips: 0, evictions: 0 };
    const warmup = warmPastCapacity();
    fc.assert(
      fc.property(scriptArbitrary, (cmds) => {
        const run = makeRun(reached);
        for (const cmd of [...warmup, ...cmds]) {
          dispatchCmd(run, cmd);
          checkInvariants(run);
        }

        // 收尾：disposeAll 之后既没有记录也没有未释放的定时器。
        run.scheduler.disposeAll();
        assert.deepEqual(run.scheduler.stateSnapshot(), {}, "disposeAll 之后仍有记录");
        for (const box of run.live.live.values()) {
          assert.equal(box.calls, 1, "disposeAll 没有释放挂着的定时器");
        }
        run.live.live.clear();
      }),
      { numRuns: 60 },
    );
    assert.ok(reached.evictions > 0, "整批没发生过一次淘汰 ⇒ 淘汰判据只是空转");
    assert.ok(
      reached.capacitySkips > 0,
      "整批没碰到过一次「新建时表已满且全忙」 ⇒ 硬上限判据只是空转",
    );
  });
});
