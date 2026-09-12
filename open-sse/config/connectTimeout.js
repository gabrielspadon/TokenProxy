export const CONNECT_TIMEOUT_DEFAULT_MS = 15000;
export const CONNECT_TIMEOUT_MIN_MS = 1000;
export const CONNECT_TIMEOUT_MAX_MS = 120000;
export const FALLBACK_BUDGET_MS = 120000;

export function isValidConnectTimeoutMs(value) {
  return Number.isFinite(value)
    && Number.isInteger(value)
    && value >= CONNECT_TIMEOUT_MIN_MS
    && value <= CONNECT_TIMEOUT_MAX_MS;
}

export function resolveConnectTimeoutMs({
  providerOverride,
  registryTimeout,
  globalTimeout,
  envTimeout,
} = {}) {
  return [providerOverride, registryTimeout, globalTimeout, envTimeout]
    .find(isValidConnectTimeoutMs);
}
