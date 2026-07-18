/**
 * B7 — POST /api/ask: вопрос (или «почему?» с ClickContext) → агентный ран.
 *
 * Тело: askRequestSchema { question, context? } — прокидывается в таску
 * investigate как есть (вход таски совместим по контракту).
 * Ответ 200: строго askResponseSchema { runId, publicAccessToken } — токен
 * read-only на этот один ран, фронт подписывается через useRealtimeRun (C2).
 *
 * Ошибки: 400 — мусор на входе (с zod-деталями), 502 — Trigger.dev API недоступен.
 */
import { NextResponse } from "next/server";
import { askRequestSchema, askResponseSchema } from "@/lib/contracts";
import { triggerInvestigate, TriggerApiError } from "@/lib/trigger-api";

// Node.js runtime: SDK Trigger.dev ходит наружу с TRIGGER_SECRET_KEY из env.
export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Тело запроса — не валидный JSON" },
      { status: 400 },
    );
  }

  const parsed = askRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Невалидное тело запроса /api/ask", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const result = await triggerInvestigate(parsed.data);
    // parse — страховка: наружу уходит строго контракт askResponseSchema.
    return NextResponse.json(askResponseSchema.parse(result));
  } catch (err) {
    const message =
      err instanceof TriggerApiError
        ? err.message
        : `Trigger.dev API: ${err instanceof Error ? err.message : String(err)}`;
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
