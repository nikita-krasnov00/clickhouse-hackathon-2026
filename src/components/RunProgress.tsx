"use client";

/**
 * C2 — видимый прогресс конвейера investigate.
 *
 * Таймлайн шагов RunStep с подписями RUN_STEP_LABELS («Изучаю схему → Пишу
 * SQL → Выполняю…»): пройденные шаги — галочка, текущий — спиннер и
 * «думающие» точки (LLM думает 5–30 с — ожидание анимировано, не мёртвый
 * экран), healing — заметный жёлтый шаг с номером попытки и текстом ошибки,
 * error — красный. Ниже — сворачиваемое моноширинное превью SQL из
 * sqlPreview шагов reviewing/executing.
 */
import { RUN_STEP_LABELS, type RunStep } from "@/lib/contracts";
import type { InvestigationPhase } from "@/lib/hooks/useInvestigationRun";

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block size-3.5 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent"
    />
  );
}

/** Три «думающие» точки — анимация ожидания у активного шага. */
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

function StepRow({ step, isActive }: { step: RunStep; isActive: boolean }) {
  const label = RUN_STEP_LABELS[step.step];
  const isHealing = step.step === "healing";
  const isError = step.step === "error";

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
              попытка {step.attempt}/3
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
      </div>
    </li>
  );
}

export function RunProgress({
  steps,
  phase,
  sqlPreview,
}: {
  steps: RunStep[];
  phase: InvestigationPhase;
  sqlPreview: string | undefined;
}) {
  const isLive = phase === "connecting" || phase === "running";

  return (
    <div>
      <ol className="flex flex-col gap-1.5">
        {steps.length === 0 && (
          <li className="flex items-center gap-2 text-xs text-muted">
            <Spinner />
            <span>
              Запускаю конвейер
              <ThinkingDots />
            </span>
          </li>
        )}
        {steps.map((step, i) => (
          <StepRow
            key={i}
            step={step}
            isActive={isLive && i === steps.length - 1}
          />
        ))}
      </ol>

      {sqlPreview && (
        <details className="mt-2.5 rounded-lg border border-border bg-background/60" open>
          <summary className="cursor-pointer px-2.5 py-1.5 font-mono text-[10px] text-muted select-none hover:text-foreground">
            SQL
          </summary>
          <pre className="max-h-56 overflow-auto border-t border-border px-2.5 py-2 font-mono text-[10px] leading-relaxed whitespace-pre">
            {sqlPreview}
          </pre>
        </details>
      )}
    </div>
  );
}
