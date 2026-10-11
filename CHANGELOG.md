# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的格式，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

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
