/**
 * E2E parallel child runs: `npx tsx --env-file=.env scripts/investigate-parallel-e2e.ts`.
 *
 * Requires a running dev worker (`npx trigger.dev@latest dev`) and TRIGGER_SECRET_KEY
 * in .env. Triggers an investigate run via src/lib/trigger-api.ts (same path as
 * /api/ask), polls runs.retrieve until a terminal status, and prints
 * metadata.steps as they appear.
 *
 * Checks:
 *   - run COMPLETED;
 *   - output has ≥ 2 viewSpecs;
 *   - parent metadata has child steps: executing and card_ready
 *     (children write them via metadata.parent.append — frontend unchanged).
 */
import { runs } from "@trigger.dev/sdk";
import { triggerInvestigate } from "../src/lib/trigger-api";
import type { RunStep } from "../src/lib/contracts";

// Neutral, known-answerable question with TWO complementary angles (top +
// trend) so triage plans ≥ 2 cards — otherwise the check below
// (specCount < 2) fails not because of a bug but because triage rules
// collapse a "simple lookup" to a single card.
const QUESTION =
  process.argv[2] ?? "top repos by stars in March 2024, and how did star activity trend across the month?";

const TERMINAL = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELED",
  "CRASHED",
  "TIMED_OUT",
  "SYSTEM_FAILURE",
  "EXPIRED",
]);

function short(s: string, max = 140): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function printStep(i: number, step: RunStep) {
  const at = new Date().toISOString().slice(11, 19);
  switch (step.step) {
    case "executing":
      console.log(`  [${at}] #${i} executing${step.message ? ` (${step.message})` : ""}: ${short(step.sqlPreview ?? "")}`);
      break;
    case "healing":
      console.log(`  [${at}] #${i} healing (attempt ${step.attempt}): ${short(step.error ?? "")}`);
      break;
    case "card_ready":
      console.log(`  [${at}] #${i} card_ready [${step.viewSpec.kind}]: ${step.message ?? ""}`);
      break;
    case "done":
      console.log(`  [${at}] #${i} done: ${step.viewSpecs.length} viewSpec — ${step.message ?? ""}`);
      break;
    default:
      console.log(`  [${at}] #${i} ${step.step}${step.message ? `: ${step.message}` : ""}`);
  }
}

async function main() {
  console.log(`=== Question: ${QUESTION}`);
  const { runId } = await triggerInvestigate({ question: QUESTION });
  console.log(`runId: ${runId}`);

  let printed = 0;
  const started = Date.now();
  for (;;) {
    const run = await runs.retrieve(runId);
    const steps = ((run.metadata?.steps as RunStep[] | undefined) ?? []);
    for (; printed < steps.length; printed++) {
      printStep(printed + 1, steps[printed]);
    }
    if (TERMINAL.has(run.status)) {
      console.log(`\nstatus: ${run.status} in ${Math.round((Date.now() - started) / 1000)} s`);

      // -- Checks ----------------------------------------------------------
      const problems: string[] = [];
      if (run.status !== "COMPLETED") {
        problems.push(`expected COMPLETED, got ${run.status}`);
      }
      const output = run.output as { viewSpecs?: unknown[] } | undefined;
      const specCount = output?.viewSpecs?.length ?? 0;
      if (specCount < 2) {
        problems.push(`expected ≥2 viewSpecs in output, got ${specCount}`);
      }
      const executing = steps.filter((s) => s.step === "executing").length;
      const cardReady = steps.filter((s) => s.step === "card_ready").length;
      if (executing < 1 || cardReady < 1) {
        problems.push(
          `parent metadata missing child steps: executing=${executing}, card_ready=${cardReady}`,
        );
      }
      console.log(
        `viewSpecs in output: ${specCount}; executing steps: ${executing}, card_ready: ${cardReady}, total steps: ${steps.length}`,
      );

      if (problems.length > 0) {
        console.error(`\ninvestigate-parallel-e2e FAILED:\n  - ${problems.join("\n  - ")}`);
        process.exit(1);
      }
      console.log("\ninvestigate-parallel-e2e OK");
      return;
    }
    if (Date.now() - started > 5 * 60_000) {
      console.error(`\ninvestigate-parallel-e2e FAILED: run did not finish within 5 minutes (status ${run.status})`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

main().catch((err) => {
  console.error("investigate-parallel-e2e FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
