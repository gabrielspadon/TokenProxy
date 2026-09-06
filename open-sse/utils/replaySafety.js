// The wire permission belongs to the attempt that produced this response.
// Absence is deliberately false because transport and parse failures can occur
// after an accepted, billable request even when their local status is 502.
export function withReplaySafety(response, safeToReplay = false, retryAfterMs = 0) {
  response.headers.set('x-tokenproxy-replay-safe', String(safeToReplay === true));
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0 && !response.headers.has('retry-after')) response.headers.set('retry-after', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  return response;
}
