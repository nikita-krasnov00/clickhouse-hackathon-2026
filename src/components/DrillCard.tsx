"use client";

/**
 * C6 — карточка результата дрилла: быстрый путь клика мимо LLM.
 *
 * Появляется в ленте мгновенно (лоадер), затем рендерит viewSpec из
 * /api/drill готовым ViewSpecCard. Дрилл-карточки кликабельны так же, как
 * агентские, — рекурсия расследования. Ошибка — компактная карточка, не
 * пустой экран.
 */
import type { ClickContext, Selection, ViewSpec } from "@/lib/contracts";
import { ViewSpecCard } from "@/components/viewspec/ViewSpecCard";

export type DrillItem = {
  /** Локальный id карточки в ленте. */
  id: string;
  drillId: string;
  params: Selection;
  /** Заголовок карточки-родителя — откуда кликнули. */
  parentTitle: string;
  state: "loading" | "done" | "error";
  viewSpec?: unknown;
  error?: string;
  tookMs?: number;
};

/** Дриллы, от которых есть сюжетный шаг к графу фермы (кульминация демо). */
const GRAPH_SUGGESTION_DRILLS = new Set(["actors-of-day", "co-starred-repos"]);

function suggestedRepo(item: DrillItem): string | undefined {
  const candidate = String(
    item.params.repo ?? item.params.repo_name ?? item.params.series ?? "",
  );
  return /^[^\s/]+\/[^\s/]+$/.test(candidate) ? candidate : undefined;
}

export function DrillCard({
  item,
  onClickContext,
  onRunDrill,
}: {
  item: DrillItem;
  onClickContext?: (ctx: ClickContext, spec: ViewSpec) => void;
  /** Запуск следующего дрилла из кнопки-подсказки (проводка Workbench). */
  onRunDrill?: (drillId: string, params: Selection, parentTitle: string) => void;
}) {
  const graphRepo =
    item.state === "done" && GRAPH_SUGGESTION_DRILLS.has(item.drillId)
      ? suggestedRepo(item)
      : undefined;
  return (
    <article className="rounded-xl border border-border bg-surface p-4">
      <header className="mb-2 flex items-baseline justify-between gap-3">
        <p className="min-w-0 font-mono text-[11px] text-muted">
          ↳ дрилл <span className="text-foreground">{item.drillId}</span>
          {" · "}из «{item.parentTitle}»
        </p>
        <span className="shrink-0 rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-muted">
          {item.state === "loading" && "выполняю…"}
          {item.state === "done" &&
            (item.tookMs !== undefined ? `${item.tookMs} мс` : "готово")}
          {item.state === "error" && "ошибка"}
        </span>
      </header>

      {item.state === "loading" && (
        <div className="flex items-center gap-2 py-3 text-xs text-muted">
          <span
            className="inline-block size-3 animate-spin rounded-full border border-muted border-t-transparent"
            aria-hidden
          />
          Параметризованный SQL без LLM — сейчас будет…
        </div>
      )}

      {item.state === "error" && (
        <div
          className="rounded-lg border border-dashed p-3 text-xs text-muted"
          style={{ borderColor: "var(--viz-anomaly-edge)" }}
        >
          <p className="font-medium" style={{ color: "var(--viz-critical)" }}>
            Дрилл не выполнился
          </p>
          <p className="mt-1 leading-relaxed">{item.error}</p>
          <p className="mt-1 font-mono text-[10px]">
            params: {JSON.stringify(item.params)}
          </p>
        </div>
      )}

      {item.state === "done" && (
        <ViewSpecCard
          cardId={item.id}
          spec={item.viewSpec}
          onClickContext={onClickContext}
        />
      )}

      {graphRepo && onRunDrill && (
        <button
          type="button"
          onClick={() =>
            onRunDrill(
              "costar-graph",
              { repo: graphRepo },
              `дрилл ${item.drillId} · ${graphRepo}`,
            )
          }
          className="mt-3 rounded-lg border border-accent/40 px-3 py-1.5 text-xs text-accent transition-colors hover:bg-accent/10"
        >
          Граф фермы: что ещё звездили эти аккаунты →
        </button>
      )}
    </article>
  );
}
