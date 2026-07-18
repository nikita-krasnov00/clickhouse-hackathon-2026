/**
 * B7 — POST /api/drill: быстрый путь без LLM (каркас для C6/A4).
 *
 * Тело: drillRequestSchema { drillId, params }. Каталог drillId и
 * параметризованные запросы делает трек A (задача A4) — до тех пор роут
 * честно отвечает 501, чтобы C6 мог сверстать обработку заранее.
 *
 * Формат будущего успешного ответа (200): drillResponseSchema { viewSpec }.
 * Ошибки: 400 — мусор на входе (с zod-деталями), 501 — каталог ещё не готов.
 */
import { NextResponse } from "next/server";
import { drillRequestSchema } from "@/lib/contracts";

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

  const parsed = drillRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Невалидное тело запроса /api/drill", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // TODO(A4/C6): найти drillId в каталоге, выполнить параметризованный SQL
  // под agent_ro и вернуть drillResponseSchema.parse({ viewSpec }).
  return NextResponse.json(
    { error: "drill catalog появится в A4" },
    { status: 501 },
  );
}
