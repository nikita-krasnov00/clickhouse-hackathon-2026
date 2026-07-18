/**
 * Страница «Insight Desk».
 *
 * По умолчанию — живое рабочее место (C2): композер → POST /api/ask →
 * карточки расследований с Realtime-прогрессом конвейера и финальными
 * view-spec карточками. Мок-лента C3/C4 осталась доступна по ?demo=mocks.
 */
import Link from "next/link";
import { InvestigationFeed } from "@/components/InvestigationFeed";
import { Workbench } from "@/components/Workbench";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ demo?: string | string[] }>;
}) {
  const { demo } = await searchParams;
  const demoMocks = (Array.isArray(demo) ? demo[0] : demo) === "mocks";

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-6">
      <header className="mb-6 flex items-baseline justify-between border-b border-border pb-4">
        <h1 className="text-xl font-semibold tracking-tight">
          Insight Desk
          <span className="ml-2 align-middle text-xs font-normal text-muted">
            github_events · ClickHouse + Trigger.dev
          </span>
        </h1>
        {demoMocks ? (
          <Link
            href="/"
            className="rounded-full border border-border px-2 py-0.5 text-xs text-muted transition-colors hover:border-accent/60 hover:text-foreground"
          >
            мок-данные · к живому агенту
          </Link>
        ) : (
          <Link
            href="/?demo=mocks"
            className="rounded-full border border-border px-2 py-0.5 text-xs text-muted transition-colors hover:border-accent/60 hover:text-foreground"
            title="Демо-лента на мок-данных (C3/C4)"
          >
            моки
          </Link>
        )}
      </header>

      {demoMocks ? (
        <section
          aria-label="Лента расследования (моки)"
          className="flex flex-1 flex-col gap-3"
        >
          <div className="rounded-xl border border-border bg-surface p-4">
            <p className="text-sm text-muted">
              Демо-расследование накрутки звёзд на мок-данных: каждая карточка —
              view-spec, отрендеренный реестром компонентов. Кликните точку
              таймлайна или строку таблицы — соберётся ClickContext.
            </p>
          </div>
          <InvestigationFeed />
        </section>
      ) : (
        <Workbench />
      )}
    </main>
  );
}
