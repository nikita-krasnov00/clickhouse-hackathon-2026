"use client";

/**
 * Dev card showcase: all ViewSpec kinds with examples from VIEW_SPEC_CATALOG.
 *
 * Live visual smoke test of renderers without ClickHouse or LLM: each catalog
 * example goes through the real ViewSpecCard (validation + render).
 * Clicking any element shows the assembled ClickContext at the top of the page —
 * verifies ClickTarget semantics for each component.
 *
 * Cards render ONLY after mount (like the production feed where they appear
 * from Realtime events): SSR chart rendering hits hydration mismatch on
 * float math (Math.log10 in Node vs browser diverges in the last ULP).
 */
import { useState, useSyncExternalStore } from "react";
import { VIEW_SPEC_CATALOG } from "@/lib/contracts";
import { ViewSpecCard } from "@/components/viewspec/ViewSpecCard";

const noopSubscribe = () => () => {};

export default function DevCardsPage() {
  const [lastClick, setLastClick] = useState<string | null>(null);
  // false on server and during hydration render, true after — mounted gate
  // without setState-in-effect.
  const mounted = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
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
