"use client";

/**
 * ImpossibleCard (C2) — terminal impossible step: the question cannot be answered
 * from the data in ClickHouse.
 *
 * Honest card: reason prominently — what's wrong; below, if the agent sent
 * available, — "Here's what you can ask about this data" as clickable chips.
 * Click immediately asks that question as a new run (onAsk prop from Workbench,
 * same path as example chips in the composer) — available are ready-made questions,
 * not clarification, so the text is sent as-is without concatenation.
 */
import { runStepLabel, type AnswerLanguage, type RunStep } from "@/lib/contracts";

type ImpossibleStep = Extract<RunStep, { step: "impossible" }>;

export function ImpossibleCard({
  step,
  onAsk,
  language,
}: {
  step: ImpossibleStep;
  onAsk?: (question: string) => void;
  language: AnswerLanguage;
}) {
  return (
    <div
      className="mt-3 rounded-lg border border-dashed p-3"
      style={{ borderColor: "var(--viz-anomaly-edge)" }}
    >
      <p className="text-xs font-medium tracking-wide uppercase" style={{ color: "var(--viz-warning)" }}>
        {runStepLabel("impossible", language)}
      </p>
      <p className="mt-1 text-sm leading-relaxed font-medium">{step.reason}</p>

      {step.available && step.available.length > 0 && (
        <>
          <p className="mt-2.5 text-xs text-muted">
            {language === "Russian"
              ? "А вот что по этим данным спросить можно:"
              : "But here's what you can ask about this data:"}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {step.available.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => onAsk?.(q)}
                disabled={!onAsk}
                className="rounded-full border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:border-accent/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                {q}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
