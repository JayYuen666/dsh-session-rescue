import { defineConfig } from "vitest/config";

// 跨平台层：时钟非单调、容量饱和、wire 换行这些**与运行平台无关但常被平台假设污染**的
// 判据，与三平台 CI 矩阵配合。覆盖率不在此层（同 integration/property/e2e 的取舍）。
export default defineConfig({
  test: {
    include: ["test/platform/**/*.test.ts"],
    environment: "node",
    setupFiles: ["test/setup-logs.ts"],
    testTimeout: 30_000,
    coverage: { reporter: ["text"], enabled: false },
  },
});
