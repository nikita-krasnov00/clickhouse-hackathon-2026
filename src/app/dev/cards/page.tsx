"use client";

/**
 * Дев-витрина карточек: все виды ViewSpec на примерах из VIEW_SPEC_CATALOG.
 *
 * Живой визуальный смоук рендереров без ClickHouse и LLM: каждый пример
 * каталога проходит через настоящий ViewSpecCard (валидация + рендер).
 * Клик по любому элементу показывает собранный ClickContext сверху страницы —
 * так проверяется семантика ClickTarget каждого компонента.
 *
 * Карточки рендерятся ТОЛЬКО после маунта (как в боевой ленте, где они
 * появляются из Realtime-событий): SSR чартов ловит гидрационный мисматч на
 * float-математике (Math.log10 в Node и браузере расходится в последнем ULP).
 */
import { useEffect, useState } from "react";
import { VIEW_SPEC_CATALOG } from "@/lib/contracts";
import { ViewSpecCard } from "@/components/viewspec/ViewSpecCard";

export default function DevCardsPage() {
  const [lastClick, setLastClick] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const entries = Object.values(VIEW_SPEC_CATALOG);
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <header className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight">
          Витрина карточек · {entries.length} видов
        </h1>
        <p className="mt-1 text-xs text-muted">
          Примеры из VIEW_SPEC_CATALOG через настоящий ViewSpecCard. Клик по
          элементу карточки печатает ClickContext ниже.
        </p>
      </header>

      <pre className="mb-4 min-h-16 overflow-auto rounded-lg border border-border bg-surface p-3 font-mono text-[11px] leading-relaxed text-muted">
        {lastClick ?? "ClickContext появится здесь после клика по карточке"}
      </pre>

      <div className="flex flex-col gap-4">
        {mounted &&
          entries.map((entry) => (
            <ViewSpecCard
              key={entry.kind}
              cardId={`dev-${entry.kind}`}
              spec={entry.example}
              onClickContext={(ctx) => setLastClick(JSON.stringify(ctx, null, 2))}
            />
          ))}
      </div>
    </main>
  );
}
