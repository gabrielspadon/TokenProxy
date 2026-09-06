import { resolveProviderAlias } from 'open-sse/services/model.js';

/**
 * Account lists override the inherited provider list, including an explicit [].
 * Alias-equivalent duplicate lists share one scope; any explicit disable in
 * that scope wins, regardless of which provider spelling the request uses.
 * Models remain exact identifiers, including slashes inside an upstream ID.
 */
export function isAccountModelDisabled(disabledMap, provider, model, connectionId = null) {
  if (!disabledMap || typeof disabledMap !== 'object' || !provider || typeof model !== 'string' || !model) {
    return false;
  }
  const providerId = resolveProviderAlias(provider);
  const modelId = (value) => {
    if (typeof value !== 'string') return null;
    const slash = value.indexOf('/');
    return slash > 0 && resolveProviderAlias(value.slice(0, slash)) === providerId
      ? value.slice(slash + 1)
      : value;
  };
  const requested = modelId(model);
  const inherited = [];
  const own = [];
  for (const [key, ids] of Object.entries(disabledMap)) {
    if (!Array.isArray(ids)) continue;
    const separator = key.indexOf('::');
    const prefix = separator < 0 ? key : key.slice(0, separator);
    if (resolveProviderAlias(prefix) !== providerId) continue;
    if (separator < 0) inherited.push(ids);
    else if (connectionId && key.slice(separator + 2) === connectionId) own.push(ids);
  }
  return (own.length ? own : inherited).some((ids) => ids.some((id) => modelId(id) === requested));
}
