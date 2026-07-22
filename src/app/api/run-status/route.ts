/**
 * C2/C6 — GET /api/run-status?runId=… : polling fallback for Realtime subscription.
 *
 * Mitigation from PLAN.md ("Realtime did not work on deploy — degrade to
 * polling run status"): the frontend polls this route in parallel with the
 * subscription and takes the freshest state. runId is an unguessable cuid,
 * issued only to the run creator by /api/ask; the server calls Trigger with
 * the secret key.
 */
import { NextResponse } from "next/server";
import { runs } from "@trigger.dev/sdk/v3";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const runId = new URL(req.url).searchParams.get("runId");
  if (!runId || !/^run_[a-z0-9]+$/i.test(runId)) {
    return NextResponse.json({ error: "runId parameter required (run_…)" }, { status: 400 });
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
      { error: `failed to retrieve run status: ${message}` },
      { status: 502 },
    );
  }
}
