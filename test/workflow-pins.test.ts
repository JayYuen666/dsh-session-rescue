// test/workflow-pins.test.ts —— 工作流 action 钉版的一致性门禁。
//
// 两件事在这里钉死：① 每个 `uses:` 都必须钉在 40 位 SHA，不许浮到 tag；
// ② 同一个 action（按 `<owner>/<repo>` 归组，codeql 的 init/analyze/upload-sarif 算同一组）
// 在本仓只允许一个 SHA 与一个版本注释。第二条堵的是「同一 action 在两个 workflow 里停在
// 不同版本」——那类漂移不会让任何一步变红，只会让某条链悄悄跑在旧版本上。
//
// 这里不查「是不是最新」：最新需要联网，Dependabot 的 weekly 更新负责那一半；
// 本地门禁只保证仓内自洽，以及新增引用时不会把浮动的 tag 写进来。
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflowsDir = path.join(import.meta.dirname, "..", ".github", "workflows");

/** `- uses: owner/repo[/subpath]@<40 位 SHA> # vX.Y.Z`：SHA 与版本注释缺一不可。 */
const USES_LINE =
  /^\s*(?:-\s*)?uses:\s*(?<action>[^@\s]+)@(?<sha>[0-9a-f]{40})\s*#\s*(?<tag>v\d+\.\d+\.\d+)\s*$/u;

/** 一条已解析的 action 引用。 */
interface Pin {
  readonly file: string;
  readonly action: string;
  readonly sha: string;
  readonly tag: string;
}

/** 工作流文件名，按字典序稳定排列。 */
function workflowFiles(): string[] {
  return readdirSync(workflowsDir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .toSorted();
}

/** 一行是否是「被注释掉的旧引用」；它不是现行配置，不参与任何判定。 */
function isComment(line: string): boolean {
  return line.trimStart().startsWith("#");
}

/** 一行是否声明了 action 引用（无论钉没钉住）。 */
function isUsesLine(line: string): boolean {
  return line.includes("uses:") && !isComment(line);
}

/** 把一行解析成 Pin；解析不出时交回 null。 */
function parsePin(file: string, line: string): Pin | null {
  const groups = USES_LINE.exec(line)?.groups;
  if (groups === undefined) {
    return null;
  }
  const { action, sha, tag } = groups;
  if (action === undefined || sha === undefined || tag === undefined) {
    return null;
  }
  return { file, action, sha, tag };
}

/** 逐文件逐行收集解析出的 action 引用。 */
function readPins(): Pin[] {
  return workflowFiles().flatMap((file) =>
    readFileSync(path.join(workflowsDir, file), "utf8")
      .split("\n")
      .flatMap((line) => {
        const pin = parsePin(file, line);
        return pin === null ? [] : [pin];
      }),
  );
}

describe("工作流 action 钉版", () => {
  it("每一条 uses 都钉在 40 位 SHA 且带语义化版本注释", () => {
    const files = workflowFiles();
    expect(files.length, "没有任何工作流文件").toBeGreaterThan(0);
    const unparsed = files.flatMap((file) =>
      readFileSync(path.join(workflowsDir, file), "utf8")
        .split("\n")
        .flatMap((line, index) =>
          isUsesLine(line) && parsePin(file, line) === null
            ? [`${file}:${String(index + 1)} ${line.trim()}`]
            : [],
        ),
    );
    expect(
      unparsed,
      "这些 uses 不是「40 位 SHA + vX.Y.Z 注释」的形态：浮动 tag 或注释缺失",
    ).toStrictEqual([]);
    expect(readPins().length, "解析出的 action 引用为空").toBeGreaterThan(0);
  });

  it("同一个 action 在全仓只有一个 SHA 与一个版本", () => {
    const pins = readPins();
    const groups = new Map<string, Pin[]>();
    for (const pin of pins) {
      // codeql 的 init/analyze/upload-sarif 是同仓的三个入口，必须同版。
      const key = pin.action.split("/").slice(0, 2).join("/");
      const current = groups.get(key);
      if (current === undefined) {
        groups.set(key, [pin]);
      } else {
        current.push(pin);
      }
    }
    const drifted = [...groups.entries()].flatMap(([action, group]) => {
      const shas = [...new Set(group.map((pin) => pin.sha))];
      const tags = [...new Set(group.map((pin) => pin.tag))];
      return shas.length > 1 || tags.length > 1
        ? [
            `${action}: ${group
              .map((pin) => `${pin.file}@${pin.tag}/${pin.sha.slice(0, 8)}`)
              .join("、")}`,
          ]
        : [];
    });
    expect(drifted, "同一 action 在不同 workflow 里用了不同版本").toStrictEqual([]);
  });
});
