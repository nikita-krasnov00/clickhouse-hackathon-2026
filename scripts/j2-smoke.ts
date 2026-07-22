// J2 smoke: trigger investigate via Trigger.dev cloud (dev env),
// wait for the dev worker to execute, verify steps in metadata and final output.
import { tasks, runs } from "@trigger.dev/sdk/v3";

async function main() {
  const question = process.argv[2] ?? "top 10 most starred repos in 2026";
  console.log(`[j2-smoke] trigger investigate: "${question}"`);
  const handle = await tasks.trigger("investigate", { question });
  console.log(`[j2-smoke] runId=${handle.id}`);

  const started = Date.now();
  let lastStep = "";
  while (Date.now() - started < 240_000) {
    const run = await runs.retrieve(handle.id);
    const meta = (run.metadata ?? {}) as Record<string, unknown>;
    const last = (meta.lastStep as { step?: string } | undefined)?.step ?? "";
    if (last && last !== lastStep) {
      lastStep = last;
      console.log(`[j2-smoke] step: ${last}`);
    }
    if (run.status === "COMPLETED") {
      const steps = (meta.steps as unknown[]) ?? [];
      console.log(`[j2-smoke] COMPLETED, steps in metadata: ${steps.length}`);
      const out = run.output as { viewSpecs?: { kind: string; title?: string }[] } | undefined;
      const specs = out?.viewSpecs ?? [];
      console.log(
        `[j2-smoke] viewSpecs: ${specs.map((s) => `${s.kind}:"${s.title ?? ""}"`).join(", ") || "NONE"}`
      );
      process.exit(specs.length > 0 ? 0 : 2);
    }
    if (["FAILED", "CRASHED", "CANCELED", "SYSTEM_FAILURE", "TIMED_OUT"].includes(run.status)) {
      console.error(`[j2-smoke] run ${run.status}:`, JSON.stringify(run.error ?? meta, null, 2).slice(0, 2000));
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.error("[j2-smoke] timeout 240s — run did not finish (is the dev worker alive?)");
  process.exit(1);
}

main();
