// Read-only observation of the inference controller. Analytics never reserves
// its permits or changes its policy, and account mutations never wait here.
export function analyticsRefreshPolicy(snapshot = globalThis[Symbol.for('tokenproxy.resourceAdmission')]?.snapshot(), now = Date.now()) {
  const fresh = snapshot?.lastSample && now - snapshot.lastSample.at < 5000
    && Number.isFinite(snapshot.smoothedPressure) && snapshot.samples >= (snapshot.policy?.minSamples || 1);
  const overloaded = fresh && (snapshot.smoothedPressure > 1 || snapshot.queued > 0);
  const reduced = overloaded || !fresh;
  return { mode: reduced ? 'reduced' : 'normal', reason: overloaded ? 'gateway-pressure' : fresh ? 'gateway-healthy' : 'pressure-unavailable',
    refreshAfterMs: reduced ? 60000 : 15000, streamIntervalMs: reduced ? 5000 : 250 };
}
