'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useObservationPolicy } from '@/shared/workspace/ObservationPolicy';

// Polls a JSON route. Keeps the last good body when a later read fails, so the
// screen can say "stale since" instead of going blank.
export function usePoll(url, intervalMs) {
  const observations = useObservationPolicy();
  const background = observations?.background ?? true;
  const mode = observations?.mode ?? 'live';
  const sharedRevision = observations?.revision ?? 0;
  const effectiveInterval = background ? intervalMs : 0;
  const requested = useRef(null);
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
    if (!url) { requested.current = null; return undefined; }
    const previous = requested.current;
    const same = previous?.url === url && previous.tick === tick && previous.sharedRevision === sharedRevision;
    if (!background && same && previous.complete) return undefined;
    if (!background && same && previous.background && mode === 'paused') {
      let current = true;
      Promise.resolve().then(() => { if (current) setR(old => ({ ...old, url, data: old.url === url ? old.data : null, loading: false, error: old.url === url ? old.error : null, goodAt: old.url === url ? old.goodAt : null })); });
      return () => { current = false; };
    }
    const requestIdentity = { url, tick, sharedRevision, background, complete: false };
    requested.current = requestIdentity;
    let alive = true;
    let historical = false;
    let timer;
    const controller = new AbortController();
    const run = async () => {
      requestIdentity.complete = false;
      try {
        setR(old => ({ ...old, url, data: old.url === url ? old.data : null, loading: old.url !== url || old.data == null, error: old.url === url ? old.error : null, status: old.url === url ? old.status : null, at: old.url === url ? old.at : null, goodAt: old.url === url ? old.goodAt : null }));
        const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
        historical = res.headers?.get('x-tokenproxy-preview') === 'historical-snapshot';
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
      requestIdentity.complete = true;
      if (alive && effectiveInterval && !historical) timer = setTimeout(run, effectiveInterval);
    };
    run();
    return () => {
      alive = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [url, effectiveInterval, tick, background, sharedRevision, mode]);

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
