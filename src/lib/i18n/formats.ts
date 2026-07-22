"use client";

/**
 * Локале-зависимые форматтеры чисел/дат для клиентских карточек.
 *
 * Раньше каждая карточка держала модульный `new Intl.NumberFormat("ru-RU")`;
 * теперь форматтер создаётся хуком от активной локали next-intl. Мемоизация —
 * по локали и сериализованным опциям (опции всегда маленькие литералы).
 */
import { useMemo } from "react";
import { useLocale } from "next-intl";

export function useNumberFormat(options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  const locale = useLocale();
  const key = JSON.stringify(options ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- options стабильны через key
  return useMemo(() => new Intl.NumberFormat(locale, options), [locale, key]);
}

export function useDateTimeFormat(options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locale = useLocale();
  const key = JSON.stringify(options ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- options стабильны через key
  return useMemo(() => new Intl.DateTimeFormat(locale, options), [locale, key]);
}
