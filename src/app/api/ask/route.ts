/**
 * B7 — POST /api/ask: question (or "why?" with ClickContext) → agent run.
 *
 * Body: askRequestSchema { question, context? } — forwarded to the
 * investigate task as-is (task input is contract-compatible).
 * Response 200: strictly askResponseSchema { runId, publicAccessToken } — read-only
 * token for this one run; the frontend subscribes via useRealtimeRun (C2).
 *
 * Errors: 400 — invalid input (with zod details), 502 — Trigger.dev API unavailable.
 */
import { NextResponse } from "next/server";
import { askRequestSchema, askResponseSchema } from "@/lib/contracts";
import { triggerInvestigate, TriggerApiError } from "@/lib/trigger-api";

// Node.js runtime: Trigger.dev SDK calls out with TRIGGER_SECRET_KEY from env.
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
    // parse — safety net: only askResponseSchema leaves the wire.
    return NextResponse.json(askResponseSchema.parse(result));
  } catch (err) {
    const message =
      err instanceof TriggerApiError
        ? err.message
        : `Trigger.dev API: ${err instanceof Error ? err.message : String(err)}`;
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
