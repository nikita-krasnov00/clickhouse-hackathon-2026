"use client";

/**
 * Investigation card stopwatch: ticks once per second while active,
 * and freezes at the last value when the run completes. LLM thinking takes
 * 5–30 s — a visible counter turns waiting into part of the experience.
 */
import { useEffect, useState } from "react";

export function useElapsedSeconds(startMs: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    // Card mounts already active (askedAt ≈ mount), initial `now` from useState
    // is current — no synchronous setState in the effect needed.
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  return Math.max(0, Math.round((now - startMs) / 1000));
}
