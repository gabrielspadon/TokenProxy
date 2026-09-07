/**
 * Client setup: endpoint generation and a BOUNDED connectivity check.
 *
 * THE THREE TIERS ARE NOT A SPECTRUM, they are three different questions with
 * three different costs, and conflating them is how a "test connection" button
 * quietly bills an operator:
 *
 *   1. `configuration` — local only. Is the base URL well formed, is the key
 *      live, unexpired and within its ceilings, does the model it names fall
 *      inside its allowlist. Reaches NOTHING. Cannot fail for a network reason
 *      and cannot cost anything.
 *   2. `authentication` — one authenticated request to this gateway's own model
 *      catalog. Proves the key is accepted and the endpoint is reachable. Does
 *      not reach a provider and buys no tokens.
 *   3. `inference` — a real completion against a real provider, which COSTS
 *      MONEY. Deliberately not implemented here. It is a separate operator
 *      decision and no code path in this module reaches it.
 *
 * `runConnectivityCheck` refuses tier 3 outright rather than silently
 * downgrading, so a caller that asks for it is told it did not happen instead
 * of reading a pass that proved something weaker.
 */

export const CHECK_TIERS = {
  configuration: {
    reaches: 'nothing',
    cost: 'none',
    proves: 'The endpoint URL parses and the key is currently valid for the requested model.',
  },
  authentication: {
    reaches: 'this gateway',
    cost: 'none',
    proves: 'The gateway accepts this key over the network and will serve its model catalog.',
  },
  inference: {
    reaches: 'an upstream provider',
    cost: 'billed',
    proves: 'A real completion succeeded end to end.',
  },
};

// Tier 3 costs money, so it is not reachable from here at all. This is the list
// the route validates against.
export const RUNNABLE_TIERS = ['configuration', 'authentication'];

export function clientEndpoints(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return {
    baseUrl: base,
    // What a client is actually configured with. `/v1` is the OpenAI-compatible
    // surface; the Anthropic-style clients take the bare origin and append
    // their own path, which is why both are listed rather than one guessed for.
    openaiBaseUrl: `${base}/v1`,
    anthropicBaseUrl: base,
    modelsUrl: `${base}/v1/models`,
  };
}

/**
 * Tier 1. Pure, synchronous, and reaches nothing.
 *
 * @param {{baseUrl?: string, model?: string}} config
 * @param {object|null} key - a key record as the repo returns it, or null.
 * @param {(allowed: string[]|null, model: string) => boolean} matchesModel
 */
export function checkConfiguration(config, key, matchesModel) {
  const findings = [];
  try {
    const { protocol } = new URL(config?.baseUrl ?? '');
    if (!['http:', 'https:'].includes(protocol)) {
      findings.push({
        severity: 'error',
        code: 'unsupported_scheme',
        detail: 'The base URL must be http or https.',
      });
    }
  } catch {
    findings.push({
      severity: 'error',
      code: 'invalid_base_url',
      detail: 'The base URL could not be parsed.',
    });
  }

  if (!key) {
    findings.push({ severity: 'error', code: 'key_unknown', detail: 'No such key.' });
  } else {
    if (!key.isActive)
      findings.push({ severity: 'error', code: 'key_paused', detail: 'This key is paused.' });
    if (key.isExpired)
      findings.push({ severity: 'error', code: 'key_expired', detail: 'This key has expired.' });
    // A superseded key still works until its window closes. That is a warning,
    // never an error: telling an operator their working key is broken is how a
    // rotation gets abandoned halfway.
    if (key.supersededAt) {
      findings.push({
        severity: 'warning',
        code: 'key_superseded',
        detail: `This key was rotated and stops working at ${key.expiresAt ?? 'its expiry'}.`,
      });
    }
    if (config?.model && key.allowedModels && !matchesModel(key.allowedModels, config.model)) {
      findings.push({
        severity: 'error',
        code: 'model_not_allowed',
        detail: `This key's allowlist does not admit ${config.model}.`,
      });
    }
  }

  return {
    tier: 'configuration',
    ok: !findings.some((f) => f.severity === 'error'),
    reached: 'nothing',
    findings,
  };
}
