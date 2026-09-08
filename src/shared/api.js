// One JSON call. Never throws; a network failure is status 0 with code "network".
export async function call(url, { method = "GET", body, headers, signal } = {}) {
  try {
    const res = await fetch(url, {
      method,
      signal,
      cache: "no-store",
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body: json };
  } catch (e) {
    return { ok: false, status: 0, body: { error: signal?.aborted ? "Request cancelled" : e.message, code: signal?.aborted ? "cancelled" : "network" } };
  }
}
