"use server";

/**
 * Server action переключателя языка: пишет cookie NEXT_LOCALE (год жизни).
 * После мутации cookie Next перерендеривает серверные компоненты, клиент
 * дополнительно делает router.refresh() — см. LocaleSwitcher.
 */
import { cookies } from "next/headers";
import { isLocale, LOCALE_COOKIE } from "@/lib/i18n/locale";

export async function setLocale(locale: string): Promise<void> {
  if (!isLocale(locale)) return;
  (await cookies()).set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
}
