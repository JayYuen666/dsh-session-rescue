<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/JayYuen666/dsh-session-rescue@main/icon.svg" width="96" height="96" alt="dsh-session-rescue logo" />
</p>

<h1 align="center">dsh-session-rescue</h1>

<p align="center"><em>回合非正常收尾时自动接续：瞬时失败续跑、截断续写、待办补跑，外加输入框下方的一排手动救援动作。</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@jayyuen66/dsh-session-rescue"><img src="https://img.shields.io/npm/v/@jayyuen66/dsh-session-rescue?style=flat-square&logo=npm&logoColor=white" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@jayyuen66/dsh-session-rescue"><img src="https://img.shields.io/npm/d18m/@jayyuen66/dsh-session-rescue?style=flat-square" alt="npm downloads (total)" /></a>
  <a href="https://github.com/JayYuen666/dsh-session-rescue/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/JayYuen666/dsh-session-rescue/ci.yml?branch=main&style=flat-square&label=ci" alt="ci" /></a>
  <img src="https://img.shields.io/badge/license-MIT-4c1?style=flat-square" alt="MIT" />
  <img src="https://img.shields.io/badge/node-%3E%3D22.12-4c1?style=flat-square&logo=nodedotjs&logoColor=white" alt="node" />
  <img src="https://img.shields.io/badge/dsh-%5E0.2.1--rc.3-658EFF?style=flat-square" alt="dsh" />
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/powered_by_dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white" alt="powered by dsh" /></a>
</p>

<p align="center">
  <img src="https://skillicons.dev/icons?i=typescript,nodejs,react,vitest,githubactions" alt="tech stack" />
</p>

<p align="center">
  <a href="https://github.com/JayYuen666"><img src="https://img.shields.io/badge/GitHub-JayYuen666-181717?style=flat-square&logo=github&logoColor=white" alt="GitHub" /></a>
  <a href="mailto:cqwkkj@gmail.com"><img src="https://img.shields.io/badge/Email-cqwkkj@gmail.com-EA4335?style=flat-square&logo=gmail&logoColor=white" alt="Email" /></a>
  <a href="https://twitter.com/JayYuen666"><img src="https://img.shields.io/badge/Twitter-X%2FJayYuen666-000000?style=flat-square&logo=x&logoColor=white" alt="Twitter/X" /></a>
  <a href="./README.md"><img src="https://img.shields.io/badge/lang-English-658EFF?style=flat-square" alt="English" /></a>
</p>

**一个 [dsh](https://github.com/deepseek-ai/deepseek-harness) 的插件：回合非正常收尾时的三类自动注入（瞬时失败续跑 / 截断续写 / 待办补跑）、请求级 429 兜底，以及输入框下方的手动救援 dock 与设置卡。零模型工具、零自有 HTTP 路由。**

## <img src="https://api.iconify.design/lucide/file-text.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 目录

- [ 它做什么](#-它做什么)
  - [判定是怎么做出来的](#判定是怎么做出来的)
- [ 安装](#-安装)
  - [shared 的版本下限](#shared-的版本下限)
- [ 确认它真的在工作](#-确认它真的在工作)
- [ 它不提供什么](#-它不提供什么)
- [ 在 dsh 里启用](#-在-dsh-里启用)
- [ 三种自动动作](#-三种自动动作)
- [ 设置项](#-设置项)
- [ 对外接口](#-对外接口)
- [ 数据与隐私](#-数据与隐私)
- [ 已知边界](#-已知边界)
- [ 常见问题](#-常见问题)
- [ 开发](#-开发)
- [ 许可](#-许可)

## <img src="https://api.iconify.design/lucide/shield.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 它做什么

- **回合非正常收尾时的三类自动注入**，各有独立的延迟 / 冷却 / 次数闸门（`lib/resume-scheduler.ts`，冷却按类别分别记录）：
  - **resume 续跑**——`agent/error` 的失败被 `classifyFailure`（`lib/failure-classify.ts`）判为瞬时；等 `resumeDelayMs` 后注入。
  - **continue 续写**——回合以 `reason.kind === "max-tokens"` 收尾；等 `continueDelayMs` 后注入「从截断处继续」。
  - **unfinished 补跑**——回合以 `completed` 收尾，但**该回合自己写的**待办清单仍有未闭合项（`lib/turn-review.ts`，纯结构化信号、零文本猜测）；等 `unfinishedDelayMs` 后注入。
  - 注入一律是经 `agent.followup()` 发出的 `role: "user"`、`source: { kind: "plugin:session-rescue" }` 消息——模型会接着跑，token 与配额继续消耗。
- **请求级 429 兜底**，只在宿主没有为该 provider 解析出 `retryPolicy` 时接手：监听 `agent/request-error`（waterfall），命中限流即返回 `{ kind: "retry" }`，让宿主在同一回合重发该请求。
  - 固定退避阶梯（默认 2s / 5s / 10s / 20s / 30s，同一会话最多 5 次——部署值）；provider 的 `Retry-After` 优先于阶梯，超过封顶的就不等、委托回 `next()`。回合收口即重置计数。
  - 有策略时官方 `llm-retry` 拥有重试（码表过滤、provider 重试时刻、抖动、持久事件）。deepseek 适配器即使不配策略也会解析出一份，所以这条阶梯实际只对「不解析策略的适配器」生效。
- **输入框下方的 dock**：编辑重发（本会话）/ Fork 重发（新分支）/ 停止并重问 / 手动重试与继续输出 / 续跑倒计时横幅 / 每会话开关。停止重问先把你的重问入队再 cancel，消息不会因取消丢失；内置重试仍在进行时，手动重试按钮保持禁用。
- **连接感知**：发送失败的注入（传输类故障）不丢弃而是挂起，横幅显示「重连后自动续跑」，连接恢复后按剩余延迟重新武装。
- **`/state` 轮询是自排循环 + 两档**：有 pending 时 1s（横幅按秒走倒计时），无 pending 时 5s；上一跳落地后才排下一跳，在飞期间不叠并发也不停摆。连着三跳读不到有效快照就把缓存判为过期——横幅与每会话开关回到中性态，不拿没人确认过的数字继续倒计时——轮询按翻倍退避到 30s 封顶。
- **一张设置卡**：自动续跑参数，加上写进官方 `llm-pi-ai` 命名空间的按 provider 429 重试档位。
- 读的宿主面：`agent/error`、`agent/status`、`agent/request-error`、`agent/disposed`（清理）。回合事实（`turn/start`、`turn/end`、`user/message`、`tool/call`、`todo/write`）经 `ctx.sessionProjections` 增量折叠；注册表缺席的 profile、或折叠不可采信的形状，回退 `session.snapshotEvents()` 全量扫描，判定逐项相同。

### 判定是怎么做出来的

- 分类（`classifyFailure`）是一条固定阶梯：永久码一票否决（`CONTEXT_WINDOW_EXCEEDED` / `AUTH` / `INVALID_CREDENTIAL` / `MISSING_CREDENTIAL` / `INVALID_REQUEST` / `INVALID_ARGS` / `NO_ADAPTER` / `INVALID_MODEL_CONTEXT` / `INVALID_PREPARED_CALL`）。随后 `QUOTA` 按证据分：HTTP 429、`Retry-After` 或限流措辞 ⇒ 瞬时；余额耗尽措辞 ⇒ 永久。HTTP 401/403 与账单状态 402 判永久；显式瞬时码（`RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT` / `EMPTY_RESPONSE`）、HTTP 408/425/429/5xx 与限流措辞判瞬时；带无法归类的 `finish_reason` 或空响应措辞的 `PI_AI_ERROR` 判瞬时。一切未知形状判永久——刻意保守。
  - `error` 没有 `.failure` 面的与永久同论；分类前会先剥开宿主包的 `AggregateError`，剥不到才作罢。
  - 分类是内置安全逻辑，设置卡刻意不提供改它的入口。
- **让路**：非根会话（子代理）；`providerExcludes` 只挡 `resume`；最后一条 `turn/end` 是 `aborted` 或 `interrupted`（你自己停的——不注入、不耗配额）；回合内调用过 `ask_user_question`（不补跑）；回合由官方 Schedule 提醒开启（三类一律让路）。
  - `"goal"` 回合**在触发时刻**读官方 goal 服务判定，不一律让路：`active` + `armed`（driver 还在 driving）⇒ 让路；`active` + `disarmed`（driver 已放弃——它自己的设计就绝不自动重试）⇒ 本包接管这一条；`paused` / `blocked` / `complete` 是人或生命周期的决定，从不覆盖；goal 状态读不到同样让路。
- **到点前二次校验**（`preFireCheck`）：agent 已消失、状态非 `idle`、inbox 有排队消息、失败轮之后已有新轮 ⇒ 待办静默作废，不计数、不进冷却。
- **配额是「连续」语义**：一次 `completed` 回合把 `resume` / `continue` 清零；`unfinished` 只在清单闭合时恢复（否则注入 → 仍不闭合 → 再注入会无限自激）。

## <img src="https://api.iconify.design/lucide/package.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 安装

```sh
dsh plugin --profile web add @jayyuen66/dsh-session-rescue
```

卸载：`dsh plugin --profile web remove @jayyuen66/dsh-session-rescue`。包在公共 npm 上，安装不需要凭据，也不需要 scoped-registry 配置。

- **需要 Node.js `>= 22.12`。** 本包仅 ESM；正是这个 Node 下限让 `require()` 一份 ESM 入口成为可能，`engines.node` 因此声明。
- **需要宿主 `dsh` 在 `0.2.1-rc.3` 这条线上。** 宿主装插件时读的是 `engines.dsh`（`^0.2.1-rc.3`，即 `0.2.x` 这条线——`0.` 主版本上的 `^` 上界到 `0.3.0` 之前），而且它**单独决定**：那一支给出结论后不再读 `peerDependencies`。预发布版本参与范围比较（宿主按 `includePrerelease: true` 判），所以窗口内的 `0.2.2-alpha.2` 同样满足。`@deepseek-ai/dsh-*` 的精确 peer 是编译期纪律，不参与装载判定。支持窗口是滚动的：本包在发布时最近的三个已发布宿主版本上逐版取证，窗口滚动后重新取证，不把这一句里的版本号当长期承诺。
- **`dependencies` 里没有任何 `@deepseek-ai/*`，这是契约**（`test/publish-manifest.test.ts` 钉着）。消费方 profile 以 `nodeLinker: hoisted` + `autoInstallPeers: false` 安装，`dependencies` 里的宿主包会被物化成一份真实目录、落在运行中宿主已装载的那份旁边——此后原生工具调用全部抛错，而构建、类型检查、覆盖率一路全绿。`host.js` 值导入的两枚宿主包（`@deepseek-ai/dsh-brand`、`@deepseek-ai/schemastery`）是必备 peer、并以同一钉版重复落在 `devDependencies`，打包器因此把它们外部化而不是内联官方函数体。
- **随包发布**：`prepack` 重建的 `host.js` 与 `client.js`、`types/`、`cordis.patch.yml`，加上 `README*`、`LICENSE`、`CHANGELOG.md` 与 `icon.svg`。产物不提交，也刻意不压缩——裸跨包说明符必须留在产物里，外部化断言才有意义。
- 装不上报 404：该版本没发出去过（先看 `dist-tags.latest`）。更常见的原因是同组库包 `@jayyuen66/dsh-plugin-shared` 还没上 registry——本包值导入它的 `lib/locale`、`lib/record`、`lib/errors`、`lib/card-apply`、`lib/card-diff` 与 `lib/lesson-bus`，缺了就是 `ERR_MODULE_NOT_FOUND`。

### <img src="https://api.iconify.design/lucide/arrow-down-to-line.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> shared 的版本下限

如果你的 profile 用 pnpm `overrides` 把 `@jayyuen66/dsh-plugin-shared` 钉在某个版本，那个钉住的值必须不低于本包声明的版本。钉得更低就会装到一份缺少本包运行期所导入名字的产物，宿主起来时报 `N entries did not activate` 加 `does not provide an export named ...`——包装得上、永远不生效，而各仓单仓 CI 看不见这一类。

## <img src="https://api.iconify.design/lucide/circle-check.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 确认它真的在工作

1. **层已挂载**：`dsh --profile web --dump-config` 里有本包的层行。
   - 这条命令是唯一被认可的「它在层栈里」判据，而它**不是只读命令**——会把该 profile 的根装配文件重写一遍。层行从 stdout 读，stderr 另行单独检查：未匹配的 patch 目标只出现在 stderr，光看退出码证明不了任何事。
   - 层行可能是 `# == <层>`，也可能是 `# == <层>, patched by <路径>`；两种形态都要认。
2. **dock 渲染出来了**：打开一个会话，输入框下方有救援 dock——每会话开关那一行，回合运行中的「停止并重问」，以及完成或失败回合之后的编辑重发 / 重试 / 续写动作。
3. **设置卡渲染实时数据**：插件页列出 session-rescue 卡片，429 档位一节加载出你的 `llm-pi-ai` providers（名称、重试模式、配额覆盖）。一直「不可用」的读数说明层已挂载、但 Remote 命名空间没到浏览器。
4. **一次真实续跑**：让回合中的一次模型调用瞬时失败（例如断网）；横幅出现并按秒倒计时，日志里有 `[session-rescue]` 行点名类别与闸门。反向核对：你自己停掉的回合（`aborted`）按设计不注入——那里的「没注入」不是装坏了。

## <img src="https://api.iconify.design/lucide/circle-slash.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 它不提供什么

- **不注册任何模型工具。** 面就是宿主事件加 Remote 命名空间；没有 `session_rescue` 工具给模型调。
- **不开自己的 HTTP 路由。** 数据面是官方 Typert Remote 命名空间 `sessionRescue`，经宿主 `/api` 网关到达；认证、Host / DNS 重绑定 / Origin 闸与 body 上限全是网关的。
- **不加 CLI 子命令。**
- **不自渲染排队区**：官方 conversation 包已把队列 dock 挂上（逐行编辑 / 删除 / 插话），本包不重复列一份。
- **host 半不写文件、不发外部请求**（见数据与隐私）。
- 可选消费的面：`lessonLoop` 总线（事实与 pass）、`sessionProjections`（快速回合事实）、goal 服务（触发时刻的接管判定）。缺席它们救援照常——只是回退全量日志扫描，goal 回合无人接管。

## <img src="https://api.iconify.design/lucide/plug.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 在 dsh 里启用

- 组合包形态：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，其唯一一行是 `- id: session-rescue`、`name` 为裸包名——宿主只对裸包名条目扫描 `dsh.client`。`dsh plugin add/remove` 维护装配层。
- host 半硬依赖 `timer` 与 `settings`（`inject: ["timer", "settings"]`）；读面经注入子 fiber 注册进宿主 `remote` 网关。不依赖 `webServer`，没有该服务的宿主（TUI）自动续跑照常、只是设置卡读不到数据面。
- 设置卡在插件页的 `plugins.bundle.config`，按 **bundle 包名** keyed；`configForms.get()` 与 settings 命名空间仍是裸条目 id `session-rescue`。改动点「保存」才写 settings、「撤销」丢弃。
- 不开 UI 时，部署默认值写在注册行 `config:` 上；优先级 = 卡运行时值 > 行 `config` > schema `.default()`，配置非法则插件加载失败（响亮报错）。

## <img src="https://api.iconify.design/lucide/refresh-cw.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 三种自动动作

| 类别 | 触发 | 默认延迟 / 冷却 / 次数 |
|---|---|---|
| `resume` 续跑 | `agent/error`，失败判为瞬时（`lib/failure-classify.ts`） | 10s / 120s / 3 |
| `continue` 续写 | 回合以 `max-tokens` 收尾（输出截断） | 3s / 60s / 3 |
| `unfinished` 补跑 | 回合以 `completed` 收尾，自己写的待办清单仍未闭合（`lib/turn-review.ts`） | 5s / 120s / 2 |

- `resumeOnOpenTodos` 是补跑这一类自己的开关；`providerExcludes` 只挡 `resume`，不涉另外两类、也不涉请求级 429 重试。
- 续跑消息自己开出的回合再次瞬时失败时**旁路冷却**、按 `chainResumeDelayMs`（默认 60s）重排：`resumeDelayMs` 加失败耗时恒落在 120s 冷却之内，没有这条例外，失败链会被冷却静默吞掉。
- 注入正文取自 `lib/messages.ts` 的固定中英模板，并跟随官方 locale 偏好（条目未被投影时即中文）；不插值任何会话内容。

## <img src="https://api.iconify.design/lucide/sliders-horizontal.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 设置项

命名空间 `session-rescue` = 条目 id（隐式注册——本包不调 `settings.register`）。设置表单与行 `config` 共用 host 入口里同一份 `Config` schema；标了 `.volatile()` 的字段即设置卡的可编辑面。时间单位 ms。

| 字段 | 类型 / 范围 | 默认 | 卡上有 | 作用 |
|---|---|---|---|---|
| `enabled` | boolean | `true` | 有 | 总开关；`false` 停掉三类注入与请求级 429 重试，手动 dock 保留 |
| `providerExcludes` | string[] | `[]` | 有 | 这些 provider 的 `resume` 永不自动触发（如已配专属重试策略的路由） |
| `resumeDelayMs` | 1000–300000 | `10000` | 有 | 瞬时失败后等待多久 |
| `resumeCooldownMs` | 5000–3600000 | `120000` | 有 | 同一会话两次续跑的最短间隔 |
| `maxResumes` | 0–20 | `3` | 有 | 每会话续跑配额（连续语义） |
| `chainResumeDelayMs` | 1000–300000 | `60000` | 有 | 续跑开出的回合再失败时的重排延迟（旁路冷却） |
| `continueDelayMs` | 500–300000 | `3000` | 有 | 截断后等待多久 |
| `continueCooldownMs` | 5000–3600000 | `60000` | 有 | 同一会话两次续写的最短间隔 |
| `maxContinues` | 0–20 | `3` | 有 | 每会话续写配额 |
| `resumeOnOpenTodos` | boolean | `true` | 有 | 补跑这一类自己的开关 |
| `unfinishedDelayMs` | 1000–300000 | `5000` | 有 | 待办未闭合后等待多久 |
| `unfinishedCooldownMs` | 5000–3600000 | `120000` | 有 | 同一会话两次补跑的最短间隔 |
| `maxUnfinished` | 0–20 | `2` | 有 | 补跑配额；清单闭合才恢复 |
| `requestRetryMax` | 0–20 | `5` | 无 | 请求级 429 重试的次数上限 |
| `requestRetryBackoffMs` | number[]（≥ 1 项） | `[2000, 5000, 10000, 20000, 30000]` | 无 | 请求级重试的退避阶梯 |
| `requestRetryBackoffCapMs` | ≥ 1000 | `30000` | 无 | 本包愿意代等的最长时间；更长的 `Retry-After` 委托回下游 |

`requestRetry*` 三行是部署值：不标 `.volatile()`，设置卡上没有它们的行——只写在注册行 `config:` 上（纯值，随重启生效）。

## <img src="https://api.iconify.design/lucide/network.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 对外接口

官方 Typert Remote 命名空间 `sessionRescue` 的六个方法。参数走 strict codec，结果走 `src-json`。

| 方法 | 入参 | 应答 |
|---|---|---|
| `state` | — | `ok` 加每会话快照：待办类别、剩余毫秒倒计时、链式 / 挂起位、触发计数、每会话开关 |
| `cancel` | `{ sessionId }` | 取消该会话的待办注入，挂起中的也算 |
| `toggle` | `{ sessionId }` | 翻转每会话开关；关掉的同时取消待办。台账满且无死会话可淘汰时答 409 |
| `resume` | — | 重连后恢复挂起的注入；`ok` 加恢复条数 |
| `retryProviders` | — | 官方 `llm-pi-ai` 的 providers 及重试模式 / 次数 / 配额覆盖；该命名空间不可用时答 503 |
| `retryPolicy` | `{ provider, preset }` | 经 `settings.mutate` 写 `providers.<name>.retryPolicy`（档位 `default` / `enhanced` / `always` / `off`）；版本冲突答 409 |

- 拒绝应答里的 `status` 是保留的语义码，不是本包任何路由的 HTTP 状态——路由根本不存在。
- 模型可见的唯一产物：一条经 `agent.followup()` 发出的 `role: "user"` 消息，id 形如 `session-rescue-<时间戳>-<序号>`，正文取自固定模板。本包不自建第二套重试配置。
- 可选 `lessonLoop` 总线：在场时收到 `transient-failure`、`unclassified-failure`、`max-tokens`、`unfinished-turn` 四类事实，并在同 provider 之后真跑完一个 `completed` 回合时补一条 `pass`。总线缺席或抛错只 warn，主流程从不依赖它。

## <img src="https://api.iconify.design/lucide/lock.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 数据与隐私

| 口径 | 内容 |
|---|---|
| 不写盘、不外联 | host 半无 `node:fs`、无网络调用；输出去向只有 `console.*` 日志与那条注入消息 |
| 内存态且有界 | 调度器最多 200 条会话记录、挂起待办 64 条、待兑 pass 64 条、每会话开关台账 200 条——超限裁最旧，`agent/disposed` 与插件卸载时释放定时器 |
| 持久化只有两处、都经官方 settings | 本包命名空间 `session-rescue` 与 `llm-pi-ai` 的重试档位，落在 dsh 数据目录里，重启不丢 |
| 每会话开关 | 只存活在进程内存；重启即回到全局 `enabled` |
| 语言 | 注入正文跟随官方 locale 偏好；条目未被投影时即中文 |
| 唯一出口 | 内容只流向 lesson-loop、且只在装了它的时候：交给它的是失败 code / status / message 原文、session id 与该会话的 `cwd`，落盘位置由 lesson-loop 决定。没装则一条都不产生 |

## <img src="https://api.iconify.design/lucide/triangle-alert.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 已知边界

- **未知失败形状判永久，刻意如此。** 分类器认不出的一律不动；设置卡不提供改它的入口。把「永久」错猜成「瞬时」会反复重开永远不可能成功的回合。
- **`providerExcludes` 只挡 `resume`**——`continue`、`unfinished` 与请求级 429 重试都不看它。
- **子代理会话一概不碰**——只救援根会话。
- **补跑有结构性前提**：该回合必须写过 `todo/write` 清单且仍有 `pending` 或 `in_progress` 项。从不用待办工具的会话触发不了它。
- **429 阶梯只对「解析不出 `retryPolicy` 的 provider」生效**，而 deepseek 适配器不配也解析出一份。profile 没装 `dsh-llm-retry` 时，一次 429 零次重发直接终态。
- **官方 `llm-retry` 不总在下游**：它的 abort 信号已触发或条目已 disposed 时直接返回、不调 `next()`，`always` 模式还会采纳下游交回的决策——那些窗口里本包根本不被咨询。
- **读面持续不可达时 dock 降级而不是假装**：横幅与每会话开关回到中性态、轮询退避。回合相关的动作照旧可用——它们读的是会话实时状态，不依赖读面。

## <img src="https://api.iconify.design/lucide/circle-help.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 常见问题

| 问题 | 回答 |
|---|---|
| 它会不会偷偷花钱？ | 会。注入的是用户角色消息，发出后模型继续跑、继续消耗 token 与配额。 |
| 我想一键关。 | 设置卡总开关（`enabled = false`）同时停掉三类注入与请求级 429 重试，手动 UI 保留。 |
| 范围更窄的出口？ | dock 的每会话开关、`resumeOnOpenTodos`（只关补跑）、`providerExcludes`（只排除某条 provider 的续跑）。 |
| 模型停了却没自动续跑。 | 日志找 `[session-rescue] <sid>: auto-<kind> skipped (pending/cooldown/max-resumes)` 或 `vetoed at fire time (<reason>)`。配额是连续语义——跑完一回合就恢复。 |
| 会不会打断「它在问我」？ | 不会，`ask_user_question` 之后不注入；goal 轮只在官方 driver 已经停机后才接管。 |
| 补跑从不触发。 | 它要求该回合自己写过待办清单且仍有未闭合项——从不用待办工具的会话结构性触发不了。 |
| 横幅在倒计时却什么都没发生。 | 到点前二次校验把它作废了（agent 消失、状态非 idle、inbox 有排队、或已有新轮）——看 `vetoed at fire time` 那行日志。 |

## <img src="https://api.iconify.design/lucide/wrench.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 开发

```sh
pnpm install
pnpm run check   # typecheck → lint → client build → host build → types → tests → integration → property → format
```

- 单测（手写宿主替身）驱动纯逻辑链：失败分类、调度闸门、回合事实折叠、dock 载荷解析。
- `test/integration/` 上真东西：发布产物经真实 cordis loader 装载；官方 testkit 装真 AgentLoop；真 goal 服务加官方 `goal-round-driver` 与脚本化失败的 mock LLM；中止语义（你停掉的回合不耗配额）。
- `test/property/`（fast-check）覆盖分类判序、回合事实折叠、`/state` 载荷解析，以及随机指令序列下调度器的状态机不变量——每条属性都带「判据真被走到」的守卫，没走到的判据直接红而不是绿。
- 覆盖率门是四项 100%，新增分支必须有走到它的用例。
- `test/publish-manifest.test.ts` 看住发布面：入口目标随包、无源码入口、`dependencies` 无 `@deepseek-ai/*`、`dsh-*` peer 精确钉且 `engines.dsh` 同范围、注释与文档无日期与本机路径。`test/dist-size.test.ts` 给产物设体积预算。

## <img src="https://api.iconify.design/lucide/scale.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 许可

MIT。源码在 [github.com/JayYuen666/dsh-session-rescue](https://github.com/JayYuen666/dsh-session-rescue)，问题提到该仓的 tracker。
