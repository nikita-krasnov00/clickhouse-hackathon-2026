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
 *   - boardCards — манифест board_planned, спроецированный на card_ready/
 *                 card_failed по cardId (skeleton-сетка C2 рисуется сразу
 *                 по манифесту, карточки гидратируются на своих местах);
 *                 пусто, если board_planned не было — компонент фоллбечит
 *                 на viewSpecs, как раньше;
 *   - phase     — connecting | running | done | failed (для рендера).
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useRealtimeRun } from "@trigger.dev/react-hooks";
import { runStepSchema, type RunStep, type ViewKind, type ViewSpec } from "@/lib/contracts";
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

/**
 * Карточка манифеста board_planned, спроецированная на её прогресс:
 *   pending → скелет ещё ждёт card_ready/card_failed со своим cardId;
 *   ready   → скелет гидратируется в spec (+ sql, если карточка sql-based);
 *   failed  → скелет схлопывается в компактную карточку ошибки.
 * Внеплановые card_ready без cardId (или без совпадения в манифесте) тоже
 * приходят как ready — см. computeBoardCards.
 */
export type BoardCard =
  | { cardId: string; kind: ViewKind; title: string; status: "pending" }
  | {
      cardId: string;
      kind: ViewKind;
      title: string;
      status: "ready";
      spec: ViewSpec;
      sql?: string;
    }
  | { cardId: string; kind: ViewKind; title: string; status: "failed"; error: string };

export type InvestigationRunState = {
  phase: InvestigationPhase;
  /** История шагов конвейера (строго по runStepSchema). */
  steps: RunStep[];
  lastStep: RunStep | undefined;
  /**
   * Карточки в порядке готовности: из шагов card_ready ещё ВО ВРЕМЯ рана
   * (прогрессивная загрузка); фоллбек для старых ранов — done/run.output.
   */
  viewSpecs: ViewSpec[] | undefined;
  /**
   * Карточки в порядке манифеста board_planned (см. BoardCard); пусто, если
   * манифеста не было вовсе — тогда рендер идёт по viewSpecs.
   */
  boardCards: BoardCard[];
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

/** Заголовок внеплановой карточки: verdict особый — в спеке нет поля title. */
function specBoardTitle(spec: ViewSpec, verdictTitle: string): string {
  return spec.kind === "verdict" ? verdictTitle : spec.title;
}

/**
 * Собирает boardCards: манифест board_planned (порядок сохраняется) со
 * статусом каждой карточки, обновлённым по card_ready/card_failed с её
 * cardId. card_ready/card_failed без совпадения в манифесте (или когда
 * манифеста не было вовсе) не теряются — card_ready уходит в хвост как
 * готовая внеплановая карточка, card_failed без пары в манифесте отбрасывается
 * (её скелету всё равно неоткуда взяться).
 */
function computeBoardCards(steps: RunStep[], verdictTitle: string): BoardCard[] {
  const plan = steps.find((s) => s.step === "board_planned");
  if (!plan) return [];

  const byId = new Map<string, BoardCard>(
    plan.cards.map((c) => [
      c.cardId,
      { cardId: c.cardId, kind: c.kind, title: c.title, status: "pending" as const },
    ]),
  );
  const extra: BoardCard[] = [];

  for (const s of steps) {
    if (s.step === "card_ready") {
      const known = s.cardId ? byId.get(s.cardId) : undefined;
      if (known) {
        byId.set(known.cardId, {
          cardId: known.cardId,
          kind: known.kind,
          title: known.title,
          status: "ready",
          spec: s.viewSpec,
          sql: s.sql,
        });
      } else {
        extra.push({
          cardId: s.cardId ?? `extra-${extra.length}`,
          kind: s.viewSpec.kind,
          title: specBoardTitle(s.viewSpec, verdictTitle),
          status: "ready",
          spec: s.viewSpec,
          sql: s.sql,
        });
      }
    } else if (s.step === "card_failed" && s.cardId) {
      const known = byId.get(s.cardId);
      if (known) {
        byId.set(known.cardId, {
          cardId: known.cardId,
          kind: known.kind,
          title: known.title,
          status: "failed",
          error: s.error,
        });
      }
    }
  }

  return [...plan.cards.map((c) => byId.get(c.cardId)!), ...extra];
}

export function useInvestigationRun(
  runId: string | undefined,
  publicAccessToken: string | undefined,
): InvestigationRunState {
  const tRun = useTranslations("run");
  const tCommon = useTranslations("common");
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

    // Прогрессивная загрузка: карточки появляются по мере card_ready, не
    // дожидаясь done. done/output — фоллбек (старые раны, потерянный стрим).
    const readySpecs = steps
      .filter((s) => s.step === "card_ready")
      .map((s) => s.viewSpec);
    const doneStep = steps.find((s) => s.step === "done");
    const finalSpecs = doneStep?.viewSpecs ?? output?.viewSpecs;
    const viewSpecs =
      readySpecs.length > 0
        ? finalSpecs && finalSpecs.length > readySpecs.length
          ? finalSpecs
          : readySpecs
        : finalSpecs;

    const boardCards = computeBoardCards(steps, tCommon("verdictTitle"));

    const errorStep = steps.find((s) => s.step === "error");
    const failed =
      Boolean(errorStep) ||
      Boolean(error) ||
      (status !== undefined && FAILED_STATUSES.has(status));

    let phase: InvestigationPhase;
    if (failed) phase = "failed";
    else if (doneStep || finalSpecs || status === "COMPLETED") phase = "done";
    else if (run || polled) phase = "running";
    else phase = "connecting";

    const errorMessage = errorStep?.message ?? error?.message ??
      (failed ? tRun("failedStatus", { status: String(status) }) : undefined);

    return {
      phase,
      steps,
      lastStep,
      viewSpecs,
      boardCards,
      errorMessage,
      runStatus: status,
    };
  }, [run, error, polled, realtimeSteps, tRun, tCommon]);
}
