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
const varWithDefault = (def: string) =>
  z.preprocess(emptyAsUndefined, nonEmpty.default(def));

/** ClickHouse Cloud: адрес и два агентских юзера (создаёт трек A, задача A1). */
const clickhouseEnvSchema = z.object({
  /** host:port без протокола (https:// добавляется здесь) либо полный URL. */
  CLICKHOUSE_URL: nonEmpty,
  AGENT_RO_USER: nonEmpty,
  AGENT_RO_PASSWORD: nonEmpty,
  AGENT_SCRATCH_USER: nonEmpty,
  AGENT_SCRATCH_PASSWORD: nonEmpty,
});

/** LLM (OpenRouter). Модель опциональна — дефолт и фоллбеки живут в llm.ts. */
const llmEnvSchema = z.object({
  OPENROUTER_API_KEY: nonEmpty,
  LLM_MODEL: optionalVar,
});

/** Датасет расследований: целевая таблица и её колонка даты. */
const datasetEnvSchema = z.object({
  GITHUB_EVENTS_TABLE: varWithDefault("github.github_events"),
  GITHUB_EVENTS_DATE_COLUMN: varWithDefault("created_at"),
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
  /** Модель из env; undefined — взять дефолтную цепочку llm.ts. */
  model: string | undefined;
};

export type DatasetConfig = {
  /** Полное имя целевой таблицы (`db.table`). */
  githubEventsTable: string;
  dateColumn: string;
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
let datasetCache: DatasetConfig | undefined;

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
      llmCache = { apiKey: env.OPENROUTER_API_KEY, model: env.LLM_MODEL };
    }
    return llmCache;
  },

  get dataset(): DatasetConfig {
    if (!datasetCache) {
      const env = parseGroup("датасета", datasetEnvSchema);
      datasetCache = {
        githubEventsTable: env.GITHUB_EVENTS_TABLE,
        dateColumn: env.GITHUB_EVENTS_DATE_COLUMN,
      };
    }
    return datasetCache;
  },
};
