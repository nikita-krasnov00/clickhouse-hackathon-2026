/**
 * Project configuration from .env — single source of truth instead of scattered
 * process.env (sources: .env locally via --env-file/Next, Trigger.dev runner env
 * on deploy; template — .env.example).
 *
 * Validation is zod, LAZY and BY GROUP: each group is parsed on first access
 * and cached per process. So a script that only needs ClickHouse (ch:ping) does
 * not need OPENROUTER_API_KEY, and vice versa. Validation errors list all
 * missing variables in the group at once.
 *
 * Server code only (API routes, pipeline, Trigger tasks, scripts) —
 * do not import into client components: secrets must not leak into the bundle.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Group schemas
// ---------------------------------------------------------------------------

const nonEmpty = z.string().trim().min(1);

/**
 * Empty string in .env (copied unfilled template `VAR=`) —
 * same as a missing variable: optional fields and defaults
 * must not fail because of it.
 */
const emptyAsUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const optionalVar = z.preprocess(emptyAsUndefined, nonEmpty.optional());

/** ClickHouse Cloud: address and two agent users (created by track A, task A1). */
const clickhouseEnvSchema = z.object({
  /** host:port without protocol (https:// added here) or full URL. */
  CLICKHOUSE_URL: nonEmpty,
  AGENT_RO_USER: nonEmpty,
  AGENT_RO_PASSWORD: nonEmpty,
  AGENT_SCRATCH_USER: nonEmpty,
  AGENT_SCRATCH_PASSWORD: nonEmpty,
});

/** LLM (OpenRouter). Models are optional — defaults and fallbacks live in llm.ts. */
const llmEnvSchema = z.object({
  OPENROUTER_API_KEY: nonEmpty,
  /** Primary model: text-to-SQL, self-healing, verdicts. */
  LLM_MODEL: optionalVar,
  /** Fast model: question triage, preset suggestions. Empty — default from llm.ts. */
  LLM_MODEL_FAST: optionalVar,
});

/** Frontend entry: Google OAuth via NextAuth (src/auth.ts). */
const authEnvSchema = z.object({
  /** Session cookie signing/encryption: openssl rand -base64 32. */
  AUTH_SECRET: nonEmpty,
  /** OAuth client (Web) from Google Cloud Console → Credentials. */
  AUTH_GOOGLE_ID: nonEmpty,
  AUTH_GOOGLE_SECRET: nonEmpty,
  /** Who may sign in: comma-separated emails. Empty — any Google account. */
  AUTH_ALLOWED_EMAILS: optionalVar,
});

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export type ClickHouseConfig = {
  /** Full URL with protocol. */
  url: string;
  readonly: { username: string; password: string };
  scratch: { username: string; password: string };
};

export type LlmConfig = {
  apiKey: string;
  /** Primary model from env; undefined — use default chain from llm.ts. */
  model: string | undefined;
  /** Fast model from env; undefined — default from llm.ts (GPT-5.6 Terra). */
  fastModel: string | undefined;
};

export type AuthConfig = {
  secret: string;
  googleId: string;
  googleSecret: string;
  /** Normalized allowlist (lowercase); empty — any account may sign in. */
  allowedEmails: string[];
};

// ---------------------------------------------------------------------------
// Lazy parsing with per-process cache
// ---------------------------------------------------------------------------

function parseGroup<S extends z.ZodRawShape>(
  group: string,
  schema: z.ZodObject<S>,
): z.infer<z.ZodObject<S>> {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues
      .map((i) => i.path.join("."))
      .filter((v, idx, arr) => arr.indexOf(v) === idx);
    throw new Error(
      `${group} configuration: environment variables missing or empty: ${missing.join(", ")} — see .env.example (locally: .env + tsx --env-file / next dev)`,
    );
  }
  return result.data;
}

let clickhouseCache: ClickHouseConfig | undefined;
let llmCache: LlmConfig | undefined;
let authCache: AuthConfig | undefined;

export const config = {
  get clickhouse(): ClickHouseConfig {
    if (!clickhouseCache) {
      const env = parseGroup("ClickHouse", clickhouseEnvSchema);
      const url =
        env.CLICKHOUSE_URL.startsWith("http://") ||
        env.CLICKHOUSE_URL.startsWith("https://")
          ? env.CLICKHOUSE_URL
          : `https://${env.CLICKHOUSE_URL}`;
      clickhouseCache = {
        url,
        readonly: { username: env.AGENT_RO_USER, password: env.AGENT_RO_PASSWORD },
        scratch: {
          username: env.AGENT_SCRATCH_USER,
          password: env.AGENT_SCRATCH_PASSWORD,
        },
      };
    }
    return clickhouseCache;
  },

  get llm(): LlmConfig {
    if (!llmCache) {
      const env = parseGroup("LLM", llmEnvSchema);
      llmCache = {
        apiKey: env.OPENROUTER_API_KEY,
        model: env.LLM_MODEL,
        fastModel: env.LLM_MODEL_FAST,
      };
    }
    return llmCache;
  },

  get auth(): AuthConfig {
    if (!authCache) {
      const env = parseGroup("Auth", authEnvSchema);
      authCache = {
        secret: env.AUTH_SECRET,
        googleId: env.AUTH_GOOGLE_ID,
        googleSecret: env.AUTH_GOOGLE_SECRET,
        allowedEmails: (env.AUTH_ALLOWED_EMAILS ?? "")
          .split(",")
          .map((e) => e.trim().toLowerCase())
          .filter(Boolean),
      };
    }
    return authCache;
  },
};
