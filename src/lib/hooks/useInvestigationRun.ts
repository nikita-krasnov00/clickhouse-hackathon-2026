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
import { useEffect, useMemo, useState } from "react";
import { useRealtimeRun } from "@trigger.dev/react-hooks";
import { runStepSchema, type RunStep, type ViewSpec } from "@/lib/contracts";
import type { investigateTask } from "@/trigger/investigate";

/**
 * Поллинг-фоллбек (риск из PLAN.md: «Realtime не завёлся — деградация до
 * поллинга»): параллельно подписке опрашиваем /api/run-status и берём самое
 * информативное состояние (больше шагов / терминальный статус). Когда Realtime
 * работает, он всегда впереди и поллинг ничего не меняет.
 */
type PolledRun = {
  status?: string;
  metadata?: { steps?: unknown } | null;
  output?: { viewSpecs?: ViewSpec[] } | null;
};

const POLL_INTERVAL_MS = 3000;

function usePolledRun(runId: string | undefined, active: boolean): PolledRun | undefined {
  const [polled, setPolled] = useState<PolledRun | undefined>(undefined);
  useEffect(() => {
    if (!runId || !active) return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/run-status?runId=${encodeURIComponent(runId)}`);
        if (!res.ok) return;
        const body = (await res.json()) as PolledRun;
        if (!stop) setPolled(body);
      } catch {
        // сеть мигнула — следующий тик попробует снова
      }
    };
    void tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [runId, active]);
  return polled;
}

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

  // Поллинг активен, пока ран не терминален ни по одному из источников.
  const realtimeSteps = useMemo(() => parseSteps(run?.metadata?.steps), [run]);
  const realtimeTerminal =
    (run?.status !== undefined &&
      (run.status === "COMPLETED" || FAILED_STATUSES.has(run.status))) ||
    realtimeSteps.some((s) => s.step === "done" || s.step === "error");
  const polled = usePolledRun(runId, enabled && !realtimeTerminal);

  return useMemo<InvestigationRunState>(() => {
    // Самый информативный источник: у кого больше валидных шагов, тот и прав.
    const polledSteps = parseSteps(polled?.metadata?.steps);
    const usePolled = polledSteps.length > realtimeSteps.length;
    const steps = usePolled ? polledSteps : realtimeSteps;
    const status = run?.status ?? polled?.status;
    const output = run?.output ?? polled?.output ?? undefined;
    const lastStep = steps.at(-1);

    const sqlPreview = steps.reduce<string | undefined>(
      (acc, s) =>
        (s.step === "reviewing" || s.step === "executing") && s.sqlPreview
          ? s.sqlPreview
          : acc,
      undefined,
    );

    const doneStep = steps.find((s) => s.step === "done");
    const viewSpecs = doneStep?.viewSpecs ?? output?.viewSpecs;

    const errorStep = steps.find((s) => s.step === "error");
    const failed =
      Boolean(errorStep) ||
      Boolean(error) ||
      (status !== undefined && FAILED_STATUSES.has(status));

    let phase: InvestigationPhase;
    if (failed) phase = "failed";
    else if (viewSpecs || status === "COMPLETED") phase = "done";
    else if (run || polled) phase = "running";
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
  }, [run, error, polled, realtimeSteps]);
}
