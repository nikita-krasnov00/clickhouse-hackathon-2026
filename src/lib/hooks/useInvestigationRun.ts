"use client";

/**
 * C2 — подписка на ран investigate через Trigger.dev Realtime.
 *
 * Обёртка над useRealtimeRun (@trigger.dev/react-hooks, канон skill
 * trigger-realtime): runId + publicAccessToken приходят из /api/ask (B7),
 * токен скоуплен на чтение ровно этого рана.
 *
 * Хук нормализует сырой ран в состояние для карточки прогресса:
 *   - steps     — история RunStep из metadata.steps (каждый элемент строго
 *                 валидируется runStepSchema; мусор молча пропускается —
 *                 лента не должна падать из-за кривого шага);
 *   - lastStep  — последний валидный шаг;
 *   - sqlPreview — последний sqlPreview из шагов reviewing/executing;
 *   - viewSpecs — из шага done (приходит прямо в Realtime-стриме) либо из
 *                 run.output — отдельный fetch результата не нужен;
 *   - phase     — connecting | running | done | failed (для рендера).
 */
import { useMemo } from "react";
import { useRealtimeRun } from "@trigger.dev/react-hooks";
import { runStepSchema, type RunStep, type ViewSpec } from "@/lib/contracts";
import type { investigateTask } from "@/trigger/investigate";

export type InvestigationPhase = "connecting" | "running" | "done" | "failed";

export type InvestigationRunState = {
  phase: InvestigationPhase;
  /** История шагов конвейера (строго по runStepSchema). */
  steps: RunStep[];
  lastStep: RunStep | undefined;
  /** Последнее превью SQL из шагов reviewing/executing. */
  sqlPreview: string | undefined;
  /** Результат: из шага done либо run.output. */
  viewSpecs: ViewSpec[] | undefined;
  /** Терминальная ошибка: шаг error, ошибка подписки или статус рана. */
  errorMessage: string | undefined;
  /** Сырой статус рана Trigger.dev (для отладочной подписи). */
  runStatus: string | undefined;
};

/** Терминальные статусы рана Trigger.dev, означающие неудачу. */
const FAILED_STATUSES = new Set([
  "FAILED",
  "CRASHED",
  "CANCELED",
  "SYSTEM_FAILURE",
  "TIMED_OUT",
  "EXPIRED",
]);

function parseSteps(raw: unknown): RunStep[] {
  if (!Array.isArray(raw)) return [];
  const steps: RunStep[] = [];
  for (const item of raw) {
    const parsed = runStepSchema.safeParse(item);
    if (parsed.success) steps.push(parsed.data);
  }
  return steps;
}

export function useInvestigationRun(
  runId: string | undefined,
  publicAccessToken: string | undefined,
): InvestigationRunState {
  const enabled = Boolean(runId && publicAccessToken);
  const { run, error } = useRealtimeRun<typeof investigateTask>(runId, {
    accessToken: publicAccessToken,
    enabled,
  });

  return useMemo<InvestigationRunState>(() => {
    const steps = parseSteps(run?.metadata?.steps);
    const lastStep = steps.at(-1);

    const sqlPreview = steps.reduce<string | undefined>(
      (acc, s) =>
        (s.step === "reviewing" || s.step === "executing") && s.sqlPreview
          ? s.sqlPreview
          : acc,
      undefined,
    );

    const doneStep = steps.find((s) => s.step === "done");
    const viewSpecs = doneStep?.viewSpecs ?? run?.output?.viewSpecs;

    const errorStep = steps.find((s) => s.step === "error");
    const status = run?.status;
    const failed =
      Boolean(errorStep) ||
      Boolean(error) ||
      (status !== undefined && FAILED_STATUSES.has(status));

    let phase: InvestigationPhase;
    if (failed) phase = "failed";
    else if (viewSpecs || status === "COMPLETED") phase = "done";
    else if (run) phase = "running";
    else phase = "connecting";

    const errorMessage = errorStep?.message ?? error?.message ??
      (failed ? `Ран завершился со статусом ${status}` : undefined);

    return {
      phase,
      steps,
      lastStep,
      sqlPreview,
      viewSpecs,
      errorMessage,
      runStatus: status,
    };
  }, [run, error]);
}
