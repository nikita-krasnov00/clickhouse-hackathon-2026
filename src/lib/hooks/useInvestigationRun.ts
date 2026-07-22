"use client";

/**
 * C2 — subscription to an investigate run via Trigger.dev Realtime.
 *
 * Wrapper over useRealtimeRun (@trigger.dev/react-hooks, canonical
 * trigger-realtime skill): runId + publicAccessToken come from /api/ask (B7),
 * token is scoped to read exactly this run.
 *
 * The hook normalizes the raw run into state for the progress card:
 *   - steps     — RunStep history from metadata.steps (each element strictly
 *                 validated by runStepSchema; garbage is silently skipped —
 *                 the feed must not crash on a malformed step);
 *   - lastStep  — last valid step;
 *   - sqlPreview — last sqlPreview from reviewing/executing steps;
 *   - viewSpecs — from the done step (arrives directly in the Realtime stream) or from
 *                 run.output — no separate result fetch needed;
 *   - boardCards — board_planned manifest, projected onto card_ready/
 *                 card_failed by cardId (C2 skeleton grid renders immediately
 *                 from the manifest, cards hydrate in place);
 *                 empty if there was no board_planned — component falls back
 *                 to viewSpecs as before;
 *   - phase     — connecting | running | done | failed (for rendering).
 */
import { useEffect, useMemo, useState } from "react";
import { useRealtimeRun } from "@trigger.dev/react-hooks";
import { runStepSchema, type RunStep, type ViewKind, type ViewSpec } from "@/lib/contracts";
import type { investigateTask } from "@/trigger/investigate";

/**
 * Polling fallback (risk from PLAN.md: "Realtime did not connect — degrade to
 * polling"): alongside the subscription, poll /api/run-status and take the most
 * informative state (more steps / terminal status). When Realtime works, it is
 * always ahead and polling changes nothing.
 */
type PolledRun = {
  status?: string;
  metadata?: { steps?: unknown } | null;
  output?: { viewSpecs?: ViewSpec[] } | null;
};

const POLL_INTERVAL_MS = 3000;

function usePolledRun(runId: string | undefined, active: boolean): PolledRun | undefined {
  const [polled, setPolled] = useState<PolledRun | undefined>(undefined);
  useEffect(() => {
    if (!runId || !active) return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/run-status?runId=${encodeURIComponent(runId)}`);
        if (!res.ok) return;
        const body = (await res.json()) as PolledRun;
        if (!stop) setPolled(body);
      } catch {
        // network blip — next tick will retry
      }
    };
    void tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [runId, active]);
  return polled;
}

export type InvestigationPhase = "connecting" | "running" | "done" | "failed";

/**
 * board_planned manifest card, projected onto its progress:
 *   pending → skeleton still waiting for card_ready/card_failed with its cardId;
 *   ready   → skeleton hydrates into spec (+ sql, if the card is sql-based);
 *   failed  → skeleton collapses into a compact error card.
 * Unplanned card_ready without cardId (or without a manifest match) also
 * arrives as ready — see computeBoardCards.
 */
export type BoardCard =
  | { cardId: string; kind: ViewKind; title: string; status: "pending" }
  | {
      cardId: string;
      kind: ViewKind;
      title: string;
      status: "ready";
      spec: ViewSpec;
      sql?: string;
    }
  | { cardId: string; kind: ViewKind; title: string; status: "failed"; error: string };

export type InvestigationRunState = {
  phase: InvestigationPhase;
  /** Pipeline step history (strictly per runStepSchema). */
  steps: RunStep[];
  lastStep: RunStep | undefined;
  /**
   * Cards in readiness order: from card_ready steps DURING the run
   * (progressive loading); fallback for older runs — done/run.output.
   */
  viewSpecs: ViewSpec[] | undefined;
  /**
   * Cards in board_planned manifest order (see BoardCard); empty if
   * there was no manifest at all — then rendering uses viewSpecs.
   */
  boardCards: BoardCard[];
  /** Terminal error: error step, subscription error, or run status. */
  errorMessage: string | undefined;
  /** Raw Trigger.dev run status (for debug caption). */
  runStatus: string | undefined;
};

/** Terminal Trigger.dev run statuses meaning failure. */
const FAILED_STATUSES = new Set([
  "FAILED",
  "CRASHED",
  "CANCELED",
  "SYSTEM_FAILURE",
  "TIMED_OUT",
  "EXPIRED",
]);

function parseSteps(raw: unknown): RunStep[] {
  if (!Array.isArray(raw)) return [];
  const steps: RunStep[] = [];
  for (const item of raw) {
    const parsed = runStepSchema.safeParse(item);
    if (parsed.success) steps.push(parsed.data);
  }
  return steps;
}

/** Title for an unplanned card: verdict is special — the spec has no title field. */
function specBoardTitle(spec: ViewSpec): string {
  return spec.kind === "verdict" ? "Вердикт расследования" : spec.title;
}

/**
 * Builds boardCards: board_planned manifest (order preserved) with each card's
 * status updated from card_ready/card_failed with its cardId. card_ready/card_failed
 * without a manifest match (or when there was no manifest at all) are not lost —
 * card_ready goes to the tail as a ready unplanned card, card_failed without a
 * manifest pair is dropped (its skeleton has nowhere to come from).
 */
function computeBoardCards(steps: RunStep[]): BoardCard[] {
  const plan = steps.find((s) => s.step === "board_planned");
  if (!plan) return [];

  const byId = new Map<string, BoardCard>(
    plan.cards.map((c) => [
      c.cardId,
      { cardId: c.cardId, kind: c.kind, title: c.title, status: "pending" as const },
    ]),
  );
  const extra: BoardCard[] = [];

  for (const s of steps) {
    if (s.step === "card_ready") {
      const known = s.cardId ? byId.get(s.cardId) : undefined;
      if (known) {
        byId.set(known.cardId, {
          cardId: known.cardId,
          kind: known.kind,
          title: known.title,
          status: "ready",
          spec: s.viewSpec,
          sql: s.sql,
        });
      } else {
        extra.push({
          cardId: s.cardId ?? `extra-${extra.length}`,
          kind: s.viewSpec.kind,
          title: specBoardTitle(s.viewSpec),
          status: "ready",
          spec: s.viewSpec,
          sql: s.sql,
        });
      }
    } else if (s.step === "card_failed" && s.cardId) {
      const known = byId.get(s.cardId);
      if (known) {
        byId.set(known.cardId, {
          cardId: known.cardId,
          kind: known.kind,
          title: known.title,
          status: "failed",
          error: s.error,
        });
      }
    }
  }

  return [...plan.cards.map((c) => byId.get(c.cardId)!), ...extra];
}

export function useInvestigationRun(
  runId: string | undefined,
  publicAccessToken: string | undefined,
): InvestigationRunState {
  const enabled = Boolean(runId && publicAccessToken);
  const { run, error } = useRealtimeRun<typeof investigateTask>(runId, {
    accessToken: publicAccessToken,
    enabled,
  });

  // Polling stays active until the run is terminal from either source.
  const realtimeSteps = useMemo(() => parseSteps(run?.metadata?.steps), [run]);
  const realtimeTerminal =
    (run?.status !== undefined &&
      (run.status === "COMPLETED" || FAILED_STATUSES.has(run.status))) ||
    realtimeSteps.some((s) => s.step === "done" || s.step === "error");
  const polled = usePolledRun(runId, enabled && !realtimeTerminal);

  return useMemo<InvestigationRunState>(() => {
    // Most informative source wins: whoever has more valid steps.
    const polledSteps = parseSteps(polled?.metadata?.steps);
    const usePolled = polledSteps.length > realtimeSteps.length;
    const steps = usePolled ? polledSteps : realtimeSteps;
    const status = run?.status ?? polled?.status;
    const output = run?.output ?? polled?.output ?? undefined;
    const lastStep = steps.at(-1);

    // Progressive loading: cards appear as card_ready arrives, without
    // waiting for done. done/output — fallback (older runs, lost stream).
    const readySpecs = steps
      .filter((s) => s.step === "card_ready")
      .map((s) => s.viewSpec);
    const doneStep = steps.find((s) => s.step === "done");
    const finalSpecs = doneStep?.viewSpecs ?? output?.viewSpecs;
    const viewSpecs =
      readySpecs.length > 0
        ? finalSpecs && finalSpecs.length > readySpecs.length
          ? finalSpecs
          : readySpecs
        : finalSpecs;

    const boardCards = computeBoardCards(steps);

    const errorStep = steps.find((s) => s.step === "error");
    const failed =
      Boolean(errorStep) ||
      Boolean(error) ||
      (status !== undefined && FAILED_STATUSES.has(status));

    let phase: InvestigationPhase;
    if (failed) phase = "failed";
    else if (doneStep || finalSpecs || status === "COMPLETED") phase = "done";
    else if (run || polled) phase = "running";
    else phase = "connecting";

    const errorMessage = errorStep?.message ?? error?.message ??
      (failed ? `Ран завершился со статусом ${status}` : undefined);

    return {
      phase,
      steps,
      lastStep,
      viewSpecs,
      boardCards,
      errorMessage,
      runStatus: status,
    };
  }, [run, error, polled, realtimeSteps]);
}
