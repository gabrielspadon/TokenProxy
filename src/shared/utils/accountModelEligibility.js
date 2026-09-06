/** A nonempty account model selection is its routing allowlist. */
export function accountSupportsModel(account, model) {
  const enabled = account?.providerSpecificData?.enabledModels;
  if (!model || !Array.isArray(enabled) || enabled.length === 0) return true;
  return enabled.includes(model) || enabled.includes(`${account.provider}/${model}`);
}

/** Match a named model subquota without applying it to other model families. */
export function scopeAppliesToModel(scope, model) {
  if (typeof model !== 'string' || !model) return false;
  const qualifier = String(scope ?? '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .replace(/\b(?:per[-_ ]?model|model|session|rate[-_ ]?limit|hourly|daily|weekly|monthly|annual|yearly)\b/gi, ' ')
    .replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
  if (!qualifier) return false;
  const normalized = ` ${model.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  return normalized.includes(` ${qualifier} `);
}
