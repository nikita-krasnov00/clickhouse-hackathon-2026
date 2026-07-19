/**
 * A4/C6 — POST /api/drill: быстрый путь клика без LLM.
 *
 * Тело: drillRequestSchema { drillId, params } (params = ClickContext.selection).
 * Каталог — src/lib/drills; SQL параметризованный, исполнение под agent_ro,
 * скорость на роллапах scratch.* (db/a4_rollups.sh).
 *
 * Ответы: 200 drillResponseSchema { viewSpec } (+ X-Drill-Ms — тайминг);
 * 400 мусор на входе; 404 неизвестный drillId; 422 параметры не подходят
 * каталогу; 500 сбой исполнения.
 */
import { NextResponse } from "next/server";
import { createReadonlyClient } from "@/lib/clickhouse";
import { drillRequestSchema, drillResponseSchema } from "@/lib/contracts";
import { DrillParamsError, UnknownDrillError, resolveDrill } from "@/lib/drills";

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
  const { drillId, params } = parsed.data;

  let def;
  try {
    def = resolveDrill(drillId);
  } catch (err) {
    if (err instanceof UnknownDrillError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }

  const parsedParams = def.params.safeParse(params);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: `Параметры не подходят дриллу ${drillId}`, issues: parsedParams.error.issues },
      { status: 422 },
    );
  }

  const client = createReadonlyClient();
  const t0 = Date.now();
  try {
    const viewSpec = await def.execute(client, parsedParams.data);
    return NextResponse.json(drillResponseSchema.parse({ viewSpec }), {
      headers: { "X-Drill-Ms": String(Date.now() - t0) },
    });
  } catch (err) {
    if (err instanceof DrillParamsError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Дрилл ${drillId} не выполнился: ${message}` },
      { status: 500 },
    );
  } finally {
    await client.close();
  }
}
