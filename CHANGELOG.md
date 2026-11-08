# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的格式，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。这里的偏离是刻意的：版本标题不写发布日期，
各版发布时间以 npm registry 为准（`npm view <包名> time` 取得到）。

## 0.1.11

一轮围绕「重试码表不被预设误删」的修正：`enhanced` 从整表替换改为并集，设置卡新增按 provider 编辑自定义重试码；请求级/回合级判定逻辑不变。

### Changed

- **`enhanced` 预设改为增量并集**（`host.ts`）：写入前读取该 provider 现行的 `retryableCodes`，把预设码表与现行自定义码合并去重后再落盘，不再整表替换。应用 `enhanced` 不会再删掉 `PI_AI_ERROR` / `MALFORMED_RESPONSE` 这类手写码；`default` 仍保持「重置为官方默认」的语义，`always` / `off` 不变。
- **设置卡支持自定义重试码**（`src/client-entry.ts` + `src/remote.ts` + `host.ts`）：每个 provider 行新增码表输入框与「保存码表」；写入走 `retryPolicy` 的 `custom` 档，只替换 `retryableCodes`，`mode` / `maxRetries` / `backoff` 沿用现行策略（缺省回官方默认）。`retryProviders` 回传现行码表，输入框初始值与磁盘一致。
- **`custom` 校验**：客户端按逗号拆分为数组；宿主端 trim、去重并拒绝空表、空项、非字符串与未知 provider（400），CAS revision 冲突仍走 409。

### Added

- **码表编辑的回归测试**：host 覆盖 `enhanced` 并集、`custom` 保留非码字段、空表/坏码 400、`retryProviders` 回传码表；client 覆盖编辑后保存的 `preset=custom` 请求体与成功提示。

## 0.1.10

一轮围绕「手动接续入口与请求级分工」的调整：回合级动作迁到回合尾部，dock 只留会话级三件；请求级限流重试改为先问下游、下游放行才接手；新增默认关闭的插话续跑与配额耗尽提示。三类自动注入的判定语义不变。

### Changed

- **回合级动作迁到 `conversation.chat.turnTail`**（`src/client-entry.ts`）：编辑重发 / 重试 / 发送续写从输入框上方的 dock 移到最新完成回合的操作行（与一方 deliverables / plan / schedule 同栈）；dock 只保留续跑倒计时横幅 / 停止并重问 / 每会话开关。`lastCompletedUserTarget` 与 `failureOfLastTurn` 在会话运行中交回 null，动作行随整块隐藏，与迁移前「运行中不出回合级动作」一致。
- **停止重问改为先改文本再停**：按钮展开草稿（预填最后一条用户消息，Esc 收起、⌘/Ctrl+Enter 确认），失败时草稿保留、错误行就地显示；成功后才收起。
- **失败原因行不再由本包重复渲染**：宿主 transcript 的 `turn-error` / `turn-max-tokens` 节点已经渲染 code 与 message，动作行里那一份逐字重复的文本删除。
- **宿主内置重试在途时重试按钮改为整块隐藏**：此前的禁用态与 composer 此刻的「继续生成」主按钮并存没有增量信息。
- **每会话开关改用设置卡同款 switch**（`.dsu-switch`，样式随唯一的 `<style>` 与 `CARD_UI_CSS` 一起注入）；hero 空态（转录为空且不在跑）不显示开关行，第一条消息发出后立即回显。
- **请求级限流重试改为「先问下游」**（`host.ts`）：先 `await next()`，下游交回 `{ kind: "retry" }` 就原样采纳（官方 `llm-retry` 的码表过滤、`Retry-After`、抖动与持久事件全部保留）；下游放行（码表外、次数耗尽、`Retry-After` 超过策略上限、abort 或条目失效）才由本包阶梯接手。原先「宿主解析出 `retryPolicy` 就让位」的判据在真宿主上恒真，已删除。`Retry-After` 超过本包封顶（默认 30 秒）时不再委托 `next()`，请求按终态收束；`next()` 只问一次。
- **重试档位 `default` 改为显式写官方默认策略**：不再 `unset`——settings 的 user section 与行配置同文档，`unset` 会把插件接管前手写的 `retryPolicy` 一并删掉；代价是官方将来调整默认值时该 provider 不自动跟随。设置卡在覆盖非规范形状（疑似手写）的配置前先弹确认。
- **`agent/disposed` 的按会话清理集中到 `handleAgentDisposed`**：新增撤掉耗尽位，其余既有台账（请求计数、失败线路、每会话开关、投影告警去重位、待兑 pass、挂起快照）原样释放。
- **文案与产物预算**：插件列表标题改为「会话自动接续 / Session auto-continue」；`HOST_BUDGET_BYTES` 按实量重定为 144 KB。

### Added

- **插话续跑（实验，默认关）**：`unfinishedSteerMode` 打开后，回合将收尾而该回合自己写的清单仍未闭合时，经 `agent.steer` 在同一回合内续做；与补跑共用 `maxUnfinished` 配额。等用户（`ask_user_question`）、Schedule 开启的回合与 goal 轮一律让路；调度器已有待办时不叠加。设置字段由十三项增至十四项。
- **配额耗尽升级提示**：`/state` 的会话行新增 `blocked` 位（`kind` + 造次失败轮），客户端经 `shell.overlay` 弹一次提示，按「会话 → 轮次:类别」去重；正常完成回合（补跑为清单闭合）后撤位，再次耗尽会再报。
- **崩溃恢复的手动接续**：回合终态为 `interrupted`（宿主崩溃修复给孤儿回合补写的闭合标记）时，回合尾部落一个「继续中断的回合」按钮，纯手动；live 中止（`aborted`）不出现。

## 0.1.9

修复 0.1.8 引入的 web 启动隐患：卡片组件收回 `client.js` 内联，移除对 `@jayyuen66/dsh-plugin-shared/client` 的模块表外置与 `cordis.patch.yml` 里的 shared 供应行。调度、恢复与投影的判定逻辑不变。

### Fixed

- **卡片组件内联进 `client.js`，产物自足**：0.1.8 把 `@jayyuen66/dsh-plugin-shared/client` 外置给宿主模块表，靠 `cordis.patch.yml` 插入的一条**不写 id** 的 shared 组件行把 shared 装载成供应方。这份供应链在 shared 只作为传递依赖装进 profile 时（`dsh plugin add` 的正常结果）没有保证——宿主侧可以既不报错也不把 shared 的 client 产物排进启动图，页面启动时 `require("@jayyuen66/dsh-plugin-shared/client")` 落进 `missed the module table`，整窗「应用无法启动或已意外停止」（dsh-ocr-review 仓 issue #2，宿主 0.2.2-rc.1 dsh desktop 实报）。`build-client.mjs` 的外置清单收回 react / zod 两族（宿主 `PLATFORM_MODULES` 供给，内联反而会产生第二份身份），卡片组件全部内联；`package.json` 的 `dsh.bundle.client.external` 与 patch 里的 shared 供应行随之移除，`cordis.patch.yml` 回到只声明本包一行。`test/build-client.test.ts` 的工厂替身对未知请求的抛出把外置回流挡在装配层。

## 0.1.8

宿主开发基线抬到 `0.2.2-rc.1`（支持窗口 `^0.2.1-rc.5 || ^0.2.2-alpha.3` 未变），`engines.node` 下限抬到 `>=24.9.0`；卡片组件改由 shared 的 `./client` 供。调度、恢复与投影的判定逻辑不变，需要留意的是 `engines.node` 抬高后 node 22 装不上本包。

### Changed

- **shared 抬到 0.2.4**：catalog、生成物与 lockfile 随之同步；shared 新增的普通依赖 `@deepseek-ai/dsh-fs-patch` 由 shared 自己安装，本包不重复声明。
- **宿主开发基线**：`devDependencies` 的 dsh 家族抬到 `0.2.2-rc.1`，`@deepseek-ai/cordis` 抬到 `4.1.0`，cordis 插件组四枚分别抬到 `1.1.0`（timer 为 `1.2.0`），`@deepseek-ai/schemastery` 抬到 `3.19.0`；`@deepseek-ai/dsh-ptc-runtime` 从 devDependencies 移除（源码与测试都不再引用它）。`engines.dsh` 与三枚 `@deepseek-ai/dsh*` peer 保持 `^0.2.1-rc.5 || ^0.2.2-alpha.3` 未动；`@deepseek-ai/schemastery` 的 peer 由 `^3.18.6-alpha.1` 放宽为 `^3.18.5 || ^3.18.6-alpha.1`，与两条宿主线各自的实装版本对齐——写确切值会在另一条线上被 npm 的严格 peer 解析拦在 `ERESOLVE`。`engines.node` 由 `>=22.12.0` 抬到 `>=24.9.0`，取值取自宿主自己的下限。
- **卡片组件改由 shared 的 `./client` 供**：`src/client-entry.ts` 与 `src/remote.ts` 的运行期值导入迁到 `./client`（只换说明符，没有逻辑改动），`package.json` 新增 `dsh.bundle.client.external`，`build-client.mjs` 的外置清单同步；`cordis.patch.yml` 因此插入一条**不写 id** 的 `@jayyuen66/dsh-plugin-shared` 组件行（写 id 会在插件页多出一个可关闭的组件，关掉后设置卡失去组件供应）。
- **CI 的 node 矩阵收敛**：`ci.yml` 的 `node: [22, 24]` 加 macOS 排除改为单格 `node: [24.9]`，两份 workflow 的 `node-version` 由 `24` 改为 `24.9`，与 `engines.node` 同值。
- **文档纠偏**：README 的 shared 值导入名单原列 `lib/card-apply` 与 `lib/card-diff`，这两位在产物里已不存在——按 `host.js` / `client.js` 当场实测改为四枚 `lib/*`（host 侧）加 `client`（client 侧）；`host.js` 值导入的宿主包由「两枚」改为三枚（原文漏了 `@deepseek-ai/dsh-typert-protocol`）；`insert:` 块由「本包那一行」改为「两条条目」并写明 shared 那行为何不写 id；检查职责那句把两条规则写反了——精确钉版那条扫的是 **devDependencies**，peer 那条要求的是与 `engines.dsh` 同一条窗口范围，原文说成「peer 精确钉且同范围」。

## 0.1.7

一轮围绕「记录被淘汰后状态仍然成立」的加固：调度器把配额记忆留在淘汰之外，回合读取接口统一按最后一次结果；
客户端重试档位不再把 always 显示成次数上限；发布链把守卫前移、产物改为 tarball 交棒，
测试补上 SEED 解析、文档同源与工作流钉版三道检查。

### Changed

- **宿主开发线抬到 `0.2.2-alpha.3`**：devDependencies 与 catalog/overrides 同值；`engines.dsh` 与
  `@deepseek-ai/dsh*` peer 改为 `^0.2.1-rc.5 || ^0.2.2-alpha.3` 的并集窗口；cordis 家族与
  schemastery 同步抬到 `*-alpha.2` 线。
- **调度器配额跨淘汰保留**（`lib/resume-scheduler.ts`）：新增 `quotaMemo`，记录因容量闸门被淘汰时
  记下三档 `counts`，重建时接回原计数；`hasCapacity` / `evictIdleSessions` 接受 `protect` 参数，
  为当前会话腾位时不挤掉它自己的配额。`onSuccess` / `onTodosClosed` 改走 `quotaOf()`，记录已被
  淘汰时仍能复位或递增。`MAX_RESUMES_REASON` 导出，调用方与测试不再抄字面量。
- **`restorePending` 只接受挂起来源**：记录必须处于 `suspended` 且当前没有 pending，否则快照作废；
  脏快照不再覆盖正常记录。
- **回合读取接口 last-wins**（`lib/turn-facts.ts`、`lib/turn-scope.ts`）：opener 查找改 `findLast`；
  中断助手消息与 `turn-error` 按 `seq` 取最后一条，不再依赖 nodes 排列顺序。
  `TranscriptView.running` / `removed` 改为只读，客户端不再有写回宿主快照位的口子。
- **客户端重试档位**（`src/client-entry.ts`）：`always` 档显示 `unlimited`，不再把宿主兜底的
  5 次显示成上限。
- **发布链与 CI**：`publish.yml` 增加默认分支守护 job；`check` 用 `pnpm pack` 产出 tarball，
  经 artifact 交给只持有 `id-token` 的 publish job；`ci.yml` 的 tracked-tree 门禁扩到全部 OS，
  dependency-review 显式关闭 PR 评论，bundle patch 解析改为块内向下找 `name` 并在解析不出时点名。
- **工作流钉版**：`pnpm/action-setup` 抬到 `6.1.1`、`github/codeql-action` 抬到 `4.39.2`，
  `publish.yml` 的 `actions/download-artifact` 与 `ci.yml` 统一到 `8.0.2`。
- **文档**：两份 README 的宿主窗口与徽章同步到 manifest；`cordis.patch.yml` 的说明改成
  「操作列表 + insert 条目」的实际形态。

### Fixed

- **abort 监听残留**（`host.ts`）：`sleepWithAbort` 的卸载释放器先摘 `abort` 监听再结算。
- **idle 清理多余守卫**（`host.ts`）：`requestRetryCounts.delete` 不再单设 `typeof` 守卫，
  与同文件其他调用同一信任档。

### Added

- **SEED 解析门禁**（`test/property-seed.test.ts`）：只接受十进制非负、安全整数且 32 位宽度的种子；
  十六进制、科学计数法、正号、小数、负数、超宽值全部拒绝，避免「换种子换序列」的假复现。
- **文档与版本同源门禁**：`test/publish-manifest.test.ts` 新增三条断言——CHANGELOG 顶部条目必须
  等于 `package.json` 的 version；两份 README 必须写明 `engines.dsh` 的完整窗口；README 的 `dsh`
  徽章解码后必须等于窗口的第一条。
- **工作流钉版门禁**（`test/workflow-pins.test.ts`）：同一 action 在本仓只允许一个 SHA 与一个版本
  注释，且 `uses` 必须是 40 位 SHA 钉版；`publish.yml` 与 `ci.yml` 的 download-artifact 漂移由它兜住。
- **工具链与构建**：`.gitattributes` 补 CRLF/二进制规则；`.gitignore` 放行 `.env.example` 与测试
  证书夹具；property 层改为串行，integration/property 的 coverage 配置只留开关；dependabot
  名额放宽到 6 并补 `*` 兜底分组。

## 0.1.6

一轮跨模块审查修复：调度器加容量闸门、投影读取接口改三态、失败分类与编辑重发判据统一处理，
测试补 e2e 与 platform 两层；宿主开发线抬升，发布链同步加固。

### Changed

- **宿主开发线抬到 `0.2.2-alpha.2`**：devDependencies 与 catalog/overrides 同值；`engines.dsh` 与
  `@deepseek-ai/dsh*` peer 写支持窗口 `^0.2.1-rc.3`。
- **`prepack` 并入 `prepare`**：两段脚本内容逐字相同，而 pnpm 12 的 `pack` 与 `publish` 都会在
  `prepare` **之前**先跑 `prepack`（实测 `pnpm pack` 与 `pnpm publish --dry-run --no-git-checks`
  的回执里两段都出现），同一条发布因此把整套构建跑两遍。删掉 `prepack`——`prepare` 在两条路上
  都会被跑，产物照样在打包前就位。
- **投影挂载的两处统一处理**：`handle.dispose()` 的拒绝不再变成 `unhandledRejection`（它只说明注册
  已随宿主卸载被撤销，不是需要重启插件的错误，改为一条 `[session-rescue]` 警告）；`publish`
  抛错时先释放这次注册再抛——否则调用方把这次挂载当成「没装上」，注册却已经成功，泄漏一个常驻 effect。
- **文案**：英文 `unfinishedLessonDetail` 不再把复数名词硬连在 `{count}` 后（`count=1` 时是语法
  错误，而这条 detail 会持久化进 lesson-loop），改为 `… still had open items (open count: {count})`；
  中文 `unfinishedText` 与英文对齐成「从清单中未完成的**第一项**继续执行」。
- **调度器容量闸门**（`lib/resume-scheduler.ts`）：新增 `hasCapacity()`，200 条满且无可淘汰空闲记录时不再新建排期（skip 理由 `capacity`）；`host.ts` 对 capacity skip 升 warn 并去重，任一次 schedule 成功后回落再武装，堵会话表无界膨胀。
- **投影读取接口三态化**（`lib/turn-facts.ts`）：`asFacts` 由二值改三态（absent / rejected / facts），`host.ts` 对 rejected 每会话报一次 stderr——投影降级的原因不再与「投影缺席」混叠。
- **失败分类判序与白名单**（`lib/failure-classify.ts`）：请求级重发把 `RATE_LIMIT` 提到余额措辞之前（与回合级同序，属性层钉死）；`UNRECOGNIZED_FINISH_REASON` 白名单扩 `tool_calls` / `function_call` / `length` / `safety` / `recitation`；余额耗尽不再报「疑似限流」。
- **客户端写通道**（`src/client-entry.ts`）：取消/开关在途时按钮 disabled；重试档位改逐项串行写到磁盘（并行写入会撞 settings-revision-conflict）；stopAndReask 的 cancel 被拒改报「重问已入队」。
- **包元数据**：author 改对象形；`@deepseek-ai/schemastery` peer 放宽为 `^3.18.6-alpha.1`；devDependencies 新增 `@deepseek-ai/dsh-app-boot` / `@deepseek-ai/dsh-config-editor`；catalog 的 shared 抬到 0.2.2。
- **文档**：两份 README 与 `docs/DETAIL(.zh).md` 重写配额清零语义、`providerExcludes` 精确匹配、重启清冷却、开关台账满额 409、429 窄化；ci.yml 的 actionlint 改按文件豁免。

### Fixed

- **定时器重复挂载泄漏**（`lib/resume-scheduler.ts`）：`attachTimer` 覆盖前先 `releaseTimer`。
- **preFireCheck 抛错卡死补发**（`host.ts`）：新增 `preFireCheckSafely`，判据抛错时 `settle("skipped")` 并报 error——否则该会话的 `rec.pending` 永久非空，再也排不进、记录不可淘汰。
- **跨版本脏 kind 回落**（`lib/resume-scheduler.ts`、`host.ts`）：新增导出 `rescueKindOf`（空串回落 `resume`），`resumeAfterReconnect` 先归一再发文案，脏快照不再让 `textForKind` 在循环里抛错、带走后续所有会话的补发。
- **可调用投影 handle 误判**（`lib/projection-reader.ts`）：`isProjectionHandle` 收 `typeof === "function"` 且判序提前，新宿主可调用+可等待的 handle 不再被当旧 disposer 接走（旧症：读口恒 undefined 且无日志）。
- **编辑重发目标过滤**（`lib/transcript.ts`、`lib/turn-scope.ts`、`lib/turn-review.ts`）：`lastUserNode` 按 `source.kind` 过滤非人类 user 节点，goal/schedule/插件注入不再被当编辑重发文本；中断轮不再借会话级 `lastAgentError` 冒充本轮原因；`turnStartSeq` 边界不连续时返回 undefined；todos 快照改倒扫 last-wins。
- **客户端展示**（`src/client-entry.ts`、`src/remote.ts`）：fork 导航 `openSession` 包 try/catch；补 `.sr-dock[hidden]{display:none}`（flex 盖掉 UA hidden）；三入参校验改 `.trim().min(1)`。
- **构建脚本**（`build-client.mjs`、`build-host.mjs`、`build-types.mjs`）：`BUNDLE_PKG` 采集先剥注释，块注释里的旧值不再被采信；host 产物判据改「恰好一条」；类型清单 JSON 解析报错带路径、0 份声明即抛错；删除幻影声明 `build-utils.d.mts`。

### Added

- **测试两层**：`test/e2e/rescue-loop.e2e.test.ts`（真 AgentLoop + 官方 mock LLM 的多回合/跨会话全旅程）与 `test/platform/scheduler.platform.test.ts`（非单调时钟、容量饱和、0 是合法时钟），check 链相应新增 `test:e2e`、`test:platform` 两腿；另新增 `test/integration/settings-real.test.ts`（真 app-boot + config-editor 钉 volatile 投影与 CAS）与 `test/projection-reader.test.ts`。
- **事件字段唯一来源**：新增 `lib/event-fields.ts`（投影折叠与回退扫描的事件读取判据）。

## 0.1.5

这一版把失败归因改到「本次请求实际走的线路」，投影挂载改成兼容新旧宿主协议的时序，
设置卡与 dock 读取接口统一到 shared 组件和 zod。

### Changed

- **失败归因读实际请求线路**：`agent/request-error` 载荷里的 `provider` 记进每会话台账；`pass` 兑换与
  未分类失败日志用它，取不到才回落初始化时的 `options.provider`。排期侧的排除名单改读
  `model.current()`（旧宿主回落 `options`），不再拿初始化线路当下一步线路。
- **投影挂载改双协议**：新增 `lib/projection-reader.ts`，`await register()` 之后按 disposer / handle
  分流；读口只在注册成功后交出，卸载途中迟到的注册当场释放，注册失败与注册表缺席同档回退全量扫描。
- **dock 状态解析改 zod**：信封 `ok` 必须为字面量 true，`sessions` 保留原对象再逐条投影；坏形状降级成
  中性显示，原型链键不会被写进表。
- **设置卡迁到 shared 组件与 zod**：时间输入按秒录入、按毫秒存，越界就地提示；保存条改整批拒绝文案。
- **客户端用例的 React 基线回到 `^19.3.0` / `^19.3.1`**：0.1.2 曾把 devDependencies 落回
  `18.3.1` 并注明「宿主锁的是 React 18.3.1」，这一版按 `@types/react` 的 catalog 规则与客户端
  代码使用的 API 面统一回 19。宿主运行期提供的仍是 18.x（`packages/client/*` 声明 `^18.2.0`），
  客户端代码因此**不得**使用 React 19 独有 API——这条约束不变，只是验收环境与类型声明回到同一 major。
- **构建与依赖**：client 产物按宿主 `PLATFORM_MODULES` 外置 zod；devDependencies 与 catalog/overrides
  抬到 `0.2.2-alpha.2`，`engines.dsh` 与 peer 保持 `^0.2.1-rc.3` 窗口，README 补滚动窗口说明。
- **插件页展示进包**：新增 `locale/en.json`、`locale/zh.json` 与 `docs/DETAIL.md`、`docs/DETAIL.zh.md`；
  `exports` 增加 `./locale/en.json` 与 `./locale/zh.json` 两条显式子路径（install-probe 不解引用
  通配键），`files` 收进 locale 与 docs。
- **正则常量提取**：失败分类里的余额耗尽与限速措辞提取为命名常量，行为不变。
- **cordis 家族与 schemastery 抬版**：`@deepseek-ai/cordis` `4.0.5` → `4.0.6-alpha.1`、
  `cordis-plugin-include` `1.0.10` → `1.0.11-alpha.1`、`cordis-plugin-loader` `1.0.6` →
  `1.0.7-alpha.1`、`cordis-plugin-timer` `1.1.7` → `1.1.8-alpha.1`、`@deepseek-ai/schemastery`
  `3.18.5` → `3.18.6-alpha.1`（overrides、devDependencies 与 `peerDependencies` 里那一条同值）；
  宿主族 devDependencies 同步抬到 `0.2.2-alpha.2`，peer 的 dsh 三枚仍留 `^0.2.1-rc.3` 窗口。

## 0.1.4

### Changed

- **失败分类器三个入口共用同一份字段投影与判序**：裸 429 只在 HTTP 语境里算限速证据；已知的 `finish_reason` 不再被当成上游异常；408/425 判瞬时，402 归永久，余额证据排在状态码之前。
- **回合事实与评审统一处理**：未闭合待办改成白名单，未知状态不再算「未完成」；缺 `turn` 的调用按本轮窗口判「等用户」；`retryState` 取官方字面量联合，没有 `turn/end` 时不再按节点区间判工具活动。
- **Remote 数据那一栏**：`$mount` 失败不再缓存；空的 `sessionId` / `provider` / `preset` 直接拒绝；六个端点收敛到同一条 `invoke`，错误带 `cause`。
- **设置卡文案**改用 `{detail}` 占位，并补三条远端不可用文案。
- **定时器释放统一成 `releaseTimer`**（纯重构，行为不变）。
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

这一版把数据那一栏迁到官方 Typert Remote，并修掉非回环绑定的信任闸门回归；宿主生态升到 alpha.2 后继续跟到 rc.2，发布清单补上类型声明、tarball 内容与 registry 元数据检查。

一类自动注入的判据也变了：**goal 轮次不再一律让路**。其余改动集中在客户端侧的可见性与发布/构建流程，注入文案与默认配置未改。

### Changed

- **六条 `/_dsh/session-rescue/*` 端点改为官方 `sessionRescue` Remote**：客户端改走 source-mode descriptor + remote 读取接口；HTTP 路由、CSRF、`shared/lib/http`、`shared/lib/trust`、`connection.requestRejection` 与 webServer 子 fiber 一并删除。
- **发布清单补齐 `types/` 声明产物**：构建后把相对 `.ts` 的说明符改写成 `.js`；`exports["."].types`、keywords/homepage/bugs/engines.node 与 `files` 同步。
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
  取 19.3.0——类型声明比运行时新，故客户端代码不得使用 React 19 独有 API 与语法糖。
  （更正：该回落未保留，0.1.5 已把 devDependencies 写回 `^19.3.0`/`^19.3.1`，见该版 Changed 里的那一条；
  「客户端代码不得使用 React 19 独有 API」这条约束仍然有效。）
- `engines.dsh` 从 `>=0.2.1-alpha.2` 改为与 peer 同一份范围（随宿主线升到 `^0.2.1-rc.2`）。宿主装插件时校验的是
  peer，`0.` 主版本上的 `^` 带上界（<0.3.0），而 `>=` 没有——旧写法等于对外宣称兼容 0.3/1.x，
  宿主却会当场拒装。检查断言随之从「同值」改成「同一份范围」。
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
- `src/client-entry.ts` 回到 `max-lines` 阈值内（写路径此前逐条返回路径各写一遍 403 重试语义，现收敛成
  一条共享写通道；`/state` 载荷解析器移入 `lib/dock-state.ts`，与它输出的类型同源）。
- **显式瞬时码不再被配额措辞抢判**。`classifyFailure` 把文本兜底排在 code 路由之前，于是 provider
  把「本分钟速率已到顶」写进 message 时，`RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`/`EMPTY_RESPONSE`
  这五个本该重开回合的码被读成余额耗尽并判永久——瞬时失败因此永不续跑。现按「永久码一票否决 →
  401/403 → 显式瞬时码 → 429 → 余额证据 → 速率措辞」的次序走，请求级重发判据同序。
- **轮次号只收安全整数**。宿主投影里 `turn` 是 number，坏载荷（NaN、小数、超 2^53）此前一路直穿：
  写进 `turn-facts` 的折叠态会让自家 schema 在读回时拒收整份快照，写进调度器的
  `lastHandledTurn` 更糟——水位比较 `turn <= lastHandledTurn` 对 NaN 恒判 false，那条会话的
  「旧轮重放」闸门从此永久失效，重放的旧回合既能复位配额又能再排一次注入，日志里一个字都不提。
  现两侧都在入口处统一处理（同一条判据，`lib/turn-facts.ts` 与 `host.ts` 各有一处）。
- `restorePending()` 不再为未知会话凭空造记录。旧写法走 `rec()`，于是「恢复一条已被 dispose/淘汰的
  挂起待办」拿到的是 counts 全 0 的新记录——`maxResumes` 这道防失控闸门被静默复位，且没有任何
  说明。现在记录不在位就返回 false，由调用方按「这一条补发不出去」处置。

### Added

- 集成层新增两条真 goal 用例（`test/integration/goal-round.test.ts`）：真 `GoalService` + 真
  `goal-round-driver` + 真 AgentLoop + 官方 mock LLM 故障脚本。一条钉住「driver 只 disarm、
  本包接管恰好补发一条且不带 goal kind」，另一条钉住「窗口里 resume 之后同一条会话只留下 driver
  一个续跑者」。`@deepseek-ai/dsh-goal` 与 `@deepseek-ai/dsh-goal-round-driver` 按 `0.2.1-alpha.2`
  进 devDependencies（只用于类型对账与这层装配；发布清单里它们是可选条目，所以 `host.ts` 的读取接口
  仍按防御式本地投影，不把官方类型写进 `types/`）。
- **集成层补齐真宿主语义与真实传输**（`test/integration/`，`npm run test:integration`，已接进
  `npm run check`，发布流水线因此也会跑）：`agent-loop.test.ts` 用官方 testkit 装真
  SessionStore/AgentLoop/投影注册表；`http-routes.test.ts` 与真 `WebServer` + 真 socket 对账
  成帧、Host 权威、keep-alive 与残断请求体；`abort-semantics.test.ts` 钉住「用户中止不 emit
  `agent/error`、不消耗续跑配额，之后的真瞬时失败照常续跑」；`goal-round.test.ts` 见上。
  装配抽到 `http-harness.ts` 唯一来源，两个 HTTP 用例文件共读一份闸门形状。
- **属性/模糊层**（`test/property/` + `test/integration/http-fuzz.test.ts`，`npm run test:property`）。
  `fast-check` 进 devDependencies。四份属性用例覆盖失败分类判序、回合事实折叠、`/state` 载荷解析，
  以及调度器的**状态机不变量**：随机指令序列驱动，逐步核对会话数上限、按 kind 的配额与冷却、
  待办双向一致、定时器配对、水位单调与淘汰只发生在空闲记录上。随机报文那一份把方法/路径/查询串/
  Host/Origin/sec-fetch-site/写令牌/请求体十个维度打散重投，判三条与形状无关的承诺（不 5xx、
  信封完好、越权不得碰巧放行）。
  两层都带「判据必须真被走到」的计数守卫：`size: "max"` 之前 fast-check 默认只把 `maxLength` 当
  上界（实测 400 的上界默认只到 12 条），会话数上限那道闸门在短序列里永远碰不到，越界与淘汰两条
 判据就成了没有实际校验的通过结果；守卫让「没走到」直接变红灯。调度器用例另外先把状态机灌过上限再腾出空闲位，
  使这两支不靠概率命中。

## 0.1.1

宿主生态与工具链升到当前发布线，并修掉一处会让局域网部署整片失效的信任闸门判据。**三类自动注入的判据、注入文案与默认配置未改**，改的是「跟谁对齐」以及发布清单。

### Changed

- `@deepseek-ai/dsh-*` 家族（41 枚）与 peer 的 `@deepseek-ai/dsh` 从 `0.2.1-alpha.1` 升到 `0.2.1-alpha.2`：`devDependencies`、`peerDependencies`、`pnpm-workspace.yaml` 的 `overrides` 与 `engines.dsh` 四处同值——`test/publish-manifest.test.ts` 要求它们与 peer 逐项相等，且一律精确钉（registry 的 `latest` 标签可能指向远早于宿主 ABI 的版本，`^`/`~` 会让消费方在没有测试的情况下换掉宿主类型声明）。`@deepseek-ai/cordis` `4.0.5-alpha.1` 与 `@deepseek-ai/schemastery` `3.18.5-alpha.1` 不动：那是 alpha.2 自己声明的约束（`~4.0.5-alpha.1` / `~3.18.5-alpha.1`），registry 上没有更新的 alpha。
- `@jayyuen66/dsh-plugin-shared` `^0.1.2` → `^0.1.4`：0.1.3 把宿主包从它自己的 `dependencies` 挪进 `peerDependencies`，消费方 profile（`nodeLinker: hoisted` + `autoInstallPeers: false`）因此不再物化出第二份宿主类型；0.1.4 把那些 peer 对齐到 `0.2.1-alpha.2`，依赖树里最后一处旧宿主需求随之清零。
- 工具链：`vitest`/`@vitest/coverage-v8` 5.0.3、`vite` 8.3.4、`rolldown` 1.2.13、`oxlint` 1.87.0、`oxfmt` 0.72.0、`oxlint-tsgolint` 7.0.2004、`happy-dom` 20.14.6、`@types/node` 26.6.5。
- README 拆成两份语言纯净的文档：`README.md`（英文，registry 页面默认读它）与 `README.zh-CN.md`（中文），两份内容对等、互相链接。

### Fixed

- **局域网绑定下六条 `/_dsh/session-rescue/*` 路由整片 403**。宿主 0.2.1-alpha.2 把 `WebServer` 的 `Config.host` 从 `'127.0.0.1' | '0.0.0.0'` 换成任意真实网卡地址字面量，并在载入时拒掉通配地址；本包那句 `webServer.host === "0.0.0.0"` 因此恒为 false，`servingNonLoopback` 再也传不到信任闸门，非回环部署会被 Host 腿判成 `untrusted host authority`。类型声明放宽成 `string`，编译期抓不到，所以这道改判据只能落在检查与文档上。现改用 shared 的 `isNonLoopbackBindHost(webServer.host)`——规则与官方 `isLoopbackHost` 对齐，且不必对本包只做类型消费的宿主包做值导入。
- 源码注释里钉住的上游坐标全部按安装态重核：`@deepseek-ai/dsh-session` 的 `id`/`header`/`snapshotEvents` 与那两枚 `@deprecated` 行号、`@deepseek-ai/dsh-host-webserver` 的类与 `register`、`dsh-session-projection` 的 host-only `register` 重载、客户端侧 `slot-contract`/`sessions`/ui-chat 若干处；agent-loop 那条「对 retry 只是 `continue`」的注记此前指错了文件也指错了行，真址是 `packages/core/agent-loop/src/agent.ts:523-526`。退避阶梯保留：上游到 alpha.2 仍然不插任何延迟。

### Added

- `types/` 声明产物：新增 `build-types.mjs` 与 `tsconfig.types.json`，`exports["."]` 加 `types` 条件，`npm run build:types` 接进 `check`/`prepack`/`prepare`。声明里的相对 `.ts`说明符由脚本改写成 `.js`——`tsc` 会把 NodeNext 的源码后缀原样抄进 `.d.ts`，留着它消费方就解析不到。
- 发布面门禁：包根每份 `.md` 都必须在 `files` 里（npm 只无条件附带 `README*` 与 `LICENSE`）；声明入口存在、声明不比源码旧、声明不含本机绝对路径与 pnpm 内容寻址目录、声明里的相对说明符指向产物后缀。
- registry 与宿主发现机制门禁：`keywords`/`homepage`/`bugs`/`repository` 四项与包名同源于同一个仓库归属；`engines.node` 存在且 `engines.dsh` 与 peer 的 dsh 同值（宿主装插件时校验的是 peer，从 dsh 0.1.7-rc 起还包括 `@deepseek-ai/dsh-*`）；`dsh` 段的 `manifestVersion`/`bundle.patch`/`client.platform` 齐备且 patch 文件随包发出；`files` 不打包源码范围。
- `test/dist-size.test.ts`：给 `host.js`、`client.js` 与入口声明设体积预算（按实测值加约 25%）。产物刻意不 minify——压缩会抹掉跨包说明符字符串，让「依赖必须外部化」那两条断言变成永远通过。
- 注释卫生检查扩展：除日期外，再禁本机绝对路径、评审条目号、决策来源与修复过程的簿记、退役叙事，存量一并清掉。
