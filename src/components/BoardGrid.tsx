"use client";

/**
 * BoardGrid (C2) — сетка карточек дашборда по манифесту board_planned.
 *
 * Каждый элемент манифеста рисуется на СВОЁМ месте (порядок манифеста
 * сохраняется) в одном из трёх состояний:
 *   pending → скелет: та же рамка CardShell, что и у готовой ViewSpecCard
 *             (kind-бейдж + title из манифеста), внутри — shimmer-заглушка
 *             высотой примерно как у будущей карточки этого вида;
 *   ready   → скелет гидратируется в настоящую ViewSpecCard на том же месте;
 *   failed  → скелет схлопывается в компактную честную карточку ошибки
 *             (в стиле FallbackCard из ViewSpecCard.tsx — рамка статуса
 *             critical, без драмы).
 *
 * Внеплановые card_ready без cardId (или без совпадения в манифесте) уже
 * подмешаны хуком useInvestigationRun в хвост cards — здесь просто рендерим
 * массив по порядку.
 */
import type { ViewKind } from "@/lib/contracts";
import type { BoardCard } from "@/lib/hooks/useInvestigationRun";
import {
  CardShell,
  ViewSpecCard,
  type SpecClickHandler,
} from "@/components/viewspec/ViewSpecCard";

/** Примерная высота будущего содержимого карточки по виду — скелет не «прыгает». */
const SKELETON_HEIGHT: Record<ViewKind, number> = {
  timeline: 240,
  scatter: 260,
  histogram: 220,
  heatmap: 200,
  graph: 300,
  leaderboard: 180,
  verdict: 150,
  bignumber: 90,
  map: 300,
};

/** Скелет карточки: рамка ViewSpecCard + shimmer-заглушка вместо данных. */
function CardSkeleton({ kind, title }: { kind: ViewKind; title: string }) {
  return (
    <CardShell kind={kind} title={title}>
      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <span aria-hidden className="h-3 w-14 animate-pulse rounded-full bg-border" />
          <span
            aria-hidden
            className="h-3 w-9 animate-pulse rounded-full bg-border/70"
            style={{ animationDelay: "150ms" }}
          />
        </div>
        <div
          aria-hidden
          className="animate-pulse rounded-lg bg-border/60"
          style={{ height: SKELETON_HEIGHT[kind], animationDelay: "75ms" }}
        />
      </div>
    </CardShell>
  );
}

/** Скелет, не дождавшийся данных: компактная честная карточка ошибки. */
function CardFailed({
  kind,
  title,
  error,
}: {
  kind: ViewKind;
  title: string;
  error: string;
}) {
  return (
    <article
      className="rounded-xl border bg-surface p-4"
      style={{ borderColor: "var(--viz-anomaly-edge)" }}
    >
      <header className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium" style={{ color: "var(--viz-critical)" }}>
          {title}
        </h2>
        <span className="shrink-0 rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-muted">
          {kind}
        </span>
      </header>
      <p className="text-xs leading-relaxed text-muted">{error}</p>
    </article>
  );
}

export function BoardGrid({
  cards,
  onClickContext,
}: {
  cards: BoardCard[];
  onClickContext?: SpecClickHandler;
}) {
  return (
    <div className="mt-3 flex flex-col gap-3">
      {cards.map((card) => {
        if (card.status === "ready") {
          return (
            <ViewSpecCard
              key={card.cardId}
              cardId={card.cardId}
              spec={card.spec}
              onClickContext={onClickContext}
            />
          );
        }
        if (card.status === "failed") {
          return (
            <CardFailed
              key={card.cardId}
              kind={card.kind}
              title={card.title}
              error={card.error}
            />
          );
        }
        return <CardSkeleton key={card.cardId} kind={card.kind} title={card.title} />;
      })}
    </div>
  );
}
