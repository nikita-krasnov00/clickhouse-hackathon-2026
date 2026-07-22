import { defineConfig } from "@trigger.dev/sdk";
import { syncEnvVars } from "@trigger.dev/build/extensions/core";

// Application task env vars (groups in src/lib/config.ts). Deploy is manual
// (README), so the source of truth is local .env: syncEnvVars copies these
// variables into the Trigger.dev environment on every deploy. Platform secrets
// (TRIGGER_SECRET_KEY, admin CLICKHOUSE_USER/PASSWORD) are intentionally omitted.
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
  // Project ref from the Trigger.dev cloud dashboard (Project settings → Project ref).
  // Priority is env (TRIGGER_PROJECT_REF from .env); hardcoded value remains a fallback
  // because the config is read by the CLI during deploy when .env may be unavailable.
  // TRIGGER_SECRET_KEY is not written here — it is picked up from env (.env locally).
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_pqzjoyqabftwlurtatuy",
  dirs: ["./src/trigger"],
  runtime: "node",
  logLevel: "info",
  // Maximum per run (seconds). An investigate agent run with several
  // LLM turns and self-healing should finish with headroom.
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
          process.loadEnvFile(".env"); // does not overwrite existing process env vars
        } catch {
          // no .env (e.g. CI) — use whatever is already in the environment
        }
        return TASK_ENV_VARS.flatMap((name) => {
          const value = process.env[name]?.trim();
          return value ? [{ name, value }] : [];
        });
      }),
    ],
  },
});
