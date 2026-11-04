// test/property-seed.ts —— 属性层的种子复现入口（vitest setupFile，只挂在 vitest.property.config.ts）。
//
// fast-check 每次跑用一枚随机种子，失败时它会把那枚种子打进报错。没有这个入口，那串数字只能
// 靠人肉重跑撞运气；有了它，`SEED=<数字> pnpm test:property` 就能把随机层钉回同一条序列。
// 不给 SEED（默认）时什么都不做，保持随机——随机层的目的本来就是覆盖人没想到的形状。
import fc from "fast-check";

/**
 * 把 SEED 钉进 fast-check 的全局配置。
 *
 * 只接受十进制非负、且落在 fast-check 实际采用的 32 位宽度内的整数，先按字面校验再转换：`Number("0x1F")` 是 31、`Number("1e3")`
 * 是 1000、超 2^53 的字面量会被静默取整——这些形都会把「复现」变成「换了一条完全不同
 * 的序列」而不报错，正好破坏本文件存在的目的。
 *
 * @param raw - 环境变量原值
 */
export function applySeed(raw: string | undefined): void {
  if (raw === undefined || raw.trim() === "") {
    return;
  }
  if (!/^\d+$/u.test(raw.trim())) {
    throw new Error(`SEED 必须是非负十进制整数，收到 ${JSON.stringify(raw)}`);
  }
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed)) {
    throw new TypeError(`SEED 超出安全整数范围，收到 ${JSON.stringify(raw)}`);
  }
  // fast-check 只取种子的低 32 位（实测 seed=1 与 seed=4294967297 交出同一条序列），
  // 所以安全整数还不够：这一位放过去，两枚不同的 SEED 会静默映射到同一条序列，
  // 而失败信息打印的仍是用户输入的那一枚。
  if (seed > 4_294_967_295) {
    throw new RangeError(
      `SEED 超出 fast-check 实际采用的 32 位宽度，收到 ${JSON.stringify(raw)}（有效上界 4294967295）`,
    );
  }
  fc.configureGlobal({ seed });
}

applySeed(process.env["SEED"]);
