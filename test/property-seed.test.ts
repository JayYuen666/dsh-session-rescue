// test/property-seed.test.ts —— 种子入口的解析判据。
//
// 这个文件是复现随机失败的唯一入口：解析器放宽一格，SEED 就会把「复现」变成「换一条
// 序列」而不报错。校验分支在此逐形钉死；import 本模块会按当前环境跑一次顶层
// applySeed（SEED 未设时是无害的 no-op），不影响这里的断言。
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { applySeed } from "./property-seed.ts";

describe("applySeed：只接受十进制非负、且在 32 位宽度内的整数", () => {
  it("合法十进制整数照常接受", () => {
    assert.doesNotThrow(() => {
      applySeed("42");
    });
    assert.doesNotThrow(() => {
      applySeed(" 7 ");
    });
    assert.doesNotThrow(() => {
      applySeed("0");
    });
  });

  it("缺省与空白是无害 no-op", () => {
    assert.doesNotThrow(() => {
      applySeed(undefined);
    });
    assert.doesNotThrow(() => {
      applySeed("");
    });
    assert.doesNotThrow(() => {
      applySeed("   ");
    });
  });

  it("宽松解析的宽松形全部拒绝（否则复现会静默换序列）", () => {
    assert.throws(
      () => {
        applySeed("0x1F");
      },
      /非负十进制/u,
      "十六进制字面量",
    );
    assert.throws(
      () => {
        applySeed("1e3");
      },
      /非负十进制/u,
      "科学计数法",
    );
    assert.throws(
      () => {
        applySeed("+5");
      },
      /非负十进制/u,
      "显式正号",
    );
    assert.throws(
      () => {
        applySeed("3.5");
      },
      /非负十进制/u,
      "小数",
    );
    assert.throws(
      () => {
        applySeed("-1");
      },
      /非负十进制/u,
      "负数",
    );
    assert.throws(
      () => {
        applySeed("abc");
      },
      /非负十进制/u,
      "非数字",
    );
  });

  it("超出安全整数的形拒绝（Number 会先静默取整）", () => {
    assert.throws(() => {
      applySeed("9007199254740993");
    }, /安全整数/u);
  });

  it("超出 32 位宽度的安全整数也拒绝（高位被 fast-check 丢弃）", () => {
    // 实测：seed=1 与 seed=4294967297 在 fast-check 下交出**同一条**序列——放过这一形，
    // 「换个种子换个实验」就是假的，而报错里打印的还是用户敲的那一枚。
    assert.throws(
      () => {
        applySeed("4294967297");
      },
      /32 位宽度/u,
      "2^32 + 1",
    );
    assert.doesNotThrow(() => {
      applySeed("4294967295");
    });
  });
});
