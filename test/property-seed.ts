// test/property-seed.ts —— 属性层的种子复现入口（vitest setupFile，只挂在 vitest.property.config.ts）。
//
// fast-check 每次跑用一枚随机种子，失败时它会把那枚种子打进报错。没有这个入口，那串数字只能
// 靠人肉重跑撞运气；有了它，`SEED=<数字> pnpm test:property` 就能把随机层钉回同一条序列。
// 不给 SEED（默认）时什么都不做，保持随机——随机层的目的本来就是覆盖人没想到的形状。
import fc from "fast-check";

/**
 * 把 SEED 钉进 fast-check 的全局配置。
 *
 * 只接受非负整数：`Number("")` 是 0、`Number("3.5")` 是小数，两者都会把「复现」变成「换了一条
 * 完全不同的序列」而不报错，所以先显式挡掉。
 *
 * @param raw - 环境变量原值
 */
export function applySeed(raw: string | undefined): void {
  if (raw === undefined || raw.trim() === "") {
    return;
  }
  const seed = Number(raw);
  if (!Number.isInteger(seed) || seed < 0) {
    throw new Error(`SEED 必须是非负整数，收到 ${JSON.stringify(raw)}`);
  }
  fc.configureGlobal({ seed });
}

applySeed(process.env["SEED"]);
