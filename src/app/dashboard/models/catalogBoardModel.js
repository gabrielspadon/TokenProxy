// The catalog is one population, not five lists. A model that a provider just
// started advertising, one an operator disabled, one registered by hand and one
// carrying an alias are all catalog entries in different states, so they share a
// board and each state is a filter chip.
export const BUCKETS = [
  { id: 'new', label: 'Newly observed', tone: 'ember' },
  { id: 'disabled', label: 'Disabled', tone: 'refusal' },
  { id: 'aliased', label: 'Aliased', tone: 'positive' },
  { id: 'custom', label: 'Registered by hand', tone: null },
  { id: 'catalog', label: 'Offered', tone: null },
];

export const SORTS = [
  { value: 'name', label: 'Model id' },
  { value: 'context', label: 'Largest context' },
  { value: 'provider', label: 'Provider' },
];

const aliasList = (model) =>
  model.aliases?.length
    ? model.aliases
    : model.alias && model.alias !== model.model
      ? [model.alias]
      : [];

// One entry per identity. `/api/models` is the offered catalog, so a disabled or
// newly observed id that the gateway filters out of it still has to appear here
// or its control has nowhere to live.
export function catalogEntries({ models = [], disabled = {}, custom = [], groups = [] } = {}) {
  const customKeys = new Set(custom.map((row) => `${row.providerAlias}/${row.id}`));
  const entries = new Map();
  const add = (entry) => entries.set(entry.id, { ...entries.get(entry.id), ...entry });
  for (const model of models) {
    const id = model.fullModel || `${model.provider}/${model.model}`;
    add({
      id,
      provider: model.provider,
      model: model.model,
      name: model.name || model.model,
      providerName: model.provider,
      aliases: aliasList(model),
      caps: model.caps || {},
      context: model.caps?.contextWindow ?? null,
      output: model.caps?.maxOutput ?? null,
      custom: customKeys.has(id),
      disabled: false,
      unseen: false,
      source: model,
    });
  }
  for (const [providerAlias, ids] of Object.entries(disabled || {}))
    for (const id of ids || [])
      add({
        id: `${providerAlias}/${id}`,
        provider: providerAlias,
        model: id,
        name: entries.get(`${providerAlias}/${id}`)?.name || id,
        providerName: providerAlias,
        aliases: entries.get(`${providerAlias}/${id}`)?.aliases || [],
        caps: entries.get(`${providerAlias}/${id}`)?.caps || {},
        context: entries.get(`${providerAlias}/${id}`)?.context ?? null,
        output: entries.get(`${providerAlias}/${id}`)?.output ?? null,
        custom: customKeys.has(`${providerAlias}/${id}`),
        disabled: true,
      });
  for (const group of groups || [])
    for (const model of group.models || [])
      add({
        id: `${group.providerAlias}/${model.modelId}`,
        provider: group.providerAlias,
        model: model.modelId,
        name: entries.get(`${group.providerAlias}/${model.modelId}`)?.name || model.modelId,
        providerName: group.providerName || group.providerAlias,
        aliases: entries.get(`${group.providerAlias}/${model.modelId}`)?.aliases || [],
        caps: entries.get(`${group.providerAlias}/${model.modelId}`)?.caps || {},
        context: entries.get(`${group.providerAlias}/${model.modelId}`)?.context ?? null,
        output: entries.get(`${group.providerAlias}/${model.modelId}`)?.output ?? null,
        custom: customKeys.has(`${group.providerAlias}/${model.modelId}`),
        unseen: true,
        free: model.isFree,
        brandNew: model.isNew,
      });
  return [...entries.values()];
}

export function catalogBucket(entry) {
  if (entry.disabled) return 'disabled';
  if (entry.unseen) return 'new';
  if (entry.aliases?.length) return 'aliased';
  if (entry.custom) return 'custom';
  return 'catalog';
}

export function catalogSummary(entries) {
  const summary = Object.fromEntries(BUCKETS.map((bucket) => [bucket.id, 0]));
  for (const entry of entries) summary[catalogBucket(entry)] += 1;
  return summary;
}

export function filterCatalog(entries, { query = '', bucket = null } = {}) {
  const needle = query.trim().toLowerCase();
  return entries.filter(
    (entry) =>
      (!bucket || catalogBucket(entry) === bucket) &&
      (!needle ||
        `${entry.id} ${entry.name} ${entry.providerName} ${(entry.aliases || []).join(' ')}`
          .toLowerCase()
          .includes(needle))
  );
}

export function sortCatalog(entries, sort = 'name') {
  const byName = (a, b) => a.id.localeCompare(b.id);
  return [...entries].sort((a, b) => {
    if (sort === 'context') return (b.context ?? -1) - (a.context ?? -1) || byName(a, b);
    if (sort === 'provider') return a.provider.localeCompare(b.provider) || byName(a, b);
    return byName(a, b);
  });
}

export const capabilityWords = (caps = {}) =>
  [caps.vision && 'Vision', caps.search && 'Search', caps.reasoning && 'Reasoning'].filter(Boolean);

// capacityAdapter must PATCH as the full four-key object: settingsRepo's
// updateSettings() merge list excludes it, so a partial write would drop the
// other three capabilities back to whatever the seeded defaults hold.
export function buildCapacityBody(current, key, patch) {
  const base = current || {};
  const next = {};
  for (const kind of ['vision', 'pdf', 'audioInput', 'videoInput']) {
    const held = base[kind] || { enabled: false, roundRobin: false, models: [] };
    next[kind] =
      kind === key
        ? {
            enabled: patch.enabled ?? held.enabled ?? false,
            roundRobin: patch.roundRobin ?? held.roundRobin ?? false,
            models: patch.models ?? held.models ?? [],
          }
        : held;
  }
  return next;
}
