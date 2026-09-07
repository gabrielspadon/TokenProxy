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
    const open = () => {
      setState((s) => ({ ...s, status: failures ? "reconnecting" : "connecting" }));
      es = new EventSource(url);
      es.onopen = () => { failures = 0; setState((s) => ({ ...s, status: "live", failures: 0 })); };
      es.onmessage = (e) => {
        if (closed) return;
        let data;
        try { data = JSON.parse(e.data); } catch { return; }
        setState((s) => ({ ...s, status: "live", lastDataAt: Date.now() }));
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
    return () => { closed = true; clearTimeout(timer); es?.close(); };
  }, [url, background]);

  return background ? state : { ...state, status: observations?.snapshot ? 'snapshot' : observations?.historical ? 'historical' : observations?.mode || 'paused' };
}
