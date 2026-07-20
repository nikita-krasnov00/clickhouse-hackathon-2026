"use client";

/**
 * C2/C6 — живое рабочее место: композер + лента карточек расследований.
 *
 * Вопрос (Enter или кнопка) → POST /api/ask → карточка InvestigationCard с
 * Realtime-подпиской. Клик по элементу карточки (C6) — всегда новый ран
 * агента (action 'why') с ClickContext: датасет-специфичных дриллов нет,
 * следующий слой раскапывает сам агент. Клик по чипу clarify/impossible
 * внутри карточки (C2) — тоже новый ран, но обычным вопросом без контекста.
 *
 * Пресеты композера — не хардкод: на маунте GET /api/suggest подтягивает
 * вопросы, сгенерированные по живому каталогу таблиц ClickHouse. Пусто или
 * ошибка — блок пресетов просто не рисуется (suggestResponseSchema валиден и
 * с пустым массивом).
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

/** Пресеты /api/suggest: null — ещё грузятся, [] — пусто/ошибка (блок скрыт). */
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
    throw new Error("Ответ /api/ask не соответствует контракту askResponseSchema");
  }
  return parsed.data;
}

function specTitle(spec: ViewSpec): string {
  return spec.kind === "verdict" ? "Вердикт расследования" : spec.title;
}

/** Авто-вопрос для action 'why' — человекочитаемый, selection уходит и контекстом. */
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

  /** C6: клик по элементу карточки — новый ран агента с контекстом клика. */
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
      {/* Композер */}
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

      {/* Лента: новые карточки сверху. */}
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
            {/* Пресеты /api/suggest: пока грузится — skeleton-чипы; пусто/ошибка — блок скрыт. */}
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
