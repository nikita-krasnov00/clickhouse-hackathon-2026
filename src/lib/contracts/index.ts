/**
 * Shared Insight Desk contracts — the single integration point for tracks A/B/C.
 * FROZEN AT J1. Import only from here: `@/lib/contracts`.
 *
 *   - view-spec.ts — ViewSpec (all card kinds) + ClickTarget + primitives;
 *   - click.ts     — ClickContext: what the UI sends on click;
 *   - api.ts       — /api/ask, /api/suggest, RunStep (Realtime progress);
 *   - catalog.ts   — VIEW_SPEC_CATALOG for the text-to-SQL prompt (B4);
 *   - language.ts  — run language (detectAnswerLanguage) for answers and reasoning.
 *
 * Exports both Zod schemas (validation: LLM output, request bodies) and
 * inferred types (z.infer) for application code. Smoke test: `npm run contracts:smoke`.
 */

export * from "./view-spec";
export * from "./click";
export * from "./api";
export * from "./catalog";
export * from "./language";
