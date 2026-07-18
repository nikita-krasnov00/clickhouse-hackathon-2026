/**
 * B3/B4 живьём без Trigger: `npm run investigate:smoke`.
 * Гоняет конвейер investigate (pipeline.ts) с LLM text-to-SQL на вопросах,
 * покрывающих виды карточек (leaderboard, timeline, histogram, heatmap, verdict),
 * против реального ClickHouse: шаги и сгенерированный SQL печатаются в stdout,
 * финальный ViewSpec валиден (viewSpecSchema.parse внутри конвейера +
 * контрольный parse здесь).
 *
 * Свой вопрос: `npm run investigate:smoke -- "ваш вопрос"` (можно несколько).
 */
import { runInvestigatePipeline } from "../src/lib/agent/pipeline";
import { viewSpecSchema, type RunStep, type ViewSpec } from "../src/lib/contracts";

const DEFAULT_QUESTIONS = [
  "top starred repos this year", // leaderboard
  "stars per day for xai-org/grok-1", // timeline
  "distribution of stars per account", // histogram
  "stars for xai-org/grok-1 by hour of day and day of week", // heatmap
  "is xai-org/grok-1 star activity suspicious?", // verdict
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
      console.log(`  → healing (попытка ${step.attempt}): ${short(step.error ?? "", 300)}`);
      break;
    case "done":
      console.log(`  → done: ${step.viewSpecs.length} viewSpec — ${step.message ?? ""}`);
      break;
    default:
      console.log(`  → ${step.step}${step.message ? `: ${step.message}` : ""}`);
  }
}

/** Урезанный вид ViewSpec для stdout (полные rows/points/cells — шум). */
function preview(spec: ViewSpec): unknown {
  switch (spec.kind) {
    case "leaderboard":
      return {
        ...spec,
        rows: spec.rows.slice(0, 5),
        _truncated: `${spec.rows.length} строк всего, показаны первые 5`,
      };
    case "timeline":
      return {
        ...spec,
        series: spec.series.map((s) => ({
          name: s.name,
          points: s.points.slice(0, 5),
          _truncated: `${s.points.length} точек всего, показаны первые 5`,
        })),
      };
    case "histogram":
      return {
        ...spec,
        buckets: spec.buckets.slice(0, 10),
        _truncated: `${spec.buckets.length} корзин всего, показаны первые 10`,
      };
    case "heatmap":
      return {
        ...spec,
        cells: spec.cells.slice(0, 10),
        _truncated: `${spec.cells.length} ячеек всего, показаны первые 10`,
      };
    default:
      return spec; // verdict и прочие — компактны сами по себе
  }
}

async function main() {
  const argQuestions = process.argv.slice(2).filter((a) => a.trim().length > 0);
  const questions = argQuestions.length > 0 ? argQuestions : DEFAULT_QUESTIONS;
  const failures: string[] = [];

  for (const question of questions) {
    console.log(`\n=== Вопрос: ${question}`);
    try {
      const result = await runInvestigatePipeline({ question }, { emit: printStep });

      // Контрольная валидация уже снаружи конвейера.
      for (const spec of result.viewSpecs) {
        viewSpecSchema.parse(spec);
      }
      console.log(
        `  результат: ${result.viewSpecs.length} ViewSpec (валидны), попыток SQL: ${result.attempts}`,
      );
      console.log(`  SQL: ${result.sql}`);
      console.log(JSON.stringify(result.viewSpecs.map(preview), null, 2));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`«${question}»: ${message}`);
      console.error(`  ПРОВАЛ: ${message}`);
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
