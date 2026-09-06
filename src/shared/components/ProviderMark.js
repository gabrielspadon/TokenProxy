'use client';
import { useState } from 'react';
import Image from 'next/image';
import { AI_PROVIDERS } from '@/shared/constants/providers';
import { getProviderIconSrc, markProviderIconMissing } from '@/shared/utils/providerIcon';

const BRANDS = {
  anthropic: ['claude', 'Anthropic', 'claude'],
  claude: ['claude', 'Claude', 'claude'],
  openai: ['openai', 'OpenAI', 'openai'],
  codex: ['openai', 'Codex', 'openai'],
  'oai-cc': ['oai-cc', 'Codex', 'openai'],
  gemini: ['gemini', 'Gemini', 'gemini'],
  google: ['gemini', 'Google', 'gemini'],
  deepseek: ['deepseek', 'DeepSeek', 'deepseek'],
  groq: ['groq', 'Groq', 'groq'],
  openrouter: ['openrouter', 'OpenRouter', 'openrouter'],
  kimi: ['kimi', 'Kimi', 'kimi'],
};
export function providerIdentity(provider) {
  const key = String(provider || '').toLowerCase();
  const known = BRANDS[key];
  if (known) return { logo: known[0], src: `/providers/${known[0]}.png`, name: known[1], color: known[2] };
  // Non-registry brands (custom openai-compatible-chat-<hash> nodes) have no
  // asset under /providers, so requesting one 404s on every view. Only fetch
  // when the id is in the local registry set or the icon registry resolves it
  // to a mark it can actually serve (alias, compat shared mark); otherwise go
  // straight to the initial-letter fallback.
  const src = getProviderIconSrc(key);
  const served = src && (key in AI_PROVIDERS || src !== `/providers/${key}.png`) ? src : null;
  return {
    logo: served ? key : null,
    src: served,
    name: provider || 'Unknown provider',
    color: 'other',
  };
}
export function ProviderMark({ provider, size = 'normal', label = false }) {
  const brand = providerIdentity(provider);
  const [failed, setFailed] = useState(false);
  return (
    <span className="provider-identity" data-provider={brand.color} data-i18n-skip>
      <span className="provider-mark" data-size={size} aria-hidden="true">
        {brand.src && !failed ? (
          <Image
            src={brand.src}
            alt=""
            width="28"
            height="28"
            unoptimized
            onError={() => {
              markProviderIconMissing(brand.logo);
              setFailed(true);
            }}
          />
        ) : (
          brand.name.slice(0, 2).toUpperCase()
        )}
      </span>
      {label ? <span>{brand.name}</span> : null}
    </span>
  );
}
