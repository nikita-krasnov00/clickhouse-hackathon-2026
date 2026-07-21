import { defineConfig } from "@trigger.dev/sdk";
import { syncEnvVars } from "@trigger.dev/build/extensions/core";

// Прикладные переменные тасок (группы src/lib/config.ts). Деплой у нас ручной
// (README), поэтому источник правды — локальный .env: syncEnvVars переливает
// эти переменные в окружение Trigger.dev при каждом deploy. Секреты платформ
// (TRIGGER_SECRET_KEY, админский CLICKHOUSE_USER/PASSWORD) намеренно не в списке.
const TASK_ENV_VARS = [
  "CLICKHOUSE_URL",
  "AGENT_RO_USER",
  "AGENT_RO_PASSWORD",
  "AGENT_SCRATCH_USER",
  "AGENT_SCRATCH_PASSWORD",
  "OPENROUTER_API_KEY",
  "LLM_MODEL",
  "LLM_MODEL_FAST",
] as const;

export default defineConfig({
  // Project ref из дашборда Trigger.dev cloud (Project settings → Project ref).
  // Приоритет — env (TRIGGER_PROJECT_REF из .env); хардкод остаётся фоллбеком,
  // потому что конфиг читается CLI и при деплое, когда .env может быть недоступен.
  // TRIGGER_SECRET_KEY сюда не пишем — он подхватывается из env (.env локально).
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_pqzjoyqabftwlurtatuy",
  dirs: ["./src/trigger"],
  runtime: "node",
  logLevel: "info",
  // Максимум на один ран (сек). Агентный ран investigate с несколькими
  // LLM-ходами и самопочинкой должен укладываться с запасом.
  maxDuration: 600,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
    },
  },
  build: {
    extensions: [
      syncEnvVars(() => {
        try {
          process.loadEnvFile(".env"); // существующие переменные процесса не перекрывает
        } catch {
          // .env нет (например, CI) — работаем с тем, что уже в окружении
        }
        return TASK_ENV_VARS.flatMap((name) => {
          const value = process.env[name]?.trim();
          return value ? [{ name, value }] : [];
        });
      }),
    ],
  },
});
