export const DIAGNOSTIC_RESPONSE_LIMIT = 1024 * 1024;

// The response is a bounded diagnostic preview, not retained run evidence.
export async function sendDiagnostic(body, signal) {
  try {
    const response = await fetch('/api/translator/send', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal,
    });
    const metadata = {
      connectionId: response.headers.get('x-tokenproxy-connection-id'),
      scope: response.headers.get('x-tokenproxy-diagnostic-scope'),
      credentialRefreshed: response.headers.has('x-tokenproxy-credential-refreshed')
        ? response.headers.get('x-tokenproxy-credential-refreshed') === 'true' : null,
    };
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let raw = '', bytes = 0, complete = true;
    try {
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = DIAGNOSTIC_RESPONSE_LIMIT - bytes;
        bytes += value.byteLength;
        raw += decoder.decode(value.subarray(0, Math.max(0, remaining)), { stream: true });
        if (bytes > DIAGNOSTIC_RESPONSE_LIMIT) {
          complete = false;
          await reader.cancel();
          break;
        }
      }
      raw += decoder.decode();
    } finally { reader?.releaseLock(); }
    let errorBody;
    if (!response.ok) {
      try { errorBody = JSON.parse(raw); }
      catch { errorBody = { error: `Diagnostic response HTTP ${response.status}`, details: raw }; }
    }
    return { ok: response.ok, status: response.status, metadata, body: response.ok ? { raw, complete } : { ...errorBody, complete } };
  } catch (error) {
    return { ok: false, status: signal?.aborted ? 499 : 0, body: { error: error.message, code: signal?.aborted ? 'cancelled' : 'network' } };
  }
}
