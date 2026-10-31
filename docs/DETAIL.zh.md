# 会话续跑救援

把卡住的回合捞回来：提供方瞬时失败后重发、输出被截断时继续、待办没闭合就接着补跑。

## 设置卡上改的是什么

三组互不相干的自动动作，各有各的等待、单会话冷却与配额。等待时间按秒录入、按毫秒存。

- **总开关** — `enabled`（默认开）关闭后三类自动动作与请求级 429 重试全部停止，只剩手动编辑、重试、继续这几个入口。
- **瞬时失败自动续跑** — `resumeDelayMs`（1–300 秒，默认 10）是宿主自己的重试跑完之后再等多久。`resumeCooldownMs`（5–3600 秒，默认 120）是同一会话两次救援之间的最小间隔。`maxResumes`（0–20，默认 3）是同一会话**连续**救援的次数上限：任一 `completed` 回合会把它清零，`0` 表示不自动续跑。`chainResumeDelayMs`（1–300 秒，默认 60）用于链式失败：延迟取它与 `resumeDelayMs` 的较大者，并跳过冷却窗口；配额与 `providerExcludes` 仍然生效。
- **输出截断自动继续** — `continueDelayMs`（0.5–300 秒，默认 3）、`continueCooldownMs`（5–3600 秒，默认 60）、`maxContinues`（0–20，默认 3，同样按连续回合计数：任一 `completed` 回合清零，`0` 表示不自动继续）。
- **待办未闭合自动补跑** — `resumeOnOpenTodos`（默认开），配 `unfinishedDelayMs`（1–300 秒，默认 5）、`unfinishedCooldownMs`（5–3600 秒，默认 120）、`maxUnfinished`（0–20，默认 2）。只有回合以 `completed` 收尾、且该回合自己写过的待办清单仍未闭合时才触发；`aborted` / `interrupted` 或调用过 `ask_user_question` 的回合不补跑。这份配额只在清单闭合时归还，清单一直不闭合就停在 `maxUnfinished` 上限。
- **排除路由** — `providerExcludes`（默认空）里写明的提供方路由不会自动触发瞬时失败续跑（`resume`）；截断继续与待办补跑不看这一项。匹配是对 provider 字符串做精确、区分大小写的比较，没有通配或前后缀匹配。

以上都是每次判定现读，改完不需要重启宿主。

## 卡上没有的

输入框旁那个按会话的开关与各组已用次数只存在于运行期内存：宿主重启后计数归零、各 kind 的冷却时间戳一并清空（等于把冷却闸门打开一次），按会话开关回落到全局 `enabled`。

`requestRetryMax`（5，取值 0–20）、`requestRetryBackoffMs`、`requestRetryBackoffCapMs`（30000）是请求级 429 重试的部署值，刻意不进设置卡，且退避数组是整份替换而非合并。只有宿主没有为该 provider 解析出 `retryPolicy` 时这段退避才接手；配了官方重试策略的路由归宿主重试层。要改就写在本插件注册行的 `config:` 块，改值随重启生效。

## 需要外部提供什么

不需要：没有外部 CLI、解释器或凭据。超过自身上限的请求级 429 处理交回宿主的重试层。

## 更完整的说明

调度器的状态机、失败如何分类、dock 区显示什么，都写在随包 README（`README.md` / `README.zh-CN.md`）。
