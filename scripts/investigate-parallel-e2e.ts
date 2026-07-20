/**
 * E2E параллельных дочерних ранов: `npx tsx --env-file=.env scripts/investigate-parallel-e2e.ts`.
 *
 * Требует запущенный dev-воркер (`npx trigger.dev@latest dev`) и TRIGGER_SECRET_KEY
 * в .env. Триггерит ран investigate через src/lib/trigger-api.ts (тот же путь,
 * что /api/ask), поллит runs.retrieve до терминального статуса и печатает
 * metadata.steps по мере появления.
 *
 * Проверки:
 *   - ран COMPLETED;
 *   - в output ≥ 2 viewSpecs;
 *   - в metadata РОДИТЕЛЯ есть шаги детей: executing и card_ready
 *     (дети пишут их через metadata.parent.append — фронт ничего не меняет).
 */
import { runs } from "@trigger.dev/sdk";
import { triggerInvestigate } from "../src/lib/trigger-api";
import type { RunStep } from "../src/lib/contracts";

// Нейтральный, заведомо отвечаемый вопрос с ДВУМЯ дополняющими углами (топ +
// тренд), чтобы триаж спланировал ≥ 2 карточки — иначе проверка ниже
// (specCount < 2) валится не из-за бага, а из-за того, что «простой лукап»
// триаж по своим же правилам сводит к одной карточке.
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
      console.log(`  [${at}] #${i} healing (попытка ${step.attempt}): ${short(step.error ?? "")}`);
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
  console.log(`=== Вопрос: ${QUESTION}`);
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
      console.log(`\nстатус: ${run.status} за ${Math.round((Date.now() - started) / 1000)} c`);

      // -- Проверки ----------------------------------------------------------
      const problems: string[] = [];
      if (run.status !== "COMPLETED") {
        problems.push(`ожидался COMPLETED, получен ${run.status}`);
      }
      const output = run.output as { viewSpecs?: unknown[] } | undefined;
      const specCount = output?.viewSpecs?.length ?? 0;
      if (specCount < 2) {
        problems.push(`ожидалось ≥2 viewSpecs в output, получено ${specCount}`);
      }
      const executing = steps.filter((s) => s.step === "executing").length;
      const cardReady = steps.filter((s) => s.step === "card_ready").length;
      if (executing < 1 || cardReady < 1) {
        problems.push(
          `в metadata родителя нет шагов детей: executing=${executing}, card_ready=${cardReady}`,
        );
      }
      console.log(
        `viewSpecs в output: ${specCount}; шагов executing: ${executing}, card_ready: ${cardReady}, всего шагов: ${steps.length}`,
      );

      if (problems.length > 0) {
        console.error(`\ninvestigate-parallel-e2e FAILED:\n  - ${problems.join("\n  - ")}`);
        process.exit(1);
      }
      console.log("\ninvestigate-parallel-e2e OK");
      return;
    }
    if (Date.now() - started > 5 * 60_000) {
      console.error(`\ninvestigate-parallel-e2e FAILED: ран не завершился за 5 минут (статус ${run.status})`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

main().catch((err) => {
  console.error("investigate-parallel-e2e FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
