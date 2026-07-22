"use client";

/**
 * C2 — visible investigate pipeline progress.
 *
 * RunStep timeline with RUN_STEP_LABELS ("Exploring schema → Planning queries →
 * Executing…"): completed steps — checkmark, current — spinner and "thinking"
 * dots (LLM thinks 5–30 s — wait is animated, not a dead screen), healing —
 * prominent yellow step with attempt number and error text, error — red. SQL
 * samples are shown IN THE STEPS THEMSELVES: executing / reviewing / card_ready
 * carry sqlPreview|sql — collapsible monospace block under the step; board_planned
 * lists planned cards.
 */
import { runStepLabel, type AnswerLanguage, type RunStep } from "@/lib/contracts";
import type { InvestigationPhase } from "@/lib/hooks/useInvestigationRun";

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block size-3.5 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent"
    />
  );
}

/** Three "thinking" dots — wait animation on the active step. */
function ThinkingDots() {
  return (
    <span aria-hidden className="ml-1 inline-flex gap-0.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1 animate-bounce rounded-full bg-accent/70"
          style={{ animationDelay: `${i * 150}ms` }}
        />
      ))}
    </span>
  );
}

function truncate(text: string, max = 220): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function StepIcon({ step, isActive }: { step: RunStep; isActive: boolean }) {
  if (isActive) return <Spinner />;
  const base =
    "inline-flex size-3.5 shrink-0 items-center justify-center rounded-full text-[9px] leading-none";
  switch (step.step) {
    case "error":
      return (
        <span
          className={base}
          style={{ background: "var(--viz-anomaly-fill)", color: "var(--viz-critical)" }}
        >
          ✕
        </span>
      );
    case "healing":
      return (
        <span
          className={base}
          style={{ background: "rgba(250,178,25,0.12)", color: "var(--viz-warning)" }}
        >
          ↻
        </span>
      );
    default:
      return (
        <span
          className={base}
          style={{ background: "rgba(12,163,12,0.12)", color: "var(--viz-good)" }}
        >
          ✓
        </span>
      );
  }
}

/** Step SQL sample: collapsible monospace block directly under the step. */
function StepSql({ sql, open }: { sql: string; open?: boolean }) {
  const firstLine = sql.replace(/\s+/g, " ").trim();
  return (
    <details
      className="mt-1 rounded-md border border-border bg-background/60"
      open={open}
    >
      <summary className="cursor-pointer truncate px-2 py-1 font-mono text-[10px] text-muted select-none hover:text-foreground">
        SQL · {truncate(firstLine, 80)}
      </summary>
      <pre className="max-h-48 overflow-auto border-t border-border px-2 py-1.5 font-mono text-[10px] leading-relaxed whitespace-pre">
        {sql}
      </pre>
    </details>
  );
}

function StepRow({
  step,
  isActive,
  language,
}: {
  step: RunStep;
  isActive: boolean;
  language: AnswerLanguage;
}) {
  const label = runStepLabel(step.step, language);
  const isHealing = step.step === "healing";
  const isError = step.step === "error";
  // Step SQL sample: executing/reviewing carry sqlPreview, card_ready — sql.
  const stepSql =
    step.step === "executing" || step.step === "reviewing"
      ? step.sqlPreview
      : step.step === "card_ready"
        ? step.sql
        : undefined;

  return (
    <li className="flex items-start gap-2 text-xs">
      <span className="mt-0.5 flex items-center">
        <StepIcon step={step} isActive={isActive} />
      </span>
      <div className="min-w-0 flex-1">
        <p
          className={isActive ? "text-foreground" : isError ? "" : isHealing ? "" : "text-muted"}
          style={
            isError
              ? { color: "var(--viz-critical)" }
              : isHealing
                ? { color: "var(--viz-warning)" }
                : undefined
          }
        >
          <span className={isActive ? "font-medium" : ""}>{label}</span>
          {isHealing && (
            <span
              className="ml-1.5 rounded-full px-1.5 py-px font-mono text-[10px]"
              style={{
                background: "rgba(250,178,25,0.12)",
                color: "var(--viz-warning)",
              }}
            >
              {language === "Russian" ? "попытка" : "attempt"} {step.attempt}/3
            </span>
          )}
          {step.step === "materializing" && step.table && (
            <span className="ml-1.5 font-mono text-[10px] text-muted">
              {step.table}
            </span>
          )}
          {isActive && <ThinkingDots />}
        </p>
        {isHealing && step.error && (
          <p
            className="mt-0.5 font-mono text-[10px] leading-relaxed break-words"
            style={{ color: "var(--viz-warning)", opacity: 0.85 }}
            title={step.error}
          >
            {truncate(step.error)}
          </p>
        )}
        {step.step === "error" && (
          <p className="mt-0.5 text-[10px] leading-relaxed break-words text-muted">
            {truncate(step.message, 400)}
          </p>
        )}
        {step.step !== "error" && !isHealing && step.message && (
          <p className="mt-0.5 text-[10px] text-muted">{truncate(step.message)}</p>
        )}
        {/* Dashboard plan: which cards of which kinds. */}
        {step.step === "board_planned" && step.cards.length > 0 && (
          <ul className="mt-1 flex flex-col gap-0.5">
            {step.cards.map((c) => (
              <li
                key={c.cardId}
                className="flex items-baseline gap-1.5 text-[10px] text-muted"
              >
                <span className="font-mono text-accent/80">{c.kind}</span>
                <span className="truncate">{c.title}</span>
              </li>
            ))}
          </ul>
        )}
        {stepSql && <StepSql sql={stepSql} open={isActive} />}
      </div>
    </li>
  );
}

export function RunProgress({
  steps,
  phase,
  language,
}: {
  steps: RunStep[];
  phase: InvestigationPhase;
  language: AnswerLanguage;
}) {
  const isLive = phase === "connecting" || phase === "running";

  return (
    <ol className="flex flex-col gap-1.5">
      {steps.length === 0 && (
        <li className="flex items-center gap-2 text-xs text-muted">
          <Spinner />
          <span>
            {language === "Russian" ? "Запускаю конвейер" : "Starting the pipeline"}
            <ThinkingDots />
          </span>
        </li>
      )}
      {steps.map((step, i) => (
        <StepRow
          key={i}
          step={step}
          isActive={isLive && i === steps.length - 1}
          language={language}
        />
      ))}
    </ol>
  );
}
