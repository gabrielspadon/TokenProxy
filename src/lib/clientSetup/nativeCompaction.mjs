// Observed in the unmodified Claude Code 2.1.263 runtime. Other versions must
// be inspected again; this is a calculation, never a live client measurement.
export function nativeCompactionBoundary({ version, advertisedContext, resolvedWindow, maxOutput, percent = 100 }) {
  const unknown = { version, advertisedContext: Number.isSafeInteger(advertisedContext) ? advertisedContext : null, source: 'unavailable', outputReserve: null, compactionReserve: null, effectiveWindow: null, threshold: null };
  if (version !== '2.1.263' || ![resolvedWindow, maxOutput].every(n => Number.isSafeInteger(n) && n > 0) || resolvedWindow < 100000 || resolvedWindow > 1000000 || !Number.isFinite(percent) || percent <= 0 || percent > 100) return unknown;
  const outputReserve = Math.min(maxOutput, 20000), effectiveWindow = resolvedWindow - outputReserve;
  return { ...unknown, source: 'installed-source-calculation', resolvedWindow, outputReserve, effectiveWindow, compactionReserve: 13000, percent, threshold: Math.min(Math.floor(effectiveWindow * percent / 100), effectiveWindow - 13000) };
}
