"use client";
import { useEffect, useRef, useState } from "react";
import { useObservationPolicy } from '@/shared/workspace/ObservationPolicy';

// One EventSource per stream per page. Closed on unmount. Reconnects with
// exponential backoff capped at 30 s. Three failures in a row read as stale.
export function useEventStream(url, onMessage) {
  const observations = useObservationPolicy();
  const background = observations?.background ?? true;
  const [state, setState] = useState({ status: "connecting", lastDataAt: null, failures: 0 });
  const handler = useRef(onMessage);
  useEffect(() => { handler.current = onMessage; });

  useEffect(() => {
    if (!background || !url || typeof EventSource === "undefined") return undefined;
    let es;
    let timer;
    let failures = 0;
    let closed = false;
    let freshnessTimer;
    const open = () => {
      setState((s) => ({ ...s, status: failures ? "reconnecting" : "connecting" }));
      es = new EventSource(url);
      es.onopen = () => { failures = 0; setState((s) => ({ ...s, status: "connecting", failures: 0 })); };
      es.onmessage = (e) => {
        if (closed) return;
        let data;
        try { data = JSON.parse(e.data); } catch { return; }
        const projection = data?.projection;
        const observedAt = Date.parse(projection?.computedAt);
        const stale = projection?.stale || Number.isFinite(observedAt) && Date.now() - observedAt > 15000;
        const status = stale ? 'stale' : projection?.mode === 'reduced' ? 'reduced' : 'live';
        setState((s) => ({ ...s, status, reason: projection?.reason, lastDataAt: Number.isFinite(observedAt) ? observedAt : Date.now() }));
        clearTimeout(freshnessTimer);
        freshnessTimer = setTimeout(() => { if (!closed) setState(s => ({ ...s, status: 'stale' })); }, Number.isFinite(observedAt) ? Math.max(0, 15000 - (Date.now() - observedAt)) : 15000);
        handler.current?.(data);
      };
      es.onerror = () => {
        es.close();
        if (closed) return;
        failures += 1;
        setState((s) => ({ ...s, status: failures >= 3 ? "stale" : "reconnecting", failures }));
        timer = setTimeout(open, Math.min(30000, 1000 * 2 ** (failures - 1)));
      };
    };
    open();
    return () => { closed = true; clearTimeout(timer); clearTimeout(freshnessTimer); es?.close(); };
  }, [url, background]);

  return background ? state : { ...state, status: observations?.snapshot ? 'snapshot' : observations?.historical ? 'historical' : observations?.mode || 'paused' };
}
