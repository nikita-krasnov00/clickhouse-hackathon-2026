"use client";

/**
 * ClarifyCard (C2) — терминальный шаг clarify: агенту не хватило вводных.
 *
 * Показывает вопрос агента, чипы options (если есть) и поле свободного
 * ответа. Выбор чипа или сабмит поля запускают НОВЫЙ ран через тот же
 * submit-флоу Workbench (проп onAsk, прокинутый из Workbench в
 * InvestigationCard) — итоговый текст:
 *   `${исходный вопрос}\n\nУточнение: ${ответ}`
 * без ClickContext — это обычный вопрос, не клик по элементу карточки.
 */
import { useState } from "react";
import { useTranslations } from "next-intl";
import type { RunStep } from "@/lib/contracts";

type ClarifyStep = Extract<RunStep, { step: "clarify" }>;

export function ClarifyCard({
  step,
  originalQuestion,
  onAsk,
}: {
  step: ClarifyStep;
  /** Вопрос расследования, к которому агент просит уточнение. */
  originalQuestion: string;
  onAsk?: (question: string) => void;
}) {
  const t = useTranslations("clarify");
  const tSteps = useTranslations("steps");
  const [answer, setAnswer] = useState("");

  const ask = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || !onAsk) return;
    onAsk(t("followUp", { question: originalQuestion, answer: trimmed }));
  };

  return (
    <div
      className="mt-3 rounded-lg border border-accent/40 bg-background/40 p-3"
      style={{ boxShadow: "0 0 24px rgba(242,176,53,0.06)" }}
    >
      <p className="text-xs font-medium tracking-wide text-accent uppercase">
        {tSteps("clarify")}
      </p>
      <p className="mt-1 text-sm leading-relaxed font-medium">{step.question}</p>

      {step.options && step.options.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {step.options.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => ask(opt)}
              disabled={!onAsk}
              className="rounded-full border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:border-accent/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {opt}
            </button>
          ))}
        </div>
      )}

      <form
        className="mt-2.5 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          ask(answer);
          setAnswer("");
        }}
      >
        <input
          type="text"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder={t("placeholder")}
          className="flex-1 rounded-lg border border-border bg-transparent px-2.5 py-1.5 text-xs outline-none placeholder:text-muted focus:border-accent/50"
        />
        <button
          type="submit"
          disabled={!answer.trim() || !onAsk}
          className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-background transition-opacity disabled:opacity-50"
        >
          {t("submit")}
        </button>
      </form>
    </div>
  );
}
