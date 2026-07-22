/**
 * Пользовательские сообщения серверных ошибок (proxy 401, /api/ask 4xx/5xx).
 *
 * Это НЕ next-intl: роут-хендлеры и proxy живут вне React-дерева, им нужен
 * простой словарь по локали. Ключей мало — только то, что реально доплывает
 * до экрана (FailedFallback показывает текст ошибки /api/ask как есть).
 */
import type { Locale } from "@/lib/i18n/locale";

const MESSAGES = {
  unauthorized: {
    en: "Not signed in — sign in with Google",
    ru: "Не авторизован — войдите через Google",
    el: "Δεν έχετε συνδεθεί — συνδεθείτε μέσω Google",
  },
  invalidJson: {
    en: "Request body is not valid JSON",
    ru: "Тело запроса — не валидный JSON",
    el: "Το σώμα του αιτήματος δεν είναι έγκυρο JSON",
  },
  invalidAskBody: {
    en: "Invalid /api/ask request body",
    ru: "Невалидное тело запроса /api/ask",
    el: "Μη έγκυρο σώμα αιτήματος /api/ask",
  },
} as const;

export type ApiMessageKey = keyof typeof MESSAGES;

export function apiMessage(locale: Locale, key: ApiMessageKey): string {
  return MESSAGES[key][locale];
}
