import { matchPattern } from 'open-sse/providers/pricing.js';

export function overrideCandidates(provider, model) {
  const basename = model.split('/').pop();
  return [
    { key: `${provider}/${model}`, scope: 'Provider / raw model' },
    { key: `${provider}/${basename}`, scope: 'Provider / basename' },
    { key: basename, scope: 'Basename across providers' },
    { key: model, scope: 'Raw model across providers' },
  ];
}

export function resolveWindowOverride(overrides, provider, model) {
  const candidates = overrideCandidates(provider, model);
  for (const candidate of candidates) {
    if (Object.hasOwn(overrides, candidate.key)) return candidate;
  }
  for (const key of Object.keys(overrides)) {
    if (key.includes('*') && candidates.some(candidate => matchPattern(key, candidate.key))) {
      return { key, scope: 'Wildcard, first matching saved key' };
    }
  }
  return null;
}

export function parseWindow(value) {
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
