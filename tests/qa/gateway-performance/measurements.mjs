export function quantiles(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const q = p => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
  return { samples: sorted.length, min: sorted[0] ?? null, p50: q(.5), p95: q(.95), p99: q(.99), max: sorted.at(-1) ?? null };
}

export function requestFailed(record) {
  return Boolean(record.error || (!record.abortAt && (record.status !== 200 || !record.terminal || record.useful.length === 0)) || record.useful.some((value, index) => value.id !== record.id || value.index !== index));
}

export function outsideProviderMs(record, provider) {
  return record.useful.length && provider?.writes.length
    ? (provider.receivedAt - record.startedAt) + (record.useful[0].at - provider.writes[0]) : NaN;
}
