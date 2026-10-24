// test/setup-logs.test.ts —— 账本自身的还原判据。
//
// 账本（test/setup-logs.ts）在每个用例前后接管/还原 console。它用得对不对，决定了「每条日志
// 都对得上骨架」这条红到底看不看得见：接管没装上，日志根本进不来；还原没装上，后面几条用例
// 看到的 console 是一个死掉的 spy，真实输出连同报错一起被吞。
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { install, uninstall } from "./setup-logs.ts";

describe("日志账本的接管与还原", () => {
  it("重复接管之后再还原，console 仍回到真实方法", () => {
    // 接管记录（originals）是还原的唯一依据。第二次 install() 若把它覆盖成上一枚 spy，
    // uninstall() 就会把 spy 装回 console——此后真实输出全被吞进 records，报告上只剩
    // 「这轮没有日志」。
    uninstall();
    const realInfo = console.info;
    install();
    install();
    uninstall();

    assert.equal(console.info, realInfo, "还原后 console.info 不是原来的那个函数");
  });
});
