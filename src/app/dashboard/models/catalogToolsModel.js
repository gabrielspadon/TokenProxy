export const modelKey = (model) => JSON.stringify([model.providerAlias, model.id, model.type || 'llm']);

export function parseBulkImport(text) {
  const body = JSON.parse(text);
  const models = Array.isArray(body) ? body : body?.models;
  if (!Array.isArray(models) || !models.length || models.length > 1000) throw new Error('Supply 1–1000 model objects in an array or { models: [...] }.');
  if (models.some(model => !model || typeof model !== 'object' || Array.isArray(model))) throw new Error('Every entry must be a model object.');
  return models;
}

export function bulkDeleteUrl(providerAlias, type, ids) {
  if (!providerAlias || !ids.length) throw new Error('Choose a provider and at least one registered model.');
  const query = new URLSearchParams({ providerAlias, type: type || 'llm' });
  for (const id of ids) query.append('id', id);
  return `/api/models/custom?${query}`;
}

export function verifyCatalogAction(action, response, readback) {
  if (action.kind === 'import') {
    if (!Array.isArray(response?.results) || !Array.isArray(readback?.models)) return false;
    return response.results.length === action.models.length && response.results.every((result, index) => {
      if (!result.success) return true;
      const input = action.models[index];
      const saved = readback.models.find(model => modelKey(model) === modelKey(input));
      if (!saved) return false;
      if (!result.added) return true;
      return ['name', 'vision', 'maxInputTokens', 'maxOutputTokens'].every(field => {
        const value = input[field] ?? input[field === 'maxInputTokens' ? 'max_input_tokens' : field === 'maxOutputTokens' ? 'max_output_tokens' : field];
        return value === undefined || saved[field] === (field === 'name' && !value ? input.id : value);
      });
    });
  }
  if (action.kind === 'delete') {
    if (!Array.isArray(response?.results) || !Array.isArray(readback?.models)) return false;
    return response.results.length === action.ids.length && response.results.every(result => !result.success || !readback.models.some(model => model.providerAlias === action.provider && (model.type || 'llm') === action.type && model.id === result.id));
  }
  if (action.kind === 'cooldown') return Array.isArray(readback?.models) && !readback.models.some(model => model.provider === action.provider && model.model === action.model && model.status === 'cooldown');
  if (action.kind === 'sync') return Boolean(readback?.lastSync && (!action.previousSync || readback.lastSync > action.previousSync) && !readback.lastError && response?.result && Object.entries(response.result).every(([key, value]) => readback.lastResult?.[key] === value));
  if (action.kind === 'plan') return Array.isArray(readback?.combos) && readback.combos.some(combo => combo.name === action.name && JSON.stringify(combo.models) === JSON.stringify(action.models));
  return false;
}

export function diagnosticRows(body, models) {
  return Array.isArray(body?.results) ? body.results : [{ model: models[0], ...body }];
}
