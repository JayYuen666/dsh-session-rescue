# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的格式，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

## 0.1.5

这一版把失败归因改到「本次请求实际走的线路」，投影挂载改成兼容新旧宿主协议的时序，
设置卡与 dock 读面统一到 shared 组件和 zod。

### Changed

- **失败归因读实际请求线路**：`agent/request-error` 载荷里的 `provider` 记进每会话台账；`pass` 兑换与
  未分类失败日志用它，取不到才回落初始化时的 `options.provider`。排期侧的排除名单改读
  `model.current()`（旧宿主回落 `options`），不再拿初始化线路当下一步线路。
- **投影挂载改双协议**：新增 `lib/projection-reader.ts`，`await register()` 之后按 disposer / handle
  分流；读口只在注册成功后交出，卸载途中迟到的注册当场释放，注册失败与注册表缺席同档回退全量扫描。
- **dock 状态解析改 zod**：信封 `ok` 必须为字面量 true，`sessions` 保留原对象再逐条投影；坏形状降级成
  中性显示，原型链键不会被写进表。
- **设置卡迁到 shared 组件与 zod**：时间输入按秒录入、按毫秒存，越界就地提示；保存条改整批拒绝文案。
- **构建与依赖**：client 产物按宿主 `PLATFORM_MODULES` 外置 zod；devDependencies 与 catalog/overrides
  抬到 `0.2.2-alpha.2`，`engines.dsh` 与 peer 保持 `^0.2.1-rc.3` 窗口，README 补滚动窗口说明。
- **插件页展示面进包**：新增 `locale/en.json`、`locale/zh.json` 与 `docs/DETAIL.md`、`docs/DETAIL.zh.md`；
  `exports` 增加 `./locale/en.json` 与 `./locale/zh.json` 两条显式子路径（install-probe 不解引用
  通配键），`files` 收进 locale 与 docs。
- **正则常量提取**：失败分类里的余额耗尽与限速措辞提取为命名常量，行为不变。

## 0.1.4

### Changed

- **失败分类器三个入口共用同一份字段投影与判序**：裸 429 只在 HTTP 语境里算限速证据；已知的 `finish_reason` 不再被当成上游异常；408/425 判瞬时，402 归永久，余额证据排在状态码之前。
- **回合事实与评审面收口**：未闭合待办改成白名单，未知状态不再算「未完成」；缺 `turn` 的调用按本轮窗口判「等用户」；`retryState` 取官方字面量联合，没有 `turn/end` 时不再按节点区间判工具活动。
- **Remote 数据面**：`$mount` 失败不再缓存；空的 `sessionId` / `provider` / `preset` 直接拒绝；六个端点收敛到同一条 `invoke`，错误带 `cause`。
- **设置卡文案**改用 `{detail}` 占位，并补三条远端不可用文案。
- **定时器释放收敛为 `releaseTimer`**（纯重构，行为不变）。
- **宿主线抬到 `0.2.1-rc.3`**：`engines.dsh`、peer/dev 依赖、overrides 与 README 徽标/正文同值。
- **CI/CodeQL/Scorecard/Dependabot 与 Windows 矩阵补齐**：构建脚本统一走 shared 的 `lib/build-*`，产物仍落 `dist/`。

### Fixed

- **dock 状态区分「字段缺失」与「坏形状」**：坏载荷不再显示成确信的空快照；非有限数被拒收；查表走 `Object.hasOwn`，原型链键不会冒充字段。
- **轮询的 `refresh` 改 try/finally**：订阅者抛错不再让定时器停表；dock 显隐计入编辑态与写失败；`RescueEditor` 的 key 带上会话与轮次，草稿不串档。

### Added

- `DockActionSignals` 增加 `editing` 与 `hostActionFailed`。

## 0.1.3

### Fixed

- **冷却哨兵 `lastFireAt` 由 `0` 改为 `null`**：`0` 是合法时钟值，零起点时钟下一次真实 fire 会被当成「从未发生」，冷却被静默关闭。对外快照仍是 number；全为 null 时回 0，与旧契约逐字一致。
- **补上 integration / property 两份 vitest 配置的遗漏项**；client 产物里 `//#region` 行内的 pnpm store 路径一并折叠，跨机器构建字节一致。

## 0.1.2

这一版把数据面迁到官方 Typert Remote，并修掉非回环绑定的信任闸门回归；宿主生态升到 alpha.2 后继续跟到 rc.2，发布面补上类型声明、tarball 内容与 registry 元数据门禁。

一类自动注入的判据也变了：**goal 轮次不再一律让路**。其余改动集中在客户端侧的可见性与发布/构建面，注入文案与默认配置未改。

### Changed

- **六条 `/_dsh/session-rescue/*` 端点改为官方 `sessionRescue` Remote**：客户端改走 source-mode descriptor + remote 读面；HTTP 路由、CSRF、`shared/lib/http`、`shared/lib/trust`、`connection.requestRejection` 与 webServer 子 fiber 一并删除。
- **发布面补齐 `types/` 声明产物**：构建后把相对 `.ts` 说明符改写成 `.js`；`exports["."].types`、keywords/homepage/bugs/engines.node 与 `files` 同步。
- **门禁补齐**：包根每份 `.md` 都进发布面；声明入口存在且不比源码旧、不含本机绝对路径与 pnpm 内容寻址目录；registry 与宿主发现面四道检查；产物体积预算。
- **publish.yml 加固**：concurrency、action 钉 commit SHA、`--provenance`、`--publish-wait-timeout`、registry 预检，不再打印 token 长度。
- **goal 轮次：让路判据从排期侧移到触发侧，driver 停机后由本包接管**。官方
  `goal-round-driver` 在 `agent/error`（以及 max-tokens、flush 失败、卸载）上只 `disarm`，
  其 README 明写「No abnormal auto-retry —— 瞬时 provider 与持久化失败要等人授权续跑」。
  原先「三类注入一律让路」因此等于把那条失败回合丢给没人管。现在 goal 轮照样排期，
  触发侧现读 `ctx.goals.get(agent)` 的 `phase`/`activation`：`active` + `disarmed` ⇒ 接管；
  `active` + `armed`（窗口里人 `resume` 过）⇒ 让路；`paused`/`blocked`/`complete` ⇒ 让路
  （那是人和生命周期的决定，不覆盖）；服务不在位、读抛错、无 current goal、或那两位不是
  官方字面量 ⇒ 让路（证不了停机就不接管）。判据必须放在触发侧：driver 的 `disarm` 发生在它
  自己的 `agent/error` 监听里，而跨插件的监听先后不是契约。
- 回合事实投影去掉 `EndRow.goalDrivenTurn`（该结论不再由回合事实给出），`stateVersion` 1 → 2；
  `TurnReview` 同步少一位。`scheduleDrivenTurn` 不动——Schedule 提醒回合仍在排期侧一律让路。
- `devDependencies` 的 `react`/`react-dom` 从 `^19.3.0` 改为 `18.3.1`：宿主锁的是 React 18.3.1，
  客户端 bundle 又把 react 外部化，测试层跑在 19 上等于用产品从不运行的那个 major 验收 UI。整套
  客户端用例（含真实 happy-dom + react-dom 挂载）在 18.3.1 上重跑通过。`@types/react*` 仍随 catalog
  取 19.3.0——类型面比运行时新，故客户端代码不得使用 React 19 独有 API 与语法糖。
- `engines.dsh` 从 `>=0.2.1-alpha.2` 改为与 peer 同一份范围（随宿主线升到 `^0.2.1-rc.2`）。宿主装插件时校验的是
  peer，`0.` 主版本上的 `^` 带上界（<0.3.0），而 `>=` 没有——旧写法等于对外宣称兼容 0.3/1.x，
  宿主却会当场拒装。门禁断言随之从「同值」改成「同一份范围」。
- **客户端不再重复渲染排队区**：官方 `dsh-client-ui-conversation` 自己就往
  `conversation.input.dock` 注册了 `QueueDock`（`id="queue"`，逐行编辑/删除/插话都有），本包在
  同一条槽（`order=500`）按同一份 inbox 投影又列了一遍，同一批待发消息显示两次。删掉本包那份
  及其 `withdrawQueueItem`/`editQueueItem` 动作位、两条队列 CSS 与两个 locale key；顺带消掉了
  一处条件调用 `useProjection` 的 hook 违例。
- `/state` 轮询加了退避与过期判定：连续读不到有效快照时按翻倍增到 30s 上限；连着三跳读不到才把
  缓存判为过期（横幅与每会话开关回到中性态），且只有「由有到过期」那一跳才惊动订阅者。此前读不通
  既不停增档、又继续拿着旧快照走倒计时。
- 设置卡的 `providerExcludes` 草稿改存「用户输入或 null」而不是「当前显示值」：未在这边动过的字段
  恒等快照。旧写法在别的页签/别次 apply 写了同一命名空间后会显示旧值、报「有改动」，一按保存就把
  别人刚写的值盖回去。

### Fixed

- **有失败轮可重试时 dock 容器可能整块隐藏**。`decideDockState` 的 `hasContent` 漏算编辑/重试/续写
  三条动作位：快照空窗 + 无 pending + 无队列那一帧容器 `hidden`，而容器里那几个按钮本该在——用户看到
  的就是「回合失败了却没有任何入口」。`/state` 一直读不通的部署下这是常驻状态。
- `npm install` 在 pnpm 12 下半途失败：`dsh-fs-local` 传递引入 `koffi`，而其安装脚本未被放行，
  pnpm 12 起「被忽略的构建脚本」直接判错。`pnpm-workspace.yaml` 的 `allowBuilds` 补上 `koffi: true`
  （`esbuild` 同批已有）。发布流程那条 `pnpm install --frozen-lockfile` 因此才走得通。
- `build-types.mjs` 不再走 `npx tsc`：`npx` 要在 PATH 上找 `npx`/`npx.cmd`，Windows 上
  `execFileSync` 不带 `shell: true` 就 ENOENT，pnpm 装的仓里 `npx` 本身也不保证存在。改为解析本地
  `typescript/bin/tsc` 并用 `process.execPath` 调用。
- `src/client-entry.ts` 回到 `max-lines` 门槛内（写路径此前逐条出口各写一遍 403 重试语义，现收敛成
  一条共享写通道；`/state` 载荷解析器移入 `lib/dock-state.ts`，与它输出的类型同源）。
- **显式瞬时码不再被配额措辞抢判**。`classifyFailure` 把文本兜底排在 code 路由之前，于是 provider
  把「本分钟速率已到顶」写进 message 时，`RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`/`EMPTY_RESPONSE`
  这五个本该重开回合的码被读成余额耗尽并判永久——瞬时失败因此永不续跑。现按「永久码一票否决 →
  401/403 → 显式瞬时码 → 429 → 余额证据 → 速率措辞」的次序走，请求级重发判据同序。
- **轮次号只收安全整数**。宿主投影里 `turn` 是 number，坏载荷（NaN、小数、超 2^53）此前一路直穿：
  写进 `turn-facts` 的折叠态会让自家 schema 在读回时拒收整份快照，写进调度器的
  `lastHandledTurn` 更糟——水位比较 `turn <= lastHandledTurn` 对 NaN 恒判 false，那条会话的
  「旧轮重放」闸门从此永久失效，重放的旧回合既能复位配额又能再排一次注入，日志里一个字都不提。
  现两侧都在入口处收口（同一条判据，`lib/turn-facts.ts` 与 `host.ts` 各有落点）。
- `restorePending()` 不再为未知会话凭空造记录。旧写法走 `rec()`，于是「恢复一条已被 dispose/淘汰的
  挂起待办」拿到的是 counts 全 0 的新记录——`maxResumes` 这道防失控闸门被静默复位，且没有任何
  说明。现在记录不在位就返回 false，由调用方按「这一条补发不出去」处置。

### Added

- 集成层新增两条真 goal 用例（`test/integration/goal-round.test.ts`）：真 `GoalService` + 真
  `goal-round-driver` + 真 AgentLoop + 官方 mock LLM 故障脚本。一条钉住「driver 只 disarm、
  本包接管恰好补发一条且不带 goal kind」，另一条钉住「窗口里 resume 之后同一条会话只留下 driver
  一个续跑者」。`@deepseek-ai/dsh-goal` 与 `@deepseek-ai/dsh-goal-round-driver` 按 `0.2.1-alpha.2`
  进 devDependencies（只用于类型对账与这层装配；发布面里它们是可选条目，所以 `host.ts` 的读面
  仍按防御式本地投影，不把官方类型写进 `types/`）。
- **集成层补齐真宿主语义与真传输面**（`test/integration/`，`npm run test:integration`，已接进
  `npm run check`，发布流水线因此也会跑）：`agent-loop.test.ts` 用官方 testkit 装真
  SessionStore/AgentLoop/投影注册表；`http-routes.test.ts` 与真 `WebServer` + 真 socket 对账
  成帧、Host 权威、keep-alive 与残断请求体；`abort-semantics.test.ts` 钉住「用户中止不 emit
  `agent/error`、不消耗续跑配额，之后的真瞬时失败照常续跑」；`goal-round.test.ts` 见上。
  装配面抽到 `http-harness.ts` 单源，两个 HTTP 用例文件共读一份闸门形状。
- **属性/模糊层**（`test/property/` + `test/integration/http-fuzz.test.ts`，`npm run test:property`）。
  `fast-check` 进 devDependencies。四份属性用例覆盖失败分类判序、回合事实折叠、`/state` 载荷解析，
  以及调度器的**状态机不变量**：随机指令序列驱动，逐步核对会话数上限、按 kind 的配额与冷却、
  待办双向一致、定时器配对、水位单调与淘汰只发生在空闲记录上。随机报文那一份把方法/路径/查询串/
  Host/Origin/sec-fetch-site/写令牌/请求体十个维度打散重投，判三条与形状无关的承诺（不 5xx、
  信封完好、越权不得碰巧放行）。
  两层都带「判据必须真被走到」的计数守卫：`size: "max"` 之前 fast-check 默认只把 `maxLength` 当
  上界（实测 400 的上界默认只到 12 条），会话数上限那道闸门在短序列里永远碰不到，越界与淘汰两条
  判据就成了空转的绿灯；守卫让「没走到」直接变红灯。调度器用例另外先把状态机灌过上限再腾出空闲位，
  使这两支不靠概率命中。

## 0.1.1

宿主生态与工具链升到当前发布线，并修掉一处会让局域网部署整片失效的信任闸门判据。**三类自动注入的判据、注入文案与默认配置未改**，改的是「跟谁对齐」以及发布面。

### Changed

- `@deepseek-ai/dsh-*` 家族（41 枚）与 peer 的 `@deepseek-ai/dsh` 从 `0.2.1-alpha.1` 升到 `0.2.1-alpha.2`：`devDependencies`、`peerDependencies`、`pnpm-workspace.yaml` 的 `overrides` 与 `engines.dsh` 四处同值——`test/publish-manifest.test.ts` 要求它们与 peer 逐项相等，且一律精确钉（registry 的 `latest` 标签可能指向远早于宿主 ABI 的版本，`^`/`~` 会让消费方在没有测试的情况下换掉宿主类型面）。`@deepseek-ai/cordis` `4.0.5-alpha.1` 与 `@deepseek-ai/schemastery` `3.18.5-alpha.1` 不动：那是 alpha.2 自己声明的约束（`~4.0.5-alpha.1` / `~3.18.5-alpha.1`），registry 上没有更新的 alpha。
- `@jayyuen66/dsh-plugin-shared` `^0.1.2` → `^0.1.4`：0.1.3 把宿主包从它自己的 `dependencies` 挪进 `peerDependencies`，消费方 profile（`nodeLinker: hoisted` + `autoInstallPeers: false`）因此不再物化出第二份宿主类型面；0.1.4 把那些 peer 钉到 `0.2.1-alpha.2`，依赖树里最后一处旧宿主需求随之清零。
- 工具链：`vitest`/`@vitest/coverage-v8` 5.0.3、`vite` 8.3.4、`rolldown` 1.2.13、`oxlint` 1.87.0、`oxfmt` 0.72.0、`oxlint-tsgolint` 7.0.2004、`happy-dom` 20.14.6、`@types/node` 26.6.5。
- README 拆成两份语言纯净的文档：`README.md`（英文，registry 页面默认读它）与 `README.zh-CN.md`（中文），两份内容对等、互相链接。

### Fixed

- **局域网绑定下六条 `/_dsh/session-rescue/*` 路由整片 403**。宿主 0.2.1-alpha.2 把 `WebServer` 的 `Config.host` 从 `'127.0.0.1' | '0.0.0.0'` 换成任意真实网卡地址字面量，并在载入时拒掉通配地址；本包那句 `webServer.host === "0.0.0.0"` 因此恒为 false，`servingNonLoopback` 再也传不到信任闸门，非回环部署会被 Host 腿判成 `untrusted host authority`。类型面放宽成 `string`，编译期抓不到，所以这道改判据只能落在门禁与文档上。现改用 shared 的 `isNonLoopbackBindHost(webServer.host)`——口径与官方 `isLoopbackHost` 对齐，且不必对本包只做类型消费的宿主包做值导入。
- 源码注释里钉住的上游坐标全部按安装态重核：`@deepseek-ai/dsh-session` 的 `id`/`header`/`snapshotEvents` 与那两枚 `@deprecated` 行号、`@deepseek-ai/dsh-host-webserver` 的类与 `register`、`dsh-session-projection` 的 host-only `register` 重载、客户端侧 `slot-contract`/`sessions`/ui-chat 若干处；agent-loop 那条「对 retry 是裸 `continue`」的注记此前指错了文件也指错了行，真址是 `packages/core/agent-loop/src/agent.ts:523-526`。退避阶梯保留：上游到 alpha.2 仍然不插任何延迟。

### Added

- `types/` 声明产物：新增 `build-types.mjs` 与 `tsconfig.types.json`，`exports["."]` 加 `types` 条件，`npm run build:types` 接进 `check`/`prepack`/`prepare`。声明里的相对 `.ts` 说明符由脚本改写成 `.js`——`tsc` 会把 NodeNext 的源码后缀原样抄进 `.d.ts`，留着它消费方就解析不到。
- 发布面门禁：包根每份 `.md` 都必须在 `files` 里（npm 只无条件附带 `README*` 与 `LICENSE`）；声明入口存在、声明不比源码旧、声明不含本机绝对路径与 pnpm 内容寻址目录、声明里的相对说明符指向产物后缀。
- registry 与宿主发现面门禁：`keywords`/`homepage`/`bugs`/`repository` 四项与包名同源于同一个仓库归属；`engines.node` 存在且 `engines.dsh` 与 peer 的 dsh 同值（宿主装插件时校验的是 peer，从 dsh 0.1.7-rc 起还包括 `@deepseek-ai/dsh-*`）；`dsh` 段的 `manifestVersion`/`bundle.patch`/`client.platform` 齐备且 patch 文件随包发出；`files` 不打包源码面。
- `test/dist-size.test.ts`：给 `host.js`、`client.js` 与入口声明设体积预算（按实测上浮约 25%）。产物刻意不 minify——压缩会抹掉跨包说明符字符串，让「依赖必须外部化」那两条断言变成恒绿。
- 注释卫生门禁扩展：除日期外，再禁本机绝对路径、评审条目号、决策来源与修复过程的簿记、退役叙事，存量一并清掉。
