'use client';
import { useCallback, useEffect, useState } from 'react';

export function useResource(url, { onSnapshot, interval = 0 } = {}) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState({ url: null, data: null, loading: true, error: null, receivedAt: null });
  const refresh = useCallback(() => setRevision((r) => r + 1), []);
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    let timer;
    async function read() {
      try {
        const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
        if (response.headers.get('x-tokenproxy-preview') === 'historical-snapshot') {
          onSnapshot?.({ capturedAt: response.headers.get('x-tokenproxy-preview-captured-at'), isolated: true });
        }
        const body = await response.json();
        if (!response.ok) throw new Error(body?.error?.message || body?.error || `Data unavailable (${response.status})`);
        setState({ url, data: body, loading: false, error: null, receivedAt: new Date().toISOString() });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState((old) => ({ ...old, url, data: old.url === url ? old.data : null, loading: false, error: String(error.message) }));
      }
      if (interval && !controller.signal.aborted) timer = setTimeout(read, interval);
    }
    read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [url, revision, onSnapshot, interval]);
  const matching = state.url === url;
  return { ...state, data: matching ? state.data : null, loading: Boolean(url) && (!matching || state.loading), error: matching ? state.error : null, refresh };
}
