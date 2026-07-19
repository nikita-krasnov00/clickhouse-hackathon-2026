/**
 * C2/C6 — GET /api/run-status?runId=… : поллинг-фоллбек Realtime-подписки.
 *
 * Митигейшн риска из PLAN.md («Realtime не завёлся на деплое — деградация до
 * поллинга статуса рана»): фронт опрашивает этот роут параллельно подписке и
 * берёт самое свежее состояние. runId — неугадываемый cuid, выдаётся только
 * создателю рана ответом /api/ask; сервер ходит в Trigger под секретным ключом.
 */
import { NextResponse } from "next/server";
import { runs } from "@trigger.dev/sdk/v3";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const runId = new URL(req.url).searchParams.get("runId");
  if (!runId || !/^run_[a-z0-9]+$/i.test(runId)) {
    return NextResponse.json({ error: "нужен параметр runId (run_…)" }, { status: 400 });
  }
  try {
    const run = await runs.retrieve(runId);
    return NextResponse.json({
      status: run.status,
      metadata: run.metadata ?? null,
      output: run.output ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `не удалось получить статус рана: ${message}` },
      { status: 502 },
    );
  }
}
