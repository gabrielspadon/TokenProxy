import { resolveProviderAlias } from 'open-sse/services/model.js';
import REGISTRY from 'open-sse/providers/registry/index.js';

const providerIds = new Set(REGISTRY.map((entry) => entry.id));
const nodeTypes = ['openai-compatible', 'anthropic-compatible', 'multi-compatible', 'custom-embedding'];

/** Policy writes name canonical IDs directly; configured prefixes own aliases. */
export function resolveDisabledModelProvider(value, providerNodes = []) {
  if (providerIds.has(value) || providerNodes.some((node) => node.id === value)) return value;
  for (const type of nodeTypes) {
    const node = providerNodes.find((entry) => entry.type === type && entry.prefix === value);
    if (node) return node.id;
  }
  return resolveProviderAlias(value);
}

/**
 * Account lists override the inherited provider list, including an explicit [].
 * Alias-equivalent duplicate lists share one scope; any explicit disable in
 * that scope wins, regardless of which provider spelling the request uses.
 * Models remain exact identifiers, including slashes inside an upstream ID.
 */
export function isAccountModelDisabled(disabledMap, provider, model, connectionId = null, providerAliases = [], providerNodes = []) {
  if (!disabledMap || typeof disabledMap !== 'object' || !provider || typeof model !== 'string' || !model) {
    return false;
  }
  const providerId = resolveDisabledModelProvider(provider, providerNodes);
  // A configured provider node has a dynamic prefix outside the static registry.
  const matchesProvider = (value) =>
    resolveDisabledModelProvider(value, providerNodes) === providerId
    || (!providerNodes.length && !providerIds.has(value) && providerAliases.includes(value));
  const modelId = (value) => {
    if (typeof value !== 'string') return null;
    const slash = value.indexOf('/');
    return slash > 0 && (matchesProvider(value.slice(0, slash)) || providerAliases.includes(value.slice(0, slash)))
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
    if (!matchesProvider(prefix)) continue;
    if (separator < 0) inherited.push(ids);
    else if (connectionId && key.slice(separator + 2) === connectionId) own.push(ids);
  }
  return (own.length ? own : inherited).some((ids) => ids.some((id) => modelId(id) === requested));
}
