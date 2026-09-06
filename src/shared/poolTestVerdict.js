// The proxy-pool test route reports a completed-but-failed probe as HTTP 200
// with body ok:false, so a transport-level 2xx alone can never mean
// "Reachable." — the body's own verdict rules.
export function poolTestVerdict(res, refusal) {
  if (res.ok && res.body?.ok === true) return { tone: 'ok', title: 'Reachable.' };
  if (res.ok) {
    return {
      tone: 'error',
      title: 'Unreachable.',
      detail: res.body?.error || `Probe failed with status ${res.body?.status ?? 'unknown'}.`,
    };
  }
  return refusal(res.status, res.body);
}
