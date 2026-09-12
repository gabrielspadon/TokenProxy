// Origin belongs to the server process. Request bodies, headers and provider
// usage objects cannot label their own telemetry as production or test.
export function processTelemetryOrigin() {
  const override = process.env.TOKENPROXY_TELEMETRY_ORIGIN;
  if (override) return override === 'test' ? 'test' : 'unknown';
  return process.env.NODE_ENV === 'test' ? 'test' : 'production';
}
