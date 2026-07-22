/**
 * B4 — OpenRouter client (chat completions) for text-to-SQL and self-healing.
 *
 * Native fetch (Node 20+), no new dependencies. TWO model tiers:
 *   - main — heavy work (SQL, self-healing, verdicts): env LLM_MODEL
 *     (OpenRouter slug or alias from MODEL_ALIASES), default minimax/minimax-m3,
 *     on unavailability — MiniMax fallback chain;
 *   - fast — question triage and preset suggestions where first-response
 *     latency matters: env LLM_MODEL_FAST, default openai/gpt-5.6-terra (~1.5-2 s),
 *     fallback — main chain.
 * Reasoning models GPT-5.x/o-series do NOT receive temperature (their endpoint
 * does not accept the parameter). Working model per tier is cached per process
 * so fallback probes are not repeated on every call.
 *
 * Retries: 429/5xx/network/timeout — one retry with pause, then next model.
 *
 * Operational log: EVERY attempt (including failures and model fallbacks)
 * is written to scratch.llm_log — full prompt, response, status, timing (llm-log.ts).
 */
import { config } from "@/lib/config";
import { logLlmCall } from "./llm-log";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatCompletionResult = {
  content: string;
  /** Actual model that answered the request (after fallbacks). */
  model: string;
  elapsedMs: number;
};

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export const DEFAULT_LLM_MODEL = "minimax/minimax-m3";

/** Fallback chain — MiniMax versions on OpenRouter, newest to oldest. */
const MODEL_FALLBACKS = [
  DEFAULT_LLM_MODEL,
  "minimax/minimax-m2.7",
  "minimax/minimax-m2.5",
  "minimax/minimax-m2.1",
  "minimax/minimax-m2",
];

/** OpenAI GPT-5.6 Terra on OpenRouter (GPT-5.x reasoning series). */
export const OPENAI_GPT_5_6_TERRA = "openai/gpt-5.6-terra";

/**
 * Short aliases for LLM_MODEL — so .env can use
 * "gpt-5.6-terra" instead of the full slug. Keys compared in lowercase;
 * full OpenRouter slug (`openai/…`, `minimax/…`) can always be set directly.
 */
const MODEL_ALIASES: Record<string, string> = {
  "gpt-5.6-terra": OPENAI_GPT_5_6_TERRA,
  "gpt-5.6-terra-pro": "openai/gpt-5.6-terra-pro",
  "minimax-m3": DEFAULT_LLM_MODEL,
};

/** Resolve alias to OpenRouter slug; unknown value — as-is. */
function resolveModelAlias(model: string | undefined): string | undefined {
  if (!model) return model;
  return MODEL_ALIASES[model.trim().toLowerCase()] ?? model;
}

/**
 * OpenAI reasoning models (GPT-5.x, o-series) on OpenRouter do NOT accept
 * temperature — we omit the parameter for them; for others (MiniMax etc.)
 * we set low temperature for text-to-SQL determinism.
 */
function modelSupportsTemperature(model: string): boolean {
  return !/^openai\/(gpt-5|o\d)/i.test(model);
}

const REQUEST_TIMEOUT_MS = 120_000;
const RETRY_PAUSE_MS = 1_500;
const TEMPERATURE = 0.2;
/** With headroom: MiniMax — reasoning models, thinking tokens count too. */
const MAX_TOKENS = 8_000;

/**
 * Model tiers: main — heavy work (SQL/heal/verdict), fast — triage and
 * suggestions where first-response latency matters.
 */
export type LlmTier = "main" | "fast";

/** Default fast tier — GPT-5.6 Terra (env LLM_MODEL_FAST overrides). */
export const FAST_LLM_DEFAULT = OPENAI_GPT_5_6_TERRA;

/** Working model per tier found by fallback probes; cached per process. */
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
    // Fast tier fallback — main chain: slow triage beats dead.
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
  // Validate LLM config group — clear error if key is missing.
  const { apiKey } = config.llm;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const requestBody: Record<string, unknown> = {
      model,
      messages,
      max_tokens: MAX_TOKENS,
    };
    // GPT-5.x/o-series do not accept temperature; others — for determinism.
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
      // 429 and 5xx — transient, retry; other 4xx — model/request unsuitable.
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
      return { ok: false, retryable: true, reason: "OpenRouter response is not JSON" };
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
      // Empty content (e.g. everything went to reasoning and hit max_tokens).
      return { ok: false, retryable: true, reason: "empty content in model response" };
    }
    return { ok: true, content };
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "AbortError"
        ? `timeout ${REQUEST_TIMEOUT_MS} ms`
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, retryable: true, reason };
  } finally {
    clearTimeout(timer);
  }
}

export type ChatCompleteOptions = {
  /** Call purpose for operational log (card_sql, heal_sql, triage, …). */
  purpose?: string;
  /** Model tier: 'fast' — triage/suggestions, default 'main'. */
  tier?: LlmTier;
};

/**
 * One chat completion: model from env/default of chosen tier, fallbacks along
 * the chain, one retry on transient errors. Returns raw content —
 * JSON parsing is done by the caller (llm-json.ts).
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
      // await is cheap: wait_for_async_insert=0 — confirmation from buffer
      // (milliseconds), and logging failures are swallowed inside logLlmCall.
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
      failures.push(`${model} (attempt ${attempt}): ${result.reason}`);
      if (!result.retryable) break; // model unavailable — move to next in chain
      if (attempt === 1) await sleep(RETRY_PAUSE_MS);
    }
  }

  throw new Error(`LLM unavailable, all models exhausted: ${failures.join(" | ")}`);
}
