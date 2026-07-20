/**
 * B3/B4 живьём без Trigger: `npm run investigate:smoke`.
 * Гоняет конвейер investigate (pipeline.ts) — dataset-agnostic v2: каталог
 * таблиц → триаж → board_planned → карточки — на вопросах, покрывающих разные
 * виды карточек И все содержательные базы инстанса (github, tpcds,
 * stackoverflow), против реального ClickHouse: шаги и SQL печатаются в stdout,
 * финальный ViewSpec валиден (viewSpecSchema.parse внутри конвейера +
 * контрольный parse здесь).
 *
 * DEFAULT_QUESTIONS — заведомо отвечаемые: ран, закончившийся clarify/impossible
 * или без единой карточки, — провал смоука (см. main). Для СВОИХ вопросов
 * (`npm run investigate:smoke -- "ваш вопрос"`, можно несколько) clarify и
 * impossible — валидные исходы: агент честно не угадывает и не выдумывает.
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
      console.log(`  → healing (попытка ${step.attempt}): ${short(step.error ?? "", 300)}`);
      break;
    case "board_planned":
      console.log(
        `  → board_planned: ${step.cards.map((c) => `[${c.kind}] ${c.title}`).join("; ")}`,
      );
      break;
    case "clarify":
      console.log(
        `  → clarify: ${step.question}${step.options ? ` [варианты: ${step.options.join(", ")}]` : ""}`,
      );
      break;
    case "impossible":
      console.log(
        `  → impossible: ${step.reason}${step.available ? ` [доступно: ${step.available.join(", ")}]` : ""}`,
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
  const usingDefaults = argQuestions.length === 0;
  const questions = usingDefaults ? DEFAULT_QUESTIONS : argQuestions;
  const failures: string[] = [];

  for (const question of questions) {
    console.log(`\n=== Вопрос: ${question}`);
    // Запоминаем, чем закончился триаж — нужно для честного сообщения о
    // провале, если DEFAULT_QUESTIONS вдруг не долетел до карточек.
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

      // Контрольная валидация уже снаружи конвейера.
      for (const spec of result.viewSpecs) {
        viewSpecSchema.parse(spec);
      }

      // DEFAULT_QUESTIONS заведомо отвечаемые — 0 карточек всегда провал.
      // Для СВОИХ вопросов (usingDefaults === false) clarify/impossible —
      // валидный честный исход, не провал: ниже до throw дело не доходит.
      if (usingDefaults && result.viewSpecs.length === 0) {
        const cause = terminal
          ? ` — ран закончился шагом "${terminal}" (для заведомо отвечаемого вопроса это баг триажа)`
          : "";
        throw new Error(`0 ViewSpec, карточек не получилось${cause}`);
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
