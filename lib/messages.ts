// lib/messages.ts —— host 半文案字典（中英双语）。
//
// 只管 host 半：设置卡与 dock 的 UI 文案走官方 @deepseek-ai/dsh-client-locale
// （client 侧 `ctx.locale.register(ns, locale, dict)` + `bind`/`t`，见 src/client-entry.ts）。
// host 侧没有官方 i18n 面，注入给模型的文本与沉淀给 lesson-loop 的 detail 只能自带字典；
// 语言取官方 settings 的 `locale.preference`（shared 的 resolveLocalePreference），未注册即中文。
//
// 键集一致由 tsc 保证：zh / en 两份都标注同一个 Messages 类型，少键多键都在编译期红。
// console.* 的日志文案不在此列——那是给排障的人看的，不随界面语言切换。apply 的宿主契约
// 违规抛错也不在此列：抛错发生在 settings 面尚未通过守卫之前，那一刻读不到语言偏好。
import type { MessagesCatalog } from "@jayyuen666/dsh-plugin-shared/lib/locale";

/** 本包 host 侧产出的全部人读文案。 */
export interface SessionRescueMessages {
  /** 注入给模型的自动续跑正文（瞬时失败后）。 */
  readonly resumeText: string;
  /** 注入给模型的续写正文（回合因输出上限截断后）。 */
  readonly continueText: string;
  /** 注入给模型的待办补跑正文（completed 回合但清单未闭合）。 */
  readonly unfinishedText: string;
  /** lesson-loop 的 unfinished-turn detail 模板（`{count}` 插值未闭合条数）。 */
  readonly unfinishedLessonDetail: string;
  /** lesson-loop 的 max-tokens 截断 detail。 */
  readonly maxTokensLessonDetail: string;
}

export const MESSAGES: MessagesCatalog<SessionRescueMessages> = {
  zh: {
    resumeText:
      "[自动续跑] 上一步因模型侧瞬时失败（限流/服务端/超时等）在自动重试后仍未成功，原任务尚未完成。请直接从中断处继续执行原任务：不要重新做已完成的工作、不要重复确认、也不要输出本条提示。",
    continueText: "请从截断处继续输出，不要重复已输出的内容。",
    unfinishedText:
      "[自动续跑] 上一步正常结束，但你刚更新的任务清单里仍有未完成的项。请从清单中未完成的那一项继续执行：不要重做已完成的工作、不要重复确认、也不要输出本条提示。",
    unfinishedLessonDetail: "回合 completed 但本回合更新的任务清单仍有 {count} 项未完成",
    maxTokensLessonDetail: "回合以 max-tokens 截断收尾，输出未完整送达",
  },
  en: {
    resumeText:
      "[auto-resume] The previous step still failed after built-in retries due to a transient model-side " +
      "failure (rate limit / server error / timeout), and the original task is not finished yet. Continue " +
      "the original task right where it stopped: do not redo finished work, do not re-confirm, and do not " +
      "echo this message.",
    continueText:
      "Continue the output from where it was truncated; do not repeat what was already written.",
    unfinishedText:
      "[auto-resume] The previous step ended normally, but the task list you just updated still has open " +
      "items. Continue executing from the first open item: do not redo finished work, do not re-confirm, " +
      "and do not echo this message.",
    unfinishedLessonDetail:
      "Turn completed while the task list updated in this turn still has {count} open items",
    maxTokensLessonDetail: "Turn ended truncated at max tokens; the output never arrived complete",
  },
};
