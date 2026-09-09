import { AI_PROVIDERS, ALIAS_TO_ID } from '@/shared/constants/providers';

// The providers most people add first. They lead the add-account list under a
// "Popular" heading and still appear in the full list below it.
export const POPULAR_PROVIDERS = [
  'claude',
  'codex',
  'openai',
  'anthropic',
  'gemini',
  'gemini-cli',
  'github',
  'deepseek',
  'xai',
  'openrouter',
  'ollama',
  'kimi',
  'mistral',
  'groq',
];
const POPULAR_PREFIX = 'popular:';

// Model rows carry the provider alias (cx for codex); accounts carry the id.
export const providerIdOf = (key) => ALIAS_TO_ID[key] || key;

function providerKeys(id) {
  return [id, AI_PROVIDERS[id]?.alias].filter(Boolean);
}

// Only the models a person can actually route to: those of providers with at
// least one configured account, optionally narrowed to one provider.
export function modelsForAccounts(models, accounts, provider = null) {
  const configured = new Set(accounts.flatMap((account) => providerKeys(account.provider)));
  const wanted = provider ? new Set(providerKeys(provider)) : null;
  return models.filter(
    (model) => configured.has(model.provider) && (!wanted || wanted.has(model.provider))
  );
}

// Grouped options for the add-account provider select. Popular entries carry a
// prefixed value so the same provider can appear in both groups.
export function providerChoices(entries) {
  const label = (entry) => entry.name || entry.id;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const popular = POPULAR_PROVIDERS.filter((id) => byId.has(id)).map((id) => ({
    value: `${POPULAR_PREFIX}${id}`,
    label: label(byId.get(id)),
  }));
  const all = [...entries]
    .sort((a, b) => label(a).localeCompare(label(b)))
    .map((entry) => ({ value: entry.id, label: label(entry) }));
  return [
    ...(popular.length ? [{ group: 'Popular', items: popular }] : []),
    { group: 'All providers', items: all },
  ];
}

export const providerChoiceId = (value) =>
  value?.startsWith(POPULAR_PREFIX) ? value.slice(POPULAR_PREFIX.length) : value;
