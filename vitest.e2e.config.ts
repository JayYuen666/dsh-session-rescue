import { defineConfig } from "vitest/config";

// 端到端层：真 AgentLoop + 官方 mock LLM 上跑**完整救援旅程**——失败分类、调度、
// 定时器 fire、注入、链式重调度、恢复（或明确的不干预），一整条链在一口锅里跑完。
// 与集成层的分工：integration 钉单条假设（abort 语义、适配器策略形状），这一层钉
// 「多回合、跨会话的完整旅程」；覆盖率不在此层（同 integration/property 的取舍：
// 旅程的价值在组合，行数命中由单测层负责）。
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.test.ts"],
    environment: "node",
    // 与集成层同一份日志账本契约：本层起的真装配最容易漏日志。
    setupFiles: ["test/setup-logs.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // 每条用例各占一个回环端口与 mock server；串行让失败现场可归因。
    fileParallelism: false,
    coverage: { reporter: ["text"], enabled: false },
  },
});
