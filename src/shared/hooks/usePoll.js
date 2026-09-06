"use client";
import { useCallback, useEffect, useState } from "react";

// Polls a JSON route. Keeps the last good body when a later read fails, so the
// screen can say "stale since" instead of going blank.
export function usePoll(url, intervalMs) {
  const [r, setR] = useState({ data: null, error: null, status: null, loading: true, at: null, goodAt: null });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!url) return undefined;
    let alive = true;
    let timer;
    const run = async () => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        const body = await res.json().catch(() => null);
        if (!alive) return;
        setR((s) => ({
          data: res.ok ? body : s.data,
          error: res.ok ? null : body || {},
          status: res.status,
          loading: false,
          at: Date.now(),
          goodAt: res.ok ? Date.now() : s.goodAt,
        }));
      } catch (e) {
        if (alive) setR((s) => ({ ...s, error: { error: e.message, code: "network" }, status: 0, loading: false, at: Date.now() }));
      }
      if (alive && intervalMs) timer = setTimeout(run, intervalMs);
    };
    run();
    return () => { alive = false; clearTimeout(timer); };
  }, [url, intervalMs, tick]);

  return { ...r, refresh };
}
