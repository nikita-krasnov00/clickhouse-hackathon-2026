"use client";

/**
 * C2 — investigation card for a single investigate run.
 *
 * Question → useRealtimeRun subscription (via useInvestigationRun) → live pipeline
 * progress (RunProgress) → data cards depending on how the run ended:
 *   - board_planned → BoardGrid: skeletons from manifest, hydrating into
 *                      ViewSpecCard as card_ready/card_failed arrive;
 *   - clarify        → ClarifyCard: agent lacked input, run finished;
 *   - impossible      → ImpossibleCard: cannot answer from data, run finished;
 *   - otherwise (old/lost streams without manifest) → fallback to viewSpecs,
 *     as before.
 * done keeps progress collapsible in details "how I did it"; error —
 * fallback "couldn't finish — here's what I tried": healing attempts list,
 * final message and last SQL — not a blank screen.
 *
 * If /api/ask returned an error (no runId) — card is immediately failed.
 */
import {
  detectAnswerLanguage,
  type AnswerLanguage,
  type RunStep,
  type ViewSpec,
} from "@/lib/contracts";
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
  /** Local card id in the feed (not runId). */
  id: string;
  question: string;
  /** Moment the question was sent — stopwatch counts from here. */
  askedAt: number;
  runId?: string;
  publicAccessToken?: string;
  /** /api/ask error — run was not created. */
  askError?: string;
};

/** Phase badge style — independent of language. */
const PHASE_BADGE: Record<
  InvestigationRunState["phase"],
  { className: string; style?: React.CSSProperties }
> = {
  connecting: { className: "border-border text-muted" },
  running: { className: "animate-pulse border-accent/60 text-accent" },
  done: { className: "border-border", style: { color: "var(--viz-good)" } },
  failed: { className: "border-border", style: { color: "var(--viz-critical)" } },
};

/** Phase badge label in the run's language. */
const PHASE_LABEL: Record<AnswerLanguage, Record<InvestigationRunState["phase"], string>> = {
  Russian: {
    connecting: "запускаю",
    running: "расследую",
    done: "готово",
    failed: "не смог",
  },
  English: {
    connecting: "starting",
    running: "investigating",
    done: "done",
    failed: "failed",
  },
};

/** Terminal failure fallback: "couldn't finish — here's what I tried". */
export function FailedFallback({
  state,
  askError,
  language,
}: {
  state: InvestigationRunState;
  askError?: string;
  language: AnswerLanguage;
}) {
  const ru = language === "Russian";
  const healingSteps = state.steps.filter((s) => s.step === "healing");
  return (
    <div
      className="mt-3 rounded-lg border border-dashed p-3"
      style={{ borderColor: "var(--viz-anomaly-edge)" }}
    >
      <p className="text-sm font-medium" style={{ color: "var(--viz-critical)" }}>
        {ru ? "Не смог довести расследование" : "Couldn't finish the investigation"}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        {askError ??
          state.errorMessage ??
          (ru ? "Ран завершился неудачей." : "The run failed.")}
      </p>
      {healingSteps.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {healingSteps.map((s, i) => (
            <li key={i} className="font-mono text-[10px] leading-relaxed text-muted">
              <span style={{ color: "var(--viz-warning)" }}>
                {ru ? "попытка" : "attempt"} {s.attempt}/3
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
  /** C2: clarify/impossible chip click — new run via same Workbench submit flow. */
  onAsk?: (question: string) => void;
}) {
  const { id, question, askedAt, runId, publicAccessToken, askError } = investigation;
  const state = useInvestigationRun(runId, publicAccessToken);

  // Run language — from question text, same signal that drives the answer.
  // Reasoning (feed, badges, wrappers) speaks the answer language.
  const language = detectAnswerLanguage(question);

  // /api/ask error — no run, card is immediately terminal.
  const phase = askError ? "failed" : state.phase;
  const isLive = phase === "connecting" || phase === "running";
  const elapsed = useElapsedSeconds(askedAt, isLive);
  const badge = PHASE_BADGE[phase];

  // Two early terminal outcomes — mutually exclusive and exclude board_planned.
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
          {PHASE_LABEL[language][phase]} · {elapsed}
          {language === "Russian" ? " с" : "s"}
        </span>
      </header>
      {runId && (
        <p className="mt-0.5 font-mono text-[10px] text-muted">
          {runId}
          {state.runStatus ? ` · ${state.runStatus}` : ""}
        </p>
      )}

      {/* Pipeline progress: live — expanded; done — collapsed in details. */}
      {!askError && phase !== "done" && (
        <div className="mt-3">
          <RunProgress steps={state.steps} phase={phase} language={language} />
        </div>
      )}
      {!askError && phase === "done" && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] text-muted select-none hover:text-foreground">
            {language === "Russian" ? "Как я это делал" : "How I did it"} —{" "}
            {state.steps.length} {stepsNoun(state.steps.length, language)} · {elapsed}
            {language === "Russian" ? " с" : "s"}
          </summary>
          <div className="mt-2">
            <RunProgress steps={state.steps} phase={phase} language={language} />
          </div>
        </details>
      )}

      {phase === "failed" && (
        <FailedFallback state={state} askError={askError} language={language} />
      )}

      {/* clarify/impossible — early terminal outcomes, before board_planned. */}
      {!askError && clarifyStep && (
        <ClarifyCard
          step={clarifyStep}
          originalQuestion={question}
          onAsk={onAsk}
          language={language}
        />
      )}
      {!askError && !clarifyStep && impossibleStep && (
        <ImpossibleCard step={impossibleStep} onAsk={onAsk} language={language} />
      )}

      {/* Manifest present — skeleton/card grid in manifest slots (C2). */}
      {!askError && !clarifyStep && !impossibleStep && state.boardCards.length > 0 && (
        <BoardGrid cards={state.boardCards} onClickContext={onClickContext} />
      )}

      {/* No manifest (old/lost streams) — as before, from viewSpecs. */}
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

function stepsNoun(n: number, language: AnswerLanguage): string {
  if (language === "English") return n === 1 ? "step" : "steps";
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "шаг";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "шага";
  return "шагов";
}
