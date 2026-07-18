/**
 * B7 — серверный хелпер поверх Trigger.dev API для HTTP-роутов.
 *
 * Единственная задача: задеплоить ран таски `investigate` и выдать public
 * access token для Realtime-подписки. Токен скоупится на чтение ТОЛЬКО этого
 * рана (канон skill trigger-realtime: auth.createPublicToken → scopes.read.runs)
 * и живёт 1 час — с запасом покрывает maxDuration рана (300 c).
 *
 * Из src/trigger/ импортируется ТОЛЬКО тип таски (type-only import) — код
 * таски в бандл роута не попадает.
 */
import { auth, tasks } from "@trigger.dev/sdk";
import type { investigateTask } from "@/trigger/investigate";
import type { AskRequest, AskResponse } from "@/lib/contracts";

/** Ошибка общения с Trigger.dev API — роут превращает её в 502. */
export class TriggerApiError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TriggerApiError";
  }
}

/**
 * Деплоит ран investigate и выдаёт read-only токен на этот ран.
 * Ответ строго соответствует askResponseSchema ({ runId, publicAccessToken }).
 */
export async function triggerInvestigate(payload: AskRequest): Promise<AskResponse> {
  let runId: string;
  try {
    const handle = await tasks.trigger<typeof investigateTask>("investigate", payload);
    runId = handle.id;
  } catch (err) {
    throw new TriggerApiError(
      `Не удалось задеплоить ран investigate: ${errorMessage(err)}`,
      { cause: err },
    );
  }

  let publicAccessToken: string;
  try {
    publicAccessToken = await auth.createPublicToken({
      scopes: { read: { runs: [runId] } },
      expirationTime: "1h",
    });
  } catch (err) {
    throw new TriggerApiError(
      `Ран ${runId} создан, но не удалось выдать public access token: ${errorMessage(err)}`,
      { cause: err },
    );
  }

  return { runId, publicAccessToken };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
