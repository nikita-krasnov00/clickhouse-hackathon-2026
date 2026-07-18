"use client";

/**
 * Общий тост ClickContext для мок-ленты и живых карточек расследования.
 *
 * Клики по view-spec карточкам пока console.log + тост (проводка к /api/drill
 * и «почему?» — C6). Хук useClickContextToast отдаёт обработчик для
 * ViewSpecCard.onClickContext и текущий тост; компонент ClickContextToast
 * рендерит его фиксированно в углу.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClickContext } from "@/lib/contracts";

export function useClickContextToast() {
  const [toast, setToast] = useState<ClickContext | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleClickContext = useCallback((ctx: ClickContext) => {
    // C6 подключит сюда /api/drill (action: 'drill') и /api/ask (action: 'why').
    console.log("[ClickContext]", ctx);
    setToast(ctx);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return { toast, handleClickContext };
}

export function ClickContextToast({ toast }: { toast: ClickContext | null }) {
  if (!toast) return null;
  return (
    <div
      role="status"
      className="fixed right-4 bottom-4 z-50 w-80 rounded-xl border border-accent/50 bg-surface p-3 shadow-2xl"
    >
      <p className="text-xs font-medium">
        ClickContext →{" "}
        <span className="font-mono text-accent">{toast.action}</span>
        <span className="ml-1 text-muted">
          ({toast.action === "drill" ? "/api/drill в C6" : "новый ран агента"})
        </span>
      </p>
      <pre className="mt-1.5 max-h-40 overflow-auto rounded-lg bg-background p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-muted">
        {JSON.stringify(toast, null, 2)}
      </pre>
    </div>
  );
}
