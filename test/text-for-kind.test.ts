import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { hostMessages, textForKind } from "../host.ts";
import { MESSAGES } from "../lib/messages.ts";
import type { SessionRescueMessages } from "../lib/messages.ts";
import type { RescueKind } from "../lib/resume-scheduler.ts";

/** 官方 locale 的 `{name}` 插值（宿主同语义）：测试里自己实现，不引宿主内部实现。 */
function fillTemplate(text: string, params: Record<string, unknown>): string {
  return text.replaceAll(/\{(?<key>\w+)\}/gu, (_all: string, key: string) => {
    const value = params[key];
    if (typeof value === "number") {
      return String(value);
    }
    return typeof value === "string" ? value : "";
  });
}

/** 模板里的 {占位符} 名字清单（不具名捕获组，避开 dot-notation 与 TS4111 的相互要求）。 */
function placeholders(template: string): Set<string> {
  return new Set(template.split(/[{}]/u).filter((piece) => /^\w+$/u.test(piece)));
}

/** 只投影 hostMessages 真正用到的那一个成员（其余服务面与本用例无关）。
 *  0.1.7 的跨命名空间读只剩 `describe()`：installed
 *  dsh-settings/lib/types/index.d.ts:96 的签名是 `describe(options?): SettingsDescriptor[]`
 *  ——**恒回一个数组**（`register`/`get` 连同"按命名空间回单个 value"那层一起被宿主移除），
 *  行里 `ns === 'locale'` 那一条的 `value` 即偏好载体。故替身只能构造"行里没有 locale
 *  那一行"，不存在"describe 回 undefined"这种形状。 */
function svcWithDescribe(rows: readonly { ns: string; value: unknown }[]): never {
  return { settings: { describe: () => rows } } as never;
}

/** locale 条目已投影：它的 value 里带着用户选的偏好（可能是脏值）。 */
function svcWithPreference(preference: unknown): never {
  return svcWithDescribe([{ ns: "locale", value: { preference } }]);
}

// E2：未知 kind 绝不能回退到任何一份 approved 文案（错文案比不发危害更大）。
// 签名已从 `RescueKind | string | undefined → string | null` 收紧为
// `RescueKind → string`：pending 快照只在进程内由 scheduler 产生，未知 kind 在
// host 侧不可达，调用方也就没有 null 分支可走。防御随之从「返回 null」改为
// 「抛错」——语义更强（静默降级 → 显式失败），断言一条没少。
// 文案本身不再住在 host.ts 的模块常量里，而是取自 lib/messages.ts 的双语字典
// （语言由 hostMessages 按官方 locale 偏好选表），本函数因此多收一个 messages 入参。
describe("textForKind 文案映射与未知 kind 防御", () => {
  it("已知 kind 返回各自 approved 文案", () => {
    assert.ok(textForKind("resume", MESSAGES.zh).includes("瞬时失败"));
    assert.ok(textForKind("continue", MESSAGES.zh).startsWith("请从截断处继续输出"));
    assert.ok(textForKind("unfinished", MESSAGES.zh).includes("任务清单"));
  });

  it("三类文案两两不同（漏一种 kind 就拿错文案的那类缺陷）", () => {
    const kinds: RescueKind[] = ["resume", "continue", "unfinished"];
    for (const catalog of ["zh", "en"] as const) {
      const texts = kinds.map((kind) => textForKind(kind, MESSAGES[catalog]));
      assert.equal(new Set(texts).size, kinds.length, `${catalog} 三类文案不得重合`);
    }
  });

  it("闭合集之外的 kind → 抛错，绝不回退到续跑/补跑文案", () => {
    // 类型系统外注入（脏快照 / 未来 kind / 原型键）：运行时仍须拒绝，
    // 不得静默发出任何一份文案。
    const dirtyKinds: readonly unknown[] = ["bogus-kind", undefined, "constructor"];
    for (const dirty of dirtyKinds) {
      assert.throws(() => {
        textForKind(dirty as RescueKind, MESSAGES.zh);
      }, /unknown rescue kind/u);
    }
  });
});

// ── host 双语（与卡片侧同源：语言取官方 locale 的 settings 命名空间）──────
describe("hostMessages 语言选取与双语字典", () => {
  it("locale 条目未被投影（describe 里没有那一行）→ 中文默认", () => {
    // 宿主装了别的条目、唯独没有 locale 那一行（没装 client-locale，或它的 Config
    // 一个 `.volatile()` 都没有 → describe 整条跳过）。describe 仍回数组。
    assert.equal(
      hostMessages(svcWithDescribe([{ ns: "session-rescue", value: { enabled: true } }])),
      MESSAGES.zh,
    );
  });

  it("偏好按主语言子标签归一：en-US → 英文、zh-Hans-CN → 中文", () => {
    assert.equal(hostMessages(svcWithPreference("en-US")), MESSAGES.en);
    assert.equal(hostMessages(svcWithPreference("zh-Hans-CN")), MESSAGES.zh);
  });

  it("偏好缺失或非字符串（用户文档里的脏值）→ 中文，不抛", () => {
    for (const raw of [undefined, 42, "fr"]) {
      assert.equal(hostMessages(svcWithPreference(raw)), MESSAGES.zh, `raw=${String(raw)}`);
    }
  });

  it("en 字典的每条文案都是英文且不残留中文（注入段与 lesson detail 全在内）", () => {
    // SessionRescueMessages 是 interface（无隐式索引签名），Object.values 在此
    // 只能推出 any[]；按键名取到的才是 string。
    for (const key of Object.keys(MESSAGES.en) as (keyof SessionRescueMessages)[]) {
      assert.doesNotMatch(
        MESSAGES.en[key],
        /\p{Script=Han}/u,
        `英文文案残留中文：${MESSAGES.en[key]}`,
      );
    }
    assert.match(MESSAGES.en.resumeText, /auto-resume/u);
    assert.match(MESSAGES.en.unfinishedText, /task list/u);
  });

  it("两语 lesson detail 模板的 {占位符} 集合一致（翻译不会漏掉插值）", () => {
    for (const key of ["unfinishedLessonDetail", "maxTokensLessonDetail"] as const) {
      assert.deepEqual(
        placeholders(MESSAGES.en[key]),
        placeholders(MESSAGES.zh[key]),
        `${key} 占位符不一致`,
      );
    }
  });

  it("未闭合条数按模板插值（host 侧唯一的带变量文案）", () => {
    assert.equal(
      fillTemplate(MESSAGES.zh.unfinishedLessonDetail, { count: 3 }),
      "回合 completed 但本回合更新的任务清单仍有 3 项未完成",
    );
    assert.match(
      fillTemplate(MESSAGES.en.unfinishedLessonDetail, { count: 3 }),
      /still has 3 open items/u,
    );
  });
});
