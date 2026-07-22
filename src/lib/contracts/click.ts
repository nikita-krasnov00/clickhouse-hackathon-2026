/**
 * ClickContext — what the UI sends when clicking a card element.
 *
 * Assembled by the renderer from ClickTarget (see view-spec.ts): the UI takes
 * fields listed in selectionKeys from the clicked element and puts them in
 * `selection` under the same names. Single path (v2, drills removed):
 *   - action: 'why' → POST /api/ask { question, context } — new agent run,
 *     selection becomes prompt context.
 */
import { z } from "zod";
import { viewKindSchema } from "./view-spec";

export const CLICK_ACTIONS = ["why"] as const;
export const clickActionSchema = z.enum(CLICK_ACTIONS);
export type ClickAction = z.infer<typeof clickActionSchema>;

/** Selection: flat dictionary of primitives, e.g. { repo: 'x/y', t: '2024-03-02' }. */
export const selectionSchema = z.record(
  z.string(),
  z.union([z.string(), z.number()]),
);
export type Selection = z.infer<typeof selectionSchema>;

export const clickContextSchema = z.strictObject({
  /** id of the card in the investigation feed that was clicked. */
  cardId: z.string(),
  componentKind: viewKindSchema,
  selection: selectionSchema,
  action: clickActionSchema,
});
export type ClickContext = z.infer<typeof clickContextSchema>;
