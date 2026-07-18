"use client";

/**
 * Секундомер карточки расследования: тикает раз в секунду, пока active,
 * и замирает на последнем значении, когда ран завершился. LLM думает
 * 5–30 с — видимый счётчик превращает ожидание в часть зрелища.
 */
import { useEffect, useState } from "react";

export function useElapsedSeconds(startMs: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    // Карточка монтируется уже активной (askedAt ≈ mount), стартовое значение
    // now из useState актуально — синхронный setState в эффекте не нужен.
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  return Math.max(0, Math.round((now - startMs) / 1000));
}
