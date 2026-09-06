'use client';
import { useCallback, useEffect, useState } from 'react';

// Polls a JSON route. Keeps the last good body when a later read fails, so the
// screen can say "stale since" instead of going blank.
export function usePoll(url, intervalMs) {
  const [r, setR] = useState({
    data: null,
    error: null,
    status: null,
    loading: true,
    at: null,
    goodAt: null,
  });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!url) return undefined;
    let alive = true;
    let timer;
    const controller = new AbortController();
    const run = async () => {
      try {
        const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
        const body = await res.json().catch(() => null);
        if (!alive) return;
        setR((s) => ({
          url,
          data: res.ok ? body : s.url === url ? s.data : null,
          error: res.ok ? null : body || {},
          status: res.status,
          loading: false,
          at: Date.now(),
          goodAt: res.ok ? Date.now() : s.url === url ? s.goodAt : null,
        }));
      } catch (e) {
        if (alive)
          setR((s) => ({
            ...(s.url === url ? s : { data: null, goodAt: null }),
            url,
            error: { error: e.message, code: 'network' },
            status: 0,
            loading: false,
            at: Date.now(),
          }));
      }
      if (alive && intervalMs) timer = setTimeout(run, intervalMs);
    };
    run();
    return () => {
      alive = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [url, intervalMs, tick]);

  return r.url === url
    ? { ...r, refresh }
    : {
        data: null,
        error: null,
        status: null,
        loading: Boolean(url),
        at: null,
        goodAt: null,
        refresh,
      };
}
