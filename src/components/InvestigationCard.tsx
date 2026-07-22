"use client";

/**
 * C2 — карточка расследования одного рана investigate.
 *
 * Вопрос → подписка useRealtimeRun (через useInvestigationRun) → живой
 * прогресс конвейера (RunProgress) → карточки данных, в зависимости от того,
 * как сложился ран:
 *   - board_planned → сетка BoardGrid: скелеты по манифесту, гидратирующиеся
 *                      в ViewSpecCard по мере card_ready/card_failed;
 *   - clarify        → ClarifyCard: агенту не хватило вводных, ран завершён;
 *   - impossible      → ImpossibleCard: по данным ответить нельзя, ран завершён;
 *   - иначе (старые/потерянные стримы без манифеста) → фоллбек на viewSpecs,
 *     как раньше.
 * done остаётся сворачивающим прогресс в details «как я это делал»; error —
 * фоллбек «не смог — вот что пробовал»: список попыток healing, финальное
 * сообщение и последний SQL — не пустой экран.
 *
 * Если /api/ask вернул ошибку (runId нет) — карточка сразу в failed.
 */
import { useTranslations } from "next-intl";
import type { RunStep, ViewSpec } from "@/lib/contracts";
import { useElapsedSeconds } from "@/lib/hooks/useElapsedSeconds";
import {
  useInvestigationRun,
  type InvestigationRunState,
} from "@/lib/hooks/useInvestigationRun";
import { RunProgress } from "@/components/RunProgress";
import { BoardGrid } from "@/components/BoardGrid";
import { ClarifyCard } from "@/components/ClarifyCard";
import { ImpossibleCard } from "@/components/ImpossibleCard";
import {
  ViewSpecCard,
  type SpecClickHandler,
} from "@/components/viewspec/ViewSpecCard";

export type Investigation = {
  /** Локальный id карточки в ленте (не runId). */
  id: string;
  question: string;
  /** Момент отправки вопроса — от него считается секундомер. */
  askedAt: number;
  runId?: string;
  publicAccessToken?: string;
  /** Ошибка /api/ask — ран не создан. */
  askError?: string;
};

/** Стили бейджа фазы; подписи — в messages (run.connecting и т.д.). */
const PHASE_BADGE: Record<
  InvestigationRunState["phase"],
  { className: string; style?: React.CSSProperties }
> = {
  connecting: { className: "border-border text-muted" },
  running: { className: "animate-pulse border-accent/60 text-accent" },
  done: { className: "border-border", style: { color: "var(--viz-good)" } },
  failed: {
    className: "border-border",
    style: { color: "var(--viz-critical)" },
  },
};

/** Фоллбек терминальной неудачи: «не смог — вот что пробовал». */
export function FailedFallback({
  state,
  askError,
}: {
  state: InvestigationRunState;
  askError?: string;
}) {
  const t = useTranslations("run");
  const healingSteps = state.steps.filter((s) => s.step === "healing");
  return (
    <div
      className="mt-3 rounded-lg border border-dashed p-3"
      style={{ borderColor: "var(--viz-anomaly-edge)" }}
    >
      <p className="text-sm font-medium" style={{ color: "var(--viz-critical)" }}>
        {t("failedTitle")}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        {askError ?? state.errorMessage ?? t("failedDefault")}
      </p>
      {healingSteps.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {healingSteps.map((s, i) => (
            <li key={i} className="font-mono text-[10px] leading-relaxed text-muted">
              <span style={{ color: "var(--viz-warning)" }}>
                {t("attempt", { attempt: s.attempt })}
              </span>
              {s.error ? ` — ${s.error.length > 200 ? `${s.error.slice(0, 200)}…` : s.error}` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function InvestigationCard({
  investigation,
  onClickContext,
  onAsk,
}: {
  investigation: Investigation;
  onClickContext?: SpecClickHandler;
  /** C2: клик по чипу clarify/impossible — новый ран тем же submit-флоу Workbench. */
  onAsk?: (question: string) => void;
}) {
  const t = useTranslations("run");
  const { id, question, askedAt, runId, publicAccessToken, askError } = investigation;
  const state = useInvestigationRun(runId, publicAccessToken);

  // Ошибка /api/ask — рана нет, карточка сразу терминальная.
  const phase = askError ? "failed" : state.phase;
  const isLive = phase === "connecting" || phase === "running";
  const elapsed = useElapsedSeconds(askedAt, isLive);
  const badge = PHASE_BADGE[phase];

  // Два ранних терминальных исхода — взаимоисключающи и исключают board_planned.
  const clarifyStep = state.steps.find(
    (s): s is Extract<RunStep, { step: "clarify" }> => s.step === "clarify",
  );
  const impossibleStep = state.steps.find(
    (s): s is Extract<RunStep, { step: "impossible" }> => s.step === "impossible",
  );

  return (
    <article
      className={`rounded-xl border bg-surface p-4 ${
        isLive ? "border-accent/30" : "border-border"
      }`}
    >
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="min-w-0 text-sm font-medium tracking-tight break-words">
          {question}
        </h2>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] ${badge.className}`}
          style={badge.style}
        >
          {t(phase)} · {t("elapsed", { seconds: elapsed })}
        </span>
      </header>
      {runId && (
        <p className="mt-0.5 font-mono text-[10px] text-muted">
          {runId}
          {state.runStatus ? ` · ${state.runStatus}` : ""}
        </p>
      )}

      {/* Прогресс конвейера: живой — развёрнут; done — свёрнут в details. */}
      {!askError && phase !== "done" && (
        <div className="mt-3">
          <RunProgress steps={state.steps} phase={phase} />
        </div>
      )}
      {!askError && phase === "done" && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] text-muted select-none hover:text-foreground">
            {t("howIDidIt", { count: state.steps.length, seconds: elapsed })}
          </summary>
          <div className="mt-2">
            <RunProgress steps={state.steps} phase={phase} />
          </div>
        </details>
      )}

      {phase === "failed" && <FailedFallback state={state} askError={askError} />}

      {/* clarify/impossible — ранние терминальные исходы, до board_planned. */}
      {!askError && clarifyStep && (
        <ClarifyCard step={clarifyStep} originalQuestion={question} onAsk={onAsk} />
      )}
      {!askError && !clarifyStep && impossibleStep && (
        <ImpossibleCard step={impossibleStep} onAsk={onAsk} />
      )}

      {/* Манифест есть — сетка скелетов/карточек на его местах (C2). */}
      {!askError && !clarifyStep && !impossibleStep && state.boardCards.length > 0 && (
        <BoardGrid cards={state.boardCards} onClickContext={onClickContext} />
      )}

      {/* Манифеста не было (старые/потерянные стримы) — как раньше, по viewSpecs. */}
      {!askError &&
        !clarifyStep &&
        !impossibleStep &&
        state.boardCards.length === 0 &&
        state.viewSpecs &&
        state.viewSpecs.length > 0 && (
          <div className="mt-3 flex flex-col gap-3">
            {state.viewSpecs.map((spec: ViewSpec, i: number) => (
              <ViewSpecCard
                key={`${id}-spec-${i}`}
                cardId={`${id}-spec-${i}`}
                spec={spec}
                onClickContext={onClickContext}
              />
            ))}
          </div>
        )}
    </article>
  );
}
