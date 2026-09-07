export const STRATEGIES = ['fallback', 'round-robin', 'fusion'];
export const shortHash = (value) => (value ? `${value.slice(0, 12)}…` : 'Not recorded');
export const utcTime = (value) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC')
    : 'Unknown time';
export const aliasTarget = (value) =>
  typeof value === 'string'
    ? value
    : value?.provider && value?.model
      ? `${value.provider}/${value.model}`
      : '';
export function editPlan(document, id, patch) {
  const previous = document.combos.find((plan) => plan.id === id);
  if (!previous) return document;
  if (
    patch.name !== undefined &&
    document.combos.some((plan) => plan.id !== id && plan.name === patch.name)
  )
    throw new Error('Another plan already uses that name.');
  const next = structuredClone(document);
  next.combos = next.combos.map((plan) => (plan.id === id ? { ...plan, ...patch } : plan));
  if (
    patch.name !== undefined &&
    patch.name !== previous.name &&
    Object.hasOwn(next.settings.comboStrategies || {}, previous.name)
  ) {
    next.settings.comboStrategies[patch.name] = next.settings.comboStrategies[previous.name];
    delete next.settings.comboStrategies[previous.name];
  }
  return next;
}
export function removePlan(document, id) {
  const previous = document.combos.find((plan) => plan.id === id);
  const next = structuredClone(document);
  next.combos = next.combos.filter((plan) => plan.id !== id);
  if (previous && next.settings.comboStrategies)
    delete next.settings.comboStrategies[previous.name];
  return next;
}
export function setPlanOverride(document, name, key, value) {
  const next = structuredClone(document);
  const overrides = (next.settings.comboStrategies ||= {});
  const selected = (overrides[name] ||= {});
  if (value === undefined) delete selected[key];
  else selected[key] = value;
  if (!Object.keys(selected).length) delete overrides[name];
  if (!Object.keys(overrides).length) delete next.settings.comboStrategies;
  return next;
}
export function scopeModel(scope, models = []) {
  if (!scope.model) return '';
  const match = models.find(
    (model) => model.model === scope.model && (!scope.provider || model.provider === scope.provider)
  );
  return match?.fullModel || (scope.provider ? `${scope.provider}/${scope.model}` : scope.model);
}
export async function policyRequest(path, method = 'GET', body) {
  let response, value;
  try {
    response = await fetch(path, {
      method,
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    value = await response.json();
  } catch {
    const error = new Error(method === 'GET' ? 'The current state could not be read.' : 'The response was interrupted. The operation may have been recorded. Read current state and receipts before another mutation.');
    error.code = method === 'GET' ? 'read_unavailable' : 'mutation_uncertain';
    throw error;
  }
  if (!response.ok) {
    const error = new Error(value.error || 'The policy operation could not complete.');
    error.code = value.code;
    error.status = response.status;
    error.details = value;
    throw error;
  }
  return value;
}
