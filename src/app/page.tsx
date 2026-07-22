/**
 * "Insight Desk" page: live workbench (C2) — composer → POST /api/ask →
 * investigation cards with Realtime pipeline progress and view-spec cards.
 */
import { UserBadge } from "@/components/UserBadge";
import { Workbench } from "@/components/Workbench";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-6">
      <header className="mb-6 flex items-center justify-between border-b border-border pb-4">
        <h1 className="text-xl font-semibold tracking-tight">
          Insight Desk
          <span className="ml-2 align-middle text-xs font-normal text-muted">
            живой SQL-агент · ClickHouse + Trigger.dev
          </span>
        </h1>
        <UserBadge />
      </header>
      <Workbench />
    </main>
  );
}
