/**
 * Локали приложения (en/ru/el) и чистая логика их определения.
 *
 * Без импортов из next-intl/next — модуль общий для request-конфига next-intl,
 * роут-хендлеров и proxy.ts (edge). Приоритет: cookie NEXT_LOCALE →
 * Accept-Language → en.
 */

export const LOCALES = ["en", "ru", "el"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/** Имя cookie, которое пишет переключатель языка (конвенция next-intl). */
export const LOCALE_COOKIE = "NEXT_LOCALE";

/** Название языка для LLM-промптов («Write the questions in …»). */
export const LOCALE_ENGLISH_NAME: Record<Locale, string> = {
  en: "English",
  ru: "Russian",
  el: "Greek",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * Выбор локали: явная cookie важнее заголовка браузера; из Accept-Language
 * берётся первый поддерживаемый базовый язык («ru-RU,ru;q=0.9,en;q=0.8» → ru).
 */
export function negotiateLocale(
  cookieValue: string | undefined,
  acceptLanguage: string | null | undefined,
): Locale {
  if (isLocale(cookieValue)) return cookieValue;
  for (const part of (acceptLanguage ?? "").split(",")) {
    const base = part.split(";")[0]?.trim().toLowerCase().split("-")[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}
