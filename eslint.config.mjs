import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Артефакты git-worktree сессий (внутри — свои .next/** и т.п.).
    ".claude/**",
    // Сборочные артефакты dev-воркера Trigger.dev.
    ".trigger/**",
    // Стрей-скаффолд `trigger.dev init` со своим package.json/node_modules;
    // рабочие таски живут в src/trigger/ — этот каталог не часть приложения.
    "triggers/**",
  ]),
]);

export default eslintConfig;
