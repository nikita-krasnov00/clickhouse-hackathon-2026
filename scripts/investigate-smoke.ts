/**
 * B3/B4 live without Trigger: `npm run investigate:smoke`.
 * Runs the investigate pipeline (pipeline.ts) — dataset-agnostic v2: table catalog
 * → triage → board_planned → cards — on questions covering different card kinds
 * AND all substantive instance databases (github, tpcds, stackoverflow),
 * against real ClickHouse: steps and SQL print to stdout,
 * final ViewSpec is valid (viewSpecSchema.parse inside the pipeline +
 * a sanity parse here).
 *
 * DEFAULT_QUESTIONS are known-answerable: a run ending in clarify/impossible
 * or with zero cards is a smoke failure (see main). For YOUR questions
 * (`npm run investigate:smoke -- "your question"`, multiple allowed) clarify and
 * impossible are valid outcomes: the agent honestly does not guess or fabricate.
 */
import { runInvestigatePipeline } from "../src/lib/agent/pipeline";
import { viewSpecSchema, type RunStep, type ViewSpec } from "../src/lib/contracts";

const DEFAULT_QUESTIONS = [
  "top repos by stars in March 2024", // github, leaderboard
  "динамика звёзд на GitHub по дням в марте 2024", // github, timeline
  "топ-10 товаров по выручке в store_sales", // tpcds, leaderboard (JOIN item)
  "распределение размера чека в store_sales", // tpcds, histogram
  "сколько всего продаж в store_sales за 1999 год", // tpcds, bignumber (JOIN date_dim)
  "у кого больше всего бейджей на stackoverflow?", // stackoverflow, leaderboard
];

function short(s: string, max = 110): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function printStep(step: RunStep) {
  switch (step.step) {
    case "executing":
    case "reviewing":
      console.log(
        `  → ${step.step}${step.message ? ` (${step.message})` : ""}: ${short(step.sqlPreview ?? "", 400)}`,
      );
      break;
    case "healing":
      console.log(`  → healing (attempt ${step.attempt}): ${short(step.error ?? "", 300)}`);
      break;
    case "board_planned":
      console.log(
        `  → board_planned: ${step.cards.map((c) => `[${c.kind}] ${c.title}`).join("; ")}`,
      );
      break;
    case "clarify":
      console.log(
        `  → clarify: ${step.question}${step.options ? ` [options: ${step.options.join(", ")}]` : ""}`,
      );
      break;
    case "impossible":
      console.log(
        `  → impossible: ${step.reason}${step.available ? ` [available: ${step.available.join(", ")}]` : ""}`,
      );
      break;
    case "card_failed":
      console.log(
        `  → card_failed${step.cardId ? ` (${step.cardId})` : ""}: ${short(step.error, 300)}`,
      );
      break;
    case "done":
      console.log(`  → done: ${step.viewSpecs.length} viewSpec — ${step.message ?? ""}`);
      break;
    default:
      console.log(`  → ${step.step}${step.message ? `: ${step.message}` : ""}`);
  }
}

/** Truncated ViewSpec for stdout (full rows/points/cells are noise). */
function preview(spec: ViewSpec): unknown {
  switch (spec.kind) {
    case "leaderboard":
      return {
        ...spec,
        rows: spec.rows.slice(0, 5),
        _truncated: `${spec.rows.length} rows total, showing first 5`,
      };
    case "timeline":
      return {
        ...spec,
        series: spec.series.map((s) => ({
          name: s.name,
          points: s.points.slice(0, 5),
          _truncated: `${s.points.length} points total, showing first 5`,
        })),
      };
    case "histogram":
      return {
        ...spec,
        buckets: spec.buckets.slice(0, 10),
        _truncated: `${spec.buckets.length} buckets total, showing first 10`,
      };
    case "heatmap":
      return {
        ...spec,
        cells: spec.cells.slice(0, 10),
        _truncated: `${spec.cells.length} cells total, showing first 10`,
      };
    default:
      return spec; // verdict and others are compact on their own
  }
}

async function main() {
  const argQuestions = process.argv.slice(2).filter((a) => a.trim().length > 0);
  const usingDefaults = argQuestions.length === 0;
  const questions = usingDefaults ? DEFAULT_QUESTIONS : argQuestions;
  const failures: string[] = [];

  for (const question of questions) {
    console.log(`\n=== Question: ${question}`);
    // Remember how triage ended — needed for an honest failure message if
    // DEFAULT_QUESTIONS did not reach cards.
    let terminal: "clarify" | "impossible" | undefined;
    try {
      const result = await runInvestigatePipeline(
        { question },
        {
          emit: (step) => {
            if (step.step === "clarify" || step.step === "impossible") terminal = step.step;
            printStep(step);
          },
        },
      );

      // Sanity validation outside the pipeline too.
      for (const spec of result.viewSpecs) {
        viewSpecSchema.parse(spec);
      }

      // DEFAULT_QUESTIONS are known-answerable — 0 cards is always a failure.
      // For YOUR questions (usingDefaults === false) clarify/impossible are
      // valid honest outcomes — no throw below.
      if (usingDefaults && result.viewSpecs.length === 0) {
        const cause = terminal
          ? ` — run ended with step "${terminal}" (for a known-answerable question this is a triage bug)`
          : "";
        throw new Error(`0 ViewSpec, no cards produced${cause}`);
      }

      console.log(
        `  result: ${result.viewSpecs.length} ViewSpec (valid), SQL attempts: ${result.attempts}`,
      );
      console.log(`  SQL: ${result.sql}`);
      console.log(JSON.stringify(result.viewSpecs.map(preview), null, 2));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`«${question}»: ${message}`);
      console.error(`  FAILED: ${message}`);
    }
  }

  if (failures.length > 0) {
    console.error(`\ninvestigate:smoke FAILED (${failures.length}/${questions.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\ninvestigate:smoke OK");
}

main().catch((err) => {
  console.error(
    "investigate:smoke FAILED:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
