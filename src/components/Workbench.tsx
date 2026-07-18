"use client";

/**
 * C2 — живое рабочее место: композер + лента карточек расследований.
 *
 * Вопрос (Enter или кнопка) → POST /api/ask → { runId, publicAccessToken } →
 * карточка InvestigationCard с собственной Realtime-подпиской. Несколько
 * вопросов подряд — несколько карточек, новые сверху, каждая живёт своей
 * подпиской. Пустая лента — приглашение с примерами-кнопками, вставляющими
 * вопрос в композер.
 */
import { useCallback, useRef, useState } from "react";
import { askResponseSchema } from "@/lib/contracts";
import {
  InvestigationCard,
  type Investigation,
} from "@/components/InvestigationCard";
import {
  ClickContextToast,
  useClickContextToast,
} from "@/components/ClickContextToast";

const EXAMPLE_QUESTIONS = [
  "подозрителен ли xai-org/grok-1?",
  "top repos by stars in March 2024",
  "у какого репо аномальный всплеск звёзд?",
];

async function askApi(
  question: string,
): Promise<{ runId: string; publicAccessToken: string }> {
  const res = await fetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
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

export function Workbench() {
  const [items, setItems] = useState<Investigation[]>([]);
  const [question, setQuestion] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast, handleClickContext } = useClickContextToast();

  const submit = useCallback(
    (raw: string) => {
      const q = raw.trim();
      if (!q) return;
      const id = crypto.randomUUID();
      setItems((prev) => [{ id, question: q, askedAt: Date.now() }, ...prev]);
      setQuestion("");

      void askApi(q)
        .then(({ runId, publicAccessToken }) => {
          setItems((prev) =>
            prev.map((it) =>
              it.id === id ? { ...it, runId, publicAccessToken } : it,
            ),
          );
        })
        .catch((err: unknown) => {
          setItems((prev) =>
            prev.map((it) =>
              it.id === id
                ? {
                    ...it,
                    askError: `Не удалось запустить ран: ${
                      err instanceof Error ? err.message : String(err)
                    }`,
                  }
                : it,
            ),
          );
        });
    },
    [],
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
          placeholder="Спросите про github_events — например: «у какого репо подозрительный всплеск звёзд?»"
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

      {/* Лента: новые карточки сверху, каждая со своей Realtime-подпиской. */}
      <section
        aria-label="Лента расследования"
        className="mt-4 flex flex-1 flex-col gap-3"
      >
        {items.length === 0 && (
          <div className="rounded-xl border border-border bg-surface p-5">
            <p className="text-sm">
              Задайте вопрос по <span className="font-mono">github_events</span> —
              агент исследует схему, напишет SQL и вернёт интерактивные карточки.
            </p>
            <p className="mt-1.5 text-xs text-muted">
              Например: «подозрителен ли xai-org/grok-1?» — или начните с примера:
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {EXAMPLE_QUESTIONS.map((q) => (
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
          </div>
        )}

        {items.map((it) => (
          <InvestigationCard
            key={it.id}
            investigation={it}
            onClickContext={handleClickContext}
          />
        ))}
      </section>

      <ClickContextToast toast={toast} />
    </>
  );
}
