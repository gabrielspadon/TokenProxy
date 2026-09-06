'use client';
import { useState } from 'react';
import Image from 'next/image';

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
  return known
    ? { logo: known[0], name: known[1], color: known[2] }
    : {
        logo: /^[a-z0-9-]+$/.test(key) ? key : null,
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
        {brand.logo && !failed ? (
          <Image
            src={`/providers/${brand.logo}.png`}
            alt=""
            width="28"
            height="28"
            unoptimized
            onError={() => setFailed(true)}
          />
        ) : (
          brand.name.slice(0, 2).toUpperCase()
        )}
      </span>
      {label ? <span>{brand.name}</span> : null}
    </span>
  );
}
