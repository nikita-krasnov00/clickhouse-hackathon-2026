"use client";

/**
 * Переключатель языка EN/RU/ΕΛ: пишет cookie NEXT_LOCALE server action'ом и
 * обновляет дерево (router.refresh) — URL не меняется, i18n-роутинга нет.
 * Живёт в шапке главной и на /login (страница входа тоже локализована).
 */
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { LOCALES, type Locale } from "@/lib/i18n/locale";
import { setLocale } from "@/lib/i18n/set-locale";

/**
 * Короткие ярлыки кнопок — двухбуквенный код латиницей (как EN/RU, не «РУ»).
 * Единая графика важнее самоназвания: греческое «ΕΛ» рендерилось из
 * фолбэк-шрифта (в Geist Mono нет greek-subset) и выглядело крупнее остальных.
 */
const LOCALE_LABELS: Record<Locale, string> = {
  en: "EN",
  ru: "RU",
  el: "EL",
};

export function LocaleSwitcher() {
  const locale = useLocale();
  const t = useTranslations("localeSwitcher");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const switchTo = (next: Locale) => {
    if (next === locale) return;
    startTransition(async () => {
      await setLocale(next);
      router.refresh();
    });
  };

  return (
    <div
      role="group"
      aria-label={t("label")}
      className={`flex items-center rounded-full border border-border p-0.5 ${
        pending ? "opacity-60" : ""
      }`}
    >
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => switchTo(l)}
          disabled={pending}
          aria-pressed={l === locale}
          className={`rounded-full px-2 py-0.5 font-mono text-[10px] transition-colors ${
            l === locale
              ? "bg-accent text-background"
              : "text-muted hover:text-foreground"
          }`}
        >
          {LOCALE_LABELS[l]}
        </button>
      ))}
    </div>
  );
}
