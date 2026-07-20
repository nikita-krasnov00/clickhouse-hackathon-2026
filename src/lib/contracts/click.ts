/**
 * ClickContext — что уходит из UI при клике по элементу карточки.
 *
 * Собирается рендерером из ClickTarget (см. view-spec.ts): UI берёт у кликнутого
 * элемента поля, перечисленные в selectionKeys, и кладёт их в `selection` под
 * теми же именами. Путь один (v2, дриллы удалены):
 *   - action: 'why' → POST /api/ask { question, context } — новый ран агента,
 *     selection становится контекстом промпта.
 */
import { z } from "zod";
import { viewKindSchema } from "./view-spec";

export const CLICK_ACTIONS = ["why"] as const;
export const clickActionSchema = z.enum(CLICK_ACTIONS);
export type ClickAction = z.infer<typeof clickActionSchema>;

/** Выделение: плоский словарь примитивов, напр. { repo: 'x/y', t: '2024-03-02' }. */
export const selectionSchema = z.record(
  z.string(),
  z.union([z.string(), z.number()]),
);
export type Selection = z.infer<typeof selectionSchema>;

export const clickContextSchema = z.strictObject({
  /** id карточки в ленте расследования, по которой кликнули. */
  cardId: z.string(),
  componentKind: viewKindSchema,
  selection: selectionSchema,
  action: clickActionSchema,
});
export type ClickContext = z.infer<typeof clickContextSchema>;
