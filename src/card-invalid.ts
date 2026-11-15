/// <reference lib="dom" />
/**
 * 设置卡「有字段越界就不许保存」那套状态的共享件（本仓两张数字行都走它）。
 *
 * `NumberField` 对越界草稿**不调 `onChange`**，于是它根本不进 `touched`：只看「草稿 vs 已提交值」
 * 的保存门禁会以为什么都没改，用户点保存时其余字段写出去、越界那一格静默丢掉。所以越界要单独
 * 记一份（本模块），保存条上那句提示也由这里出。`resetToken` 负责在保存/撤销后把框里的非法草稿
 * 清回已提交值（父值没变时组件内「保留输入中的草稿」那一支会把它一直留在框里）。
 *
 * 抽成独立文件而不是写在 `client-entry.ts` 里，是因为那个文件已经贴着 `eslint/max-lines` 的上限。
 *
 * 越界状态机本体（`useInvalidFields`）已经收进 shared —— 带数字字段的卡都需要它，各写一遍
 * 只会让「漏掉 clear」「漏掉 resetToken 透传」这类缺陷在每一仓各修一次。本文件只留保存条，
 * 那一半是**本仓自己的**：撤销按钮的文案键是 `discard` 而不是别处的 `revert`。
 */
import { createElement } from "react";
import type { ReactNode } from "react";
import { SaveBar } from "@jayyuen66/dsh-plugin-shared/client";
import type { Translate } from "./ui-messages.ts";

export { useInvalidFields } from "@jayyuen66/dsh-plugin-shared/client";
export type { InvalidFields } from "@jayyuen66/dsh-plugin-shared/client";

/** 保存条那一行需要的全部输入（都是卡片已经算好的东西，这里只负责摆位置）。 */
export interface SettingsSaveBarProps {
  t: Translate;
  dirty: boolean;
  busy: boolean;
  writable: boolean;
  saveError: string | null;
  blocked: boolean;
  dirtyCount: number;
  onSave: () => void;
  onDiscard: () => void;
}

/** 保存条：越界/保存失败两种错误优先显示（越界那句是这张卡上唯一的可见出口）。 */
export function settingsSaveBar(props: SettingsSaveBarProps): ReactNode {
  const { t } = props;
  return createElement(SaveBar, {
    dirty: props.dirty,
    // 越界要同时交给保存条：它自己把「保存」灰掉、把「撤销」留着——撤销正是这里的出路
    // （本仓的 `dirty` 刻意不含越界，否则只改一格的用户连撤销都点不动）。
    blocked: props.blocked,
    busy: props.busy,
    writable: props.writable,
    error: props.saveError ?? (props.blocked ? t("invalidFields") : null),
    saveLabel: t("save"),
    savingLabel: t("saving"),
    revertLabel: t("discard"),
    dirtyLabel: t("dirtyCount", { count: props.dirtyCount }),
    cleanLabel: t("statusClean"),
    readOnlyLabel: t("statusReadOnly"),
    onSave: props.onSave,
    onDiscard: props.onDiscard,
  });
}
