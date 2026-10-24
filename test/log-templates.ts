// test/log-templates.ts —— 本包算子可见日志的模板骨架（与源码逐条同源）。
//
// 骨架里的 ⟨slot⟩ 代表源码里的一处插值。账本按「整条日志与某个骨架逐字符对齐」认领
// （见 claimsLog），不用子串包含：子串判据下 `message sent` 会替
// `message sent after reconnect` 顶包，短片段（`: turn`、`: auto-`）能替几乎所有同类日志
// 认领，于是「新增 console.* 没有被认领」这条红实际上不会响。
//
// 这份清单与源码的同步由 test/log-templates.test.ts 当场核对：它从 host.ts 与 lib/ 下现扫
// 一遍 console.* 的首个模板字面量，与清单逐条比对，清单陈旧或手改都会判红。
export const LOG_SKELETONS: readonly string[] = [
  "[session-rescue] lessonLoop report failed: ⟨slot⟩",
  "[session-rescue] lessonLoop pass failed: ⟨slot⟩",
  "[session-rescue] ⟨slot⟩: provider Retry-After ⟨slot⟩ms exceeds ⟨slot⟩ms cap — delegating to llm-retry",
  "[session-rescue] ⟨slot⟩: auto-⟨slot⟩ skipped (⟨slot⟩)",
  "[session-rescue] ⟨slot⟩: chained failure at turn ⟨slot⟩ (rescue-opened turn) — bypassing cooldown, re-scheduling in ⟨slot⟩ms",
  "[session-rescue] ⟨slot⟩: ⟨slot⟩ trigger at turn ⟨slot⟩ — auto-⟨slot⟩ in ⟨slot⟩ms",
  "[session-rescue] ⟨slot⟩: auto-⟨slot⟩ vetoed at fire time (⟨slot⟩)",
  "[session-rescue] ⟨slot⟩: auto-⟨slot⟩ message sent",
  "[session-rescue] ⟨slot⟩: failed to send auto-⟨slot⟩: ⟨slot⟩",
  "[session-rescue] ⟨slot⟩: auto-⟨slot⟩ send failed (⟨slot⟩) — pending preserved; will re-fire after connection/reset",
  "[session-rescue] ⟨slot⟩: suspended auto-⟨slot⟩ dropped (disabled: plugin off or session toggle off)",
  "[session-rescue] ⟨slot⟩: auto-⟨slot⟩ vetoed at re-fire (⟨slot⟩)",
  "[session-rescue] ⟨slot⟩: auto-⟨slot⟩ message sent after reconnect",
  "[session-rescue] ⟨slot⟩: failed to send auto-⟨slot⟩ after reconnect: ⟨slot⟩",
  "[session-rescue] ⟨slot⟩: re-fire failed (⟨slot⟩) — preserved, waiting next reconnect",
  "[session-rescue] ⟨slot⟩: suspended auto-⟨slot⟩ dropped (a newer pending is already armed)",
  "[session-rescue] ⟨slot⟩ (⟨slot⟩): failure looks rate-limit-ish but classified permanent (⟨slot⟩) — matcher may need extension: ⟨slot⟩",
  "[session-rescue] ⟨slot⟩: turn ⟨slot⟩ is schedule-driven — resume suppressed (dsh-schedule owns it)",
  "[session-rescue] ⟨slot⟩: stale turn review (turn ⟨slot⟩) skipped",
  "[session-rescue] ⟨slot⟩: turn ⟨slot⟩ is schedule-driven — continue suppressed",
  "[session-rescue] retry-policy mutate failed (⟨slot⟩/⟨slot⟩):",
  "[session-rescue] sessionProjections register failed, falling back to log scan: ⟨slot⟩",
];

/**
 * 骨架里的插值占位符。
 *
 * 用尖括号记号而不是源码里那种花括号写法：本文件里的骨架是普通字符串常量（要按占位符
 * 切分拼正则），而普通字符串里出现花括号插值形态会触发 no-template-curly-in-string；
 * 换成模板串又会让占位符变成一次真插值。
 */
const PLACEHOLDER = "⟨slot⟩";

/** 骨架 → 整条日志的匹配式。转义字面量、把占位符换回通配，两端锚死。 */
function skeletonPattern(skeleton: string): RegExp {
  const parts = skeleton
    .split(PLACEHOLDER)
    .map((part) => part.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`));
  return new RegExp(`^${parts.join(".*")}$`, "u");
}

const SKELETON_PATTERNS = LOG_SKELETONS.map((skeleton) => skeletonPattern(skeleton));

/** 一条日志是否整条对上某个骨架。端锚死是这条判据的全部意义：多一个尾巴就不算认领。 */
export function claimsLog(text: string): boolean {
  return SKELETON_PATTERNS.some((pattern) => pattern.test(text));
}
