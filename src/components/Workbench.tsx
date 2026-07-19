"use client";

/**
 * C2/C6 — живое рабочее место: композер + лента карточек расследований.
 *
 * Вопрос (Enter или кнопка) → POST /api/ask → карточка InvestigationCard с
 * Realtime-подпиской. Клик по элементу карточки (C6):
 *   - action 'drill' → POST /api/drill → мгновенная дрилл-карточка (мимо LLM);
 *     drillId берётся из ClickTarget спека, по которому кликнули;
 *   - action 'why'   → POST /api/ask с контекстом клика → новый ран агента.
 * Дрилл-карточки кликабельны так же — рекурсия расследования.
 */
import { useCallback, useRef, useState } from "react";
import {
  askResponseSchema,
  drillResponseSchema,
  type ClickContext,
  type ClickTarget,
  type ViewSpec,
} from "@/lib/contracts";
import {
  InvestigationCard,
  type Investigation,
} from "@/components/InvestigationCard";
import { DrillCard, type DrillItem } from "@/components/DrillCard";

const EXAMPLE_QUESTIONS = [
  "Что странного со звёздами solidSpoon/DashPlayer весной 2024?",
  "Накручен ли xai-org/grok-1? Докажи",
  "top repos by stars in March 2024",
];

type FeedItem =
  | { type: "run"; run: Investigation }
  | { type: "drill"; drill: DrillItem };

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

async function drillApi(
  drillId: string,
  params: ClickContext["selection"],
): Promise<{ viewSpec: unknown; tookMs?: number }> {
  const res = await fetch("/api/drill", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ drillId, params }),
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  const parsed = drillResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("Ответ /api/drill не соответствует контракту drillResponseSchema");
  }
  const tookHeader = res.headers.get("X-Drill-Ms");
  return {
    viewSpec: parsed.data.viewSpec,
    tookMs: tookHeader ? Number(tookHeader) : undefined,
  };
}

/** Каким классом элемента кликается каждый вид карточки (контракт ClickTarget). */
const KIND_TO_ELEMENT: Partial<Record<ViewSpec["kind"], ClickTarget["on"]>> = {
  timeline: "point",
  leaderboard: "row",
  histogram: "bucket",
  heatmap: "cell",
};

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
  const [items, setItems] = useState<FeedItem[]>([]);
  const [question, setQuestion] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = useCallback((raw: string, context?: ClickContext) => {
    const q = raw.trim();
    if (!q) return;
    const id = crypto.randomUUID();
    setItems((prev) => [
      { type: "run", run: { id, question: q, askedAt: Date.now() } },
      ...prev,
    ]);
    setQuestion("");

    const patchRun = (patch: Partial<Investigation>) =>
      setItems((prev) =>
        prev.map((it) =>
          it.type === "run" && it.run.id === id
            ? { type: "run", run: { ...it.run, ...patch } }
            : it,
        ),
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

  const runDrill = useCallback(
    (drillId: string, params: ClickContext["selection"], parentTitle: string) => {
      const id = crypto.randomUUID();
      setItems((prev) => [
        {
          type: "drill",
          drill: { id, drillId, params, parentTitle, state: "loading" },
        },
        ...prev,
      ]);

      const patch = (p: Partial<DrillItem>) =>
        setItems((prev) =>
          prev.map((it) =>
            it.type === "drill" && it.drill.id === id
              ? { type: "drill", drill: { ...it.drill, ...p } }
              : it,
          ),
        );

      void drillApi(drillId, params)
        .then(({ viewSpec, tookMs }) => patch({ state: "done", viewSpec, tookMs }))
        .catch((err: unknown) =>
          patch({
            state: "error",
            error: err instanceof Error ? err.message : String(err),
          }),
        );
    },
    [],
  );

  /** C6: клик по элементу карточки — дрилл (быстрый путь) или новый ран агента. */
  const handleClickContext = useCallback(
    (ctx: ClickContext, spec: ViewSpec) => {
      const element = KIND_TO_ELEMENT[ctx.componentKind];
      const target =
        element && "clicks" in spec
          ? spec.clicks.find((c) => c.on === element)
          : undefined;
      if (ctx.action === "drill" && target?.drillId) {
        runDrill(target.drillId, ctx.selection, specTitle(spec));
        return;
      }
      submit(whyQuestion(ctx, spec), ctx);
    },
    [runDrill, submit],
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

      {/* Лента: новые карточки сверху; раны и дриллы вперемешку. */}
      <section
        aria-label="Лента расследования"
        className="mt-4 flex flex-1 flex-col gap-3"
      >
        {items.length === 0 && (
          <div className="rounded-xl border border-border bg-surface p-5">
            <p className="text-sm">
              Задайте вопрос по <span className="font-mono">github_events</span> —
              агент исследует схему, напишет SQL и вернёт интерактивные карточки.
              Клики по точкам, строкам и ячейкам раскрывают следующий слой.
            </p>
            <p className="mt-1.5 text-xs text-muted">Начните с примера:</p>
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

        {items.map((it) =>
          it.type === "run" ? (
            <InvestigationCard
              key={it.run.id}
              investigation={it.run}
              onClickContext={handleClickContext}
            />
          ) : (
            <DrillCard
              key={it.drill.id}
              item={it.drill}
              onClickContext={handleClickContext}
              onRunDrill={runDrill}
            />
          ),
        )}
      </section>
    </>
  );
}
