# @jayyuen66/dsh-session-rescue

[中文](#中文) · [English](#english)

## 中文

### 它做什么

- 回合非正常收尾时代除人工干预，三类自动注入：瞬时失败**续跑**、输出截断**续写**、待办未闭合**补跑**。
- 另有请求级 429 兜底：监听 `agent/request-error`（waterfall），命中限流即返回 `{ kind: "retry" }` 让宿主在同一回合重发该请求。
  - 退避阶梯默认 2s/5s/10s/20s/30s、同一会话最多 5 次（阶梯与次数都是非 volatile 的部署值，见设置项末组），回合收口（`agent/status` → `idle`）即重置计数。
  - provider 的 `Retry-After` 优先于阶梯，超过 30s 封顶（`requestRetryBackoffCapMs`）就不等、委托 `next()` 交给官方 llm-retry。
- client 半（构建产物 `client.js`）在输入框下挂一块 dock：
  - 编辑重发（本会话）/ Fork 重发（新分支）/ 排队消息的撤回与编辑 / 停止并重问 / 手动重试与继续输出 / 续跑倒计时横幅 / 每会话开关。
- `/state` 轮询是**自排循环 + 两档**：有 pending 时 1s（横幅要按秒走倒计时），无 pending 时 5s 兜底；上一跳落地后才排下一跳，在飞期间不叠并发也不停摆。
- 无订阅者或页签隐藏即停表，回到可见补一跳；快照内容没变就不通知订阅者（旧实现每 tick 无条件遍历一遍订阅者）。
- 喂给 `useSyncExternalStore` 的 `subscribe`/`getSnapshot` 是**模块级稳定引用**：写成内联函数会让 React 每次渲染重跑订阅 effect（官方实现 `useEffect(bind(...),[subscribe])` 依赖数组只收 `subscribe`），退订→再订阅会把一次渲染放大成一发 `/state`。
- 另有一张设置卡与按平台的 429 重试档位。
- 读的宿主面：`agent/error`、`agent/status`、`agent/request-error`、`agent/disposed`（清理）。
- 回合事实（`turn/start`、`turn/end`、`user/message`、`tool/call`、`todo/write`）经 `ctx.sessionProjections` 的投影单元增量折叠，判定只读 `stateOf()` 的同步水位。
  - 注册表缺席的 profile，或折叠不可采信的形状（`turn/end` 对不上它的 `turn/start`、opener 被窗口淘汰），回退 `session.snapshotEvents()` 全量扫描，判定逐项相同。

### 三种自动动作

- `resume` 续跑：`agent/error` 的 `error.failure` 被 `lib/failure-classify.ts` 判为瞬时，等 `resumeDelayMs` 后注入。
  - 瞬时形状：`RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`/`EMPTY_RESPONSE`、HTTP 429、5xx、带限流措辞的 `QUOTA`、`PI_AI_ERROR` 加无法归类的 `finish_reason` 或上游空响应措辞。
- `continue` 续写：`agent/status` 转 `idle` 且最后一条 `turn/end` 的 `reason.kind === "max-tokens"`，等 `continueDelayMs` 后注入「从截断处继续」。
- `unfinished` 补跑：同一条 `turn/end` 是 `completed`，但**该回合自己写的** `todo/write` 快照里仍有非 `completed` 项（`lib/turn-review.ts`，纯结构化信号、零文本猜测），等 `unfinishedDelayMs` 后注入。
- 三类各有独立的延迟/冷却/次数闸门（`lib/resume-scheduler.ts`，冷却按 kind 分别记录）。
  - 注入一律是 `role: "user"`、`source: { kind: "plugin:session-rescue" }` 的消息：模型会接着跑，token 与配额继续消耗。

### 什么时候不会动

- 判为永久失败：`CONTEXT_WINDOW_EXCEEDED`/`AUTH`/`INVALID_CREDENTIAL`/`MISSING_CREDENTIAL`/`INVALID_REQUEST`/`INVALID_ARGS`/`NO_ADAPTER`/`INVALID_MODEL_CONTEXT`/`INVALID_PREPARED_CALL`、HTTP 401/403。
  - 余额耗尽措辞（`insufficient quota|balance|credits` 等）与一切未知形状；`error` 没有 `.failure`（普通 Error）同此论。
  - 分类是内置安全逻辑，设置卡不提供改它的入口。
- 非根会话（子代理）；`providerExcludes` 命中的那条 provider 的 `resume`——它不挡 `continue`/`unfinished`，也不挡请求级 429 重试。
- 你按了停止：最后一条 `turn/end` 的 `reason.kind` 为 `aborted`/`interrupted` 时既不注入、也不消耗配额。
- 它在等你：该回合内调用过 `ask_user_question` → 补跑不注入；该回合首条 `user/message` 的 `source.kind === "goal"`（goal 轮次驱动）→ 三类一律让路。
- 到点前二次校验（`preFireCheck`）不过：agent 已消失、状态非 `idle`、inbox 有排队消息、失败轮之后已有新轮 → 静默作废，不计数、不进冷却。
  - 闸门拦下则是同类已有待办、同类冷却内、或同类次数已满。
  - 次数是「连续」语义——一次 `completed` 回合把 `resume`/`continue` 清零，`unfinished` 只在清单闭合时才恢复。

### 安装

```sh
dsh plugin --profile web add @jayyuen66/dsh-session-rescue
```

- 需要 dsh `>=0.2.0-rc.2`：真源是 `package.json` 里 `peerDependencies` 下的 `@deepseek-ai/dsh`（宿主自 0.1.7-rc 起在装插件时校验它；alpha.1 还没有这道门）。`engines.dsh` 同值但无人读。
- 包在公共 npm 上，安装不需要凭据。
- 卸载：`dsh plugin --profile web remove @jayyuen66/dsh-session-rescue`。许可 MIT，源码仓见 `package.json` 的 `repository.url`。

### 在 dsh 里启用

- 组合包形态：包内 `cordis.patch.yml` 带 `- id: session-rescue` + `name: "@jayyuen66/dsh-session-rescue"`，由 `package.json` 的 `dsh.bundle.patch` 指向，`dsh plugin add` 自动登记。
  - 发布态入口是 `prepack` 重建的 `host.js` 与 `client.js`。
- host 半硬依赖 `timer` 与 `settings`（`inject: ["timer", "settings"]`）；`webServer` 走子 fiber 依赖，所以没有 webServer 的宿主（TUI）自动续跑照常、只是那六条路由不存在。
- 设置卡在插件管理页的 `plugins.bundle.config`（该槽按 bundle 包名 keyed，key = `@jayyuen66/dsh-session-rescue`，即 `~/.dsh/profiles/web/package.json` 里 `dsh.profile.bundles` 的那一行；`configForms.get()` 与 settings 命名空间仍是裸条目 id `session-rescue`）：改动点「保存」才写 settings、「撤销」丢弃。
- 不想开 UI 时部署默认值写在注册行 `config:` 上，优先级 = 设置卡运行时值 > 行 `config` > 内置默认，配置非法则插件加载失败（响亮报错）。

### 设置项

命名空间 `session-rescue`（0.1.7 起隐式注册：命名空间 = `cordis.patch.yml` 里的条目 id，本包不再调 `settings.register`）：设置项与行 `config` 共用 `host.ts` 里同一份 `Config` schema（单源防漂移），内置默认逐字段落在 `.default()` 上，标了 `.volatile()` 的十三项即设置卡的可编辑面（另有三枚非 volatile 的部署值，见下面末组），时间单位 ms。取值范围：延迟 1000–300000（`continueDelayMs` 500–300000）、冷却 5000–3600000、次数 0–20。

- 全局：`enabled` `true`、`providerExcludes` `[]`。
- `resume`：`resumeDelayMs` `10000`、`resumeCooldownMs` `120000`、`maxResumes` `3`、`chainResumeDelayMs` `60000`（续跑消息自己开出的回合再失败时旁路冷却、按此延迟重排）。
- `continue`：`continueDelayMs` `3000`、`continueCooldownMs` `60000`、`maxContinues` `3`。
- `unfinished`：`resumeOnOpenTodos` `true`（这一类自己的开关）、`unfinishedDelayMs` `5000`、`unfinishedCooldownMs` `120000`、`maxUnfinished` `2`。
- 请求级 429 重试的三枚部署值：刻意不标 `.volatile()` ⇒ 设置卡没有它们的行，只在注册行的 `config:` 上给（cordis 交进 apply 的是值而非引用，改值随重启生效）。
  - 默认：`requestRetryMax` `5`（0–20）、`requestRetryBackoffMs` `[2000, 5000, 10000, 20000, 30000]`（数组至少一项）、`requestRetryBackoffCapMs` `30000`（min 1000）。

### 对外接口

- 六条 `webServer` 路由（`kind: "exact"`）：
  - `GET /_dsh/session-rescue/state`（各会话计数、待办剩余时间、开关态，外加本次 apply 的写操作令牌）
  - `POST /_dsh/session-rescue/cancel?sessionId=`
  - `POST /_dsh/session-rescue/toggle?sessionId=`（会话级开关，关掉顺带解除待办）
  - `POST /_dsh/session-rescue/resume`（client 在 `connection/reset` 时通知恢复挂起待办）
  - 另外两条：`GET /_dsh/session-rescue/retry-providers`、`POST /_dsh/session-rescue/retry-policy`
- 写操作的信任闸门：六条路由 handler 体的第一条语句都是 `shared/lib/trust` 的 `guardTrust(req, res, { servingNonLoopback })`，判据依次为 Host 权威 → `sec-fetch-site` 白名单 → `Origin` 逐字比对；`servingNonLoopback` 只从 `webServer.host === "0.0.0.0"` 取。
  - 任一不成立 → `403` + JSON `{ ok: false, error: "untrusted host authority" | "cross-origin request rejected" }`（`lib/http` 的 `isCrossOrigin` 支因此不可达：白名单更严且文案相同）。
  - 方法不对 → 405 + `Allow` 头 + `{ ok: false, error: "GET only" }`（两条 GET 路由）或 `"POST only"`（四条 POST 路由），不再是空体。
- CSRF 与体积：POST 须以 `x-rescue-csrf` 回灌 `state` 下发的 token（缺或错 → 403 `invalid csrf token`）；`retry-policy` 的 body 上限 64 KiB（超限 413、坏流 400）。
- `retry-policy` 写的是官方 `llm-pi-ai` 命名空间的 `providers.<name>.retryPolicy`（档位 `default`/`enhanced`/`always`/`off`，经 `settings.mutate` 落盘），本包不自建第二套重试配置。
- 模型可见的唯一面：`agent.followup()` 发出的一条 `role: "user"` 消息，`id` 形如 `session-rescue-<时间戳>-<序号>`，正文是 `lib/messages.ts` 里的固定中英模板，不插值任何会话内容。
- 可选读总线 `ctx.get("lessonLoop")`：装了才沉淀 `transient-failure`、`unclassified-failure`、`max-tokens`、`unfinished-turn` 四类事实，并在同 provider 之后真跑完一个 `completed` 回合时补一条 `pass`。
  - 总线缺席或抛错只 warn，主流程不依赖它。

### 数据与隐私

- host 半不写文件、不发外部请求（无 `node:fs`、无网络调用）。
  - 运行态全在内存且都有界：调度器最多 200 条会话记录，挂起待办与待兑 pass 台账各 64 条，超限裁最旧，`agent/disposed` 与插件卸载时释放定时器。
- 持久化只有两处、都经官方 settings：本包命名空间 `session-rescue` 与 `llm-pi-ai` 的重试档位，落在 `<dsh 数据目录>`（`$DSH_HOME`）里，重启不丢。
- 每会话开关只存活在进程内存，重启即回到全局 `enabled`。注入正文的语言取官方 locale 偏好（`settings.describe()` 里 `locale` 那一条的 `value.preference`），该条目没被投影时默认中文。
- 装了 `lesson-loop` 才有内容外流：交给它的记录含失败的 code/status/message 原文、session id 与该会话的 `cwd`，落盘位置由 lesson-loop 决定；没装则一条都不产生。

### 常见问题

- 它会不会偷偷花钱：会。注入的是用户角色消息，发出后模型继续跑、继续消耗 token 与配额。
- 一键关：设置卡「启用自动续跑」（`enabled = false`，三类注入与请求级 429 重试同时停，手动 UI 保留）。
- 范围更窄的出口：dock 的「自动续跑（本会话）」、`resumeOnOpenTodos`（只关补跑）、`providerExcludes`（只排除某条 provider 的续跑）。
- 为什么有时模型停了却没自动续跑：日志找 `[session-rescue] <sid>: auto-<kind> skipped (<reason>)`（`pending`/`cooldown`/`max-resumes`）或 `vetoed at fire time (<reason>)`；配额是连续语义，跑完一回合就恢复。
- 会不会打断「它在问我」：不会，`ask_user_question` 之后不注入；goal 轮次驱动的回合三类全部让路。
- 补跑从不触发：它要求该回合自己写过 `todo/write` 且清单里仍有非 `completed` 项——从不用待办工具的会话结构性不会触发（`openTodos` 为 `null`）。
- 装不上：404 多半是该版本还没发到 npmjs（先看 `dist-tags.latest`）。
  - 404 通常是同组库包 `@jayyuen66/dsh-plugin-shared` 还没上 registry——本包值 import 它的 `lib/locale` 与 `lib/http`，缺了就是 `ERR_MODULE_NOT_FOUND`。
- 判定有没有测试兜着：`test/` 覆盖瞬时失败续跑、成功回合重置配额、待办未闭合补跑、等用户回答不注入四条主链。
  - 其中 `test/integration/loader-boot.test.ts` 用真实 cordis loader 装载发布产物端到端验。

## English

### What it does

- It removes the manual chore when a turn ends badly, via three automatic injections: **resume** after a transient failure, **continue** after output truncation, **re-run** after an open todo list.
- There is also a request-level 429 backstop: it listens on `agent/request-error` (waterfall) and returns `{ kind: "retry" }` on rate limiting so the host re-sends that request inside the same turn.
  - The backoff ladder defaults to 2s/5s/10s/20s/30s with at most 5 retries per session (the ladder and the counter are both non-volatile deployment values, see Settings), and the counter resets when the turn closes (`agent/status` → `idle`).
  - A provider `Retry-After` wins over the ladder, and anything above the 30s cap (`requestRetryBackoffCapMs`) is not waited out - the plugin delegates to `next()` and lets the official llm-retry take over.
- The client half (built artifact `client.js`) docks below the input box:
  - edit-resend (this session) / fork-resend (new branch) / withdraw and edit queued messages / stop-and-re-ask / manual retry and continue-output / a countdown banner / a per-session switch
- The `/state` poll is a **self-scheduling two-tier loop**: 1s while a pending exists (the banner counts down by the second), 5s as a fallback when nothing is pending.
- The next hop is armed only after the current one lands, so an in-flight request neither overlaps with it nor strands the loop.
- It stops with no subscribers or while the tab is hidden, and catches up one tick on return. Subscribers are only notified when the snapshot actually changed.
- The `subscribe`/`getSnapshot` pair handed to `useSyncExternalStore` is made of **module-level stable references**, so a re-render never re-subscribes.
- Inline closures make React re-run the subscribe effect on every render (the shipped React 18.3.1 is `useEffect(bind(...),[subscribe])`): unsubscribe then re-subscribe turns one render into an extra `/state`.
- There is also a settings card and per-platform 429 retry presets.
- Host surface read: `agent/error`, `agent/status`, `agent/request-error`, `agent/disposed` (cleanup).
- Turn facts (`turn/start`, `turn/end`, `user/message`, `tool/call`, `todo/write`) fold incrementally into a `ctx.sessionProjections` unit; every verdict reads the synchronous `stateOf()` watermark.
  - On profiles without that registry, or on shapes the fold cannot vouch for (a `turn/end` whose `turn/start` is outside the window, an evicted opener), it falls back to a full `session.snapshotEvents()` scan with identical verdicts.

### The three automatic actions

- `resume`: `error.failure` on `agent/error` is judged transient by `lib/failure-classify.ts`; the message lands after `resumeDelayMs`.
  - Transient shapes: `RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`/`EMPTY_RESPONSE`, HTTP 429, 5xx, `QUOTA` carrying rate-limit wording, `PI_AI_ERROR` carrying an unrecognized `finish_reason` or empty-response wording.
- `continue`: `agent/status` goes to `idle` and the last `turn/end` carries `reason.kind === "max-tokens"`; the "continue from the truncation" message lands after `continueDelayMs`.
- `unfinished`: that same `turn/end` is `completed`, but the `todo/write` snapshot **that turn wrote itself** still holds non-`completed` items (`lib/turn-review.ts`, a purely structured signal, no text guessing); the message lands after `unfinishedDelayMs`.
- Each kind has its own delay / cooldown / quota gates (`lib/resume-scheduler.ts`, cooldowns tracked per kind).
  - Every injection is a `role: "user"` message with `source: { kind: "plugin:session-rescue" }`: the model picks the conversation back up, so tokens and quota keep being spent.

### When it does nothing

- Permanent failures: `CONTEXT_WINDOW_EXCEEDED`/`AUTH`/`INVALID_CREDENTIAL`/`MISSING_CREDENTIAL`/`INVALID_REQUEST`/`INVALID_ARGS`/`NO_ADAPTER`/`INVALID_MODEL_CONTEXT`/`INVALID_PREPARED_CALL`, HTTP 401/403.
  - Exhausted-balance wording (`insufficient quota|balance|credits` and friends) and anything unrecognized; an `error` without `.failure` (a plain Error) counts the same.
  - Classification is built-in safety logic and the card deliberately exposes no way to change it.
- Non-root sessions (sub-agents); `resume` on a provider listed in `providerExcludes` - which does not gate `continue`, `unfinished`, or the request-level 429 retry.
- You stopped it: when the last `turn/end` carries `reason.kind` `aborted` or `interrupted`, nothing is injected and no quota is spent.
- It is waiting for you: the turn called `ask_user_question` → no re-run message; the turn's first `user/message` carries `source.kind === "goal"` (goal-round driven) → all three kinds stand down.
- The pre-fire check (`preFireCheck`) fails: the agent is gone, the status is not `idle`, the inbox holds queued messages, or a newer turn already started → the pending injection is silently voided, without counting or entering cooldown.
  - The gates block it when that kind already has a pending record, is inside its cooldown, or has spent its quota.
  - Quota is a _consecutive_ notion - one `completed` turn zeroes `resume`/`continue`, while `unfinished` only refills once the list closes.

### Install

```sh
dsh plugin --profile web add @jayyuen66/dsh-session-rescue
```

- Requires dsh `>=0.2.0-rc.2`: the source of truth is the `@deepseek-ai/dsh` entry under `peerDependencies` (the host checks it on plugin install from 0.1.7-rc; alpha.1 has no such gate yet). `engines.dsh` carries the same value but nothing reads it.
- The packages are on the public npm registry, so installation needs no credentials.
- Remove with `dsh plugin --profile web remove @jayyuen66/dsh-session-rescue`. MIT licensed; the source repository is in `repository.url` of `package.json`.

### Enabling it in dsh

- Bundle form: the package's own `cordis.patch.yml` carries `- id: session-rescue` + `name: "@jayyuen66/dsh-session-rescue"` and is pointed at by `dsh.bundle.patch` in `package.json`, so `dsh plugin add` registers it.
  - The published entry points are the `prepack`-rebuilt `host.js` and `client.js`.
- The host half hard-depends on `timer` and `settings` (`inject: ["timer", "settings"]`); `webServer` is required through a child fiber, so a host without webServer (TUI) keeps auto-resume working and simply never gets the six routes.
- The settings card lives in `plugins.bundle.config` on the plugin page, keyed by the bundle package name `@jayyuen66/dsh-session-rescue` (that is the `dsh.profile.bundles` row in `~/.dsh/profiles/web/package.json`).
  - `configForms.get()` and the settings namespace stay the bare entry id `session-rescue`; edits are staged, Save writes them into settings, Revert discards them.
- Without UI, deployment defaults go on the registration line's `config:`; precedence = card runtime value > line `config` > schema `.default()`, and an invalid `config` fails the plugin load loudly.

### Settings

Namespace `session-rescue`: since 0.1.7 the namespace is registered implicitly (it IS the entry id in `cordis.patch.yml` — the package no longer calls `settings.register`). The settings form and the line `config` share one `Config` schema in `host.ts` (single source, drift-proof); built-in defaults sit on each field's `.default()`, and the thirteen `.volatile()` fields are what the card exposes (three further non-volatile deployment values sit at the end of the list below). Times in ms. Ranges: delays 1000-300000 (`continueDelayMs` 500-300000), cooldowns 5000-3600000, counters 0-20.

- Global: `enabled` `true`, `providerExcludes` `[]`.
- `resume`: `resumeDelayMs` `10000`, `resumeCooldownMs` `120000`, `maxResumes` `3`, `chainResumeDelayMs` `60000` (when the turn opened by a resume message fails again, the cooldown is bypassed and it re-schedules at this delay).
- `continue`: `continueDelayMs` `3000`, `continueCooldownMs` `60000`, `maxContinues` `3`.
- `unfinished`: `resumeOnOpenTodos` `true` (this kind's own switch), `unfinishedDelayMs` `5000`, `unfinishedCooldownMs` `120000`, `maxUnfinished` `2`.
- The three deployment values of the request-level 429 retry: not `.volatile()`, so the card has no row for them - they go on the registration line's `config:` only (plain values, so a change applies on restart).
  - Defaults: `requestRetryMax` `5` (0-20), `requestRetryBackoffMs` `[2000, 5000, 10000, 20000, 30000]` (at least one entry), `requestRetryBackoffCapMs` `30000` (min 1000).

### Public surface

- Six `webServer` routes (`kind: "exact"`):
  - `GET /_dsh/session-rescue/state` (per-session counters, remaining pending time, switch state, plus this apply's write token)
  - `POST /_dsh/session-rescue/cancel?sessionId=`
  - `POST /_dsh/session-rescue/toggle?sessionId=` (per-session switch; turning it off also disarms the pending record)
  - `POST /_dsh/session-rescue/resume` (the client signals `connection/reset` so suspended pendings re-arm)
  - The remaining two: `GET /_dsh/session-rescue/retry-providers`, `POST /_dsh/session-rescue/retry-policy`
- Trust gate on writes: all six handlers open with `guardTrust(req, res, { servingNonLoopback })` from `shared/lib/trust`, judged as Host authority -> `sec-fetch-site` allowlist -> verbatim `Origin` comparison.
  - Any failure -> `403` plus JSON `{ ok: false, error: "untrusted host authority" | "cross-origin request rejected" }` (the `isCrossOrigin` leg in `lib/http` becomes unreachable - stricter allowlist, same text); `servingNonLoopback` comes only from `webServer.host === "0.0.0.0"`.
  - Wrong method -> 405 with `Allow` plus `{ ok: false, error: "GET only" }` (the two GET routes) or `"POST only"` (the four POST routes) - no longer an empty body.
- CSRF and size: POSTs must echo in `x-rescue-csrf` the token `state` handed out (missing or wrong -> 403 `invalid csrf token`); the `retry-policy` body is capped at 64 KiB (oversized 413, unreadable stream 400).
- `retry-policy` writes into the official `llm-pi-ai` namespace at `providers.<name>.retryPolicy` (presets `default`/`enhanced`/`always`/`off`, persisted via `settings.mutate`); the package keeps no second retry configuration of its own.
- The only model-visible artifact: one message through `agent.followup()` with `role: "user"`, an `id` like `session-rescue-<timestamp>-<seq>`, and text taken from the fixed bilingual templates in `lib/messages.ts` - no session content is interpolated.
- Optional read of `ctx.get("lessonLoop")`: when present it receives the `transient-failure`, `unclassified-failure`, `max-tokens` and `unfinished-turn` facts, and one `pass` once the same provider genuinely finishes a `completed` turn.
  - An absent or throwing bus only warns, the main path never depends on it.

### Data and privacy

- The host half writes no files and makes no outbound requests (no `node:fs`, no network calls).
  - All runtime state is in memory and bounded: at most 200 session records in the scheduler, 64 suspended pendings and 64 pending pass entries, oldest trimmed first, with timers released on `agent/disposed` and on plugin unload.
- Persistence happens in exactly two places, both through the official settings service: this package's namespace `session-rescue` and the `llm-pi-ai` retry presets, stored under `<dsh data dir>` (`$DSH_HOME`) and surviving restarts.
- The per-session switch lives only in process memory; a restart falls back to the global `enabled`.
- The injected text follows the official locale preference (`value.preference` on the `locale` row of `settings.describe()`) and defaults to Chinese when that entry is not projected.
- Content only leaves towards `lesson-loop` if that plugin is installed: it receives the failure code/status/message verbatim, the session id and the session's `cwd`, and lesson-loop alone decides where that is written. Without it, nothing is recorded.

### FAQ

- Does it silently spend money: yes. The injections are user-role messages, so the model continues and keeps consuming tokens and quota.
- One switch off: the card's "Enable auto-resume" (`enabled = false`) stops all three injections and the request-level 429 retry while keeping the manual UI.
- Narrower exits: the dock's per-session switch, `resumeOnOpenTodos` (re-run only), `providerExcludes` (resume on one provider only).
- Why did it stop without resuming: look for `[session-rescue] <sid>: auto-<kind> skipped (<reason>)` (`pending`/`cooldown`/`max-resumes`) or `vetoed at fire time (<reason>)` in the log; the budget is consecutive-semantics and one finished turn refills it.
- Will it interrupt a question aimed at me: no. Nothing is injected after `ask_user_question`, and goal-round driven turns are skipped by all three kinds.
- The re-run never fires: it requires that turn to have written a `todo/write` list that still holds non-`completed` items - sessions that never use the todo tool structurally cannot trigger it (`openTodos` stays `null`).
- Install fails with 404: that version was never published to npmjs (check `dist-tags.latest`).
  - 404 usually means the sibling library package `@jayyuen66/dsh-plugin-shared` is not on the registry yet - this package value-imports its `lib/locale` and `lib/http`, so a missing one is `ERR_MODULE_NOT_FOUND`.
- What backs these decisions: `test/` covers the four main chains - transient failure resumes, a successful turn refills the quota, an open todo list re-runs, and a waiting-for-user turn stays untouched.
  - `test/integration/loader-boot.test.ts` boots the published artifact through the real cordis loader.
