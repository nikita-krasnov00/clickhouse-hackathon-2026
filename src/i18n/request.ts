/**
 * Request-конфиг next-intl (cookie-режим, без i18n-роутинга в URL):
 * локаль per-request из NEXT_LOCALE/Accept-Language, сообщения — JSON по локали.
 * Путь файла канонический — его ищет createNextIntlPlugin из next.config.ts.
 */
import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";
import { LOCALE_COOKIE, negotiateLocale } from "@/lib/i18n/locale";

export default getRequestConfig(async () => {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const locale = negotiateLocale(
    cookieStore.get(LOCALE_COOKIE)?.value,
    headerStore.get("accept-language"),
  );
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
