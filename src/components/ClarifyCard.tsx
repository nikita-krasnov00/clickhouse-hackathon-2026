"use client";

/**
 * ClarifyCard (C2) — terminal clarify step: the agent lacked input.
 *
 * Shows the agent's question, option chips (if any), and a free-text answer field.
 * Choosing a chip or submitting the field starts a NEW run via the same Workbench
 * submit flow (onAsk prop forwarded from Workbench to InvestigationCard) — final text:
 *   `${original question}\n\nClarification: ${answer}`
 * without ClickContext — this is a plain question, not a card element click.
 */
import { useState } from "react";
import { runStepLabel, type AnswerLanguage, type RunStep } from "@/lib/contracts";

type ClarifyStep = Extract<RunStep, { step: "clarify" }>;

export function ClarifyCard({
  step,
  originalQuestion,
  onAsk,
  language,
}: {
  step: ClarifyStep;
  /** Investigation question the agent is asking to clarify. */
  originalQuestion: string;
  onAsk?: (question: string) => void;
  language: AnswerLanguage;
}) {
  const [answer, setAnswer] = useState("");
  const ru = language === "Russian";

  const ask = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || !onAsk) return;
    onAsk(`${originalQuestion}\n\n${ru ? "Уточнение" : "Clarification"}: ${trimmed}`);
  };

  return (
    <div
      className="mt-3 rounded-lg border border-accent/40 bg-background/40 p-3"
      style={{ boxShadow: "0 0 24px rgba(242,176,53,0.06)" }}
    >
      <p className="text-xs font-medium tracking-wide text-accent uppercase">
        {runStepLabel("clarify", language)}
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
          placeholder={ru ? "Свой ответ…" : "Your answer…"}
          className="flex-1 rounded-lg border border-border bg-transparent px-2.5 py-1.5 text-xs outline-none placeholder:text-muted focus:border-accent/50"
        />
        <button
          type="submit"
          disabled={!answer.trim() || !onAsk}
          className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-background transition-opacity disabled:opacity-50"
        >
          {ru ? "Ответить" : "Answer"}
        </button>
      </form>
    </div>
  );
}
