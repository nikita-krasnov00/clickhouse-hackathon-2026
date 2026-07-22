/**
 * Конфигурация проекта из .env — одно место правды вместо разбросанных
 * process.env (источники: .env локально через --env-file/Next, env раннера
 * Trigger.dev на деплое; шаблон — .env.example).
 *
 * Валидация — zod, ЛЕНИВО и ПО ГРУППАМ: каждая группа парсится при первом
 * обращении и кэшируется на процесс. Поэтому скрипту, которому нужен только
 * ClickHouse (ch:ping), не нужен OPENROUTER_API_KEY, и наоборот. Ошибка
 * валидации перечисляет все недостающие переменные группы разом.
 *
 * Только для серверного кода (API-роуты, конвейер, Trigger-таски, скрипты) —
 * в клиентские компоненты не импортировать: секреты не должны попасть в бандл.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Схемы групп
// ---------------------------------------------------------------------------

const nonEmpty = z.string().trim().min(1);

/**
 * Пустая строка в .env (скопированный незаполненный шаблон `VAR=`) —
 * то же самое, что отсутствие переменной: опциональные поля и дефолты
 * не должны падать из-за неё.
 */
const emptyAsUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const optionalVar = z.preprocess(emptyAsUndefined, nonEmpty.optional());

/** ClickHouse Cloud: адрес и два агентских юзера (создаёт трек A, задача A1). */
const clickhouseEnvSchema = z.object({
  /** host:port без протокола (https:// добавляется здесь) либо полный URL. */
  CLICKHOUSE_URL: nonEmpty,
  AGENT_RO_USER: nonEmpty,
  AGENT_RO_PASSWORD: nonEmpty,
  AGENT_SCRATCH_USER: nonEmpty,
  AGENT_SCRATCH_PASSWORD: nonEmpty,
});

/** LLM (OpenRouter). Модели опциональны — дефолты и фоллбеки живут в llm.ts. */
const llmEnvSchema = z.object({
  OPENROUTER_API_KEY: nonEmpty,
  /** Основная модель: text-to-SQL, самопочинка, вердикты. */
  LLM_MODEL: optionalVar,
  /** Быстрая модель: триаж вопроса, подсказки-пресеты. Пусто — дефолт llm.ts. */
  LLM_MODEL_FAST: optionalVar,
});

/** Вход на фронтенд: Google OAuth через NextAuth (src/auth.ts). */
const authEnvSchema = z.object({
  /** Подпись/шифрование сессионных cookie: openssl rand -base64 32. */
  AUTH_SECRET: nonEmpty,
  /** OAuth client (Web) из Google Cloud Console → Credentials. */
  AUTH_GOOGLE_ID: nonEmpty,
  AUTH_GOOGLE_SECRET: nonEmpty,
  /** Кому разрешён вход: email через запятую. Пусто — любой Google-аккаунт. */
  AUTH_ALLOWED_EMAILS: optionalVar,
});

// ---------------------------------------------------------------------------
// Типы наружу
// ---------------------------------------------------------------------------

export type ClickHouseConfig = {
  /** Полный URL с протоколом. */
  url: string;
  readonly: { username: string; password: string };
  scratch: { username: string; password: string };
};

export type LlmConfig = {
  apiKey: string;
  /** Основная модель из env; undefined — взять дефолтную цепочку llm.ts. */
  model: string | undefined;
  /** Быстрая модель из env; undefined — дефолт llm.ts (GPT-5.6 Terra). */
  fastModel: string | undefined;
};

export type AuthConfig = {
  secret: string;
  googleId: string;
  googleSecret: string;
  /** Нормализованный allowlist (lowercase); пустой — вход любому аккаунту. */
  allowedEmails: string[];
};

// ---------------------------------------------------------------------------
// Ленивый парсинг с кэшем на процесс
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
      `Конфигурация ${group}: не заданы или пусты переменные окружения ${missing.join(", ")} — см. .env.example (локально: .env + tsx --env-file / next dev)`,
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
