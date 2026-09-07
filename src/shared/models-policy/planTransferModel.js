const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const strategies = ['fallback', 'round-robin', 'fusion'];
const allowed = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\s\u0000-\u001f]|:\/\//.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);

export function preparePlanImport(text, current, { createId = () => crypto.randomUUID(), excludeCapacityAdapter = false } = {}) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > 256000) throw new Error('Plan files are limited to 256 KB.');
  let source;
  try { source = JSON.parse(text); } catch { throw new Error('Enter a valid JSON plan export.'); }
  if (!allowed(source, ['version', 'exportedAt', 'combos', 'capacityAdapter']) || ![1, 2].includes(source.version) || !Array.isArray(source.combos) || source.combos.length === 0) throw new Error('Use a version 1 or 2 plan export with at least one plan. Unknown fields are refused.');
  if (source.capacityAdapter != null && !excludeCapacityAdapter) throw new Error('This file also contains capacity adapter settings. Acknowledge their exclusion before reviewing plans.');
  const document = structuredClone(current), names = new Set(), added = [], updated = [];
  for (const plan of source.combos) {
    if (!allowed(plan, ['name', 'kind', 'models', 'strategy', 'roundRobin']) || !identifier(plan.name) || !/^[a-zA-Z0-9_.-]+$/.test(plan.name) || names.has(plan.name)) throw new Error('Each plan needs a unique valid name and supported fields.');
    if (!(plan.kind == null || ['llm', 'webSearch', 'webFetch'].includes(plan.kind)) || !Array.isArray(plan.models) || !plan.models.every(identifier)) throw new Error('Plan kinds and ordered model identifiers must be valid.');
    if ('roundRobin' in plan && typeof plan.roundRobin !== 'boolean') throw new Error('Legacy roundRobin must be a boolean.');
    if (plan.strategy != null && (!allowed(plan.strategy, ['fallbackStrategy', 'judgeModel']) || ('fallbackStrategy' in plan.strategy && !strategies.includes(plan.strategy.fallbackStrategy)) || ('judgeModel' in plan.strategy && !identifier(plan.strategy.judgeModel)))) throw new Error('A strategy may contain only fallbackStrategy and an exact judgeModel.');
    if (plan.strategy != null && 'roundRobin' in plan) throw new Error('A plan cannot specify both legacy roundRobin and an explicit strategy.');
    names.add(plan.name);
    const index = document.combos.findIndex(item => item.name === plan.name);
    const next = { id: index >= 0 ? document.combos[index].id : createId(), name: plan.name, kind: plan.kind ?? null, models: [...plan.models] };
    if (index >= 0) { document.combos[index] = next; updated.push(plan.name); }
    else { document.combos.push(next); added.push(plan.name); }
    const overrides = (document.settings.comboStrategies ||= {});
    const previous = overrides[plan.name] || {};
    const { judgeModel: previousJudge, ...retained } = previous;
    void previousJudge;
    overrides[plan.name] = { ...retained, fallbackStrategy: plan.strategy?.fallbackStrategy || (plan.roundRobin ? 'round-robin' : 'fallback'), ...(plan.strategy?.judgeModel ? { judgeModel: plan.strategy.judgeModel } : {}) };
  }
  return { document, added, updated, retained: current.combos.filter(plan => !names.has(plan.name)).map(plan => plan.name), excludedCapacityAdapter: source.capacityAdapter != null };
}
