import { defineConfig } from "@trigger.dev/sdk";

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
    extensions: [],
  },
});
