"use client";

/**
 * ImpossibleCard (C2) — терминальный шаг impossible: по данным в ClickHouse
 * на вопрос ответить нельзя.
 *
 * Честная карточка: reason крупно — что именно не так; ниже, если агент
 * прислал available, — «А вот что по этим данным спросить можно» кликабельными
 * чипами. Клик сразу задаёт этот вопрос новым раном (проп onAsk из Workbench,
 * тот же путь, что и у чипов-примеров в композере) — available это уже готовые
 * вопросы, а не уточнение, поэтому текст уходит как есть, без склейки.
 */
import { RUN_STEP_LABELS, type RunStep } from "@/lib/contracts";

type ImpossibleStep = Extract<RunStep, { step: "impossible" }>;

export function ImpossibleCard({
  step,
  onAsk,
}: {
  step: ImpossibleStep;
  onAsk?: (question: string) => void;
}) {
  return (
    <div
      className="mt-3 rounded-lg border border-dashed p-3"
      style={{ borderColor: "var(--viz-anomaly-edge)" }}
    >
      <p className="text-xs font-medium tracking-wide uppercase" style={{ color: "var(--viz-warning)" }}>
        {RUN_STEP_LABELS.impossible}
      </p>
      <p className="mt-1 text-sm leading-relaxed font-medium">{step.reason}</p>

      {step.available && step.available.length > 0 && (
        <>
          <p className="mt-2.5 text-xs text-muted">
            А вот что по этим данным спросить можно:
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
