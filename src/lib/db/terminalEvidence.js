import { FORMATS } from '../../../open-sse/translator/formats.js';

// Only server-owned terminal evidence crosses the durable statistics boundary.
export const REQUEST_TERMINAL_COLUMNS = {
  terminalState: "TEXT CHECK (terminalState IS NULL OR terminalState IN ('succeeded','failed','cancelled','unknown'))",
  terminalReason: 'TEXT',
  terminalSource: "TEXT CHECK (terminalSource IS NULL OR terminalSource IN ('provider-stream','gateway-stream','provider-json','provider-http','gateway-response'))",
  terminalObservedAt: 'TEXT',
};

const REASONS = {
  'stream-complete': ['succeeded', 'provider-stream'],
  'upstream-error-event': ['failed', 'provider-stream'],
  'json-complete': ['succeeded', 'provider-json'],
  'upstream-error-response': ['failed', 'provider-json'],
  'upstream-http-error': ['failed', 'provider-http'],
  'response-rejected': ['unknown', 'gateway-response'],
  'json-terminal-unconfirmed': ['unknown', 'gateway-response'],
  'stream-error-event': ['failed', 'gateway-stream'],
  'caller-cancelled': ['cancelled', ['gateway-stream', 'gateway-response']],
  'terminal-evidence-overflow': ['unknown', 'gateway-stream'],
  'terminal-evidence-malformed': ['unknown', 'gateway-stream'],
  'missing-terminal': ['unknown', 'gateway-stream'],
  'unsupported-terminal': ['unknown', 'gateway-stream'],
  'stream-interrupted': ['unknown', 'gateway-stream'],
};

export function normalizeTerminalEvidence(value, status, observedAt = new Date().toISOString()) {
  if (value == null) return null;
  const expected = REASONS[value.reason];
  const matchingStatus = { succeeded: 'success', failed: 'error', cancelled: ['cancelled', 'aborted'], unknown: ['unknown', 'cancelled', 'aborted', 'error'] }[value.state];
  if (!expected || expected[0] !== value.state || !(Array.isArray(expected[1]) ? expected[1].includes(value.source) : expected[1] === value.source)
    || !(Array.isArray(matchingStatus) ? matchingStatus.includes(status) : matchingStatus === status)) {
    throw new Error('Invalid terminal evidence');
  }
  return { terminalState: value.state, terminalReason: value.reason, terminalSource: value.source, terminalObservedAt: observedAt };
}

export function classifyJsonTerminalEvidence(body, format) {
  const value = body?.data?.choices ? body.data : body;
  if (value?.error || ['failed', 'incomplete', 'cancelled'].includes(value?.status)) {
    return { state: 'failed', reason: 'upstream-error-response', source: 'provider-json' };
  }
  const complete = format === FORMATS.OPENAI_RESPONSES ? value?.status === 'completed'
    : format === FORMATS.CLAUDE ? value?.type === 'message' && typeof value.stop_reason === 'string' && value.stop_reason.length > 0
      : format === FORMATS.OPENAI ? Array.isArray(value?.choices) && value.choices.length > 0
        && value.choices.every((choice) => typeof choice?.finish_reason === 'string' && choice.finish_reason.length > 0)
        : false;
  return complete ? { state: 'succeeded', reason: 'json-complete', source: 'provider-json' }
    : { state: 'unknown', reason: 'json-terminal-unconfirmed', source: 'gateway-response' };
}

export function classifyHttpTerminalEvidence(response) {
  // A synthetic executor response lacks fetch's response URL and needs its
  // own provenance. A status number alone is insufficient attribution.
  return response instanceof Response && /^https?:\/\//.test(response.url || '')
    && response.status >= 400 && response.status <= 599
    ? { state: 'failed', reason: 'upstream-http-error', source: 'provider-http' }
    : { state: 'unknown', reason: 'response-rejected', source: 'gateway-response' };
}
