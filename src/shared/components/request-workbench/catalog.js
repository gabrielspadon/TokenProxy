import { AI_PROVIDERS, getProviderByAlias } from '@/shared/constants/providers';
import { PROVIDER_MODELS, getModelKind } from '@/shared/constants/models';

// Rerank's provider allowlist currently belongs to open-sse/handlers/rerankCore.js.
const rerankProviders = new Set(['cohere', 'jina-ai', 'together', 'siliconflow', 'voyage-ai']);
export function supportsOperation(provider, operation) {
  if (!provider) return false;
  if (operation.kind === 'video') return Boolean(provider.videoConfig) && (operation.id === 'video-generate' || operation.id === 'video-poll' || provider.videoConfig.adapter !== 'gemini');
  if (operation.kind === 'rerank') return rerankProviders.has(provider.id);
  if (operation.kind === 'webSearch') return Boolean(provider.searchConfig || provider.searchViaChat);
  if (operation.kind === 'webFetch') return Boolean(provider.fetchConfig);
  if (operation.kind === 'ocr') return Boolean(provider.ocrConfig);
  if (operation.kind === 'moderation') return Boolean(provider.moderationConfig);
  if (operation.kind === 'llm') return !provider.serviceKinds || provider.serviceKinds.includes('llm');
  return provider.serviceKinds?.includes(operation.kind) === true;
}

export function localCatalogue(operation) {
  const models = new Map();
  for (const [alias, list] of Object.entries(PROVIDER_MODELS)) {
    const provider = getProviderByAlias(alias);
    if (!supportsOperation(provider, operation)) continue;
    for (const model of list) {
      if (getModelKind(model, 'llm') !== operation.kind) continue;
      const id = `${provider.alias || alias}/${model.id}`;
      models.set(id, { ...model, id, provider: provider.id, providerLabel: provider.name || provider.id });
    }
  }
  for (const provider of Object.values(AI_PROVIDERS)) {
    if (!supportsOperation(provider, operation)) continue;
    const virtual = operation.kind === 'webSearch' ? 'search' : operation.kind === 'webFetch' ? 'fetch' : null;
    if (virtual) {
      const id = `${provider.alias || provider.id}/${virtual}`;
      models.set(id, { id, name: `${provider.name || provider.id} ${virtual}`, kind: operation.kind, provider: provider.id, providerLabel: provider.name || provider.id });
    }
  }
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function operationProviders(operation) {
  return Object.values(AI_PROVIDERS).filter(provider => supportsOperation(provider, operation)).map(provider => provider.name || provider.id).sort();
}
