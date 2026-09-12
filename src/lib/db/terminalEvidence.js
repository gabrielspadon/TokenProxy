// Only server-owned terminal evidence crosses the durable statistics boundary.
export const REQUEST_TERMINAL_COLUMNS = {
  terminalState: "TEXT CHECK (terminalState IS NULL OR terminalState IN ('succeeded','failed','cancelled','unknown'))",
  terminalReason: 'TEXT',
  terminalSource: "TEXT CHECK (terminalSource IS NULL OR terminalSource IN ('provider-stream','gateway-stream'))",
  terminalObservedAt: 'TEXT',
};

const REASONS = {
  'stream-complete': ['succeeded', 'provider-stream'],
  'upstream-error-event': ['failed', 'provider-stream'],
  'stream-error-event': ['failed', 'gateway-stream'],
  'caller-cancelled': ['cancelled', 'gateway-stream'],
  'terminal-evidence-overflow': ['unknown', 'gateway-stream'],
  'terminal-evidence-malformed': ['unknown', 'gateway-stream'],
  'missing-terminal': ['unknown', 'gateway-stream'],
  'unsupported-terminal': ['unknown', 'gateway-stream'],
  'stream-interrupted': ['unknown', 'gateway-stream'],
};

export function normalizeTerminalEvidence(value, status, observedAt = new Date().toISOString()) {
  if (value == null) return null;
  const expected = REASONS[value.reason];
  const matchingStatus = { succeeded: 'success', failed: 'error', cancelled: ['cancelled', 'aborted'], unknown: ['unknown', 'cancelled', 'aborted'] }[value.state];
  if (!expected || expected[0] !== value.state || expected[1] !== value.source
    || !(Array.isArray(matchingStatus) ? matchingStatus.includes(status) : matchingStatus === status)) {
    throw new Error('Invalid terminal evidence');
  }
  return { terminalState: value.state, terminalReason: value.reason, terminalSource: value.source, terminalObservedAt: observedAt };
}
