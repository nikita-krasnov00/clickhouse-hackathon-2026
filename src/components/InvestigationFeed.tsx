"use client";

/**
 * Мок-лента расследования (C3): мок-спеки → ViewSpecCard. Доступна по
 * ?demo=mocks; живая лента — Workbench. Клики логируются и показываются
 * общим тостом ClickContext (проводка к /api/drill и «почему?» — C6).
 */
import { MOCK_FEED } from "@/lib/mocks";
import { ViewSpecCard } from "@/components/viewspec/ViewSpecCard";
import {
  ClickContextToast,
  useClickContextToast,
} from "@/components/ClickContextToast";

export function InvestigationFeed() {
  const { toast, handleClickContext } = useClickContextToast();

  return (
    <>
      {MOCK_FEED.map(({ cardId, spec }) => (
        <ViewSpecCard
          key={cardId}
          cardId={cardId}
          spec={spec}
          onClickContext={handleClickContext}
        />
      ))}

      <ClickContextToast toast={toast} />
    </>
  );
}
