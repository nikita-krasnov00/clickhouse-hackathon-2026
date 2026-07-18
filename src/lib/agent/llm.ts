/**
 * B4 — клиент OpenRouter (chat completions) для text-to-SQL и самопочинки.
 *
 * Нативный fetch (Node 20+), без новых зависимостей. Модель — env LLM_MODEL,
 * дефолт minimax/minimax-m3; при недоступности модели (4xx «нет такой модели»)
 * спускаемся по цепочке MiniMax-версий вниз. Рабочая модель кэшируется на
 * процесс, чтобы фоллбек-пробы не повторялись на каждый вызов.
 *
 * Ретраи: 429/5xx/сеть/таймаут — один повтор с паузой, затем следующая модель.
 */

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

const REQUEST_TIMEOUT_MS = 120_000;
const RETRY_PAUSE_MS = 1_500;
const TEMPERATURE = 0.2;
/** С запасом: MiniMax — reasoning-модели, thinking-токены тоже считаются. */
const MAX_TOKENS = 8_000;

/** Рабочая модель, найденная фоллбек-пробами; кэш на процесс. */
let resolvedModel: string | undefined;

function candidateModels(): string[] {
  const first = resolvedModel ?? (process.env.LLM_MODEL?.trim() || undefined);
  if (!first) return [...MODEL_FALLBACKS];
  return [first, ...MODEL_FALLBACKS.filter((m) => m !== first)];
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
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY не задан — см. .env");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS,
      }),
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

/**
 * Один chat-completion: модель из env/дефолта, фоллбеки по цепочке MiniMax,
 * один ретрай на временных ошибках. Возвращает сырой content — парсинг JSON
 * из ответа делает вызывающий (generate-sql.ts).
 */
export async function chatComplete(
  messages: ChatMessage[],
): Promise<ChatCompletionResult> {
  const started = Date.now();
  const failures: string[] = [];

  for (const model of candidateModels()) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const result = await attemptOnce(model, messages);
      if (result.ok) {
        resolvedModel = model;
        const elapsedMs = Date.now() - started;
        console.log(`[llm] model=${model} elapsed=${elapsedMs}ms`);
        return { content: result.content, model, elapsedMs };
      }
      failures.push(`${model} (попытка ${attempt}): ${result.reason}`);
      if (!result.retryable) break; // модель недоступна — к следующей в цепочке
      if (attempt === 1) await sleep(RETRY_PAUSE_MS);
    }
  }

  throw new Error(`LLM недоступна, все модели исчерпаны: ${failures.join(" | ")}`);
}
