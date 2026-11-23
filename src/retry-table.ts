// src/retry-table.ts —— 429 重试区的明细表与码表编辑器（从 client-entry 拆出）。
//
// 拆出原因：设置卡入口的 eslint/max-lines（max=2000）——retry 区的表格化让入口顶破上限。
// 本模块只吃 props 与参数注入的 reader，不回引 client-entry（rescueState 留在入口侧），
// 依赖方向保持单向：client-entry → retry-table。
import { Fragment, createElement, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { z } from "zod";
import {
  DataTable,
  EmptyState,
  ListField,
  SelectField,
  StatusDot,
  fieldOf,
  isRecord,
} from "@jayyuen66/dsh-plugin-shared/client";
import type { Translate, UiMessages } from "./ui-messages.ts";
import type { RescueReader } from "./remote.ts";

// 数据流：remote.sessionRescue.retryProviders()（host 读 llm-pi-ai namespace）
// → 每 provider 一行下拉；选择 → remote.sessionRescue.retryPolicy() → host 经
// 官方 settings.mutate 写到磁盘（validator 在写处把关）→ 重拉列表。
// 档位：default（官方默认 5 次码表）/ enhanced（12 次 + QUOTA + 8s→60s，
// settings.yaml 四家现行同款）/ always（官方无限重试 + backoff）/ off（0 次）。

/** host 载荷 → 码表数组：非数组回落空表，只保留字符串项（逐字段守卫）。 */
function retryCodesFromValue(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

const RETRY_CODES_SCHEMA = z.array(z.string());

const RETRY_PROVIDER_SCHEMA = z.object({
  provider: z.preprocess((value) => (typeof value === "string" ? value : ""), z.string()),
  mode: z.preprocess((value) => (typeof value === "string" ? value : ""), z.string()),
  maxRetries: z.preprocess((value) => (typeof value === "number" ? value : 0), z.number()),
  hasQuota: z.preprocess((value) => value === true, z.boolean()),
  retryableCodes: z.preprocess(retryCodesFromValue, RETRY_CODES_SCHEMA),
});

type RetryProviderRow = z.infer<typeof RETRY_PROVIDER_SCHEMA>;

/** 一行 provider 的逐字段守卫投影（坏类型落回空串/0，`hasQuota` 只认显式 true）。
 *  坏行本身由调用侧的 isRecord 挡下。 */
function parseProviderRow(rowRaw: Record<string, unknown>): RetryProviderRow {
  return RETRY_PROVIDER_SCHEMA.parse(rowRaw);
}

/** preset → 下拉档位文案键（顺序即下拉顺序；文案本体在 UI_MESSAGES 双语字典里）。 */
const RETRY_PRESET_KEYS: Record<string, keyof UiMessages> = {
  default: "presetDefault",
  enhanced: "presetEnhanced",
  always: "presetAlways",
  off: "presetOff",
};

/** 由 provider 行推导下拉当前档位（与 host preset 语义对齐的只读展示推断）。 */
function presetOfRow(row: RetryProviderRow): string {
  if (row.mode === "always") {
    return "always";
  }
  if (row.maxRetries === 0) {
    return "off";
  }
  if (row.mode === "normal" && row.hasQuota) {
    return "enhanced";
  }
  return "default";
}

// ── 行形状判定（确认门与状态点共用）────────────────────────────────────────
// host 侧各档位写盘的码表现量（host.ts 的 RETRY_PRESETS / OFFICIAL_DEFAULT_RETRY_POLICY；
// 上游出处是 @deepseek-ai/dsh-llm retry-policy 的 DEFAULT_RETRYABLE_CODES）。client 与 host
// 各持一份，test/retry-table.test.ts 把两份常量逐项比对钉住漂移。读侧注意：未配置
// retryPolicy 的行与 preset always 产出（不写码表键）经 host retryCodesOf 投影成**空表**，
// 不是官方默认码表。
const OFFICIAL_DEFAULT_RETRY_CODES: readonly string[] = [
  "EMPTY_RESPONSE",
  "RATE_LIMIT",
  "SERVER",
  "TIMEOUT",
  "TRANSPORT",
];
/** enhanced 档写盘的预设码 = 官方默认码 + QUOTA（host.ts RETRY_PRESETS 的 enhanced 条目）。 */
const ENHANCED_RETRY_CODES: readonly string[] = [...OFFICIAL_DEFAULT_RETRY_CODES, "QUOTA"];
/** off 档写盘的占位码表（码表非空校验所迫，host.ts RETRY_PRESETS 的 off 条目）。 */
const OFF_RETRY_CODES: readonly string[] = ["RATE_LIMIT"];

/** 码表集合等价（顺序无关）：preset 写盘的码表顺序固定，手写码表顺序不影响行为，
 *  顺序差异不应判成手写内容。 */
function codesEqualSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size !== rightSet.size) {
    return false;
  }
  for (const code of leftSet) {
    if (!rightSet.has(code)) {
      return false;
    }
  }
  return true;
}

/** 行是否处于任一档位可产出（或从未配置过）的形状——状态点 ok/warn 与写前确认门
 *  共用的「无手写内容」判据。码表参与判定：恰好写成规范次数但码表手写的行不再误判。
 *  判据按 host 写盘语义推导（host.ts RETRY_PRESETS）：
 *  - 未配置行：normal/5/码表 []（retryProviders 对缺 key 投影空表）；
 *  - default 产出：normal/5/官方默认码表；
 *  - off 产出：normal/0/[RATE_LIMIT]（normal/0 但码表为空表意味着只手写了关闭——照旧确认）；
 *  - always 产出：mode always 且码表为空表/默认码表（次数在 always 档不起作用，不计手写）；
 *  - enhanced 产出：码表恰为预设六码（host 合并只增不删，现行无自定义码时恰为六码），
 *    次数沿用现行——但 preset 链写不出的次数（非 5/0）只能来自更早的手写配置，仍算手写。
 *  盲区（与投影能力同界，确认门与状态点都看不见）：backoff 不在投影里，恰为上述形状
 *  但手写过 backoff 的行检测不出来；enhanced 产出把上游手写的关闭（0 次）沿用下来时
 *  也无法与 preset 链区分。 */
function isPresetShape(row: RetryProviderRow): boolean {
  const codes = row.retryableCodes;
  const knownCodes =
    codes.length === 0 ||
    codesEqualSet(codes, OFFICIAL_DEFAULT_RETRY_CODES) ||
    codesEqualSet(codes, ENHANCED_RETRY_CODES);
  if (row.mode === "always") {
    return knownCodes;
  }
  if (codesEqualSet(codes, ENHANCED_RETRY_CODES)) {
    return row.maxRetries === 5 || row.maxRetries === 0;
  }
  if (row.maxRetries === 5) {
    return codes.length === 0 || codesEqualSet(codes, OFFICIAL_DEFAULT_RETRY_CODES);
  }
  if (row.maxRetries === 0) {
    return codesEqualSet(codes, OFF_RETRY_CODES);
  }
  return false;
}

/** 应用目标档位是否会覆盖投影可辨的手写内容（写前确认判据；与「行是否符合形状」分开）。
 *  host 语义（host.ts RETRY_PRESETS）：enhanced 只合并码表（只增不删）并沿用现行
 *  mode/maxRetries/backoff，custom 只替换码表（编辑器把现行值预填成草稿，本身就是确认）
 *  ——两者永不破坏，无需确认。default/off/always 写入固定整表对象，会盖掉手写码表与
 *  次数，行里只要还有手写内容就必须先确认（settings 的 user section 与行配置同文档，
 *  没有历史可回滚）。next 只会来自下拉闭集；键表之外的取值按需确认处理。 */
function needsOverwriteConfirm(row: RetryProviderRow, next: string): boolean {
  if (next === "enhanced" || next === "custom") {
    return false;
  }
  return !isPresetShape(row);
}

/** 自定义码表写盘：返回 null=成功，字符串=给用户看的失败原因（与 applyPreset 同形）。 */
/** 自定义码表写盘：返回 null=成功，字符串=给用户看的失败原因（与 applyPreset 同形）。 */
async function applyRetryCodes(
  t: Translate,
  reader: RescueReader | undefined,
  provider: string,
  codes: readonly string[],
): Promise<string | null> {
  const target = `${provider}→custom`;
  if (reader === undefined) {
    return t("remoteUnavailable", { target });
  }
  try {
    const body = await reader.retryPolicy(provider, "custom", codes);
    if (isRecord(body) && body["ok"] === true) {
      return null;
    }
    const error = fieldOf(body, "error");
    return typeof error === "string" ? `${target}: ${error}` : t("hostRejected", { target });
  } catch (error) {
    return `${target}: ${String(error)}`;
  }
}

/** 码表编辑器的提示文案：always 档不可用 > 空表 > 普通说明。 */
function retryCodesHint(row: RetryProviderRow, empty: boolean, t: Translate): string {
  if (row.mode === "always") {
    return t("presetCodesAlways");
  }
  return empty ? t("presetCodesEmpty") : t("presetCodesHint");
}

function RetryCodesRow(props: {
  row: RetryProviderRow;
  reader: RescueReader | undefined;
  disabled: boolean;
  /** 写入在途上抛：父层据此锁住两个写入口（码表与档位批量共用同一互斥）。 */
  onBusyChange: (busy: boolean) => void;
  /** 保存成功：父层重读行表，编辑器以 host 落盘值为准（host 写侧会去空白去重）。 */
  onSaved: () => void;
  t: Translate;
}): ReactNode {
  const { row, disabled, t } = props;
  const [draft, setDraft] = useState<string[]>(row.retryableCodes);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  // 草稿脏标记与「等待保存后的重读」标记走 ref：effect 只按远端行引用触发，标记翻转
  // 本身不该引发一次采纳——保存成功后、重读到达前，effect 若被标记翻转触发，会把
  // 旧远端值写回草稿（重读失败时草稿就停在保存前的旧值上）。
  const draftDirtyRef = useRef(false);
  const adoptRemoteRef = useRef(false);
  // 远端行更新时的草稿同步（行引用每次 load 都是新数组）：保存成功后置位的采纳标记
  // 先行——重读带回的 host 落盘值必须落进草稿；其次脏草稿（未保存编辑）保留，不被
  // 重读覆盖；干净草稿直接跟随远端。标记翻转本身不触发本 effect（依赖只有行引用），
  // 保存成功后、重读到达前不会有旧远端值写回草稿。
  useEffect(() => {
    if (adoptRemoteRef.current) {
      adoptRemoteRef.current = false;
      draftDirtyRef.current = false;
      setDraft(row.retryableCodes);
      return;
    }
    if (draftDirtyRef.current) {
      return;
    }
    setDraft(row.retryableCodes);
  }, [row.retryableCodes]);
  const codesDisabled = disabled || row.mode === "always";
  const empty = draft.length === 0;
  const hint = retryCodesHint(row, empty, t);
  const saveLabel = t("presetCodesSave");
  const save = async (): Promise<void> => {
    if (codesDisabled || empty) {
      return;
    }
    setNotice(null);
    props.onBusyChange(true);
    let failure: string | null;
    try {
      failure = await applyRetryCodes(t, props.reader, row.provider, draft);
    } finally {
      props.onBusyChange(false);
    }
    if (failure === null) {
      // 草稿已是已保存值：清脏标记、置采纳标记，等父层重读把 host 落盘值带回来。
      draftDirtyRef.current = false;
      adoptRemoteRef.current = true;
      props.onSaved();
      setNotice({ text: t("presetCodesSaved"), error: false });
    } else {
      setNotice({ text: failure, error: true });
    }
  };
  return createElement(
    "div",
    { className: "dsu-actions" },
    createElement(ListField, {
      label: t("presetCodesLabel"),
      hint,
      field: `retry-codes-${row.provider}`,
      value: draft,
      placeholder: "PI_AI_ERROR, MALFORMED_RESPONSE",
      disabled: codesDisabled,
      onChange: (next: string[]): void => {
        // 用户动手即取消「采纳远端」：编辑期间到达的重读不得覆盖草稿。
        adoptRemoteRef.current = false;
        draftDirtyRef.current = true;
        setNotice(null);
        setDraft(next);
      },
    }),
    createElement(
      "div",
      { className: "dsu-actions dsu-actionsEnd" },
      createElement(
        "button",
        {
          type: "button",
          className: "dsu-btn dsu-btnSm",
          "data-field": `retry-codes-save-${row.provider}`,
          disabled: codesDisabled || empty,
          onClick: (): void => {
            void save();
          },
        },
        saveLabel,
      ),
    ),
    notice === null
      ? null
      : createElement("div", { className: notice.error ? "dsu-error" : "dsu-hint" }, notice.text),
  );
}

/** 表格下展开的码表编辑器：一次只渲染一个 provider（RetryCodesRow 自持草稿状态）。 */
export function retryCodesElement(props: {
  state: RetryPanelState;
  codesProvider: string | null;
  reader: RescueReader | undefined;
  saving: boolean;
  /** 透传 RetryCodesRow 的写入在途与保存成功回调（见其 props 注释）。 */
  onBusyChange: (busy: boolean) => void;
  onSaved: () => void;
  t: Translate;
}): ReactNode {
  const { state, codesProvider, reader, saving, onBusyChange, onSaved, t } = props;
  if (state === null || !state.ok || codesProvider === null) {
    return null;
  }
  const row = state.providers.find((entry) => entry.provider === codesProvider);
  if (row === undefined) {
    return null;
  }
  return createElement(
    "div",
    { className: "dsu-actions" },
    // key 按 provider：切换编辑对象时强制重挂，草稿/提示互不串行——A 的异步保存结果
    // 与失败提示都不得出现在 B 的编辑器下（成功提示不含 provider 名，串行尤其难辨）。
    createElement(RetryCodesRow, {
      key: row.provider,
      row,
      reader,
      disabled: saving,
      onBusyChange,
      onSaved,
      t,
    }),
  );
}

/** 一次读面的结局：成功带行表，失败带原因（或还没读到 = null）。 */
export type RetryPanelState =
  | { ok: true; providers: RetryProviderRow[] }
  | { ok: false; error?: string }
  | null;

export interface RetryTableProps {
  state: RetryPanelState;
  pending: Record<string, string>;
  saving: boolean;
  onChange: (row: RetryProviderRow, next: string) => void;
  onCodes: (provider: string) => void;
  t: Translate;
}

export function retryProvidersBody(props: RetryTableProps): ReactNode {
  const { state, pending, saving, onChange, onCodes, t } = props;
  if (state === null) {
    return createElement("p", { className: "dsu-hint" }, t("presetLoading"));
  }
  if (!state.ok) {
    return createElement(
      "p",
      { className: "dsu-hint" },
      t("presetFaceUnavailable", { detail: state.error ?? "" }),
    );
  }
  const columns = [
    { key: "provider", label: t("retryColProvider"), strong: true },
    { key: "preset", label: t("retryColPreset") },
    { key: "staged", label: t("retryColStaged") },
    { key: "state", label: t("retryColState") },
    { key: "codes", label: t("retryColCodes") },
  ];
  const rows = state.providers.map((row) => {
    // 原型链防护：pending 只认自有键（row.provider 来自 host 载荷）。
    const staged = Object.hasOwn(pending, row.provider) ? pending[row.provider] : undefined;
    const current = presetOfRow(row);
    const meta =
      row.mode === "always"
        ? `always · unlimited · QUOTA ${row.hasQuota ? "✓" : "✗"}`
        : `${row.mode} · max ${row.maxRetries} · QUOTA ${row.hasQuota ? "✓" : "✗"}`;
    const providerCell = createElement(
      Fragment,
      null,
      createElement("span", { className: "dsu-tblMono" }, row.provider),
      createElement("span", { className: "dsu-tblSub" }, meta),
    );
    const selectCell = createElement(SelectField, {
      bare: true,
      label: `${t("retryColPreset")} · ${row.provider}`,
      value: staged ?? current,
      options: Object.entries(RETRY_PRESET_KEYS).map(([value, labelKey]) => ({
        value,
        label: t(labelKey),
      })),
      field: `retry-preset-${row.provider}`,
      disabled: saving,
      onChange: (next: string) => {
        onChange(row, next);
      },
    });
    // 两个 ?? 兜底防 host 返回键表之外的档位名（防御性，UI 路径进不去：档位候选
    // 来自 RETRY_PRESET_KEYS 的闭集）。v8 ignore 让防御分支不计入覆盖率分母。
    /* v8 ignore next 3 -- 键表外的档位名在 UI 路径不可达（候选是闭集），兜底只防坏载荷 */
    const stagedText =
      staged === undefined
        ? "—"
        : `${t(RETRY_PRESET_KEYS[current] ?? "presetDefault")} → ${t(RETRY_PRESET_KEYS[staged] ?? "presetDefault")}`;
    const canonical = isPresetShape(row);
    // 设计稿 B 的状态列是一颗 8px 点（ok / warn + title），不是一枚写着「规范」的胶囊：
    // 每行都重复同两个词会把表格撑成文字墙。label 仍交给读屏与 title。
    const stateCell = createElement(StatusDot, {
      tone: canonical ? "ok" : "warn",
      label: t(canonical ? "retryStateCanonical" : "retryStateOverride"),
    });
    const codesCell = createElement(
      "button",
      {
        type: "button",
        className: "dsu-btn dsu-btnGhost dsu-btnSm",
        disabled: saving,
        onClick: (): void => {
          onCodes(row.provider);
        },
      },
      t("retryColCodes"),
    );
    return {
      key: row.provider,
      cells: [providerCell, selectCell, stagedText, stateCell, codesCell],
    };
  });
  // 空表不画空壳：0 Provider 时给一句「为什么这里是空的」的空态，而不是一张隐形表格
  // 配一条孤儿保存条（实测后者像渲染残缺）。空态先落成局部量：嵌套调用层数的上限
  // 挡住了内联写法。
  const emptyNote = createElement("span", { className: "dsu-hint" }, t("presetEmptyNote"));
  const emptyState = createElement(EmptyState, { title: t("presetEmpty"), plain: true }, emptyNote);
  return createElement(DataTable, {
    columns,
    rows,
    stickyFirst: true,
    caption: t("retryTableCaption"),
    empty: emptyState,
  });
}

/** 读侧类型重投影：入口持有 rescueState，这里只吃 reader（无回引）。 */
export type { RetryProviderRow };
export { isPresetShape, needsOverwriteConfirm, parseProviderRow, presetOfRow };
