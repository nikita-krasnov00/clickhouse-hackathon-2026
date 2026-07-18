/**
 * Страница «Insight Desk».
 *
 * Лента расследования (C3): мок-спеки всех шести kind рендерятся через
 * ViewSpecCard; клики собирают ClickContext (пока console.log + тост,
 * проводка к API — C6). Композер подключается к /api/ask в B7.
 */
import { InvestigationFeed } from "@/components/InvestigationFeed";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-6">
      <header className="mb-6 flex items-baseline justify-between border-b border-border pb-4">
        <h1 className="text-xl font-semibold tracking-tight">
          Insight Desk
          <span className="ml-2 align-middle text-xs font-normal text-muted">
            github_events · ClickHouse + Trigger.dev
          </span>
        </h1>
        <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted">
          мок-данные
        </span>
      </header>

      {/* Лента расследования: мок-спеки через рендерер view-spec (C3/C4) */}
      <section
        aria-label="Лента расследования"
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

      {/* Композер */}
      <form
        aria-label="Композер вопроса"
        className="mt-6 flex items-center gap-2 rounded-xl border border-border bg-surface p-2"
      >
        <input
          type="text"
          name="question"
          placeholder="Спросите про github_events — например: «у какого репо подозрительный всплеск звёзд?»"
          className="flex-1 bg-transparent px-2 py-2 text-sm outline-none placeholder:text-muted"
          disabled
        />
        <button
          type="submit"
          disabled
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-background opacity-50"
          title="Подключается в B7 (/api/ask)"
        >
          Спросить
        </button>
      </form>
      <p className="mt-2 text-center text-xs text-muted">
        Композер подключается к /api/ask в задаче B7 · пока это заглушка
      </p>
    </main>
  );
}
