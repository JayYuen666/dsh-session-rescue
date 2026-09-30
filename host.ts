// session-rescue host 半（TypeScript 版）：回合非正常收尾时的通用自动注入
// （baidu-429-auto-resume 的通用化替代）+ client 状态/取消/会话开关 webServer 端点。
//
// 三类注入（各自独立的延迟/冷却/次数上限，互不跨类误拦）：
//   - resume     ← agent/error 且 classifyFailure 判为瞬时（限流/5xx/超时/传输…）
//   - continue   ← 回合以 reason.kind='max-tokens' 收尾（输出上限截断）
//   - unfinished ← 回合以 'completed' 收尾，但**本回合自己写的**待办清单仍未闭合
//                  （结构化信号，见 lib/turn-review.ts；零文本猜测）
//
// 设计依据全部见计划「已验证 API 事实」表，要点：
//   - agent/error 是回合级终态（内置 dsh-llm-retry 已耗尽），只做转发决策；
//   - 仅根会话；失败必须被 classifyFailure 判为瞬时；
//   - 调度状态机在 lib/resume-scheduler.ts（单待办/限次/按 kind 独立的冷却）；
//   - 触发前二次校验（仍 idle、inbox 无待办、无更新轮）——手动操作即失效；
//   - 配额是「连续」语义：completed 回合重置 resume/continue；待办闭合才重置
//     unfinished（否则注入→仍不闭合→再注入 会无限自激）；
//   - 模型在等用户（ask_user_question，仅 unfinished 需要判：该类回合本身就是
//     "正常收尾但在等人"）或回合由 goal 轮次驱动（source.kind=goal，三类注入
//     一律不注入）时绝不注入——绝不抢人/抢 goal 的话（goal 轮次由官方
//     goal-round-driver 自己驱动续跑，它同时监听 agent/error 与 agent/status）；
//   - 用户中止/打断的回合不注入：这条判定在 agent/status 侧（turn/end 已落盘，
//     reason.kind 就位）。**不**在 agent/error 侧做：harness 的 agent-loop 先
//     emit agent/error（catch 块）再 append turn/end（finally），且被 abort 的
//     轮次根本不 emit agent/error（直接 rethrow），所以在 error 处扫 turn/end
//     永远是空扫——那段判定是死代码，已删（见 test/host-contract.test.ts）。
//   - 严禁自定义会话事件（持久化读取白名单会拒绝加载），状态只走 webServer。
//   - 三类判定的会话日志读法：主路径是 `ctx.sessionProjections` 上注册的回合事实
//     投影（lib/turn-facts.ts，`stateOf` 同步水位读）；注册表缺席/迟到、opener 被窗口
//     淘汰、或最后一条 turn/end 对不上它的 start 时，回退 `snapshotEvents()` 全量扫描。
//     两条读法逐项同解，等价用例见 test/turn-facts.test.ts。
//   - 设置面（0.1.7 起）是**隐式注册**的：命名空间 = profile 条目 id（`session-rescue`，
//     见 cordis.patch.yml），可编辑项由导出 `Config` 上的 `.volatile()` 决定，内置默认
//     逐字段落在 `.default()`（不再有 `settings.register(ns, schema, { base })` 那层底座）。
//     十三项**全部**要标 volatile：漏一项就从设置卡上静默消失，全漏则整条不被投影
//     （写入抛 `has no volatile fields`）——那等于用户再也打不开续跑开关。读侧一律
//     `config.<field>.get()`（见 settingsOf），跨命名空间读只剩 `settings.describe()`。
//
// 运行方式：dsh 的 cordis Loader 直接 import 本 .ts 文件（Node ≥22.18 类型剥离）。
// 运行时值导入两枚：@deepseek-ai/dsh-brand（在 dependencies，产物留裸
// 说明符；它只在 `brandString<MessageId>` 那一处用）与 schemastery，且 0.1.7 起必须是**宿主 fork** @deepseek-ai/schemastery：
// 只有它的 resolve 会把标了 .volatile() 的字段包成 Volatile 引用（公共 schemastery@3.18.0
// 既没有 .volatile()，解析出来的也仍是普通值，设置卡写进去的值永远读不到）。
// @deepseek-ai/* 里另有**一处**值导入：`@deepseek-ai/dsh-brand` 的 `brandString`。注入消息
// 要过官方 `Agent["followup"](message: UserMessage)`，而 `UserMessage.id` 是官方幻影品牌
// `MessageId`（dsh-llm/lib/types/brand.d.ts:14 `Branded<'MessageId'>`），type-only 面没有任何
// 构造口、`as` 又被 lint 的 typescript/no-unsafe-type-assertion 禁掉——唯一合法送法就是官方
// 自己的 `brandString`（同包 lib/types/index.d.ts:28）。它是恒等函数，且 dsh-brand 自述
// "owns no runtime identity or mutable state, so independently installed copies produce
// interchangeable values"（同文件 :9-10）。本仓据此把它落在 dependencies、
// 产物留 @deepseek-ai/dsh-brand 裸说明符；放 devDependencies 时 rolldown 会把函数体内联进
// host.js（本包 client 半仍是内联——build-client.mjs 只 external react，见 test/ 里的说明）。
// @deepseek-ai/cordis 除 `Events` 的 type-only 取型外一律不值导入（运行时由 ctx 注入）。

import Schema from "@deepseek-ai/schemastery";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
// 注入消息的 id 位是官方幻影品牌 `MessageId`，`brandString` 是它唯一的合法构造口（见文件头）。
import { brandString } from "@deepseek-ai/dsh-brand";
// `Events` 只用来取官方事件载荷的类型（Parameters<Events[…]>[0]），不值导入。
import type { Context, Events, Fiber, Volatile } from "@deepseek-ai/cordis";
// 结构面全部钉回官方声明：`Agent`/`Inbox` 出自 @deepseek-ai/dsh-agent（安装态
// lib/types/runtime-types.d.ts，Agent 的成员由 `declare module './types.ts'` 增强挂上：
// options :141、session :143、inbox :145、status :147、followup :192），`Session` 出自
// @deepseek-ai/dsh-session（lib/types/index.d.ts：id :122、header :118、snapshotEvents :192）。
// 这两个包都是**类型面**依赖（type-only + 一处 dsh-brand 值导入，见文件头）。
import type { Agent, AgentRegistry, Inbox } from "@deepseek-ai/dsh-agent";
import type { WebServer } from "@deepseek-ai/dsh-host-webserver";
import type { Session, SessionId } from "@deepseek-ai/dsh-session";
import type { MessageId } from "@deepseek-ai/dsh-llm";
import type { SettingsForms, SettingsPathOp } from "@deepseek-ai/dsh-settings";
import { classifyFailure, looksRateLimitish } from "./lib/failure-classify.ts";
import type { LlmFailureLike } from "./lib/failure-classify.ts";
import { ResumeScheduler } from "./lib/resume-scheduler.ts";
import type { PendingRecord, RescueKind, TimerDisposer } from "./lib/resume-scheduler.ts";
import { reviewLastTurn } from "./lib/turn-review.ts";
import type { TurnReview } from "./lib/turn-review.ts";
// 回合事实投影：投影单元 + 读侧换算 + 回退扫描（旧实现原样搬进同一模块，见该文件头）。
import {
  asFacts,
  hasNewerTurn,
  rescueFactsProjection,
  reviewFromFacts,
  scanNewerTurn,
  scanOpenerKind,
  turnOpenerKind,
  RESCUE_FACTS_KEY,
} from "./lib/turn-facts.ts";
import type { RescueFacts } from "./lib/turn-facts.ts";
import { MESSAGES } from "./lib/messages.ts";
import type { SessionRescueMessages } from "./lib/messages.ts";
// host 侧文案语言跟官方 locale 插件的偏好同源：0.1.7 起跨命名空间只有 `settings.describe()`
// 一条路，挑出 `locale` 那一条的 value（该条目未被投影即中文）。
import {
  LOCALE_SETTINGS_NAMESPACE,
  messagesFor,
  resolveLocalePreference,
} from "@jayyuen66/dsh-plugin-shared/lib/locale";

// 共享 webServer 样板：sendJson/queryParam/guardBody（自家 isCrossOrigin 支在信任闸门
// 落地后不可达，已随那道闸门收敛）
// 与 lesson-loop/zvec-grep/ocr-review 原来各自复制，现统一由 shared 提供；
// checkCsrf 各插件 header 名不同，本文件留薄包装传 x-rescue-csrf。
// guardBody 覆盖「跨域 → CSRF → 读 body（Buffer 累积、UTF-8 字节上限）→
// 413/400」整条 POST 前置链，本包 retry-policy 端点即用它。
import { sendJson, queryParam, checkCsrf, guardBody } from "@jayyuen66/dsh-plugin-shared/lib/http";
// 信任闸门：六条路由 handler 的第一条语句。
import { guardTrust } from "@jayyuen66/dsh-plugin-shared/lib/trust";
// lesson bus 收口：lesson-loop 的 report/pass 已异步落库（返回 Promise），只包一层同步
// try/catch 抓不到 rejection——失败既被静默吞掉又给宿主进程留一枚未处理拒绝。
// 同步抛错与异步拒绝共用这一个出口（三个包的调用点降级口径一致）。
import { settleLessonCall } from "@jayyuen66/dsh-plugin-shared/lib/lesson-bus";
import { fieldOf, isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

const PLUGIN_NAME = "session-rescue";
const STATE_PATH = "/_dsh/session-rescue/state";
const CANCEL_PATH = "/_dsh/session-rescue/cancel";
const TOGGLE_PATH = "/_dsh/session-rescue/toggle";
/** 连接恢复通知端点（client 在 connection/reset 时 POST；host 恢复挂起待办）*/
const RESUME_NOTIFY_PATH = "/_dsh/session-rescue/resume";
/** 官方 llm-retry 策略读写通道：GET 列 providers，POST 按 preset 落盘。 */
const RETRY_PROVIDERS_PATH = "/_dsh/session-rescue/retry-providers";
const RETRY_POLICY_PATH = "/_dsh/session-rescue/retry-policy";
/** 官方 llm-pi-ai 的 settings namespace（mutate 目标；与 pi-ai src/index.ts NS 一致）。 */
const PI_AI_NS = "llm-pi-ai";

/** goal-round-driver 开轮时的 source.kind（packages/goal/goal-round-driver：
 *  `source: { kind: 'goal', goalId, revision, round }`）。该类回合由 goal 机制
 *  自己驱动续跑，本插件三类注入都要让路。 */
const GOAL_SOURCE_KIND = "goal";

/** 本插件注入消息的 producer-owned source.kind。0.1.7 的 V4 准入拒收旧的
 *  `{ kind: 'plugin', plugin }` 包装（session-format-v3-to-v4 message-sources.ts
 *  对每个持久消息位抛 "format v4 message requires a producer-owned source kind"），
 *  迁移表把未知插件名统一加 `plugin:` 前缀，故历史行读回也是这个串：发出同一
 *  串，历史与新行才是同一个身份（下方 openerKindOf 读回的也是它）。 */
const RESCUE_SOURCE_KIND = "plugin:session-rescue";

/** 本包是那两条注入消息的 **producer**，按官方政策在自己的模块里声明自己的 source.kind：
 *  `@deepseek-ai/dsh-llm` 的 `MessageSourceMap` 注释明写 "each producer declares its own
 *  `kind` in its own module; there is no shared catch-all `plugin` kind"（安装态
 *  lib/types/message.d.ts:96-97），宿主自带插件正是这个写法（dsh-agent 的
 *  lib/types/model-selection.d.ts:7-13 往同一张表里挂 `'model-selection'`）。
 *  `Agent["followup"](message: UserMessage)` 的入参形状（`UserMessage` :144 继承
 *  `MessageBase.source: MessageSource` :132，而 `MessageSource` 就是这张表的价值联合 :122）
 *  因此**由本声明给出**，两个注入点不再靠本地 `followup: (message: unknown) => void` 假装它不存在。 */
declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    // interface 的键位必须是字面量，故用下方那条编译期等式把它与 RESCUE_SOURCE_KIND 钉死
    // （wukil-plugins/lib/tools-rules.ts 同款护栏：键串与常量各写一遍迟早漂）。
    "plugin:session-rescue": {
      readonly kind: typeof RESCUE_SOURCE_KIND;
    };
  }
}

/** 编译期契约：增强里写死的键必须始终等于 RESCUE_SOURCE_KIND（漂了就编译不过）。 */
export const RESCUE_SOURCE_KIND_KEY: "plugin:session-rescue" = RESCUE_SOURCE_KIND;

/** kind → 注入文案的单一映射：调度路径与断连重发路径共用，避免两处 ternary 漂移
 *  （重连补发若漏一种 kind，会拿错文案发出）。
 *  入参写成 `string` 而非 `RescueKind`：闭合集之外的 kind 在运行时**确实到得了**
 *  ——`PendingRecord.kind` 承认跨版本脏快照里的空串（lib/resume-scheduler.ts），
 *  suspended 台账又按原样把 kind 交回这里。那道「抛错」闸门因此必须留在运行时，
 *  而类型面要给它一条走得到的路（写死 `RescueKind` 会让最后一分支被判定为恒真、
 *  抛错成为不可达死代码，而那行为 test/text-for-kind.test.ts 的用例所钉）。
 *  调用方照常交 `RescueKind`（`string` 的可赋值子集），窄化只在这一侧放宽。
 *  来自 wire 的不可信 kind 由 client 侧 `parsePending` + `PENDING_COPY`（Map，
 *  原型键无从命中）处理——那里才是外部输入面。
 *  E2：闭合集之外的 kind 一律**抛错**，绝不静默回退到任何一份 approved 文案
 *  （错文案比不发危害更大，而调用方已无 null 分支可走）。
 *  文案表由调用点经 `hostMessages(runtime)` 取（语言随官方 locale 偏好走），
 *  本函数只做 kind → 键的映射，不再持有字符串常量。 */
export function textForKind(kind: string, messages: SessionRescueMessages): string {
  if (kind === "resume") {
    return messages.resumeText;
  }
  if (kind === "continue") {
    return messages.continueText;
  }
  if (kind === "unfinished") {
    return messages.unfinishedText;
  }
  throw new Error(`[session-rescue] unknown rescue kind: ${kind}`);
}

/** 取本包 host 文案表：语言与官方 dsh-client-locale 的偏好同源（该包在 settings 的
 *  `locale` 命名空间里持久化 `preference`）。0.1.7 起跨命名空间读只剩 `describe()`
 *  一条路（`settings.get(ns)` 已随隐式注册一起移除）：挑出 `ns === 'locale'` 那一条的
 *  `value`。该条目未投影（宿主没装 client-locale，或它的 Config 一个 `.volatile()` 都没有）
 *  → `find` 取不到 → undefined → 中文默认；用户在「设置 → 常规」改语言后，下一次注入即
 *  新文案（不重启、不再开一个本包自己的 locale 设置项）。 */
export function hostMessages(svc: HostCtx): SessionRescueMessages {
  return messagesFor(
    MESSAGES,
    resolveLocalePreference(
      svc.settings.describe().find((row) => row.ns === LOCALE_SETTINGS_NAMESPACE)?.value,
    ),
  );
}

/** retry-policy POST body 上限（**UTF-8 字节**）：合法载荷只有 {provider, preset}
 *  两个短字符串，超限即 413（防异常/恶意超大 body 撑爆常驻进程内存）。 */
const RETRY_POLICY_BODY_MAX_BYTES = 64 * 1024;

// 链式例外：续跑消息开出的回合再次瞬时失败时，不再被冷却闸门静默吞掉
// （resumeDelayMs+失败耗时 恒小于 resumeCooldownMs，冷却会系统性断链）。
// 改为允许重调度，但延迟取 max(resumeDelayMs, chainResumeDelayMs) 跨出
// 限流窗口。chainResumeDelayMs 上限保护：schema max 300s。
const CHAIN_RESUME_DELAY_MS_DEFAULT = 60_000;

/** 请求级 429 重试的常量：次数上限与退避阶梯。原在 apply 闭包内，
 *  拆 helper 时提升为模块常量——handleRequestError 是模块级受控函数，用到它们。 */
const REQUEST_RETRY_MAX = 5;
const REQUEST_RETRY_BACKOFF_MS: readonly number[] = [2000, 5000, 10_000, 20_000, 30_000];
/** 本插件愿意代等的上限（= 阶梯封顶）。提供方 Retry-After 超过它就不等、
 *  直接委托 next()，让官方 llm-retry（其策略 maxDelayMs 可达 60s+）接手。 */
const REQUEST_RETRY_BACKOFF_CAP_MS = 30_000;

// 连接感知挂起快照的安全上限：防极端场景下数组无界增长。
const MAX_SUSPENDED = 64;

/** 「已发生瞬时失败、尚待成功信号兑成 pass」台账的上限：长跑会话不得无界增长，
 *  超上限裁剪最旧一条（与 MAX_SUSPENDED 同策）。 */
const MAX_TRANSIENT_PASS_PENDING = 64;

// ── 结构类型（宿主交互面：成员形状一律取官方声明，只把「在位与否」按运行时数据收）──

/**
 * 会话事件流的本插件读面：**官方 `Session` 的成员投影**
 * （@deepseek-ai/dsh-session 安装态 `lib/types/index.d.ts`：`get id(): SessionId` :122、
 * `readonly header: SessionHeader` :118、
 * `snapshotEvents(fromSeq?: SessionLogOffset, toSeqExclusive?: SessionLogOffset): readonly SessionEvent[]` :192）。
 * 三个成员的形状一位都不再本地复述——官方换形状就编译不过。
 *
 * `Session` 是**类面**（`private log` 等私有字段让它按名义比较），所以只 `Pick` 成员、
 * 绝不取整类：整类作面会把任何非宿主 `new` 的对象在编译期拒掉，而本包读它只要这三个成员
 * （quality-gate/host.ts:151-152 同形）。
 *
 * - `id` 保持**必选**（与官方一致）：本插件把调度器、每会话开关、请求级重试计数、
 *   pass 台账、`agents.get()` 反查全部键在这枚 id 上，缺席时没有任何合法降级可走；
 *   写成可缺失会在五处读取上各凭空长出一条宿主永不可能交付的兜底分支，而本包的
 *   100% 分支门槛正好不收这种测不到的分支。
 *   品牌是**单向**的：`SessionId` 读出来当 string 用（Map/Set 键、日志插值）不受影响。
 * - `header` / `snapshotEvents` 官方都是必选成员（:118 / :192，:110-117 还写明宿主自己
 *   new 的 Session 一定合成一份最小 header 故 `header` 恒在位），但本面收的是**跨进程
 *   边界送来的宿主对象**，在位与否只能运行时判（`hasEventReader` 的 typeof 守卫、
 *   `agent.session.header?.cwd`）。官方类型描述宿主**承诺**什么，守卫负责宿主**交付**什么。
 *   `SessionHeader.cwd` 官方即 `readonly cwd?: string`（types.d.ts:69），读法不变。
 *
 * `snapshotEvents` 的返回就此绑成官方 `readonly SessionEvent[]`（那枚 `@deprecated`
 * "new calls are prohibited" :186-187 也一并进来，见 readEvents 里带理由的 lint 豁免）。
 * 它现在只服务**回退扫描**（主路径是 lib/turn-facts.ts 的投影读）；返回仍交回
 * `readonly unknown[]` 并逐字段守卫（lib/turn-facts.ts 的 `typeOf` / `numIn` /
 * `sourceKindOf`）：日志条目跨版本缺字段是真事，判据面不能因为"类型说必存在"就省掉守卫。
 */
export type SessionEventsLike = Pick<Session, "id"> &
  Partial<Pick<Session, "header" | "snapshotEvents">>;

/**
 * agent/error 与 agent/status 载荷里本插件要用的 agent 面：**官方 `Agent` 的成员投影**
 * （@deepseek-ai/dsh-agent 安装态 `lib/types/types.d.ts:13` 的 `readonly id: SessionId`，
 * 加上 `lib/types/runtime-types.d.ts` 以 `declare module './types.ts'` 官方增强挂上的成员：
 * `options: AgentOptions` :141、`session: Session` :143、`inbox: Inbox` :145、
 * `status: AgentStatus` :147、`followup(message: UserMessage): void` :192）。
 * 字段类型全部由 `Pick` / 索引访问取，本文件不复述任何形状：
 * - `id` 就此是官方品牌的 `SessionId`，`followup` 就此是官方的
 *   `(message: UserMessage) => void`——旧镜像写成 `(message: unknown) => void`，等于让
 *   注入载荷的形状由本包自说自话（真正的形状见下方 MessageSourceMap 的 producer 声明）。
 * - `status` 就此是官方 `AgentStatus = 'idle' | 'running'`（runtime-types.d.ts:90，
 *   先例：quality-gate/host.ts:201 同款绑定），`agent.status !== "idle"` 那两道判定照旧
 *   成立（闭合集上的比较不会因为换成官方联合而变宽或变窄）。
 * - `options` / `status` / `inbox` 按可缺失收（宿主载荷），`inbox` 只取官方 `Inbox` 的两个
 *   只读队列（见 RescueInbox），不带 clear/append/prepend/replace/remove/splice 六条写口
 *   ——本插件只读待办，从不改待办。
 * - `session` 用本包的 Partial 投影而不是官方 `Session` 整类（名义类面，见上）。
 */
export interface RescueAgent extends Pick<Agent, "id" | "followup"> {
  options?: Agent["options"] | null;
  status?: Agent["status"];
  inbox?: RescueInbox | null;
  session: SessionEventsLike;
}

// ── 对象/字段防御 helper（shared/lib/tool-events / src/client-entry 同款看来）
//    原则：对 JSON/unknown 一律守卫投影，避开 `as SomeInterface` 的 unsafe 断言
//    与 Record 的点访问。动态键读取（fieldOf）同时满足 tsconfig 的
//    noPropertyAccessFromIndexSignature 与 oxlint 的 dot-notation。

/** 值的安全字符串化：原始值直接转，object/null/undefined/function/symbol 出空串
 *  （避免对未知形状值输出无意义的 [object Object]，满足 no-base-to-string）。 */
function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  // 逐分支直接 typeof 收窄原始标量后字符串化（object/function/symbol/… 出空串）。
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "bigint") {
    return String(value);
  }
  return "";
}

/** 错误信息安全提取：失败对象带 message 原样返回，否则回退到自身原始值串。 */
function errorText(error: unknown): string {
  const messageOf = fieldOf(error, "message");
  if (typeof messageOf === "string") {
    return messageOf;
  }
  return stringifyValue(error);
}

/**
 * `SettingsConflictError` 的判定（官方 dsh-settings index.d.ts:31-43）。不值导入
 * `@deepseek-ai/*`（本包对官方包只 type-only），按它两个稳定成员认：`code` 是给调用方
 * 映射的机器码，`name` 是类名兜底。认出来才能把「别处已改过这段设置」与真正的服务端
 * 故障分开——两者都回 500 的话，用户看到的是一条和自己刚才那次点击无关的错误。
 */
function isSettingsConflict(error: unknown): boolean {
  return (
    fieldOf(error, "code") === "SETTINGS_CONFLICT" ||
    fieldOf(error, "name") === "SettingsConflictError"
  );
}

/**
 * `agent/error` 载荷＝官方 cordis `Events`（@deepseek-ai/cordis 安装态
 * `lib/types/events.d.ts:216`，由 `lib/types/index.d.ts:4` 原样 re-export）里 `agent/error`
 * 条目的 payload（@deepseek-ai/dsh-agent 安装态 `lib/types/runtime-types.d.ts:402-407` 以
 * `declare module '@deepseek-ai/cordis'` 官方增强登记，`@mode emit`），官方形状
 * `{ agent: Agent; turn: number; step: number; error: unknown }`——四位全必填。
 * 本包只把 `agent` 换成本包的 `RescueAgent` Pick 投影（官方 `Agent["session"]` 是名义的
 * `Session` **整类**，跨边界的替身永远满足不了它），并整体 `Partial` 化：官方类型说的是
 * 宿主**承诺**什么，事件载荷是跨进程边界送来的，在位与否仍由运行时守卫逐项判
 * （`if (!agent) return`、`typeof payload.turn === "number"`）。字段一位都不复述。
 *
 * ⚠ 官方的 `error` 就是 `unknown`（:406，注释 "the failure, verbatim"）：抛出的可能是
 * `LlmError`（自带 `.failure`）也**可能**是任何普通 Error（无 `.failure`）。旧镜像把这一位
 * 写成 `{ failure?: FailureLike } | null`，是**替宿主虚构了一个形状**——它既没描述
 * 普通 Error 那一支，又凭空少了官方在场的 `step`。现在按官方收 `unknown`，读 `.failure`
 * 一律走本文件既有的守卫投影（见 handleAgentError 的 `fieldOf` + `isRecord`）。
 */
export type AgentErrorPayload = Partial<Omit<Parameters<Events["agent/error"]>[0], "agent">> & {
  agent?: RescueAgent | null;
};

/** `agent/status` 载荷＝官方 `Events` 的 `agent/status` 条目
 *  （runtime-types.d.ts:252-255，`@mode emit`）：`{ agent: Agent; status: AgentStatus }`。
 *  `status` 就此是官方 `AgentStatus = 'idle' | 'running'`（:90），旧镜像的 `string` 比官方
 *  宽（写得出宿主永远不会发的第三种状态并让它进比较分支）；`agent` 换成本包投影的理由
 *  同上，`Partial` 的理由是载荷跨进程边界（host-contract 有用例喂 null 与空对象）。 */
export type AgentStatusPayload = Partial<Omit<Parameters<Events["agent/status"]>[0], "agent">> & {
  agent?: RescueAgent | null;
};

/** `agent/request-error` 载荷＝官方 `Events` 的 `agent/request-error` 条目
 *  （runtime-types.d.ts:348-356，`@mode waterfall`）：
 *  `{ agent: Agent; turn: number; step: number; provider: string; failure: LlmFailure;
 *     retryPolicy: ResolvedRetryPolicy | undefined; signal: AbortSignal }`，除 `retryPolicy`
 *  自己就是 `| undefined` 外全必选。除 `agent`/`failure` 两位按本插件的运行时读面放宽
 *  （见下）外，字段类型（`code`/`message` 必填、`status`/`providerRetryAfterMs` 可选，
 *  dsh-llm lib/types/types.d.ts:26-44）全部由官方给出；可选化只发生在
 *  「整位可缺失」这一层（Partial），运行时仍逐项守卫。 */
export type RequestErrorPayload = Partial<
  Omit<Parameters<Events["agent/request-error"]>[0], "agent" | "failure">
> & {
  agent?: RescueAgent | null;
  /** `failure` 按 `LlmFailureLike`（= Partial<LlmFailure>）+ null 读：官方给的是必填的
   *  `LlmFailure`，但这一位来自进程外的 LLM 适配器（缺 code/message 的坏形状、以及整位
   *  null 都实测到得了，守卫面见 lib/failure-classify.ts 的逐项投影），所以类型面必须
   *  给 handleRequestError 里那些 `?? ""` / `?? 0` 一条 reachable 的路。 */
  failure?: LlmFailureLike | null;
};

/** agent/request-error 返回值：{ kind:'retry' } 触发重发；undefined 终结。 */
export type RequestErrorAction = { kind: "retry" } | undefined;

/**
 * webServer 服务的本插件读面 = 官方 `WebServer`（installed
 * @deepseek-ai/dsh-host-webserver/lib/types/index.d.ts:67 起，cordis `Service` 子类 + 一整套
 * private 路由表字段 → 名义比较）的 `register` **方法面投影**（:90）。
 * 旧镜像自己抄了一枚 `type WebRouteKind = "exact" | "prefix"`（注释还指向 harness 源码的
 * 行号）并逐个重述 `WebRoute` 的三位——官方那张表改 kind 或 handler 形状时，抄本会安静地
 * 继续编译通过。现在路由字面量直接受官方 `WebRoute`（同文件 :33-39，`kind` 是官方
 * `WebRouteKind` :31）约束，disposer 也按官方 `() => void` 收。
 */
export type RescueWebServer = Pick<WebServer, "register" | "host">;

/**
 * agents 服务的本插件读面 = 官方 `AgentRegistry`（installed
 * @deepseek-ai/dsh-agent/lib/types/index.d.ts:19-21 交出 `Context.agents`）的两枚成员投影：
 * `roots(): Agent[]` :364 与 `get(id: SessionId): Agent | undefined` :343。
 * 入参就此是官方品牌的 `SessionId`（经 `Parameters<AgentRegistry["get"]>[0]` 索引，不重述），
 * 返回值域换成 {@link RescueAgent} 投影而不是官方整枚 `Agent`：本包只读 id/followup/status/
 * inbox/session 五位，且官方 `Agent.session` 是 dsh-session 的 `Session` **类**（private 字段
 * → 名义比较），替身会话满足不了整类，渗进本包会让那几条运行时守卫在编译器眼里变成死代码
 * （口径与 danger-guard/host.ts 的 `GuardExecution` 一致：借键名、换值域）。
 * `roots()` 返回按 `readonly` 收：本包只遍历不改写。
 */
export interface RescueAgents {
  roots: () => readonly RescueAgent[];
  get: (id: Parameters<AgentRegistry["get"]>[0]) => RescueAgent | undefined;
}

/** 插件用到的宿主 ctx 面：注入的服务（timer/settings）+ 无 inject 语义的服务读
 *  （get）+ cordis 生命周期面（effect/inject/on）+ 本插件 fiber。契约来源：
 *  - `inject: ['timer','settings']` 保证两服务在位（模块底部 default 导出）；
 *  - `ctx.get` 是 cordis reflect.ts:226 的存储读（"without the inject
 *    requirement"），未提供时返回 undefined，故一律按可缺席处理；
 *  - `Context.on` 的 `keyof Events` 泛型不含 dsh 自定义事件，这里点名本插件
 *    用到的四个事件面（运行期由 cordis 事件总线保证）。
 *  apply 用 isHostCtx 把 Context 收窄到本类型（不写 `as unknown as` 断言，
 *  也不靠 lint 忽略注释：见 lesson-loop/ocr-review 同款守卫写法）。 */
export interface HostCtx {
  timer: { timeout: (fn: () => void, ms: number) => TimerDisposer };
  /** 0.1.7 的 settings 服务对本包只剩三件事（`register`/`get`/`installSection` 均已
   *  被宿主移除，命名空间改为按 profile 条目 id 隐式注册，见下方 `Config`）：
   *  - `describe()`：跨命名空间读的**唯一**入口（locale 偏好、llm-pi-ai providers）；
   *  - `mutate(ns, ops)`：路径级写入，ns 是**被写条目**的 profile 条目 id（本包只写
   *    官方 `llm-pi-ai` 的 `providers.<p>.retryPolicy`，那条路径在它的 schema 里标了
   *    `.volatile()`）；
   *  - `configure(presentation, owner)`：页面策略（本包自带卡片 → 不走自动生成），
   *    只在 `ctx.inject(['settings'])` 的子上下文上调用。
   *  服务面直接取官方 `SettingsForms`（dsh-settings 已把 `settings` 增强进 cordis
   *  Context），不再本地投影 describe/mutate/configure 的签名。 */
  settings: SettingsForms;
  get: ((name: "agents") => RescueAgents | undefined) &
    ((name: "webServer") => RescueWebServer | undefined) &
    ((name: "lessonLoop") => LessonLoopReporter | undefined);
  /** 本插件 fiber：`settings.configure` 的 owner 必须显式传它（缺省是 settings
   *  服务自己的 fiber，传错等于给别人的页面定策略）。类型取官方 cordis `Fiber`。 */
  fiber: Fiber;
  effect: (factory: () => () => void, label?: string) => unknown;
  /** 注入子上下文：本包用它挂页面策略与回合事实投影单元，故回调面按用到的三个
   *  成员投影。`sessionProjections` 在这里是**必选**：cordis 只在依赖到位时才激活回调，
   *  缺席的那条路径上本回调根本不运行（不需要再造一次 undefined 分支）。 */
  inject: (
    deps: readonly string[],
    activate: (child: {
      effect: HostCtx["effect"];
      settings: HostCtx["settings"];
      sessionProjections: ProjectionsRegistry;
    }) => void,
  ) => unknown;
  on: ((event: "agent/error", listener: (payload: AgentErrorPayload) => void) => unknown) &
    ((event: "agent/status", listener: (payload: AgentStatusPayload) => void) => unknown) &
    ((
      event: "agent/request-error",
      listener: (
        payload: RequestErrorPayload,
        next: () => Promise<RequestErrorAction>,
      ) => Promise<RequestErrorAction>,
    ) => unknown) &
    ((
      event: "agent/disposed",
      listener: (payload: { agent?: { session?: { id?: unknown } } }) => void,
    ) => unknown);
}

/** 对象守卫（本文件通用防御）：typeof 收窄为 Record 而不经断言。 */
function hasMethods(value: unknown, methods: readonly string[]): boolean {
  if (!isRecord(value)) {
    return false;
  }
  for (const method of methods) {
    if (typeof value[method] !== "function") {
      return false;
    }
  }
  return true;
}

/** 宿主 ctx 是否满足本插件契约：点名 HostCtx 上每个要被调用的方法。只查
 *  「有没有对象」等于没查——缺方法要在这里就急停，而不是跑一半再炸。
 *
 *  ⚠ 不能再探 `settings.register`/`settings.get`：0.1.7 已把它们连同 `installSection`
 *  一起移除（命名空间改由 profile 条目 id 隐式注册），拿它们当硬前置会让**每一条真
 *  宿主**都判成「服务面不齐」——本包设置面就会静默失效、三类注入全部停摆。
 *  settings 上探的是本包**直接在宿主 ctx 上调**的两个方法：`describe`（locale 偏好 +
 *  llm-pi-ai providers）与 `mutate`（retry-policy 落盘）。`configure` 不探：它只在
 *  `inject(['settings'])` 的子上下文上被调，探宿主面等于断言一条没有测试撑着的能力。 */
function isHostCtx(value: unknown): value is HostCtx {
  if (!isRecord(value)) {
    return false;
  }
  return (
    hasMethods(value, ["get", "effect", "inject", "on"]) &&
    isRecord(fieldOf(value, "fiber")) &&
    hasMethods(fieldOf(value, "timer"), ["timeout"]) &&
    hasMethods(fieldOf(value, "settings"), ["describe", "mutate"])
  );
}

/**
 * lesson-loop 总线最小面（自进化闭环）：可选读——总线缺失只丢报告；
 * report 自身容错，续跑主流程绝不因总线故障失败。全量 detail，不截断。
 * `pass` 声明为可选成员：总线按版本可能只有 report（契约见 lesson-loop/host.ts
 *  的 bus.pass），缺失即整条度量增强降级为无操作。
 *
 * 返回值按 unknown 收而不是 void：本插件确实**不据返回值判定**（既不据此重发，
 *  也不据此改行为），但形状要如实——lesson-loop 落库已异步（report 返回 Promise）。
 *  而 `(input) => void` 的函数类型**恰好允许调用方丢弃返回的 Promise**：TS 不报
 *  "游离 Promise"，no-floating-promises 也看不到，失败于是被静默吞掉并留下一枚未处理
 *  拒绝，正是这次修的根因。unknown 既保留真实形状（调用一律经 settleLessonCall 收口），
 *  也不被跨版本返回形状绑住。
 */
export interface LessonLoopReporter {
  report: (input: {
    source: "session-rescue";
    category: string;
    cwd?: unknown;
    sessionId?: unknown;
    turn?: number;
    signature: string;
    detail: string;
    evidence?: Record<string, unknown>;
  }) => unknown;
  pass?: (input: {
    category: string;
    cwd?: unknown;
    sessionId?: string;
    signature: string;
  }) => unknown;
}

// ── webServer 工具 ─────────────────────────────────────────────────────────

/** 写操作 CSRF 头名（state 下发 token，POST 回填）。 */
const RESCUE_CSRF_HEADER = "x-rescue-csrf";

/** CSRF 校验未过时的 403 拒因：cancel/toggle/retry-policy 三个写端点走同一道
 *  checkRescueCsrf 闸门，拒因必须是同一条串（调用方按状态码 403 判，文案只供排障）。 */
const CSRF_REJECT_ERROR = "invalid csrf token";

/** 写操作 CSRF 守卫：mutating POST 必须回填 state 下发的 per-apply
 *  token。sec-fetch-site 只做纵深防御（浏览器可伪造头缺失但伪造不了 token）。
 *  校验逻辑复用 shared checkCsrf（无 body 的端点用它；带 body 的走 guardBody）。 */
function checkRescueCsrf(req: IncomingMessage, token: string): boolean {
  return checkCsrf(req, token, RESCUE_CSRF_HEADER);
}

/** 守卫收窄到的那一份：`snapshotEvents` 已确认在位。官方把它记成必选成员
 *  （@deepseek-ai/dsh-session lib/types/index.d.ts:192），本面按可缺失收（见
 *  SessionEventsLike 的 Partial）——这一条守卫同时挡「整个面缺席」与「宿主没实现」。
 *  谓词钉的是**成员**而不是整面，调用方因此既不必再判一次、也不经断言、更不必 `.call`。 */
type SessionWithReader = SessionEventsLike & {
  readonly snapshotEvents: NonNullable<SessionEventsLike["snapshotEvents"]>;
};

function hasEventReader(session: SessionEventsLike | undefined): session is SessionWithReader {
  return typeof fieldOf(session, "snapshotEvents") === "function";
}

/** 读会话事件流的统一入口（dsh 0.1.2-alpha.4：snapshotEvents() 取代 Session.events）。
 *  session 缺失 / 未实现 / 返回非数组 → 空数组（触发前校验宁可误 veto 也不误发，
 *  判定失败优于崩溃）。item 8：直接返回宿主数组，调用方就地倒扫，不复制事件日志。
 *  官方零参即「从日志首读到末尾」（index.d.ts:188-189 的 @param 注记：fromSeq 缺省为日志
 *  起点），故本包不给 `SessionLogOffset` 造品牌——包内唯一的 brand 值导入是注入 id 那位
 *  `brandString<MessageId>`（见文件头）。 */
function readEvents(session: SessionEventsLike | undefined): readonly unknown[] {
  if (!hasEventReader(session)) {
    return [];
  }
  // 官方 snapshotEvents 自带 @deprecated（index.d.ts:186-187 "new calls are prohibited"）：
  // 把返回形状钉回官方成员之后，lint 的 typescript/no-deprecated 才**第一次**看得见它——
  // 旧手抄镜像没有那枚标记，那条绿一直是假的。如今这条读只剩**回退**用途（三类判定的主路径
  // 是 lib/turn-facts.ts 的投影读）：注册表缺席/迟到（未装 dsh-session-projection 的 profile、
  // headless 组装）、opener 被窗口淘汰、或最后一条 end 对不上它的 start 时才走，
  // 故豁免留在这里并写清它兜的是哪三件事。
  // oxlint-disable-next-line typescript/no-deprecated -- 回退扫描的全量同步读（注册表缺席/窗口淘汰/终态对不上才走），主路径见 turn-facts 投影；官方替代 `sessionQuery.observeSession()` 是异步，而本读点在定时器回调的触发前校验里，改 await 即动时序
  const raw = session.snapshotEvents();
  // 官方契约交回 readonly SessionEvent[]，Array.isArray 挡的是**类型外**的输入（宿主版本
  // 漂移 / 自定义 session 实现送来 null、字符串）：那时按「读不到事件」降级。
  return Array.isArray(raw) ? raw : [];
}

/**
 * `ctx.sessionProjections` 的本包读面：官方 `SessionProjectionRegistry` 的成员投影
 * （installed lib/types/index.d.ts：host-only `register(definition)` 第二重载 :150 附近、
 * `stateOf(session, key)` :167-175）。`stateOf` 的第一参官方钉名义类 `Session`，本包的
 * 会话替身永远满足不了 ⇒ 这里按 `unknown` 收，返回值再经 `asFacts` 过一次 stateSchema
 * （wukil-plugins/wukil-dev-tools.ts 的 ProjectionsRegistry 同形）。
 */
export interface ProjectionsRegistry {
  register: (definition: typeof rescueFactsProjection) => () => void;
  stateOf: (session: unknown, key: typeof RESCUE_FACTS_KEY) => unknown;
}

/** 投影态读口（`runtime.facts` 的装箱形状）：注册表在位时由 inject 回调装上。 */
type FactsReader = (session: SessionEventsLike) => unknown;

/**
 * 三处判定的统一投影读：注册表缺席/迟到、key 未落地、或回填形状不符 ⇒ undefined
 * ⇒ 调用方回退扫描。`apply()` 只在注册表到位时才装读口，故这里不再判第二次在位。
 */
function factsOf(runtime: ApplyRuntime, session: SessionEventsLike): RescueFacts | undefined {
  const read: FactsReader | undefined = runtime.facts.value;
  return read === undefined ? undefined : asFacts(read(session));
}

/**
 * 最后回合的复盘（agent/status→idle 的三项判定之源）：投影可用则 O(1) 读，
 * 否则回退全量扫描（与迁移前同一入口、同一判据）。
 */
function reviewOf(runtime: ApplyRuntime, agent: RescueAgent): TurnReview {
  const state = factsOf(runtime, agent.session);
  const projected = state === undefined ? undefined : reviewFromFacts(state);
  if (projected !== undefined) {
    return projected;
  }
  return reviewLastTurn(readEvents(agent.session));
}

/**
 * 该回合 opener 的 `source.kind`（goal 让路 / 链式失败两项判定的共同依据）：投影在位且
 * 该回合在窗口内 ⇒ 增量折叠的当前态（O(1) 读）；否则回退全量扫描（注册表缺席/迟到、
 * opener 被窗口淘汰）。两条读法在同一串事件上逐项同解，判据见 lib/turn-facts.ts 文件头
 * 与 test/turn-facts.test.ts。读回的是会话事件流里的持久 source，与注入点发出的是同一个
 * producer-owned kind（0.1.7 起不再有 `{ kind: 'plugin', plugin }` 包装可比）。
 */
function openerKindOf(runtime: ApplyRuntime, agent: RescueAgent, turn: number): string | null {
  const state = factsOf(runtime, agent.session);
  const kind = state === undefined ? undefined : turnOpenerKind(state, turn);
  if (kind !== undefined) {
    return kind;
  }
  return scanOpenerKind(readEvents(agent.session), turn);
}

/** 待处理面的**防御读型**：`Inbox` 的两个只读待办队列（@deepseek-ai/dsh-agent 安装态
 *  lib/types/runtime-types.d.ts:41-45，`nextTurn` :43 / `nextStep` :45 官方都是
 *  **必填**的 `readonly UserMessage[]`）。元素/数组形状仍钉回官方声明（`Inbox["nextTurn"]`），
 *  只在「这一位是否缺失」上按运行时放宽：这里跨的是宿主进程边界，Inbox 自 0.1.5-alpha.1
 *  才收敛为类型接口，旧宿主与测试夹具交回的对象可以缺任一位——守卫 `?.length ?? 0` 的
 *  运行时意义不因官方必选而消失（见 inboxHasPending）。只读这两位：官方 `Inbox` 另有
 *  clear/append/prepend/replace/remove/splice 六条写口，本插件只读不改。 */
export interface RescueInbox {
  readonly nextTurn?: Inbox["nextTurn"] | undefined;
  readonly nextStep?: Inbox["nextStep"] | undefined;
}

/** Inbox 是否有待处理消息（0.1.5-alpha.1 起 Inbox 收敛为类型接口，hasPending 不再是公共
 *  API → 待处理判定读两个待办队列）。 */
function inboxHasPending(inbox: RescueInbox | null | undefined): boolean {
  if (inbox === null || inbox === undefined) {
    return false;
  }
  // 官方两位都是必读数组，`?.` / `?? 0` 挡的是类型外的输入（宿主漂移与测试夹具的
  // 空对象），方向是保守的「当作没有待办」——把缺字段读成有待办会让续跑永久自 veto。
  return (inbox.nextTurn?.length ?? 0) > 0 || (inbox.nextStep?.length ?? 0) > 0;
}

/** 触发前校验结论：`ready` 一支直接带出确认过的 agent——调用方因此不需要再
 *  补一次 `if (current === null) return`（那份判定在旧实现里永远走不到：
 *  agent 为 null 时本函数就返回 not-ready 了）。 */
type PreFireVerdict =
  | { readonly ready: true; readonly agent: RescueAgent }
  | { readonly ready: false; readonly reason: string };

/** 触发前校验：会话仍 idle、inbox 无待处理、且失败轮之后没有新轮开启。
 *  用户中止的判定不在此处（agent/error 时该轮的 turn/end 尚未落盘，见文件头）。 */
function preFireCheck(
  runtime: ApplyRuntime,
  agent: RescueAgent | null,
  failedTurn: number,
): PreFireVerdict {
  if (!agent) {
    return { ready: false, reason: "agent-gone" };
  }
  if (agent.status !== "idle") {
    return { ready: false, reason: "not-idle" };
  }
  if (inboxHasPending(agent.inbox)) {
    return { ready: false, reason: "inbox-pending" };
  }
  // 「有没有更大的 turn/start」只看最大值，投影态这一位对任意日志都与旧倒扫同解。
  const state = factsOf(runtime, agent.session);
  const newer =
    state === undefined
      ? scanNewerTurn(readEvents(agent.session), failedTurn)
      : hasNewerTurn(state, failedTurn);
  if (newer) {
    return { ready: false, reason: "newer-turn" };
  }
  return { ready: true, agent };
}

// ── apply 的模块级受控 helper ─────────────────────────────────────────────
// apply 原本 ~474 行、complexity 24，超 max-lines-per-function(300)
// 与 complexity(20)。用户拍板把内部闭包拆成模块级受控函数，依赖经 ApplyRuntime
// 显式传入——每个函数 <300 行、complexity<20，且消息流转/不变量语义与原先
// apply 闭包完全一致（218 测试零回归）。可变状态（msgSeq/suspendedSnapshots）
// 用 { value } 箱包装，保证按引用读写对 expose 的 webServer 路由仍可见。

/** 失败原文（全量，不截断）：message 优先，回退 code/status 序列化。
 *  入参是**已确认在位**的失败对象（两个调用点都在 failure 缺失时提前返回），
 *  所以这里不再对 `failure?.` 的空值侧做分支——那条降级永远走不到。 */
function failureText(failure: LlmFailureLike): string {
  const parts: string[] = [];
  if (failure.code !== undefined) {
    parts.push(stringifyValue(failure.code));
  }
  if (failure.status !== undefined) {
    parts.push(`status=${stringifyValue(failure.status)}`);
  }
  if (failure.message !== undefined) {
    parts.push(stringifyValue(failure.message));
  }
  return parts.join(" ");
}

/** apply 运行期共享状态的可变箱。闭包拆出 apply 后仍须按引用读写同一份可变
 *  状态：`msgSeq`/`suspendedSnapshots` 用 { value } 包装，使内部自增/整体替换
 *  之后暴露给 webServer 路由的读取依然拿得到最新值（不变量语义零变差）。 */
interface ApplyRuntime {
  svc: HostCtx;
  /** cordis 交进 apply 的那份 volatile 引用配置（旧 `scope` 的等价物）：各消费方
   *  经 `settingsOf()` 现读，设置卡改完下一次读即生效，不必重载插件。 */
  config: PluginConfig;
  scheduler: ResumeScheduler;
  disabledSessions: Set<string>;
  requestRetryCounts: Map<string, number>;
  /** 在途的请求级退避 sleep 释放器集合（item 7）：这些定时器不属于 scheduler，
   *  disposeAll() 管不到它们，插件卸载必须逐个回收，否则卸载后还会唤醒注入。 */
  backoffs: Set<() => void>;
  csrf: string;
  msgSeq: { value: number };
  suspendedSnapshots: { value: SuspendedItem[] };
  /** 待兑 lesson-loop pass 的瞬时失败台账（有界，见 rememberTransientFailure）。
   *  用 { value } 箱与 suspendedSnapshots 同型：整体替换后各处读到的仍是同一份。 */
  transientPasses: { value: TransientPassItem[] };
  /** 投影读口：`ctx.sessionProjections` 到位时由 inject 回调装上（缺席/迟到 ⇒
   *  undefined ⇒ 三处判定走回退扫描）。装箱同 msgSeq 那批：回调晚于本对象构造。 */
  facts: { value: FactsReader | undefined };
}

/** 一条挂起的续跑快照（断连窗口内保留，重连后按原 fireAt 恢复）。 */
interface SuspendedItem {
  sessionId: string;
  pending: PendingRecord;
}

/** 一条「该会话该 provider 刚发生瞬时失败、尚待成功信号」的记录（lesson-loop pass
 *  台账）。`signature` 存**最终串**（transientSignatureOf 的产物）而不是重算素材：
 *  pass 与 report 因此不可能各自算出一份。`cwd` 是 lesson-loop 推导 project 的唯一
 *  入参，必须与 report 当时读到的那一份同源。 */
interface TransientPassItem {
  sessionId: string;
  provider: string;
  signature: string;
  cwd: unknown;
}

/** 一次读全的解析后设置快照（旧 `settings.register` 返回 scope 的 `get()` 等价物）：
 *  续跑/续写/补跑三类注入按事件现读一份，纯值往下传，不必让每个消费方持有引用。
 *  十三项全是 `Config` 里的 volatile 字段（见文件末 configSchema），逐项 `.get()`
 *  即当前值 —— 设置卡改完，下一次读即生效，不必重载插件。 */
interface ResolvedSettings {
  enabled: boolean;
  /** volatile 引用的 `get()` 交回的是**不可变快照**（cosmokit VolatileSnapshot 递归
   *  readonly，见 vendor/cosmokit/src/volatile.ts），故这里收 readonly 数组；本包只读
   *  它做 `includes` 判定，不原地改。 */
  providerExcludes: readonly string[];
  resumeDelayMs: number;
  resumeCooldownMs: number;
  maxResumes: number;
  chainResumeDelayMs: number;
  continueDelayMs: number;
  continueCooldownMs: number;
  maxContinues: number;
  resumeOnOpenTodos: boolean;
  unfinishedDelayMs: number;
  unfinishedCooldownMs: number;
  maxUnfinished: number;
  /** 部署值（非 volatile，装载期定值）：请求级 429 重试的次数上限。 */
  requestRetryMax: number;
  /** 部署值：退避阶梯（毫秒，超出档位取末档）。 */
  requestRetryBackoffMs: readonly number[];
  /** 部署值：本插件愿意代等的上限（毫秒），即阶梯封顶。 */
  requestRetryBackoffCapMs: number;
}

/** 逐字段现读当前设置（引用不变、值可变）。schema 已给全部十三项 `.default()`，
 *  故交进来的引用恒有值 —— 投影本身是否漏项由 test/host.test.ts 的验收用例守住。 */
function settingsOf(config: PluginConfig): ResolvedSettings {
  return {
    enabled: config.enabled.get(),
    providerExcludes: config.providerExcludes.get(),
    resumeDelayMs: config.resumeDelayMs.get(),
    resumeCooldownMs: config.resumeCooldownMs.get(),
    maxResumes: config.maxResumes.get(),
    chainResumeDelayMs: config.chainResumeDelayMs.get(),
    continueDelayMs: config.continueDelayMs.get(),
    continueCooldownMs: config.continueCooldownMs.get(),
    maxContinues: config.maxContinues.get(),
    resumeOnOpenTodos: config.resumeOnOpenTodos.get(),
    unfinishedDelayMs: config.unfinishedDelayMs.get(),
    unfinishedCooldownMs: config.unfinishedCooldownMs.get(),
    maxUnfinished: config.maxUnfinished.get(),
    // 这三项是**非 volatile** 的部署值：cordis 交进来的是值而不是引用（改值随重启
    // 生效），所以这里不带 .get()。
    requestRetryMax: config.requestRetryMax,
    requestRetryBackoffMs: config.requestRetryBackoffMs,
    requestRetryBackoffCapMs: config.requestRetryBackoffCapMs,
  };
}

function findAgent(runtime: ApplyRuntime, sessionId: string): RescueAgent | null {
  const agents = runtime.svc.get("agents");
  if (!agents) {
    return null;
  }
  // 官方 `AgentRegistry.get` 的入参是品牌 `SessionId`（installed dsh-agent/lib/types/index.d.ts:343，
  // 形参类型经 `Parameters<AgentRegistry["get"]>[0]` 索引进本包的 RescueAgents，见那位的注记）；
  // 本包的 sessionId 走的是 HTTP 查询参数/调度器键（裸 string），构造口只有文件头那枚
  // `brandString`（恒等函数，与 MessageId 那一位同一处值导入）。
  return agents.get(brandString<SessionId>(sessionId)) ?? null;
}

function isRootAgent(runtime: ApplyRuntime, agent: RescueAgent): boolean {
  const agents = runtime.svc.get("agents");
  if (!agents) {
    return false;
  }
  for (const root of agents.roots()) {
    if (root.id === agent.id) {
      return true;
    }
  }
  return false;
}

/** 入列挂起快照：同会话去重（后进覆盖），超上限裁剪最旧。 */
function pushSuspended(runtime: ApplyRuntime, sessionId: string, pending: PendingRecord): void {
  const next: SuspendedItem[] = [
    ...runtime.suspendedSnapshots.value.filter((x) => x.sessionId !== sessionId),
    { sessionId, pending },
  ];
  runtime.suspendedSnapshots.value =
    next.length > MAX_SUSPENDED ? next.slice(next.length - MAX_SUSPENDED) : next;
}

/** 移除某会话的挂起快照；返回被移除的待办（无则 null）。 */
function dropSuspended(runtime: ApplyRuntime, sessionId: string): PendingRecord | null {
  let dropped: PendingRecord | null = null;
  runtime.suspendedSnapshots.value = runtime.suspendedSnapshots.value.filter((x) => {
    if (x.sessionId !== sessionId) {
      return true;
    }
    dropped = x.pending;
    return false;
  });
  return dropped;
}

/** 总线沉淀（自进化闭环）：失败事实与注入决策解耦——配额耗尽/冷却/
 *  会话开关都不影响沉淀，度量"同类失败是否被规则抑制"由此才有分母。report 容错。 */
interface LessonInput {
  category: string;
  signature: string;
  detail: string;
  agent: RescueAgent;
  turn: number;
  evidence?: Record<string, unknown>;
}

function reportLesson(runtime: ApplyRuntime, input: LessonInput): void {
  const bus = runtime.svc.get("lessonLoop");
  if (bus === undefined || typeof bus.report !== "function") {
    return;
  }
  settleLessonCall(
    () =>
      bus.report({
        source: "session-rescue",
        category: input.category,
        cwd: input.agent.session.header?.cwd,
        sessionId: input.agent.session.id,
        turn: input.turn,
        signature: input.signature,
        detail: input.detail,
        ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
      }),
    (reason) => {
      console.warn(
        `[session-rescue] lessonLoop report failed: ${String(reason instanceof Error ? reason.message : reason)}`,
      );
    },
  );
}

/** transient-failure 教训的类别名：report 与 pass 必须落在同一张规则卡上，而规则卡
 *  由 (project, category, signature) 三元组定位（project 由 cwd 推导）。三者任一处
 *  各写一遍字面量，迟早漂一个空格/少一段前缀——那时 violation 记在 A 卡、pass 记在
 *  B 卡，被度量的规则永远拿不到"已遵守"观测，复发率结构性 1.0（lesson-loop 只能报
 *  不可判定）。故类别与签名都单源。 */
const TRANSIENT_LESSON_CATEGORY = "transient-failure";

/** 瞬时失败签名（provider + 分类理由）的唯一算式：report 侧与 pass 台账共用，
 *  pass 存的即是本函数的产物，不再重算。 */
export function transientSignatureOf(provider: string | undefined, reason: string): string {
  return `${provider ?? "unknown"} ${reason}`.trim();
}

/** provider 归一键（缺失 → "unknown"）：pass 只在该会话**同一 provider** 的后续
 *  请求真跑成功时才兑，比对的键与签名首段同源。 */
function providerKeyOf(agent: RescueAgent): string {
  return agent.options?.provider ?? "unknown";
}

/** 记下一次瞬时失败（待兑 pass）。同 (会话, 签名) 已在册则不重复记账——本地台账
 *  不随失败次数增长，同一条教训也只兑一次 pass（lesson-loop 侧另有会话去重）。
 *  超上限裁剪最旧，与 pushSuspended 同策。 */
function rememberTransientFailure(runtime: ApplyRuntime, item: TransientPassItem): void {
  const next: TransientPassItem[] = [
    ...runtime.transientPasses.value.filter(
      (x) => !(x.sessionId === item.sessionId && x.signature === item.signature),
    ),
    item,
  ];
  runtime.transientPasses.value =
    next.length > MAX_TRANSIENT_PASS_PENDING
      ? next.slice(next.length - MAX_TRANSIENT_PASS_PENDING)
      : next;
}

/** 会话结束即撤销其未兑付的记录（与 requestRetryCounts/disabledSessions 同一处置点）：
 *  已消失的会话不可能再跑成功，留着只是一条永不兑现的观察，白占台账额度。 */
function dropTransientPasses(runtime: ApplyRuntime, sessionId: string): void {
  runtime.transientPasses.value = runtime.transientPasses.value.filter(
    (x) => x.sessionId !== sessionId,
  );
}

/** lesson-loop pass 入参（总线契约的 pass 面；project 由 bus 内部按 cwd 推导，
 *  故 cwd 必须是 report 当时读到的那一份）。 */
interface LessonPassInput {
  category: string;
  cwd: unknown;
  sessionId: string;
  signature: string;
}

/** pass 上报（度量增强，非主流程依赖）：总线缺席 / 跨版本无 pass / pass 抛错一律
 *  静默降级，只 warn——与 reportLesson 同构，成功路径绝不因总线故障受影响。 */
function reportPass(runtime: ApplyRuntime, input: LessonPassInput): void {
  const bus = runtime.svc.get("lessonLoop");
  if (bus === undefined || typeof bus.pass !== "function") {
    return;
  }
  settleLessonCall(
    () =>
      // `?.` 不是第二道守卫（上面已判过）：TS 不把属性收窄带进闭包，回调里 pass 的可选性
      // 要重新面对；写成方法调用（而不是取出函数）才保住接收方。
      bus.pass?.({
        category: input.category,
        cwd: input.cwd,
        sessionId: input.sessionId,
        signature: input.signature,
      }),
    (reason) => {
      console.warn(
        `[session-rescue] lessonLoop pass failed: ${String(reason instanceof Error ? reason.message : reason)}`,
      );
    },
  );
}

/** 兑 pass：该会话该 provider 在瞬时失败之后**真的跑成功**了一次 → 规则（退避重试
 *  而非换路由/放弃）被遵守。比对按 (会话, provider) 成对匹配，故一条记录只能由它
 *  自己的会话兑走，绝不跨会话串观测。先摘牌后上报：pass 抛错也不补发第二次，
 *  宁可少一条观测也不能给出"没验证过的已遵守"。 */
function emitTransientPasses(runtime: ApplyRuntime, agent: RescueAgent): void {
  const sessionId = agent.session.id;
  const provider = providerKeyOf(agent);
  const due = runtime.transientPasses.value.filter(
    (x) => x.sessionId === sessionId && x.provider === provider,
  );
  if (due.length === 0) {
    return;
  }
  runtime.transientPasses.value = runtime.transientPasses.value.filter(
    (x) => !(x.sessionId === sessionId && x.provider === provider),
  );
  for (const item of due) {
    reportPass(runtime, {
      category: TRANSIENT_LESSON_CATEGORY,
      cwd: item.cwd,
      sessionId: item.sessionId,
      signature: item.signature,
    });
  }
}

// ── 请求级 429 退避等待 ────────────────────────────────────────────────────
/** 带中止感知的退避等待。为什么这里刻意不用 `new Promise` 字面量而是
 *  Promise.withResolvers：语义完全等价（同构造 Promise + resolve），但后者
 *  不触发 promise/avoid-new。本等待必须在「计时到点」「signal 中止」「插件卸载」
 *  三个来源的竞态里只结算一次——中止/卸载要委托 next() 终结、到点要返回重试。
 *  timers/promises 的 setTimeout 无法同时观察外部 signal，也无法替换成宿主
 *  提供的 timer 服务面——故仍为架构必需的显式 Promise（architecture-required）。 */
async function sleepWithAbort(
  timer: { timeout: (fn: () => void, ms: number) => TimerDisposer },
  signal: AbortSignal | undefined,
  ms: number,
  backoffs: Set<() => void>,
): Promise<boolean> {
  // ES2024 lib（Promise.withResolvers）：语义与裸 new Promise 完全等价，但不触发
  // promise/avoid-new。
  const { promise, resolve } = Promise.withResolvers<boolean>();
  let settled = false;
  // 前向引用经 holder 解开（no-use-before-define）：finish 要在 stopTimer 赋值前
  // 存在（作为 timer 回调的捕获），而 stopTimer 只能在 timer.timeout() 返回后有值。
  const holder: { stopTimer: TimerDisposer | null; unregister: (() => void) | null } = {
    stopTimer: null,
    unregister: null,
  };
  const finish = (aborted: boolean): void => {
    if (settled) {
      return;
    }
    settled = true;
    holder.stopTimer?.();
    if (holder.unregister !== null) {
      backoffs.delete(holder.unregister);
    }
    resolve(aborted);
  };
  const onAbort = (): void => {
    finish(true);
  };
  holder.stopTimer = timer.timeout(() => {
    signal?.removeEventListener("abort", onAbort);
    finish(false);
  }, ms);
  // 卸载释放器：结算为「已中止」→ 调用方走 next()，既不重发也不占重试名额。
  holder.unregister = (): void => {
    finish(true);
  };
  backoffs.add(holder.unregister);
  if (signal?.aborted === true) {
    finish(true);
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
  }
  // 等的是本函数自己造的那一场竞态（计时到点 / 外部 abort / 卸载释放器），落地后再交回
  // 结算值：`async` 函数不带 await 会踩 require-await，而 `return await promise`
  // 踩 return-await，故写成落地一跳。调用点（handleRequestError）本来就 await 它，
  // 语义与行为不变。
  const aborted = await promise;
  return aborted;
}

/** 本次重试该等多久（ms）。返回 null = 提供方要求等待超过本插件封顶，等不起，
 *  直接交回 next()（官方 llm-retry 的策略面 maxDelayMs 更大，由它接手）。
 *  item 7：优先服从 provider 的 Retry-After（harness llm-retry/src/index.ts:227
 *  同规则），此前固定阶梯把它完全忽略——429 带 `Retry-After: 120` 时我们仍在
 *  2s 后重发，等于对着限流窗口继续砸请求。
 *  阶梯与封顶都由 entry config 交进来（cap 与 providerRetryAfterMs 同单位 ms），
 *  函数不再回读模块常量——常量只剩 schema 的 `.default()` 一处。 */
function requestBackoffMs(
  count: number,
  providerRetryAfterMs: number | undefined,
  ladderMs: readonly number[],
  capMs: number,
): number | null {
  if (providerRetryAfterMs !== undefined) {
    if (providerRetryAfterMs > capMs) {
      return null;
    }
    return providerRetryAfterMs;
  }
  // 阶梯取第 count 档、超出档位取最后一档。用遍历而不是 `LADDER[i] ?? 0`：
  // 可达性证明——count 唯一来源是 `requestRetryCounts.get(sessionId) ?? 0` 的自增链
  // （0..requestRetryMax-1，≥上限时调用方提前 return），`Math.min` 又把它夹进
  // [0, length-1] 的稠密常量数组下标内，所以 `?? 0` 的右支永远走不到；而
  // noUncheckedIndexedAccess 又不允许直接返回 `LADDER[i]`，只能这样整体消掉。
  let pickedMs = 0;
  let steps = 0;
  for (const stepMs of ladderMs) {
    pickedMs = stepMs;
    steps += 1;
    if (steps > count) {
      break;
    }
  }
  return pickedMs;
}

/** agent/request-error：请求级 429 自动重试（不打断模型运行）。waterfall
 *  返回 {kind:'retry'} → agent-loop 同一回合重发；退避优先服从 provider
 *  Retry-After，否则走固定阶梯，超出 REQUEST_RETRY_MAX 交给 llm-retry（让官方
 *  兜底）。与 agent/error（回合级续跑）互补：请求级先重试，耗尽仍失败才续跑。
 *  等待中 signal 中止 → 委托 next() 终结，不重发**也不占重试名额**。 */
async function handleRequestError(
  runtime: ApplyRuntime,
  payload: RequestErrorPayload,
  next: () => Promise<RequestErrorAction>,
): Promise<RequestErrorAction> {
  const { agent } = payload;
  if (agent === null || agent === undefined) {
    return next();
  }
  const cfg = settingsOf(runtime.config);
  if (!cfg.enabled) {
    return next();
  }
  const { failure } = payload;
  if (failure === null || failure === undefined) {
    return next();
  }
  const text = `${failure.code ?? ""} ${failure.message ?? ""}`;
  const status = failure.status ?? 0;
  const isRateLimit =
    status === 429 ||
    /\b429\b|rate[\s_.-]*limit|throttl|too many/iu.test(text) ||
    /\bquota[\s_-]*(?:exceeded|exhausted|reached|limit)\b|\busage[\s_-]+limit\b/iu.test(text);
  if (!isRateLimit) {
    return next();
  }
  const sessionId = agent.session.id;
  const retryCount = runtime.requestRetryCounts.get(sessionId) ?? 0;
  if (retryCount >= cfg.requestRetryMax) {
    runtime.requestRetryCounts.delete(sessionId);
    return next();
  }
  const delayMs = requestBackoffMs(
    retryCount,
    failure.providerRetryAfterMs,
    cfg.requestRetryBackoffMs,
    cfg.requestRetryBackoffCapMs,
  );
  if (delayMs === null) {
    console.info(
      `[session-rescue] ${sessionId}: provider Retry-After ${String(failure.providerRetryAfterMs)}ms exceeds ${String(cfg.requestRetryBackoffCapMs)}ms cap — delegating to llm-retry`,
    );
    return next();
  }
  // 退避等待：第 n 次重试取阶梯第 n 档；等待中回合被中止（用户停止/会话关闭）
  // → 委托 next() 终结，不重发。名额只在真的要重发时才占用（item 7：原先
  // 先 ++ 再判 abort，白等一场还要烧掉一次配额）。
  if (delayMs > 0) {
    const abortedDuringWait = await sleepWithAbort(
      runtime.svc.timer,
      payload.signal ?? undefined,
      delayMs,
      runtime.backoffs,
    );
    if (abortedDuringWait) {
      return next();
    }
  }
  runtime.requestRetryCounts.set(sessionId, retryCount + 1);
  return { kind: "retry" };
}

/** 调度一次自动注入（resume/continue/unfinished 共用）：经 scheduler 限频限次 →
 *  定时器 → 触发前校验 → followup。三种 kind 各自独立的次数上限与冷却。
 *  参数以 opts 对象聚合（保持函数参数 ≤ max-params 上限）。 */
interface InjectionOptions {
  agent: RescueAgent;
  turn: number;
  kind: RescueKind;
  text: string;
  chainDelayMs?: number;
}

function scheduleInjection(runtime: ApplyRuntime, opts: InjectionOptions): void {
  const { agent, turn, kind, text, chainDelayMs = 0 } = opts;
  const cfg = settingsOf(runtime.config);
  const sessionId = agent.session.id;
  let timing: { delayMs: number; cooldownMs: number; maxResumes: number };
  if (kind === "resume") {
    timing = {
      delayMs: cfg.resumeDelayMs,
      cooldownMs: cfg.resumeCooldownMs,
      maxResumes: cfg.maxResumes,
    };
  } else if (kind === "continue") {
    timing = {
      delayMs: cfg.continueDelayMs,
      cooldownMs: cfg.continueCooldownMs,
      maxResumes: cfg.maxContinues,
    };
  } else {
    timing = {
      delayMs: cfg.unfinishedDelayMs,
      cooldownMs: cfg.unfinishedCooldownMs,
      maxResumes: cfg.maxUnfinished,
    };
  }
  const decision = runtime.scheduler.onFailure({
    sessionId,
    turn,
    kind,
    delayMs: timing.delayMs,
    cooldownMs: timing.cooldownMs,
    maxResumes: timing.maxResumes,
    chainDelayMs: kind === "resume" ? chainDelayMs : 0,
  });
  if (decision.action === "skip") {
    // skip（pending/配额/冷却）是正常流控，不是错误：log 级即可（旧用 error 级刷屏）。
    console.info(`[session-rescue] ${sessionId}: auto-${kind} skipped (${decision.reason})`);
    return;
  }
  if (decision.chained) {
    console.info(
      `[session-rescue] ${sessionId}: chained failure at turn ${turn} (rescue-opened turn) — bypassing cooldown, re-scheduling in ${decision.delayMs}ms`,
    );
  } else {
    console.info(
      `[session-rescue] ${sessionId}: ${kind} trigger at turn ${turn} — auto-${kind} in ${decision.delayMs}ms`,
    );
  }
  const dispose = runtime.svc.timer.timeout(() => {
    const check = preFireCheck(runtime, findAgent(runtime, sessionId), turn);
    if (!check.ready) {
      runtime.scheduler.settle(sessionId, "skipped");
      console.info(
        `[session-rescue] ${sessionId}: auto-${kind} vetoed at fire time (${check.reason})`,
      );
      return;
    }
    const current = check.agent;
    runtime.msgSeq.value += 1;
    try {
      // 官方 `followup(message: UserMessage)`（dsh-agent lib/types/runtime-types.d.ts:192）
      // 要求的正是官方消息形状：`id` 是幻影品牌 `MessageId`（dsh-llm lib/types/brand.d.ts:14），
      // 只能由官方 `brandString` 送出（见文件头列出的 dsh-brand 值导入）；`source.kind` 由本包
      // 上方的 producer 声明进 `MessageSourceMap`——不再是本包自说自话的 `message: unknown`。
      current.followup({
        id: brandString<MessageId>(`${PLUGIN_NAME}-${Date.now()}-${runtime.msgSeq.value}`),
        role: "user",
        content: [{ type: "text", text }],
        source: { kind: RESCUE_SOURCE_KIND },
      });
      runtime.scheduler.settle(sessionId, "fired");
      console.info(`[session-rescue] ${sessionId}: auto-${kind} message sent`);
    } catch (error) {
      // 发送抛错（通常是传输/连接类瞬时问题）：不丢待办，挂起等待重连恢复，
      // 由 client 的 connection/reset 信号触发重新武装（聪明重试：断连窗口
      // 内不再空发，重连后按原 fireAt 剩余时间补发）。
      const pending = runtime.scheduler.suspendSession(sessionId);
      if (pending === null) {
        console.error(
          `[session-rescue] ${sessionId}: failed to send auto-${kind}: ${String(error)}`,
        );
      } else {
        pushSuspended(runtime, sessionId, pending);
        console.error(
          `[session-rescue] ${sessionId}: auto-${kind} send failed (${String(error)}) — pending preserved; will re-fire after connection/reset`,
        );
      }
    }
  }, decision.delayMs);
  runtime.scheduler.attachTimer(sessionId, dispose);
}

// ── 连接感知（dsh 0.1.2-alpha.2）：client 在 connection/reset 时通知"传输已
//    就绪"。host 曾挂起的自动续跑待办在此恢复并重新武装定时器。挂起发生在
//    fire 发送抛错（见 scheduleInjection）；client 侧仅做恢复方向（断连本身不臆测）。
//    恢复前过闸门（审查修正）：全局 enabled 或会话 disabled 时
//    丢弃快照（不补发）——被用户关闭的功能不得在重连后悄悄恢复执行。
//    两道闸门并成一个 `||` 而不是 if/else-if：可达性证明——`disabledSessions.add`
//    只发生在 toggle 路由的关闭支，而该支紧接着就 `dropSuspended(sessionId)`
//    （并 cancel 已武装定时器，之后该会话也不可能再产生快照），故「快照存在 &&
//    该会话已 disabled」在今日的装配线下不可达，独立分支的文案永远测不到。
//    合并后两条闸门逐项照旧生效。
function resumeAfterReconnect(runtime: ApplyRuntime): void {
  if (runtime.suspendedSnapshots.value.length === 0) {
    return;
  }
  const snapshots = runtime.suspendedSnapshots.value;
  runtime.suspendedSnapshots.value = [];
  const cfg = settingsOf(runtime.config);
  for (const item of snapshots) {
    if (!cfg.enabled || runtime.disabledSessions.has(item.sessionId)) {
      console.info(
        `[session-rescue] ${item.sessionId}: suspended auto-${item.pending.kind} dropped (disabled: plugin off or session toggle off)`,
      );
    } else {
      // kind 恒为 RescueKind（待办由 scheduler 进程内产生，无持久化/跨版本反序列化），
      // textForKind 的返回类型因此收敛为 `string`：调用方不再需要 null 降级分支
      // （这层的防御改在 textForKind 内部对闭合集之外的 kind 直接抛错）。
      const text = textForKind(item.pending.kind, hostMessages(runtime.svc));
      // 剩余时间走调度器注入时钟的 remainingMsFor(fireAt)（与 state 路由
      // 同一算式）。此前是 restorePending 之后再 `remainingMs(sessionId)` 读回——
      // restorePending 返回 true 即已把 pending 写进同一条记录，紧随其后的同步读
      // 不可能返回 null，那条 `!== null` 降级不可达。
      if (runtime.scheduler.restorePending(item.sessionId, item.pending)) {
        const remaining = runtime.scheduler.remainingMsFor(item.pending.fireAt);
        runtime.msgSeq.value += 1;
        // 断连重发路径与 scheduleInjection 的 fire 路径同一形状：官方 `UserMessage.id` 要
        // 的是品牌串（dsh-llm lib/types/brand.d.ts:14），构造口只有官方 `brandString`。
        const msgId = brandString<MessageId>(
          `${PLUGIN_NAME}-${Date.now()}-${runtime.msgSeq.value}`,
        );
        const dispose = runtime.svc.timer.timeout(() => {
          const check = preFireCheck(
            runtime,
            findAgent(runtime, item.sessionId),
            item.pending.turn,
          );
          if (!check.ready) {
            runtime.scheduler.settle(item.sessionId, "skipped");
            console.info(
              `[session-rescue] ${item.sessionId}: auto-${item.pending.kind} vetoed at re-fire (${check.reason})`,
            );
            return;
          }
          const current = check.agent;
          try {
            current.followup({
              id: msgId,
              role: "user",
              content: [{ type: "text", text }],
              source: { kind: RESCUE_SOURCE_KIND },
            });
            runtime.scheduler.settle(item.sessionId, "fired");
            console.info(
              `[session-rescue] ${item.sessionId}: auto-${item.pending.kind} message sent after reconnect`,
            );
          } catch (error) {
            // 恢复后再次发送失败：再挂起一次，等下一次 connection/reset。
            const pending = runtime.scheduler.suspendSession(item.sessionId);
            if (pending === null) {
              console.error(
                `[session-rescue] ${item.sessionId}: failed to send auto-${item.pending.kind} after reconnect: ${String(error)}`,
              );
            } else {
              pushSuspended(runtime, item.sessionId, pending);
              console.error(
                `[session-rescue] ${item.sessionId}: re-fire failed (${String(error)}) — preserved, waiting next reconnect`,
              );
            }
          }
        }, remaining);
        runtime.scheduler.attachTimer(item.sessionId, dispose);
      }
    }
  }
}

/** 观察性兜底：疑似限流但被判永久 → 打日志 + 总线沉淀（误分类本身就是匹配器
 *  扩展的线索，signature 带上分类理由）。 */
function observeUnclassifiedFailure(
  runtime: ApplyRuntime,
  agent: RescueAgent,
  failure: LlmFailureLike,
  verdictReason: string,
  turn: number,
): void {
  const provider = agent.options ? agent.options.provider : undefined;
  console.error(
    `[session-rescue] ${agent.id} (${provider ?? "?"}): failure looks rate-limit-ish but classified permanent (${verdictReason}) — matcher may need extension: ${stringifyValue(failure.message).slice(0, 160)}`,
  );
  reportLesson(runtime, {
    category: "unclassified-failure",
    signature: provider ?? "unknown",
    detail: failureText(failure),
    agent,
    turn,
    evidence: { reason: verdictReason },
  });
}

function handleAgentError(runtime: ApplyRuntime, payload: AgentErrorPayload): void {
  const { agent } = payload;
  if (!agent) {
    return;
  }
  const cfg = settingsOf(runtime.config);
  if (!cfg.enabled) {
    return;
  }
  const provider = agent.options ? agent.options.provider : undefined;
  if (typeof provider === "string" && cfg.providerExcludes.includes(provider)) {
    return;
  }
  const turn = typeof payload.turn === "number" ? payload.turn : 0;
  // 官方 `agent/error` 的 `error` 位是 `unknown`（dsh-agent lib/types/runtime-types.d.ts:406，
  // 注记 "the failure, verbatim"）：抛出的可能是自带 `.failure` 的 `LlmError`，也可能是任何
  // 普通 Error（无 `.failure`），类型面给不出形状 → 走本文件既有的守卫投影，不经断言。
  // `Record<string, unknown>` 交得进 `classifyFailure`/`looksRateLimitish`/`failureText`，
  // 是因为它们的入参本就是 `Partial<LlmFailure>`（lib/failure-classify.ts:20，官方派生）——
  // 可选位在源里不存在即可，故这里不需要任何字段级重映射。
  const failure = fieldOf(payload.error, "failure");
  if (!isRecord(failure)) {
    // error 是普通 Error（非 LlmError）：根本没有 failure 面可分类，一律永久、
    // 不注入。原先靠 classifyFailure 的 not-a-failure 降级间接达成，现在写死在
    // 类型上：failureText 的入参因此是**已确认在位**的对象，无需再防御。
    return;
  }
  const verdict = classifyFailure(failure);
  if (!verdict.transient) {
    // 观察性兜底：疑似限流但被判永久 → 打日志以便扩展匹配器。
    if (looksRateLimitish(failure)) {
      observeUnclassifiedFailure(runtime, agent, failure, verdict.reason, turn);
    }
    return;
  }

  // 总线沉淀：瞬时失败（限流/服务端/超时…）。signature = provider + 分类理由——
  // 同 provider 的同类瞬时失败反复发生（尤其 429 链）是最常见的高频教训。
  const signature = transientSignatureOf(provider, verdict.reason);
  reportLesson(runtime, {
    category: TRANSIENT_LESSON_CATEGORY,
    signature,
    detail: failureText(failure),
    agent,
    turn,
    evidence: { reason: verdict.reason },
  });
  // 同一处登记"待兑 pass"：本会话该 provider 之后真跑成功一次，才说明规则
  // （退避重试而非换路由/放弃）被遵守。与沉淀解耦——非根会话/已关会话同样记账，
  // 只是它们到不了成功信号（兑不出去，随会话 dispose 撤销）。
  rememberTransientFailure(runtime, {
    sessionId: agent.session.id,
    provider: providerKeyOf(agent),
    signature,
    cwd: agent.session.header?.cwd,
  });

  if (!isRootAgent(runtime, agent)) {
    return;
  }
  const sessionId = agent.session.id;
  if (runtime.disabledSessions.has(sessionId)) {
    return;
  }
  // 该回合的 opener（一次读，两位判定共用；此前是两次全量倒扫）。
  const opener = openerKindOf(runtime, agent, turn);
  // goal 轮次驱动的失败回合：goal-round-driver 自己监听 agent/error 并驱动下一轮，
  // 此处再注入就是抢它的话（文件头不变量：三类注入一律让路）。
  if (opener === GOAL_SOURCE_KIND) {
    console.info(
      `[session-rescue] ${sessionId}: turn ${turn} is goal-driven — resume suppressed (goal-round-driver owns it)`,
    );
    return;
  }
  // 链式例外：失败轮由本插件上次 fire 开启 → 不受冷却拦截，改按
  // max(resumeDelayMs, chainResumeDelayMs) 重调度（跨出限流窗口）。
  // 曾经这里是 `|| CHAIN_RESUME_DELAY_MS_DEFAULT`：schema 的 min(1000) 让 0 不可表示
  // （行 config 与设置卡都过同一份 schema），右支永远走不到，留着反而暗示「0 有含义」。
  const chainDelayMs = opener === RESCUE_SOURCE_KIND ? cfg.chainResumeDelayMs : 0;
  scheduleInjection(runtime, {
    agent,
    turn,
    kind: "resume",
    text: hostMessages(runtime.svc).resumeText,
    chainDelayMs,
  });
}

/** agent/status 处理器（回合终态：max-tokens→continue，completed→unfinished/配额恢复）。 */
interface CompletedTurnOptions {
  turn: number;
  openTodos: number | null;
  todoUpdatedInTurn: boolean;
  awaitsUser: boolean;
  goalDrivenTurn: boolean;
}

function handleCompletedTurn(
  runtime: ApplyRuntime,
  agent: RescueAgent,
  cfg: ResolvedSettings,
  sessionId: string,
  opts: CompletedTurnOptions,
): void {
  // completed：先重置失败配额——失败序列已断（A）。
  runtime.scheduler.onSuccess(sessionId);
  // 同一个成功信号也是 lesson-loop 的 pass：瞬时失败发生过、之后同 provider 的请求
  // 真的跑完了整个回合 → 退避重试这条规则被遵守。必须在下面的清单/开关判定**之前**
  // 兑——那几项与"这一轮有没有跑成功"无关，提前 return 会把观测整批吞掉。
  emitTransientPasses(runtime, agent);

  // 清单从未写过（null）→ 无从判断；写过但属更早回合 → 陈旧，不据此触发。
  if (opts.openTodos === null || !opts.todoUpdatedInTurn) {
    return;
  }
  if (opts.openTodos === 0) {
    runtime.scheduler.onTodosClosed(sessionId);
    return;
  }
  // 未闭合但需抑制：模型在等用户 / 回合由 goal 轮次驱动 / 开关关闭。
  if (!cfg.resumeOnOpenTodos) {
    return;
  }
  if (opts.awaitsUser) {
    return;
  }
  if (opts.goalDrivenTurn) {
    return;
  }
  // 总线沉淀：带着未闭合待办结束回合（等用户/goal 驱动的合法收尾不计）。
  const messages = hostMessages(runtime.svc);
  reportLesson(runtime, {
    category: "unfinished-turn",
    signature: "open-todos",
    detail: messages.unfinishedLessonDetail.replaceAll("{count}", String(opts.openTodos)),
    agent,
    turn: opts.turn,
    evidence: { openTodos: opts.openTodos },
  });
  scheduleInjection(runtime, {
    agent,
    turn: opts.turn,
    kind: "unfinished",
    text: messages.unfinishedText,
  });
}

function handleAgentStatus(
  runtime: ApplyRuntime,
  payload: AgentStatusPayload | null | undefined,
): void {
  if (payload === null || payload === undefined) {
    return;
  }
  if (payload.status !== "idle") {
    return;
  }
  const { agent } = payload;
  if (!agent) {
    return;
  }
  // 请求级 429 重试计数按会话累加且从不重置——长跑会话把零星 429
  // 累加到 REQUEST_RETRY_MAX 后永久不再兜底重试（第 6 次直接交给 llm-retry，而
  // sensenova 等 QUOTA 未配置 → 回合失败），且 Map 随会话增长泄漏。回合收口
  // （status→idle）= 请求周期结束（重试循环内 status 恒为 running，不会误重置），
  // 此处重置该会话计数——放在 root/disabled/review 判定之前，任何 idle 都清，兼防泄漏。
  const idleSid = agent.session.id;
  if (typeof idleSid === "string") {
    runtime.requestRetryCounts.delete(idleSid);
  }
  const cfg = settingsOf(runtime.config);
  if (!cfg.enabled) {
    return;
  }
  if (!isRootAgent(runtime, agent)) {
    return;
  }
  const sessionId = agent.session.id;
  if (runtime.disabledSessions.has(sessionId)) {
    return;
  }

  const review = reviewOf(runtime, agent);
  if (review.lastTurn === null) {
    return;
  }

  // E5：用户中止/打断的回合既不调度也不重置配额（不消耗、不恢复，原样保留）。
  // 这是 abort 判定的**唯一**存活位置：turn/end 此刻已落盘。
  if (review.lastReasonKind === "aborted" || review.lastReasonKind === "interrupted") {
    return;
  }

  if (review.lastReasonKind === "max-tokens") {
    // goal 轮次驱动的截断：与 resume 同理让路（判定免费，review 已算好）。
    if (review.goalDrivenTurn) {
      console.info(
        `[session-rescue] ${sessionId}: turn ${review.lastTurn} is goal-driven — continue suppressed`,
      );
      return;
    }
    // 总线沉淀：输出截断（provider 维度签名——长输出任务撞顶是可改进的工作方式问题）。
    reportLesson(runtime, {
      category: "max-tokens",
      signature: agent.options?.provider ?? "unknown",
      detail: hostMessages(runtime.svc).maxTokensLessonDetail,
      agent,
      turn: review.lastTurn,
    });
    scheduleInjection(runtime, {
      agent,
      turn: review.lastTurn,
      kind: "continue",
      text: hostMessages(runtime.svc).continueText,
    });
    return;
  }
  if (review.lastReasonKind !== "completed") {
    return;
  }
  handleCompletedTurn(runtime, agent, cfg, sessionId, {
    turn: review.lastTurn,
    openTodos: review.openTodos,
    todoUpdatedInTurn: review.todoUpdatedInTurn,
    awaitsUser: review.awaitsUser,
    goalDrivenTurn: review.goalDrivenTurn,
  });
}

// ── 官方 llm-retry 策略读写通道 ────────────────────────────────────────────
// 背景：pi-ai 对 429+insufficient_quota 归码 QUOTA（官方测试锁定语义），
// 默认 retryableCodes 不含 QUOTA → llm-retry 放行 → 请求级 5 次瞬发耗尽 →
// 回合失败。此通道把官方 provider 级 retryPolicy 配置面暴露到本插件设置卡：
// GET 列出 llm-pi-ai 全部 providers 与当前策略摘要；POST 按 preset 经
// settings.mutate 落盘（validator 在写处把关，坏值 settings-rejected）。
// preset → 官方 RetryPolicyConfig（retry-policy.ts:100 z.union([normal, always])）：
//   default   → unset（回官方默认：normal 5 次，码表 RATE_LIMIT/SERVER/
//               TIMEOUT/TRANSPORT/EMPTY_RESPONSE，500ms→10s）
//   enhanced  → normal 12 次 + QUOTA + 8s→60s（settings.yaml 现行四家同款）
//   always    → 官方无限重试（until success/cancellation/disposal）+ 5s→60s
//   off       → normal maxRetries:0（码表非空校验所迫带单 RATE_LIMIT 占位）
//
// 用 Map 而不是字面量 Record：preset 名来自 POST body（不可信输入），
// `RETRY_PRESETS["constructor"]` / `["toString"]` / `["__proto__"]` 在对象表上
// 都**不是** undefined —— 400 闸门被原型键绕过，`value: undefined` 被发给
// settings.mutate 并回 200（item 4）。Map.get 只看自有条目，原型链无从命中。
type RetryPreset =
  | { readonly op: "set"; readonly value: Record<string, unknown> }
  | { readonly op: "unset" };

const RETRY_PRESETS = new Map<string, RetryPreset>([
  ["default", { op: "unset" }],
  [
    "enhanced",
    {
      op: "set",
      value: {
        mode: "normal",
        maxRetries: 12,
        retryableCodes: ["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT", "QUOTA"],
        backoff: { initialDelayMs: 8000, maxDelayMs: 60_000, jitterRatio: 0.2 },
      },
    },
  ],
  [
    "always",
    {
      op: "set",
      value: {
        mode: "always",
        backoff: { initialDelayMs: 5000, maxDelayMs: 60_000, jitterRatio: 0.2 },
      },
    },
  ],
  [
    "off",
    {
      op: "set",
      value: {
        mode: "normal",
        maxRetries: 0,
        retryableCodes: ["RATE_LIMIT"],
        backoff: { initialDelayMs: 1000, maxDelayMs: 1000, jitterRatio: 0 },
      },
    },
  ],
]);

/** 从 describe 的 namespace value 投影出 providers（动态键 + 守卫，不经 unsafe 断言）。 */
function piAiProviders(runtime: ApplyRuntime): Record<string, { retryPolicy?: unknown }> | null {
  try {
    const hit = runtime.svc.settings.describe().find((desc) => desc.ns === PI_AI_NS);
    const rawProviders = fieldOf(hit?.value, "providers");
    if (!isRecord(rawProviders)) {
      return null;
    }
    const providers: Record<string, { retryPolicy?: unknown }> = {};
    for (const [name, profile] of Object.entries(rawProviders)) {
      if (isRecord(profile)) {
        providers[name] = { retryPolicy: fieldOf(profile, "retryPolicy") };
      }
    }
    return providers;
  } catch {
    return null;
  }
}

/** retry-policy 的异步体（item 6）。跨域 → CSRF → 读 body → 413/400 整条前置链
 *  交给 shared `guardBody`：原先手写 `req.on("data"/"end")` 只监听这两个事件，
 *  流 error/abort 没有任何路径（响应就那么挂着），且 `raw += String(chunk)` 会把
 *  跨 chunk 边界的多字节字符解成 U+FFFD —— 仍是合法 JSON，静默写坏用户配置。
 *  shared 版按 UTF-8 字节累积 Buffer、先查 content-length 再收流。
 *  本函数总（total）：唯一的抛错点 settings.mutate 已就地 catch 成 500，其余
 *  语句（guardBody/JSON.parse/Map.get）各自消化失败，故调用方无需再兜 reject。 */
async function handleRetryPolicy(
  runtime: ApplyRuntime,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const raw = await guardBody(req, res, {
    maxBytes: RETRY_POLICY_BODY_MAX_BYTES,
    csrf: { token: runtime.csrf, headerName: RESCUE_CSRF_HEADER },
  });
  if (raw === null) {
    // guardBody 已经把 403/413/400 发出去了。
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { ok: false, error: "invalid json body" });
    return;
  }
  const body = isRecord(parsed) ? parsed : {};
  const provider = typeof body["provider"] === "string" ? body["provider"] : "";
  const preset = typeof body["preset"] === "string" ? body["preset"] : "";
  if (provider === "" || preset === "") {
    sendJson(res, 400, { ok: false, error: "provider and preset required" });
    return;
  }
  const mapped = RETRY_PRESETS.get(preset);
  if (mapped === undefined) {
    sendJson(res, 400, { ok: false, error: `unknown preset: ${preset}` });
    return;
  }
  const op: SettingsPathOp =
    mapped.op === "unset"
      ? { op: "unset", path: ["providers", provider, "retryPolicy"] }
      : { op: "set", path: ["providers", provider, "retryPolicy"], value: mapped.value };
  // CAS：先取 `llm-pi-ai` 那条的当前 revision 再写。mutate 的第 3 参缺省 = 无条件覆盖
  // （官方 index.d.ts:114 `mutate(ns, ops, expectedRevision?)`），而本路由写的是**另一个
  // 条目**的 `providers.<p>.retryPolicy`：用户同时在设置页改该 provider 时，无 CAS 会把
  // 对方刚写入的值静默抹掉，且两边都以为保存成功。取不到数字 revision（条目未投影）时
  // 传 undefined——此时 mutate 自己会抛 `No configurable plugin entry`，不会盲写。
  const piAiRevision = runtime.svc.settings.describe().find((row) => row.ns === PI_AI_NS)?.revision;
  const expectedRevision = typeof piAiRevision === "number" ? piAiRevision : undefined;
  try {
    await runtime.svc.settings.mutate(PI_AI_NS, [op], expectedRevision);
    sendJson(res, 200, { ok: true, provider, preset });
  } catch (error: unknown) {
    if (isSettingsConflict(error)) {
      // 不自动重试：重试等于拿刚读到的新值再盖一次，替并发写入方背书。让卡片提示刷新后重试。
      sendJson(res, 409, { ok: false, error: "settings-revision-conflict" });
      return;
    }
    console.error(`[session-rescue] retry-policy mutate failed (${provider}/${preset}):`, error);
    sendJson(res, 500, { ok: false, error: errorText(error) });
  }
}

/** 路由注册动作：注册一条并把它的释放器推进 disposers（六条共用同一份释放器表）。 */
type AddRescueRoute = (route: Parameters<RescueWebServer["register"]>[0]) => void;

/** `/state` 的会话表：调度器快照、禁用位与挂起待办三者的合并投影。 */
function stateSessionsOf(runtime: ApplyRuntime): Record<string, unknown> {
  const { scheduler, disabledSessions, suspendedSnapshots } = runtime;
  const snap = scheduler.stateSnapshot();
  const sessions: Record<string, unknown> = {};
  for (const [id, rec] of Object.entries(snap)) {
    sessions[id] = { ...rec, disabled: disabledSessions.has(id) };
  }
  for (const id of disabledSessions) {
    if (sessions[id] === undefined) {
      sessions[id] = { count: 0, lastFireAt: 0, pending: null, disabled: true };
    }
  }
  // 挂起中的待办并入 state（修正）：断连窗口里 UI 也要看得到
  // 横幅并可取消，否则用户对"已挂起待重连"的续跑既不知情也无法干预。
  for (const item of suspendedSnapshots.value) {
    const { pending } = item;
    const prevValue = sessions[item.sessionId];
    const prevRecord = isRecord(prevValue) ? prevValue : undefined;
    const prevCount = typeof prevRecord?.["count"] === "number" ? prevRecord["count"] : 0;
    const prevLastFire =
      typeof prevRecord?.["lastFireAt"] === "number" ? prevRecord["lastFireAt"] : 0;
    sessions[item.sessionId] = {
      count: prevCount,
      lastFireAt: prevLastFire,
      pending: {
        turn: pending.turn,
        kind: pending.kind,
        fireAt: pending.fireAt,
        // E3：走调度器注入时钟（与 scheduler.remainingMs 同源），
        // 不再直调 Date.now() 致 UI 倒计时与真实 fire 时刻漂移。
        remainingMs: scheduler.remainingMsFor(pending.fireAt),
        chained: pending.chained === true,
        suspended: true,
      },
      disabled: disabledSessions.has(item.sessionId),
    };
  }
  return sessions;
}

/** GET /state 的注册。 */
function registerStateRoute(
  runtime: ApplyRuntime,
  servingNonLoopback: boolean,
  add: AddRescueRoute,
): void {
  add({
    kind: "exact",
    path: STATE_PATH,
    handler: (req, res) => {
      // 信任闸门（shared/lib/trust）：必须是 handler 体的第一条语句——先验权威再谈方法/参数。
      if (!guardTrust(req, res, { servingNonLoopback })) {
        return;
      }
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        sendJson(res, 405, { ok: false, error: "GET only" });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        sessions: stateSessionsOf(runtime),
        csrf: runtime.csrf,
      });
    },
  });
}

/** POST /cancel 的注册。 */
function registerCancelRoute(
  runtime: ApplyRuntime,
  servingNonLoopback: boolean,
  add: AddRescueRoute,
): void {
  add({
    kind: "exact",
    path: CANCEL_PATH,
    handler: (req, res) => {
      // 信任闸门（shared/lib/trust）：必须是 handler 体的第一条语句——先验权威再谈方法/参数。
      if (!guardTrust(req, res, { servingNonLoopback })) {
        return;
      }
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        sendJson(res, 405, { ok: false, error: "POST only" });
        return;
      }
      // 自家 isCrossOrigin 支在 trust 之后不可达：trust 的 sec-fetch-site 白名单更严且文案相同，
      // 拒答由上面那道闸门给出。
      if (!checkRescueCsrf(req, runtime.csrf)) {
        sendJson(res, 403, { ok: false, error: CSRF_REJECT_ERROR });
        return;
      }
      const sessionId = queryParam(req, "sessionId");
      if (sessionId === null || sessionId === "") {
        sendJson(res, 400, { ok: false, error: "missing sessionId" });
        return;
      }
      const sched = runtime.scheduler.cancel(sessionId);
      // 挂起中的待办同样要可取消（修正）：断连窗口里点"取消"
      // 必须能阻止重连后的补发。
      const dropped = dropSuspended(runtime, sessionId);
      if (sched.cancelled) {
        sendJson(res, 200, { ok: true, ...sched });
        return;
      }
      if (dropped !== null) {
        sendJson(res, 200, { ok: true, cancelled: true, turn: dropped.turn });
        return;
      }
      sendJson(res, 200, { ok: true, ...sched });
    },
  });
}

/** POST /toggle 的注册。 */
function registerToggleRoute(
  runtime: ApplyRuntime,
  servingNonLoopback: boolean,
  add: AddRescueRoute,
): void {
  add({
    kind: "exact",
    path: TOGGLE_PATH,
    handler: (req, res) => {
      // 信任闸门（shared/lib/trust）：必须是 handler 体的第一条语句——先验权威再谈方法/参数。
      if (!guardTrust(req, res, { servingNonLoopback })) {
        return;
      }
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        sendJson(res, 405, { ok: false, error: "POST only" });
        return;
      }
      // 自家 isCrossOrigin 支在 trust 之后不可达：trust 的 sec-fetch-site 白名单更严且文案相同，
      // 拒答由上面那道闸门给出。
      if (!checkRescueCsrf(req, runtime.csrf)) {
        sendJson(res, 403, { ok: false, error: CSRF_REJECT_ERROR });
        return;
      }
      const sessionId = queryParam(req, "sessionId");
      if (sessionId === null || sessionId === "") {
        sendJson(res, 400, { ok: false, error: "missing sessionId" });
        return;
      }
      const { disabledSessions } = runtime;
      if (disabledSessions.has(sessionId)) {
        disabledSessions.delete(sessionId);
      } else {
        disabledSessions.add(sessionId);
        // 关闭开关即解除已武装的续跑
        runtime.scheduler.cancel(sessionId);
        // 挂起中的待办一并清除（修正）
        dropSuspended(runtime, sessionId);
      }
      sendJson(res, 200, { ok: true, disabled: disabledSessions.has(sessionId) });
    },
  });
}

/** POST /resume 的注册（连接就绪通知）。 */
function registerResumeNotifyRoute(
  runtime: ApplyRuntime,
  servingNonLoopback: boolean,
  add: AddRescueRoute,
): void {
  // 连接感知：client 在 connection/reset（dsh 0.1.2-alpha.2 网关重连）时
  // 通知"传输已就绪"，host 恢复挂起的自动续跑待办并重新武装定时器。
  add({
    kind: "exact",
    path: RESUME_NOTIFY_PATH,
    handler: (req, res) => {
      // 信任闸门（shared/lib/trust）：必须是 handler 体的第一条语句——先验权威再谈方法/参数。
      if (!guardTrust(req, res, { servingNonLoopback })) {
        return;
      }
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        sendJson(res, 405, { ok: false, error: "POST only" });
        return;
      }
      // 自家 isCrossOrigin 支在 trust 之后不可达：trust 的 sec-fetch-site 白名单更严且文案相同，
      // 拒答由上面那道闸门给出。
      if (!checkRescueCsrf(req, runtime.csrf)) {
        sendJson(res, 403, { ok: false, error: CSRF_REJECT_ERROR });
        return;
      }
      const restored = runtime.suspendedSnapshots.value.length;
      resumeAfterReconnect(runtime);
      sendJson(res, 200, { ok: true, restored });
    },
  });
}

/** GET /retry-providers 的注册。 */
function registerRetryProvidersRoute(
  runtime: ApplyRuntime,
  servingNonLoopback: boolean,
  add: AddRescueRoute,
): void {
  add({
    kind: "exact",
    path: RETRY_PROVIDERS_PATH,
    handler: (req, res) => {
      // 信任闸门（shared/lib/trust）：必须是 handler 体的第一条语句——先验权威再谈方法/参数。
      if (!guardTrust(req, res, { servingNonLoopback })) {
        return;
      }
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        sendJson(res, 405, { ok: false, error: "GET only" });
        return;
      }
      const providers = piAiProviders(runtime);
      if (providers === null) {
        sendJson(res, 200, { ok: false, error: "llm-pi-ai settings unavailable" });
        return;
      }
      const list: { provider: string; mode: string; maxRetries: number; hasQuota: boolean }[] = [];
      for (const [name, profile] of Object.entries(providers)) {
        const rp = fieldOf(profile, "retryPolicy");
        const rpRec = isRecord(rp) ? rp : undefined;
        const mode = typeof rpRec?.["mode"] === "string" ? rpRec["mode"] : "normal";
        const maxRetries = typeof rpRec?.["maxRetries"] === "number" ? rpRec["maxRetries"] : 5;
        const codes = Array.isArray(rpRec?.["retryableCodes"]) ? rpRec["retryableCodes"] : [];
        list.push({ provider: name, mode, maxRetries, hasQuota: codes.includes("QUOTA") });
      }
      list.sort((left, right) => left.provider.localeCompare(right.provider));
      sendJson(res, 200, { ok: true, providers: list });
    },
  });
}

/** POST /retry-policy 的注册（异步体在 handleRetryPolicy）。 */
function registerRetryPolicyRoute(
  runtime: ApplyRuntime,
  servingNonLoopback: boolean,
  add: AddRescueRoute,
): void {
  add({
    kind: "exact",
    path: RETRY_POLICY_PATH,
    handler: (req, res) => {
      // 信任闸门（shared/lib/trust）：必须是 handler 体的第一条语句——先验权威再谈方法/参数。
      if (!guardTrust(req, res, { servingNonLoopback })) {
        return;
      }
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        sendJson(res, 405, { ok: false, error: "POST only" });
        return;
      }
      // 异步体自身兜底全部抛错（见 handleRetryPolicy）：这里只需显式 fire-and-forget
      // 以满足 no-floating-promises / strict-void-return。
      void handleRetryPolicy(runtime, req, res);
    },
  });
}

/** 六条路由逐个注册，注销器推进 `disposers`（供 registerWebRoutes 组装释放器）。 */
function registerRoutesInto(runtime: ApplyRuntime, disposers: (() => void)[]): void {
  const webServer = runtime.svc.get("webServer");
  if (webServer === undefined) {
    // 契约上 inject 已保证到位；仍防御跨版本 ctx.get 的严格读返回 undefined：
    // 不注册任何路由（功能面退化为无 UI），也不留释放器。
    return;
  }
  // 非回环服务面唯一的可读信号（installed dsh-host-webserver d.ts `:50`/`:83`）。
  const servingNonLoopback = webServer.host === "0.0.0.0";
  const add: AddRescueRoute = (route) => {
    disposers.push(webServer.register(route));
  };
  registerStateRoute(runtime, servingNonLoopback, add);
  registerCancelRoute(runtime, servingNonLoopback, add);
  registerToggleRoute(runtime, servingNonLoopback, add);
  registerResumeNotifyRoute(runtime, servingNonLoopback, add);
  registerRetryProvidersRoute(runtime, servingNonLoopback, add);
  registerRetryPolicyRoute(runtime, servingNonLoopback, add);
}

/** webServer 路由注册入口（曾内嵌于 apply 的 ctx.effect，拆出降 apply 行数）。
 *  由 apply 的 `ctx.inject(["webServer"], …)` 触发：webServer 到位（或重启换实例）
 *  时才会跑到这里（item 3）。
 *  register() 抛错时把已挂上的路由全部注销再上抛——不留"半个插件"的孤儿路由
 *  （它们会一直占着这些 path，而拿不到注销器的我们再也没机会释放它们），
 *  也不静默吞错：注册失败必须可见。 */
function registerWebRoutes(runtime: ApplyRuntime): () => void {
  const disposers: (() => void)[] = [];
  try {
    registerRoutesInto(runtime, disposers);
  } catch (error: unknown) {
    for (const dispose of disposers) {
      dispose();
    }
    disposers.length = 0;
    throw error;
  }
  return (): void => {
    for (const dispose of disposers) {
      dispose();
    }
    disposers.length = 0;
  };
}

// ── 插件体 ─────────────────────────────────────────────────────────────────

/** 交进 apply 的那份配置：0.1.7 起每个 `.volatile()` 字段是一枚 **Volatile 引用**
 *  而不是值快照（读当前值一律 `.get()`，设置卡改完下一次读即生效，不必重载插件）。
 *  同一份 `Config` schema 也用于校验 loader 行 config（组合包层/用户层行的 `config:`），
 *  cordis 装载期按 `.default()` 填齐后交进来。
 *  优先级：settings 运行时值（设置卡）> 行 config > schema 的 `.default()`。 */
export interface PluginConfig {
  enabled: Volatile<boolean>;
  providerExcludes: Volatile<string[]>;
  resumeDelayMs: Volatile<number>;
  resumeCooldownMs: Volatile<number>;
  maxResumes: Volatile<number>;
  chainResumeDelayMs: Volatile<number>;
  continueDelayMs: Volatile<number>;
  continueCooldownMs: Volatile<number>;
  maxContinues: Volatile<number>;
  resumeOnOpenTodos: Volatile<boolean>;
  unfinishedDelayMs: Volatile<number>;
  unfinishedCooldownMs: Volatile<number>;
  maxUnfinished: Volatile<number>;
  /** 部署值：请求级 429 自动重试的次数上限（非 volatile ⇒ 不进设置卡）。 */
  requestRetryMax: number;
  /** 部署值：退避阶梯毫秒数；数组是整体替换，行 config 要给完整的一份。 */
  requestRetryBackoffMs: readonly number[];
  /** 部署值：愿意代等的上限毫秒数（= 阶梯封顶），provider Retry-After 超过即交回 llm-retry。 */
  requestRetryBackoffCapMs: number;
}

/** 设置面（= profile 条目 `session-rescue` 的可编辑表单，见 cordis.patch.yml）与
 *  loader 行 config 共用同一 schema（单源，防漂移）。
 *
 *  0.1.7 迁移要点（两处都是**静默失效**，写错不报错，而本包失效的代价是续跑哑掉）：
 *   - `.volatile()` 决定字段是否进设置表单。宿主 `describe()` 只投影 volatile 字段
 *     （packages/settings/settings/src/schema.ts 的 volatileForm），全漏标则整条被跳过
 *     （settings/src/index.ts:308-309）、写入抛 `has no volatile fields`（:386）。
 *     十三项全是本卡的可编辑项，一个都不能漏（见 test/host.test.ts 的投影验收）。
 *   - `settings.register(ns, schema, { base })` 的「底座」层已被宿主移除：原 BUILTIN_BASE
 *     逐字段落成下面的 `.default()`（同值同源，cordis 装载期按它校验行 config 并填默认，
 *     再把 volatile 字段包成引用交给 apply）。
 *   - 数组字段（providerExcludes）由 `.default([])` 承载缺省，写入按整表替换（与旧 base
 *     层的数组语义一致，卡片侧也是整表写回）。
 *  ⚠ 下面每个数值都是**延迟/冷却/配额**语义（见文件头不变量），改默认等于改调度行为。 */
const configSchema = Schema.object({
  enabled: Schema.boolean().default(true).volatile(),
  providerExcludes: Schema.array(String).default([]).volatile(),
  resumeDelayMs: Schema.natural().min(1000).max(300_000).default(10_000).volatile(),
  resumeCooldownMs: Schema.natural().min(5000).max(3_600_000).default(120_000).volatile(),
  maxResumes: Schema.natural().min(0).max(20).default(3).volatile(),
  chainResumeDelayMs: Schema.natural()
    .min(1000)
    .max(300_000)
    .default(CHAIN_RESUME_DELAY_MS_DEFAULT)
    .volatile(),
  continueDelayMs: Schema.natural().min(500).max(300_000).default(3000).volatile(),
  continueCooldownMs: Schema.natural().min(5000).max(3_600_000).default(60_000).volatile(),
  maxContinues: Schema.natural().min(0).max(20).default(3).volatile(),
  resumeOnOpenTodos: Schema.boolean().default(true).volatile(),
  unfinishedDelayMs: Schema.natural().min(1000).max(300_000).default(5000).volatile(),
  unfinishedCooldownMs: Schema.natural().min(5000).max(3_600_000).default(120_000).volatile(),
  maxUnfinished: Schema.natural().min(0).max(20).default(2).volatile(),
  // 请求级 429 重试的三枚部署值。刻意不标 volatile —— 它们是「两部署可能想设不同
  // 值」的调优参数（官方 config.md:78-92），不是用户随时翻的开关，因此不进设置卡；
  // 默认与旧模块常量同值，行为冻结由 test/host.test.ts 的字面值钉住。
  requestRetryMax: Schema.natural().min(0).max(20).default(REQUEST_RETRY_MAX),
  requestRetryBackoffMs: Schema.array(Schema.natural().min(0))
    .min(1)
    .default([...REQUEST_RETRY_BACKOFF_MS]),
  requestRetryBackoffCapMs: Schema.natural().min(1000).default(REQUEST_RETRY_BACKOFF_CAP_MS),
});
export { configSchema as Config };

function apply(ctx: Context, config: PluginConfig): void {
  // 宿主契约经守卫收窄（不写 `as unknown as`、不靠 lint 忽略注释）：缺面即急停，
  // 而不是跑到某条路由/某个事件才炸（同 lesson-loop/ocr-review 的纪律）。
  if (!isHostCtx(ctx)) {
    throw new Error(
      "[session-rescue] host context contract violated: 缺少 get/effect/inject/on/fiber 或 timer/settings 服务面",
    );
  }
  // 交并后的 svc 只保留本插件声明过的成员面：`Context.get(name): any` 那条
  // 兜底重载不得混进来（否则每个服务读都成了 any）。
  const svc: HostCtx = ctx;

  // 0.1.7 起命名空间是**隐式**的：宿主把本条目导出的 Config 里标了 `.volatile()` 的
  // 十三项投影成设置表单，ns = profile 条目 id（`session-rescue`，见 cordis.patch.yml）。
  // 插件侧不再 register、也不再交 base（内置默认已逐字段落成 schema 的 `.default()`，
  // cordis 装载期按它校验行 config 并把引用交进上面的 config 参数），只剩一条页面策略：
  // 本包自带设置卡片，别让宿主再生成一份自动表单页。owner 必须显式传本插件 fiber
  // （缺省是 settings 服务自己的 fiber），且经 child.effect 挂载以便随注入子上下文回收
  // ——宿主 dsh-client-locale / 本仓 ctx-observe、quality-gate、zvec-grep 同款写法。
  svc.inject(["settings"], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, svc.fiber));
  });

  const scheduler = new ResumeScheduler();
  const disabledSessions = new Set<string>();
  // 每会话开关（运行期内存；重启回到全局默认；agent/disposed 时随会话释放）
  const csrf = randomUUID();
  // per-apply 写操作令牌；state GET 下发，POST 回填校验
  const requestRetryCounts = new Map<string, number>();
  const runtime: ApplyRuntime = {
    svc,
    config,
    scheduler,
    disabledSessions,
    requestRetryCounts,
    backoffs: new Set<() => void>(),
    csrf,
    msgSeq: { value: 0 },
    suspendedSnapshots: { value: [] },
    transientPasses: { value: [] },
    facts: { value: undefined },
  };

  // 回合事实投影（把「agent/status→idle 每次全量 readEvents 是 O(n)」这条发现收口）：
  // 注册表订阅一次 session/event 并增量折叠，三类判定的读侧经 runtime.facts 走 stateOf
  // （同步水位读，时序与迁移前逐字一致）。注册表缺席（未装 dsh-session-projection 的
  // profile）或迟到时回调根本不激活——cordis 只在依赖到位时才激活子 fiber——读口保持
  // undefined ⇒ 三处判定沿用回退扫描（wukil-plugins 的 rules 判重同策）。
  // 不写进插件级 inject：那会让没装投影包的 profile 整个插件不再激活。
  svc.inject(["sessionProjections"], (child) => {
    const registry = child.sessionProjections;
    // 注册是 effect（disposer 随本注入子 fiber 回收，见官方 SessionProjectionRegistry 注记）
    registry.register(rescueFactsProjection);
    runtime.facts.value = (session) => registry.stateOf(session, RESCUE_FACTS_KEY);
  });

  // agent/disposed：会话结束即释放本会话的请求级重试计数、每会话开关与待兑 pass
  // 台账。前两表此前仅 idle/重试耗尽时自洁（泄漏审计：LOW 级缓慢无界），
  // 显式清理后按会话严格有界。事件面与 gateway 侧 auto-recall 同型
  // （payload.agent.session.id；fork 收尾同样触发）。
  svc.on("agent/disposed", (payloadRaw) => {
    const sid = payloadRaw.agent?.session?.id;
    if (typeof sid !== "string" || sid === "") {
      return;
    }
    requestRetryCounts.delete(sid);
    disabledSessions.delete(sid);
    // 未兑的 pass 记录一并撤销：会话都没了，"之后跑成功"永不可能发生，
    // 继续留着就是一条永不兑现的观察（且可能被误兑）。
    dropTransientPasses(runtime, sid);
  });

  // ── 请求级 429 自动重试（用户裁决：所有平台 429 限流都要自动
  //    重试、不打断模型运行；后来补退避）。agent/request-error 是
  //    waterfall：返回 {kind:'retry'} → agent-loop 同一回合重发该请求——
  //    已核实 agent-loop 对 retry 是裸 continue（lib/index.ts:656-665 无任何延迟），
  //    不退避的 5 连发会加重限流。退避走固定阶梯（对齐官方 llm-retry 量纲：
  //    首退避短、逐级拉长、30s 封顶），sleep 用宿主 timer（插件卸载可回收、
  //    测试 tick 可控）；sleep 期间 signal 中止 → 委托 next() 终结，不重发。
  svc.on("agent/request-error", (payloadRaw, next) =>
    handleRequestError(runtime, payloadRaw, next),
  );

  svc.on("agent/error", (payload: AgentErrorPayload) => {
    handleAgentError(runtime, payload);
  });

  // 回合终态处理（agent/status→idle 检测）：
  //   max-tokens → 截断续写（continue）；
  //   completed  → ①成功回合重置 resume/continue 配额（A：长跑会话不得用完即哑）；
  //                ②清单已闭合 → 恢复 unfinished 配额；
  //                ③本回合自己写的清单仍有未完成 → 自动补跑（unfinished，C）。
  //   error/aborted/interrupted → 不处理（error 走 agent/error 路径）。
  svc.on("agent/status", (payload: AgentStatusPayload) => {
    handleAgentStatus(runtime, payload);
  });

  // item 3：路由归属方必须对 webServer 建立**依赖**，而不是只读一次。
  // `ctx.get` 是无 inject 语义的存储读（cordis reflect.ts:226 "Read a service from
  // the store without the inject requirement"）——未提供时静默返回 undefined，
  // 于是 webServer 后装载/重启换实例时这六条路由永不注册。harness 的路由归属方
  // 都声明 inject:['webServer']（packages/bundle/web-app/src/index.ts:41）；
  // ctx.inject 的子 fiber 在依赖到位时才激活、依赖变化时先卸后装（cordis
  // registry.ts:169 "the callback is unloaded and re-run whenever a required
  // service changes"），故 effect 挂在**子 ctx** 上即得到「后到即注册、重启即重注册」。
  // 不写进插件级 inject：那会让没有 webServer 的宿主（TUI 场景）整个插件不再
  // 激活，连自动续跑能力一并丢掉。
  svc.inject(["webServer"], (injected) => {
    injected.effect(() => registerWebRoutes(runtime), "session-rescue: webServer routes");
  });

  svc.effect(
    () => () => {
      scheduler.disposeAll();
      // 退避 sleep 的定时器不归 scheduler（item 7）：disposeAll 只回收调度器待办，
      // 这些在途 sleep 必须逐个结算为「已中止」，否则插件卸载后它照样唤醒。
      const pending: (() => void)[] = [...runtime.backoffs];
      runtime.backoffs.clear();
      for (const dispose of pending) {
        dispose();
      }
    },
    "session-rescue: dispose scheduler and backoff timers",
  );
}

export default {
  inject: ["timer", "settings"],
  // 隐式注册靠的就是这个键：宿主按它校验行 config、投影 volatile 字段（ns = 条目 id
  // `session-rescue`，见 cordis.patch.yml）。
  Config: configSchema,
  apply,
};
