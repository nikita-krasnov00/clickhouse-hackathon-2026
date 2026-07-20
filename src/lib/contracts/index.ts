/**
 * Общие контракты Insight Desk — единственная точка связи треков A/B/C.
 * ЗАМОРОЖЕНО НА J1. Импортировать только отсюда: `@/lib/contracts`.
 *
 *   - view-spec.ts — ViewSpec (8 видов карточек) + ClickTarget + примитивы;
 *   - click.ts     — ClickContext: что уходит из UI при клике;
 *   - api.ts       — /api/ask, /api/suggest, RunStep (Realtime-прогресс);
 *   - catalog.ts   — VIEW_SPEC_CATALOG для промпта text-to-SQL (B4).
 *
 * Экспортируются и Zod-схемы (валидация: выход LLM, тела запросов), и
 * выведенные типы (z.infer) для кода. Проверка: `npm run contracts:smoke`.
 */

export * from "./view-spec";
export * from "./click";
export * from "./api";
export * from "./catalog";
