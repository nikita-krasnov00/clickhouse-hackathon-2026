/**
 * B4 — клиент OpenRouter (chat completions) для text-to-SQL и самопочинки.
 *
 * Нативный fetch (Node 20+), без новых зависимостей. ДВА ЯРУСА моделей:
 *   - main — тяжёлая работа (SQL, самопочинка, вердикты): env LLM_MODEL
 *     (слаг OpenRouter или алиас из MODEL_ALIASES), дефолт minimax/minimax-m3,
 *     при недоступности — цепочка MiniMax вниз;
 *   - fast — триаж вопроса и подсказки-пресеты, где важна скорость первого
 *     ответа: env LLM_MODEL_FAST, дефолт openai/gpt-5.6-terra (~1.5-2 c),
 *     фоллбек — основная цепочка.
 * Reasoning-моделям GPT-5.x/o-серии temperature НЕ отправляется (их эндпоинт
 * параметр не принимает). Рабочая модель каждого яруса кэшируется на процесс,
 * чтобы фоллбек-пробы не повторялись на каждый вызов.
 *
 * Ретраи: 429/5xx/сеть/таймаут — один повтор с паузой, затем следующая модель.
 *
 * Операционный лог: КАЖДАЯ попытка (включая неудачные и фоллбеки моделей)
 * пишется в scratch.llm_log — полный промпт, ответ, статус, тайминг (llm-log.ts).
 */
import { config } from "@/lib/config";
import { logLlmCall } from "./llm-log";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatCompletionResult = {
  content: string;
  /** Фактическая модель, ответившая на запрос (после фоллбеков). */
  model: string;
  elapsedMs: number;
};

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export const DEFAULT_LLM_MODEL = "minimax/minimax-m3";

/** Цепочка фоллбеков — версии MiniMax на OpenRouter, от новой к старой. */
const MODEL_FALLBACKS = [
  DEFAULT_LLM_MODEL,
  "minimax/minimax-m2.7",
  "minimax/minimax-m2.5",
  "minimax/minimax-m2.1",
  "minimax/minimax-m2",
];

/** OpenAI GPT-5.6 Terra на OpenRouter (reasoning-серия GPT-5.x). */
export const OPENAI_GPT_5_6_TERRA = "openai/gpt-5.6-terra";

/**
 * Короткие алиасы для LLM_MODEL — чтобы в .env можно было указать
 * «gpt-5.6-terra» вместо полного слага. Ключи сравниваются в нижнем регистре;
 * полный слаг OpenRouter (`openai/…`, `minimax/…`) всегда можно задать напрямую.
 */
const MODEL_ALIASES: Record<string, string> = {
  "gpt-5.6-terra": OPENAI_GPT_5_6_TERRA,
  "gpt-5.6-terra-pro": "openai/gpt-5.6-terra-pro",
  "minimax-m3": DEFAULT_LLM_MODEL,
};

/** Разворачивает алиас в слаг OpenRouter; неизвестное значение — как есть. */
function resolveModelAlias(model: string | undefined): string | undefined {
  if (!model) return model;
  return MODEL_ALIASES[model.trim().toLowerCase()] ?? model;
}

/**
 * reasoning-модели OpenAI (GPT-5.x, o-серия) на OpenRouter НЕ принимают
 * temperature — для них параметр не отправляем; остальным (MiniMax и т.п.)
 * задаём низкую температуру ради детерминизма text-to-SQL.
 */
function modelSupportsTemperature(model: string): boolean {
  return !/^openai\/(gpt-5|o\d)/i.test(model);
}

const REQUEST_TIMEOUT_MS = 120_000;
const RETRY_PAUSE_MS = 1_500;
const TEMPERATURE = 0.2;
/** С запасом: MiniMax — reasoning-модели, thinking-токены тоже считаются. */
const MAX_TOKENS = 8_000;

/**
 * Ярусы моделей: main — тяжёлая работа (SQL/heal/verdict), fast — триаж и
 * подсказки, где решает латентность первого ответа.
 */
export type LlmTier = "main" | "fast";

/** Дефолт быстрого яруса — GPT-5.6 Terra (env LLM_MODEL_FAST переопределяет). */
export const FAST_LLM_DEFAULT = OPENAI_GPT_5_6_TERRA;

/** Рабочая модель каждого яруса, найденная фоллбек-пробами; кэш на процесс. */
const resolvedByTier: Partial<Record<LlmTier, string>> = {};

function mainCandidates(): string[] {
  const first = resolvedByTier.main ?? resolveModelAlias(config.llm.model);
  if (!first) return [...MODEL_FALLBACKS];
  return [first, ...MODEL_FALLBACKS.filter((m) => m !== first)];
}

function candidateModels(tier: LlmTier): string[] {
  if (tier === "fast") {
    const first =
      resolvedByTier.fast ??
      resolveModelAlias(config.llm.fastModel) ??
      FAST_LLM_DEFAULT;
    // Фоллбек быстрого яруса — основная цепочка: медленный триаж лучше мёртвого.
    return [first, ...mainCandidates().filter((m) => m !== first)];
  }
  return mainCandidates();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type AttemptResult =
  | { ok: true; content: string }
  | { ok: false; retryable: boolean; reason: string };

async function attemptOnce(
  model: string,
  messages: ChatMessage[],
): Promise<AttemptResult> {
  // Валидация группы LLM конфига — понятная ошибка, если ключ не задан.
  const { apiKey } = config.llm;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const requestBody: Record<string, unknown> = {
      model,
      messages,
      max_tokens: MAX_TOKENS,
    };
    // GPT-5.x/o-серия temperature не принимают; остальным — для детерминизма.
    if (modelSupportsTemperature(model)) requestBody.temperature = TEMPERATURE;

    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    const bodyText = await res.text();
    if (!res.ok) {
      // 429 и 5xx — временные, ретраим; прочие 4xx — модель/запрос не годятся.
      return {
        ok: false,
        retryable: res.status === 429 || res.status >= 500,
        reason: `HTTP ${res.status}: ${bodyText.slice(0, 300)}`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return { ok: false, retryable: true, reason: "ответ OpenRouter — не JSON" };
    }
    const body = parsed as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    };
    if (body.error?.message) {
      return { ok: false, retryable: false, reason: body.error.message.slice(0, 300) };
    }
    const content = body.choices?.[0]?.message?.content;
    if (!content || !content.trim()) {
      // Пустой content (например, всё ушло в reasoning и упёрлось в max_tokens).
      return { ok: false, retryable: true, reason: "пустой content в ответе модели" };
    }
    return { ok: true, content };
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "AbortError"
        ? `таймаут ${REQUEST_TIMEOUT_MS} мс`
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, retryable: true, reason };
  } finally {
    clearTimeout(timer);
  }
}

export type ChatCompleteOptions = {
  /** Назначение вызова для операционного лога (card_sql, heal_sql, triage, …). */
  purpose?: string;
  /** Ярус модели: 'fast' — триаж/подсказки, дефолт 'main'. */
  tier?: LlmTier;
};

/**
 * Один chat-completion: модель из env/дефолта выбранного яруса, фоллбеки по
 * цепочке, один ретрай на временных ошибках. Возвращает сырой content —
 * парсинг JSON из ответа делает вызывающий (llm-json.ts).
 */
export async function chatComplete(
  messages: ChatMessage[],
  options?: ChatCompleteOptions,
): Promise<ChatCompletionResult> {
  const started = Date.now();
  const purpose = options?.purpose ?? "unknown";
  const tier = options?.tier ?? "main";
  const failures: string[] = [];
  let attemptNo = 0;

  for (const model of candidateModels(tier)) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      attemptNo += 1;
      const attemptStarted = Date.now();
      const result = await attemptOnce(model, messages);
      const attemptMs = Date.now() - attemptStarted;
      // await дешёвый: wait_for_async_insert=0 — подтверждение из буфера
      // сервера (миллисекунды), а сбой логирования гасится внутри logLlmCall.
      await logLlmCall({
        purpose,
        model,
        attempt: attemptNo,
        status: result.ok ? "ok" : "error",
        error: result.ok ? undefined : result.reason,
        messages,
        response: result.ok ? result.content : undefined,
        elapsedMs: attemptMs,
      });
      if (result.ok) {
        resolvedByTier[tier] = model;
        const elapsedMs = Date.now() - started;
        console.log(`[llm] purpose=${purpose} model=${model} elapsed=${elapsedMs}ms`);
        return { content: result.content, model, elapsedMs };
      }
      failures.push(`${model} (попытка ${attempt}): ${result.reason}`);
      if (!result.retryable) break; // модель недоступна — к следующей в цепочке
      if (attempt === 1) await sleep(RETRY_PAUSE_MS);
    }
  }

  throw new Error(`LLM недоступна, все модели исчерпаны: ${failures.join(" | ")}`);
}
