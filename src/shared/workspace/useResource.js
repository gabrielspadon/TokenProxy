'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useObservationPolicy } from './ObservationPolicy';

export function useResource(url, { onSnapshot, interval } = {}) {
  const observations = useObservationPolicy();
  const background = observations?.background ?? true;
  const mode = observations?.mode ?? 'live';
  const sharedRevision = observations?.revision ?? 0;
  const intervalMs = background ? interval ?? (observations ? 15000 : 0) : 0;
  const requested = useRef(null);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState({
    url: null,
    data: null,
    loading: true,
    error: null,
    receivedAt: null,
  });
  const refresh = useCallback(() => setRevision((r) => r + 1), []);
  useEffect(() => {
    if (!url) { requested.current = null; return; }
    const previous = requested.current;
    const same = previous?.url === url && previous.revision === revision && previous.sharedRevision === sharedRevision;
    if (!background && same && previous.complete) return;
    if (!background && same && previous.background && mode === 'paused') {
      let current = true;
      // The previous effect has aborted the read. Settle that cancellation
      // independently from the mode so later explicit reads can still load.
      Promise.resolve().then(() => { if (current) setState(old => ({ ...old, url, data: old.url === url ? old.data : null, loading: false, error: old.url === url ? old.error : null, receivedAt: old.url === url ? old.receivedAt : null })); });
      return () => { current = false; };
    }
    const requestIdentity = { url, revision, sharedRevision, background, complete: false };
    requested.current = requestIdentity;
    const controller = new AbortController();
    let timer;
    let historical = false;
    let suggestedInterval = 0;
    async function read() {
      requestIdentity.complete = false;
      try {
        setState(old => ({ ...old, url, data: old.url === url ? old.data : null, loading: old.url !== url || old.data == null, error: old.url === url ? old.error : null, receivedAt: old.url === url ? old.receivedAt : null }));
        const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
        if (response.headers.get('x-tokenproxy-preview') === 'historical-snapshot') {
          historical = true;
          onSnapshot?.({
            capturedAt: response.headers.get('x-tokenproxy-preview-captured-at'),
            isolated: true,
            ...(response.headers.get('x-tokenproxy-preview-kind') === 'synthetic-fixture'
              ? { kind: 'synthetic-fixture' }
              : {}),
          });
        }
        const suggested = Number(response.headers.get('x-tokenproxy-refresh-after-ms'));
        suggestedInterval = Number.isFinite(suggested) && suggested >= 0 ? Math.min(120000, suggested) : 0;
        const body = await response.json();
        if (controller.signal.aborted) return;
        if (!response.ok)
          throw new Error(
            body?.error?.message || body?.error || `Data unavailable (${response.status})`
          );
        setState({
          url,
          data: body,
          loading: false,
          error: null,
          receivedAt: new Date().toISOString(),
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState((old) => ({
          ...old,
          url,
          data: old.url === url ? old.data : null,
          loading: false,
          error: String(error.message),
        }));
      }
      requestIdentity.complete = true;
      if (intervalMs && !historical && !controller.signal.aborted) timer = setTimeout(read, Math.max(intervalMs, suggestedInterval));
    }
    read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [url, revision, onSnapshot, intervalMs, background, sharedRevision, mode]);
  const matching = state.url === url;
  return {
    ...state,
    data: matching ? state.data : null,
    loading: Boolean(url) && (!matching || state.loading),
    error: matching ? state.error : null,
    refresh,
  };
}
