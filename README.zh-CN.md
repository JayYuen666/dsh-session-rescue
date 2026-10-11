# @jayyuen66/dsh-session-rescue

[English](./README.md)

### 它做什么

- 回合非正常收尾时代除人工干预，三类自动注入：瞬时失败**续跑**、输出截断**续写**、待办未闭合**补跑**。
- 另有请求级 429 兜底：**只在宿主没有为该 provider 解析出 `retryPolicy` 时**才接手——监听 `agent/request-error`（waterfall），命中限流即返回 `{ kind: "retry" }` 让宿主在同一回合重发该请求。
  - 两条链共用同一个 waterfall，先返回 `{kind:'retry'}` 的赢。有策略时官方 `llm-retry` 拥有重试（`retryableCodes` 过滤、`providerRetryAfterMs`、抖动、写入持久日志的 `llm/retry` 事件），本包让路；设置卡上 `default` 预设（unset）那条路才落到本包。
  - 退避阶梯默认 2s/5s/10s/20s/30s、同一会话最多 5 次（阶梯与次数都是非 volatile 的部署值，见设置项末组），回合收口（`agent/status` → `idle`）即重置计数。
  - provider 的 `Retry-After` 优先于阶梯，超过 30s 封顶（`requestRetryBackoffCapMs`）就不等、委托 `next()` 交回下游。
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
- 它在等你：该回合内调用过 `ask_user_question` → 补跑不注入；该回合首条 `user/message` 的 `source.kind` 为 `"goal"`（goal 轮次驱动）或 `"schedule"`（官方 Schedule 定时提醒）→ 三类一律让路。
- 到点前二次校验（`preFireCheck`）不过：agent 已消失、状态非 `idle`、inbox 有排队消息、失败轮之后已有新轮 → 静默作废，不计数、不进冷却。
  - 闸门拦下则是同类已有待办、同类冷却内、或同类次数已满。
  - 次数是「连续」语义——一次 `completed` 回合把 `resume`/`continue` 清零，`unfinished` 只在清单闭合时才恢复。

### 安装

```sh
dsh plugin --profile web add @jayyuen66/dsh-session-rescue
```

- 需要 dsh `>= 0.2.1-alpha.2`：真源是 `package.json` 里 `peerDependencies` 下的 `@deepseek-ai/dsh`（宿主自 0.1.7-rc 起在装插件时校验它，`@deepseek-ai/dsh-*` 的 peer 也一并校验）。`engines.dsh` 同值但无人读。
- 包在公共 npm 上，安装不需要凭据。
- 卸载：`dsh plugin --profile web remove @jayyuen66/dsh-session-rescue`。许可 MIT，源码仓见 `package.json` 的 `repository.url`。

### 在 dsh 里启用

- 组合包形态：包内 `cordis.patch.yml` 带 `- id: session-rescue` + `name: "@jayyuen66/dsh-session-rescue"`，由 `package.json` 的 `dsh.bundle.patch` 指向，`dsh plugin add` 自动登记。
  - 发布态入口是 `prepack` 重建的 `host.js` 与 `client.js`。
- host 半硬依赖 `timer` 与 `settings`（`inject: ["timer", "settings"]`）；`webServer` 走子 fiber 依赖，所以没有 webServer 的宿主（TUI）自动续跑照常、只是那六条路由不存在。
- 设置卡在插件管理页的 `plugins.bundle.config`（该槽按 bundle 包名 keyed，key = `@jayyuen66/dsh-session-rescue`，即 `~/.dsh/profiles/web/package.json` 里 `dsh.profile.bundles` 的那一行；`configForms.get()` 与 settings 命名空间仍是裸条目 id `session-rescue`）：改动点「保存」才写 settings、「撤销」丢弃。
- 不想开 UI 时部署默认值写在注册行 `config:` 上，优先级 = 设置卡运行时值 > 行 `config` > 内置默认，配置非法则插件加载失败（响亮报错）。

### 设置项

命名空间 `session-rescue`（隐式注册：命名空间 = `cordis.patch.yml` 里的条目 id，本包不调 `settings.register`）：设置项与行 `config` 共用 `host.ts` 里同一份 `Config` schema（单源防漂移），内置默认逐字段落在 `.default()` 上，标了 `.volatile()` 的十三项即设置卡的可编辑面（另有三枚非 volatile 的部署值，见下面末组），时间单位 ms。取值范围：延迟 1000–300000（`continueDelayMs` 500–300000）、冷却 5000–3600000、次数 0–20。

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
- 写操作的信任闸门：六条路由 handler 体的第一条语句都是 `shared/lib/trust` 的 `guardTrust(req, res, { servingNonLoopback })`，判据依次为 Host 权威 → `sec-fetch-site` 白名单 → `Origin` 逐字比对；`servingNonLoopback` 取 shared 的 `isNonLoopbackBindHost(webServer.host)`——宿主绑的是一枚真实网卡地址，通配地址在宿主载入时就被拒。
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
