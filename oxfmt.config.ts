import { defineConfig } from "oxfmt";

// 忽略 **/*.md 与 **/*.jsonc：文档与带注释的 JSON 由写作的人排版，不该被格式化器重排。
// 其余忽略面交给 .gitignore（oxfmt 默认读它，且不带 --ignore-path 时才生效）：产物目录 types/、
// coverage/ 与 client.js、host.js 已被忽略，不在这里重复——重复一份清单只会让两处不同步。
export default defineConfig({
  ignorePatterns: ["**/*.md", "**/*.jsonc"],
});
