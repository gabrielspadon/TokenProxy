// A tee branch may never settle cancellation until its sibling is consumed.
// Start cleanup before another dispatch without waiting on that dependency.
export function discardResponseBody(response) {
  try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch {}
}
