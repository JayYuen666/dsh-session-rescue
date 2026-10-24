import { defineConfig } from "vitest/config";

// 属性/模糊层：不问「这一组输入的结果是什么」，而问「对**任意**输入，哪些不变量必须成立」。
// 与单测项目的分工是补位而不是重复：单测钉的是作者想到的形状，这一层跑的是作者没想到的
// 形状（随机事件日志、随机失败载荷、随机调度指令序列、任意 JSON 线格式）。
// 覆盖率门槛不在此处（仍由 vitest.config.ts 的 100% 负责）：属性测试的价值是找反例，
// 把它算进行数命中只会逼出为凑覆盖率写的断言。
//
// 种子：默认让 fast-check 用随机种子，失败时它会把那枚种子打进报错；按 `SEED=<数字>` 起一次
// 就能把随机层钉回同一条序列复现——随机层不留「本机过、CI 红」这种账。这颗种子由
// test/property-seed.ts 读环境变量并写给 fast-check，配置本身不碰 process.env。
export default defineConfig({
  test: {
    include: ["test/property/**/*.test.ts"],
    environment: "node",
    // 同 vitest.integration.config.ts：随机层更容易产出「只在全量跑时看得见」的日志，账本要在每一层都生效。
    setupFiles: ["test/setup-logs.ts", "test/property-seed.ts"],
    // 单条属性通常百来毫秒；现量最慢一条 4.3s（模型化调度器那条跑千级序列长度），
    // 30s 已是它的七倍。给到 60s 的代价是一次死循环要等满一分钟才报错，而这一层跑的是
    // 「任意输入」，死循环正是它最可能的坏法——反馈时间比余量值钱。
    testTimeout: 30_000,
    coverage: { reporter: ["text"], enabled: false },
  },
});
