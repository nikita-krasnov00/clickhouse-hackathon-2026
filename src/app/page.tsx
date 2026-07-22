/**
 * "Insight Desk" page: live workbench (C2) — composer → POST /api/ask →
 * investigation cards with Realtime pipeline progress and view-spec cards.
 */
import { getTranslations } from "next-intl/server";
import { LocaleSwitcher } from "@/components/LocaleSwitcher";
import { UserBadge } from "@/components/UserBadge";
import { Workbench } from "@/components/Workbench";

export default async function Home() {
  const t = await getTranslations("home");
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-6">
      <header className="mb-6 flex items-center justify-between border-b border-border pb-4">
        <h1 className="text-xl font-semibold tracking-tight">
          Insight Desk
          <span className="ml-2 align-middle text-xs font-normal text-muted">
            {t("tagline")}
          </span>
        </h1>
        <div className="flex items-center gap-3">
          <LocaleSwitcher />
          <UserBadge />
        </div>
      </header>
      <Workbench />
    </main>
  );
}
