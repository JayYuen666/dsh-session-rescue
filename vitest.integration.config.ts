import { defineConfig } from "vitest/config";

// 集成层：真实宿主装配（真 cordis Context + 真 SessionStore/AgentLoop/投影注册表 +
// 真 WebServer + 真 HTTP 客户端），只在内存与回环端口上跑，不碰 ~/.dsh、不需要 API key。
// 与单测项目的分工：单测钉「本包自己的判定」，这一层钉「本包对宿主行为的假设是否为真」——
// 手写替身按作者的想象造事件流，真宿主按代码造事件流，两者不一致时只有这一层会红。
// 覆盖率门槛不在此处（见 vitest.config.ts 的 100%）：这一层的价值在于组合可用性与真序，
// 行数命中由单测项目负责，混在一起只会逼出为覆盖率而写的断言。
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    environment: "node",
    // 与单测项目同一份日志账本契约：接管 console，跑测期间漏出的每一行本包日志都必须被源码里的
    // 模板片段认领（见 test/setup-logs.ts）。这一层起的是真宿主装配，插件日志最容易从这里漏进报告。
    setupFiles: ["test/setup-logs.ts"],
    // 真服务启动 + 真网络往返 + 真定时器退避（首档 2s）都在这条时限里。
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // 每条用例各自占一个回环端口与一个临时目录；并行跑时失败现场难归因，串行更划算。
    fileParallelism: false,
    coverage: { reporter: ["text"], enabled: false },
  },
});
