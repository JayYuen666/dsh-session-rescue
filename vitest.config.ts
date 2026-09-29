import { definePackageConfig } from "@jayyuen666/dsh-plugin-shared/config/vitest.base";

// 公共面（test.include / environment / testTimeout / provider / exclude / reporter /
// reportsDirectory / 四项 100% 阈值）在 shared/config/vitest.base.ts 单源。
// 本包差异：覆盖率面含 src/**，并且每条用例都要装一个静音 logger 的 setup 文件。
export default definePackageConfig({
  coverageInclude: ["host.ts", "lib/**/*.ts", "src/**/*.ts"],
  test: {
    setupFiles: ["test/setup-logs.ts"],
  },
});
