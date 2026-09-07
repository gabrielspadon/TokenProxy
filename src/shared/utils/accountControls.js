// Only operator policy participates in conflicts; credential and quota refreshes do not.
export function captureAccountControls(connection) {
  const thresholds = connection.quotaPauseThresholds ?? {};
  return {
    isActive: connection.isActive !== false,
    priority: connection.priority ?? null,
    quotaPauseThresholds: Object.fromEntries(
      Object.keys(thresholds).sort().map(key => [key, thresholds[key]]),
    ),
  };
}
