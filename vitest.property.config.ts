import { defineConfig } from "vitest/config";

// 属性/模糊层：不问「这一组输入的结果是什么」，而问「对**任意**输入，哪些不变量必须成立」。
// 与单测项目的分工是补位而不是重复：单测钉的是作者想到的形状，这一层跑的是作者没想到的
// 形状（随机事件日志、随机失败载荷、随机调度指令序列、任意 JSON 线格式）。
// 覆盖率门槛不在此处（仍由 vitest.config.ts 的 100% 负责）：属性测试的价值是找反例，
// 把它算进行数命中只会逼出为凑覆盖率写的断言。
//
// 种子：默认让 vitest 打印 fast-check 自己的 seed，失败时按 `-e SEED=...` 复现——
// 随机层不留「本机过、CI 红」这种账。
export default defineConfig({
  test: {
    include: ["test/property/**/*.test.ts"],
    environment: "node",
    // 同 vitest.integration.config.ts：随机层更容易产出「只在全量跑时看得见」的日志，账本要在每一层都生效。
    setupFiles: ["test/setup-logs.ts"],
    // 单条属性通常百来毫秒；给到 60s 是因为模型化调度器用例会跑到千级序列长度。
    testTimeout: 60_000,
    coverage: { reporter: ["text"], enabled: false },
  },
});
