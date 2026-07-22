"use client";

/**
 * C2/C6 — live workbench: composer + feed of investigation cards.
 *
 * Question (Enter or button) → POST /api/ask → InvestigationCard with
 * Realtime subscription. Click on a card element (C6) — always a new agent run
 * (action 'why') with ClickContext: no dataset-specific drills; the next layer
 * is uncovered by the agent itself. Click on a clarify/impossible chip inside
 * the card (C2) — also a new run, but as a plain question without context.
 *
 * Composer presets — not hardcoded: on mount GET /api/suggest fetches questions
 * generated from the live ClickHouse table catalog. Empty or error — preset
 * block is simply not rendered (suggestResponseSchema is valid with an empty
 * array too).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  askResponseSchema,
  suggestResponseSchema,
  type ClickContext,
  type ViewSpec,
} from "@/lib/contracts";
import {
  InvestigationCard,
  type Investigation,
} from "@/components/InvestigationCard";

/** /api/suggest presets: null — still loading, [] — empty/error (block hidden). */
function usePresetQuestions(): string[] | null {
  const [presets, setPresets] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/suggest");
        const body: unknown = await res.json().catch(() => null);
        const parsed = suggestResponseSchema.safeParse(body);
        if (!cancelled) setPresets(parsed.success ? parsed.data.questions : []);
      } catch {
        if (!cancelled) setPresets([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return presets;
}

async function askApi(
  question: string,
  context?: ClickContext,
): Promise<{ runId: string; publicAccessToken: string }> {
  const res = await fetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(context ? { question, context } : { question }),
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  const parsed = askResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("/api/ask response does not match askResponseSchema contract");
  }
  return parsed.data;
}

function specTitle(spec: ViewSpec): string {
  return spec.kind === "verdict" ? "Вердикт расследования" : spec.title;
}

/** Auto-question for action 'why' — human-readable; selection goes as context too. */
function whyQuestion(ctx: ClickContext, spec: ViewSpec): string {
  const sel = Object.entries(ctx.selection)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  return `Почему? Разбери подробнее: ${sel} (клик по карточке «${specTitle(spec)}»)`;
}

export function Workbench() {
  const [runs, setRuns] = useState<Investigation[]>([]);
  const [question, setQuestion] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const presets = usePresetQuestions();

  const submit = useCallback((raw: string, context?: ClickContext) => {
    const q = raw.trim();
    if (!q) return;
    const id = crypto.randomUUID();
    setRuns((prev) => [{ id, question: q, askedAt: Date.now() }, ...prev]);
    setQuestion("");

    const patchRun = (patch: Partial<Investigation>) =>
      setRuns((prev) =>
        prev.map((run) => (run.id === id ? { ...run, ...patch } : run)),
      );

    void askApi(q, context)
      .then(({ runId, publicAccessToken }) => patchRun({ runId, publicAccessToken }))
      .catch((err: unknown) =>
        patchRun({
          askError: `Не удалось запустить ран: ${
            err instanceof Error ? err.message : String(err)
          }`,
        }),
      );
  }, []);

  /** C6: click on a card element — new agent run with click context. */
  const handleClickContext = useCallback(
    (ctx: ClickContext, spec: ViewSpec) => {
      submit(whyQuestion(ctx, spec), ctx);
    },
    [submit],
  );

  const fillExample = useCallback((q: string) => {
    setQuestion(q);
    inputRef.current?.focus();
  }, []);

  return (
    <>
      {/* Composer */}
      <form
        aria-label="Композер вопроса"
        className="flex items-center gap-2 rounded-xl border border-border bg-surface p-2 focus-within:border-accent/50"
        onSubmit={(e) => {
          e.preventDefault();
          submit(question);
        }}
      >
        <input
          ref={inputRef}
          type="text"
          name="question"
          autoComplete="off"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Спросите про данные в ClickHouse — агент сам найдёт нужные таблицы"
          className="flex-1 bg-transparent px-2 py-2 text-sm outline-none placeholder:text-muted"
        />
        <button
          type="submit"
          disabled={!question.trim()}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-background transition-opacity disabled:opacity-50"
        >
          Спросить
        </button>
      </form>

      {/* Feed: newest cards on top. */}
      <section
        aria-label="Лента расследования"
        className="mt-4 flex flex-1 flex-col gap-3"
      >
        {runs.length === 0 && (
          <div className="rounded-xl border border-border bg-surface p-5">
            <p className="text-sm">
              Задайте вопрос по данным в ClickHouse — агент исследует схему,
              выберет таблицы, напишет SQL и вернёт интерактивные карточки.
              Клики по точкам, строкам и ячейкам раскрывают следующий слой.
            </p>
            {/* /api/suggest presets: skeleton chips while loading; empty/error — block hidden. */}
            {presets === null && (
              <>
                <p className="mt-1.5 text-xs text-muted">Начните с примера:</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {[96, 132, 84].map((w, i) => (
                    <span
                      key={i}
                      aria-hidden
                      className="h-7 animate-pulse rounded-full bg-border/60"
                      style={{ width: w, animationDelay: `${i * 100}ms` }}
                    />
                  ))}
                </div>
              </>
            )}
            {presets !== null && presets.length > 0 && (
              <>
                <p className="mt-1.5 text-xs text-muted">Начните с примера:</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {presets.map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => fillExample(q)}
                      className="rounded-full border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:border-accent/60 hover:text-foreground"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {runs.map((run) => (
          <InvestigationCard
            key={run.id}
            investigation={run}
            onClickContext={handleClickContext}
            onAsk={submit}
          />
        ))}
      </section>
    </>
  );
}
