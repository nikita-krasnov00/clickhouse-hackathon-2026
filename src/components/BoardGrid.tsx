"use client";

/**
 * BoardGrid (C2) — dashboard card grid from the board_planned manifest.
 *
 * Each manifest entry is rendered in ITS OWN slot (manifest order preserved)
 * in one of three states:
 *   pending → skeleton: same CardShell frame as a ready ViewSpecCard
 *             (kind badge + title from manifest), inside — shimmer placeholder
 *             roughly the height of the future card of that kind;
 *   ready   → skeleton hydrates into a real ViewSpecCard in the same slot;
 *   failed  → skeleton collapses into a compact honest error card
 *             (FallbackCard style from ViewSpecCard.tsx — critical status
 *             border, no drama).
 *
 * Unplanned card_ready without cardId (or no manifest match) is already
 * appended by useInvestigationRun at the tail of cards — here we just render
 * the array in order.
 */
import type { ViewKind } from "@/lib/contracts";
import type { BoardCard } from "@/lib/hooks/useInvestigationRun";
import {
  CardShell,
  ViewSpecCard,
  type SpecClickHandler,
} from "@/components/viewspec/ViewSpecCard";

/** Approximate height of future card content by kind — skeleton doesn't "jump". */
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
  treemap: 260,
  funnel: 220,
  boxplot: 200,
};

/** Card skeleton: ViewSpecCard frame + shimmer placeholder instead of data. */
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

/** Skeleton that never got data: compact honest error card. */
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
