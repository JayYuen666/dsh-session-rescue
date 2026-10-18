import { definePackageConfig } from "@jayyuen66/dsh-plugin-shared/config/vitest.base";

// 单测项目：纯函数与手写宿主替身那条线（test/ 根目录）。
// 公共面（environment / testTimeout / provider / 四项 100% 阈值 / reportsDirectory）在
// shared/config/vitest.base.ts 单源；本包差异：覆盖率面含 src/**，每条用例装静音 logger 的
// setup 文件，以及**按目录分层**——test/integration 与 test/e2e 走各自的项目配置，
// 因为它们要起真服务、占端口，不该被 20s 单测超时与覆盖率门槛管着。
export default definePackageConfig({
  coverageInclude: ["host.ts", "lib/**/*.ts", "src/**/*.ts"],
  test: {
    setupFiles: ["test/setup-logs.ts"],
    include: ["test/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "test/integration/**", "test/e2e/**"],
  },
});
