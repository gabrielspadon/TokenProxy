// Pricing rates for AI models — all rates in $/1M tokens
//
// Fallback order (first match wins):
//   1. PROVIDER_PRICING[provider][model]  — provider-specific override
//   2. MODEL_PRICING[model]               — canonical model price (provider-agnostic)
//   3. PATTERN_PRICING                    — glob pattern match (e.g. "codex-*")

/**
 * Canonical model pricing — provider-agnostic.
 * Cover all known models; deduplicated across providers.
 */
export const MODEL_PRICING = {
  // === Anthropic / Claude ===
  "claude-opus-4-6": {
    input: 5.0,
    output: 25.0,
    cached: 0.5,
    reasoning: 25.0,
    cache_creation: 6.25,
  },
  "claude-opus-4-5-20251101": {
    input: 5.0,
    output: 25.0,
    cached: 0.5,
    reasoning: 25.0,
    cache_creation: 6.25,
  },
  "claude-sonnet-4-6": {
    input: 3.0,
    output: 15.0,
    cached: 0.3,
    reasoning: 15.0,
    cache_creation: 3.75,
  },
  "claude-sonnet-4-5-20250929": {
    input: 3.0,
    output: 15.0,
    cached: 0.3,
    reasoning: 15.0,
    cache_creation: 3.75,
  },
  "claude-haiku-4-5-20251001": {
    input: 1.0,
    output: 5.0,
    cached: 0.1,
    reasoning: 5.0,
    cache_creation: 1.25,
  },
  "claude-sonnet-4-20250514": {
    input: 3.0,
    output: 15.0,
    cached: 1.5,
    reasoning: 15.0,
    cache_creation: 3.0,
  },
  "claude-opus-4-20250514": {
    input: 15.0,
    output: 25.0,
    cached: 7.5,
    reasoning: 112.5,
    cache_creation: 15.0,
  },
  "claude-3-5-sonnet-20241022": {
    input: 3.0,
    output: 15.0,
    cached: 1.5,
    reasoning: 15.0,
    cache_creation: 3.0,
  },
  "claude-haiku-4.5": {
    input: 0.5,
    output: 2.5,
    cached: 0.05,
    reasoning: 3.75,
    cache_creation: 0.5,
  },
  "claude-opus-4.1": {
    input: 5.0,
    output: 25.0,
    cached: 0.5,
    reasoning: 37.5,
    cache_creation: 5.0,
  },
  "claude-opus-4.5": {
    input: 5.0,
    output: 25.0,
    cached: 0.5,
    reasoning: 37.5,
    cache_creation: 5.0,
  },
  "claude-opus-4.6": {
    input: 5.0,
    output: 25.0,
    cached: 0.5,
    reasoning: 37.5,
    cache_creation: 5.0,
  },
  "claude-sonnet-4": {
    input: 3.0,
    output: 15.0,
    cached: 0.3,
    reasoning: 22.5,
    cache_creation: 3.0,
  },
  "claude-sonnet-4.5": {
    input: 3.0,
    output: 15.0,
    cached: 0.3,
    reasoning: 22.5,
    cache_creation: 3.0,
  },
  "claude-sonnet-4.6": {
    input: 3.0,
    output: 15.0,
    cached: 0.3,
    reasoning: 22.5,
    cache_creation: 3.0,
  },
  "claude-opus-4-5-thinking": {
    input: 5.0,
    output: 25.0,
    cached: 0.5,
    reasoning: 37.5,
    cache_creation: 5.0,
  },
  "claude-opus-4-6-thinking": {
    input: 5.0,
    output: 25.0,
    cached: 0.5,
    reasoning: 37.5,
    cache_creation: 5.0,
  },
  "claude-fable-5": {
    input: 10.0,
    output: 50.0,
    cached: 1.0,
    reasoning: 50.0,
    cache_creation: 12.5,
  },
  "claude-fable-5-1": {
    input: 10.0,
    output: 50.0,
    cached: 1.0,
    reasoning: 50.0,
    cache_creation: 12.5,
  },

  // === OpenAI / GPT ===
  // Rates: official OpenAI standard-tier list prices, $/1M tokens
  // (developers.openai.com/api/docs/pricing). cached = cached-input rate;
  // reasoning tokens bill at the output rate (subset of output_tokens).
  "gpt-3.5-turbo": {
    input: 0.5,
    output: 1.5,
    cached: 0.25,
    reasoning: 1.5,
    cache_creation: 0.5,
  },
  "gpt-4": {
    input: 30.0,
    output: 60.0,
    cached: 15.0,
    reasoning: 60.0,
    cache_creation: 30.0,
  },
  "gpt-4-turbo": {
    input: 10.0,
    output: 30.0,
    cached: 5.0,
    reasoning: 30.0,
    cache_creation: 10.0,
  },
  "gpt-4o": {
    input: 2.5,
    output: 10.0,
    cached: 1.25,
    reasoning: 10.0,
    cache_creation: 2.5,
  },
  "gpt-4o-2024-05-13": {
    input: 5.0,
    output: 15.0,
    cached: 5.0,
    reasoning: 15.0,
    cache_creation: 5.0,
  },
  "gpt-4o-mini": {
    input: 0.15,
    output: 0.6,
    cached: 0.075,
    reasoning: 0.6,
    cache_creation: 0.15,
  },
  "gpt-4.1": {
    input: 2.0,
    output: 8.0,
    cached: 0.5,
    reasoning: 8.0,
    cache_creation: 2.0,
  },
  "gpt-4.1-mini": {
    input: 0.4,
    output: 1.6,
    cached: 0.1,
    reasoning: 1.6,
    cache_creation: 0.4,
  },
  "gpt-4.1-nano": {
    input: 0.1,
    output: 0.4,
    cached: 0.025,
    reasoning: 0.4,
    cache_creation: 0.1,
  },
  "gpt-5": {
    input: 1.25,
    output: 10.0,
    cached: 0.125,
    reasoning: 10.0,
    cache_creation: 1.25,
  },
  "gpt-5-mini": {
    input: 0.25,
    output: 2.0,
    cached: 0.025,
    reasoning: 2.0,
    cache_creation: 0.25,
  },
  "gpt-5-nano": {
    input: 0.05,
    output: 0.4,
    cached: 0.005,
    reasoning: 0.4,
    cache_creation: 0.05,
  },
  "gpt-5-codex": {
    input: 1.25,
    output: 10.0,
    cached: 0.125,
    reasoning: 10.0,
    cache_creation: 1.25,
  },
  "gpt-5-pro": {
    input: 15.0,
    output: 120.0,
    cached: 15.0,
    reasoning: 120.0,
    cache_creation: 15.0,
  },
  "gpt-5.1": {
    input: 1.25,
    output: 10.0,
    cached: 0.125,
    reasoning: 10.0,
    cache_creation: 1.25,
  },
  "gpt-5.1-codex": {
    input: 1.25,
    output: 10.0,
    cached: 0.125,
    reasoning: 10.0,
    cache_creation: 1.25,
  },
  "gpt-5.1-codex-mini": {
    input: 1.5,
    output: 6.0,
    cached: 0.75,
    reasoning: 6.0,
    cache_creation: 1.5,
  },
  "gpt-5.1-codex-mini-high": {
    input: 2.0,
    output: 8.0,
    cached: 1.0,
    reasoning: 12.0,
    cache_creation: 2.0,
  },
  "gpt-5.1-codex-max": {
    input: 8.0,
    output: 32.0,
    cached: 4.0,
    reasoning: 32.0,
    cache_creation: 8.0,
  },
  "gpt-5.2": {
    input: 1.75,
    output: 14.0,
    cached: 0.175,
    reasoning: 14.0,
    cache_creation: 1.75,
  },
  "gpt-5.2-codex": {
    input: 1.75,
    output: 14.0,
    cached: 0.175,
    reasoning: 14.0,
    cache_creation: 1.75,
  },
  "gpt-5.2-pro": {
    input: 21.0,
    output: 168.0,
    cached: 21.0,
    reasoning: 168.0,
    cache_creation: 21.0,
  },
  "gpt-5.3-codex": {
    input: 1.75,
    output: 14.0,
    cached: 0.175,
    reasoning: 14.0,
    cache_creation: 1.75,
  },
  "gpt-5.3-codex-spark": {
    input: 3.0,
    output: 12.0,
    cached: 0.3,
    reasoning: 12.0,
    cache_creation: 3.0,
  },
  "gpt-5.4": {
    input: 2.5,
    output: 15.0,
    cached: 0.25,
    reasoning: 15.0,
    cache_creation: 2.5,
  },
  "gpt-5.4-mini": {
    input: 0.75,
    output: 4.5,
    cached: 0.075,
    reasoning: 4.5,
    cache_creation: 0.75,
  },
  "gpt-5.4-nano": {
    input: 0.2,
    output: 1.25,
    cached: 0.02,
    reasoning: 1.25,
    cache_creation: 0.2,
  },
  "gpt-5.4-pro": {
    input: 30.0,
    output: 180.0,
    cached: 30.0,
    reasoning: 180.0,
    cache_creation: 30.0,
  },
  "gpt-5.5": {
    input: 5.0,
    output: 30.0,
    cached: 0.5,
    reasoning: 30.0,
    cache_creation: 5.0,
  },
  "gpt-5.5-pro": {
    input: 30.0,
    output: 180.0,
    cached: 30.0,
    reasoning: 180.0,
    cache_creation: 30.0,
  },
  "gpt-5.6": {
    input: 2.5,
    output: 15.0,
    cached: 0.25,
    reasoning: 15.0,
    cache_creation: 2.5,
  },
  "gpt-5.6-luna": {
    input: 0.2,
    output: 1.2,
    cached: 0.02,
    reasoning: 1.2,
    cache_creation: 0.25,
  },
  "gpt-5.6-terra": {
    input: 2.0,
    output: 12.0,
    cached: 0.2,
    reasoning: 12.0,
    cache_creation: 2.5,
  },
  "gpt-5.6-sol": {
    input: 4.0,
    output: 20.0,
    cached: 0.4,
    reasoning: 20.0,
    cache_creation: 5.0,
  },
  "gpt-5.6-cyber": {
    input: 12.5,
    output: 75.0,
    cached: 1.25,
    reasoning: 75.0,
    cache_creation: 15.625,
  },
  "o1-pro": {
    input: 150.0,
    output: 600.0,
    cached: 150.0,
    reasoning: 600.0,
    cache_creation: 150.0,
  },
  o3: {
    input: 2.0,
    output: 8.0,
    cached: 0.5,
    reasoning: 8.0,
    cache_creation: 2.0,
  },
  "o3-mini": {
    input: 1.1,
    output: 4.4,
    cached: 0.55,
    reasoning: 4.4,
    cache_creation: 1.1,
  },
  "o3-pro": {
    input: 20.0,
    output: 80.0,
    cached: 20.0,
    reasoning: 80.0,
    cache_creation: 20.0,
  },
  o1: {
    input: 15.0,
    output: 60.0,
    cached: 7.5,
    reasoning: 90.0,
    cache_creation: 15.0,
  },
  "o1-mini": {
    input: 3.0,
    output: 12.0,
    cached: 1.5,
    reasoning: 18.0,
    cache_creation: 3.0,
  },
  o1: {
    input: 15.0,
    output: 60.0,
    cached: 7.5,
    reasoning: 60.0,
    cache_creation: 15.0,
  },

  // === Gemini ===
  "gemini-3.7-flash": {
    input: 1.5,
    output: 7.5,
    cached: 0.15,
    reasoning: 11.25,
    cache_creation: 1.875,
  },
  "gemini-3.7-flash-high": {
    input: 1.5,
    output: 7.5,
    cached: 0.15,
    reasoning: 11.25,
    cache_creation: 1.875,
  },
  "gemini-3.7-flash-medium": {
    input: 1.5,
    output: 7.5,
    cached: 0.15,
    reasoning: 11.25,
    cache_creation: 1.875,
  },
  "gemini-3.7-flash-low": {
    input: 1.5,
    output: 7.5,
    cached: 0.15,
    reasoning: 11.25,
    cache_creation: 1.875,
  },
  "gemini-3.6-flash": {
    input: 1.5,
    output: 7.5,
    cached: 0.15,
    reasoning: 11.25,
    cache_creation: 1.875,
  },
  "gemini-3.6-flash-high": {
    input: 1.5,
    output: 7.5,
    cached: 0.15,
    reasoning: 11.25,
    cache_creation: 1.875,
  },
  "gemini-3.6-flash-medium": {
    input: 1.5,
    output: 7.5,
    cached: 0.15,
    reasoning: 11.25,
    cache_creation: 1.875,
  },
  "gemini-3.6-flash-low": {
    input: 1.5,
    output: 7.5,
    cached: 0.15,
    reasoning: 11.25,
    cache_creation: 1.875,
  },
  "gemini-3.5-flash-lite": {
    input: 0.3,
    output: 2.5,
    cached: 0.03,
    reasoning: 3.75,
    cache_creation: 0.375,
  },
  "gemini-3.5-flash-high": {
    input: 0.5,
    output: 3.0,
    cached: 0.03,
    reasoning: 4.5,
    cache_creation: 0.5,
  },
  "gemini-3-flash-preview": {
    input: 0.5,
    output: 3.0,
    cached: 0.03,
    reasoning: 4.5,
    cache_creation: 0.5,
  },
  "gemini-3-pro-preview": {
    input: 2.0,
    output: 12.0,
    cached: 0.25,
    reasoning: 18.0,
    cache_creation: 2.0,
  },
  "gemini-3.1-pro-low": {
    input: 2.0,
    output: 12.0,
    cached: 0.25,
    reasoning: 18.0,
    cache_creation: 2.0,
  },
  "gemini-3.1-pro-high": {
    input: 4.0,
    output: 18.0,
    cached: 0.5,
    reasoning: 27.0,
    cache_creation: 4.0,
  },
  "gemini-pro-agent": {
    input: 4.0,
    output: 18.0,
    cached: 0.5,
    reasoning: 27.0,
    cache_creation: 4.0,
  },
  "gemini-3-flash-agent": {
    input: 0.5,
    output: 3.0,
    cached: 0.03,
    reasoning: 4.5,
    cache_creation: 0.5,
  },
  "gemini-3.5-flash-low": {
    input: 0.5,
    output: 3.0,
    cached: 0.03,
    reasoning: 4.5,
    cache_creation: 0.5,
  },
  "gemini-3.5-flash-extra-low": {
    input: 0.5,
    output: 3.0,
    cached: 0.03,
    reasoning: 4.5,
    cache_creation: 0.5,
  },
  "gemini-3-flash": {
    input: 0.5,
    output: 3.0,
    cached: 0.03,
    reasoning: 4.5,
    cache_creation: 0.5,
  },
  "gemini-2.5-pro": {
    input: 2.0,
    output: 12.0,
    cached: 0.25,
    reasoning: 18.0,
    cache_creation: 2.0,
  },
  "gemini-2.5-flash": {
    input: 0.3,
    output: 2.5,
    cached: 0.03,
    reasoning: 3.75,
    cache_creation: 0.3,
  },
  "gemini-2.5-flash-lite": {
    input: 0.15,
    output: 1.25,
    cached: 0.015,
    reasoning: 1.875,
    cache_creation: 0.15,
  },

  // === Qwen ===
  // Qwen3.8 family — canonical provider-agnostic rates (mirror TokenRouter overrides).
  "qwen3-coder-plus": {
    input: 0.65,
    output: 3.25,
    cached: 0.5,
    reasoning: 3.25,
    cache_creation: 1.0,
  },
  "qwen3-coder-flash": {
    input: 0.195,
    output: 0.975,
    cached: 0.25,
    reasoning: 0.975,
    cache_creation: 0.5,
  },
  "qwen3-coder-next": {
    input: 0.12,
    output: 0.8,
    cached: 0.06,
    reasoning: 0.8,
    cache_creation: 0.5,
  },
  "qwen3.8-max": {
    input: 2.0,
    output: 6.0,
    cached: 0.25,
    reasoning: 6.0,
    cache_creation: 2.5,
  },
  "qwen3.8-27b": {
    input: 0.4,
    output: 3.0,
    cached: 0.05,
    reasoning: 3.0,
  },
  "qwen3.8-2.4t-a95b": {
    input: 2.0,
    output: 6.0,
    cached: 0.25,
    reasoning: 6.0,
  },
  "qwen3.7-max": {
    input: 1.475,
    output: 4.425,
    cached: 0.25,
    reasoning: 4.425,
  },
  "qwen3.7-plus": {
    input: 0.32,
    output: 1.28,
    cached: 0.08,
    reasoning: 1.28,
  },
  "qwen3.6-plus": {
    input: 0.325,
    output: 1.95,
    reasoning: 1.95,
  },
  "qwen3.6-flash": {
    input: 0.1875,
    output: 1.125,
    cached: 0.01875,
    cache_creation: 0.2344,
    reasoning: 1.125,
  },
  "qwen3.6-35b-a3b": {
    input: 0.098,
    output: 0.95,
    reasoning: 0.95,
  },
  "qwen3.6-27b": {
    input: 0.289,
    output: 2.4,
    reasoning: 2.4,
  },
  "qwen3.6-max-preview": {
    input: 1.027,
    output: 6.162,
    reasoning: 6.162,
  },
  "qwen3.5-plus": {
    input: 0.3,
    output: 1.8,
    reasoning: 1.8,
  },
  "qwen3.5-flash": {
    input: 0.065,
    output: 0.26,
    reasoning: 0.26,
  },
  "qwen3.5-27b": {
    input: 0.195,
    output: 1.56,
    reasoning: 1.56,
  },
  "qwen3.5-35b-a3b": {
    input: 0.14,
    output: 1.0,
    reasoning: 1.0,
  },
  "qwen3.5-122b-a10b": {
    input: 0.26,
    output: 2.08,
    reasoning: 2.08,
  },
  "qwen3.5-397b-a17b": {
    input: 0.3025,
    output: 1.925,
    reasoning: 1.925,
  },

  // === Kimi ===
  // Official platform.kimi.ai: cache-hit / cache-miss / output per 1M tokens
  "kimi-k3": {
    input: 3.0,
    output: 15.0,
    cached: 0.3,
    reasoning: 15.0,
    cache_creation: 3.0,
  },
  k3: {
    input: 3.0,
    output: 15.0,
    cached: 0.3,
    reasoning: 15.0,
    cache_creation: 3.0,
  },
  "kimi-k2.7-code": {
    input: 0.95,
    output: 4.0,
    cached: 0.19,
    reasoning: 4.0,
    cache_creation: 0.95,
  },
  "kimi-k2.7-code-highspeed": {
    input: 1.9,
    output: 8.0,
    cached: 0.38,
    reasoning: 8.0,
    cache_creation: 1.9,
  },
  "kimi-for-coding": {
    input: 0.95,
    output: 4.0,
    cached: 0.19,
    reasoning: 4.0,
    cache_creation: 0.95,
  },
  "kimi-for-coding-highspeed": {
    input: 1.9,
    output: 8.0,
    cached: 0.38,
    reasoning: 8.0,
    cache_creation: 1.9,
  },
  "kimi-k2": {
    input: 1.0,
    output: 4.0,
    cached: 0.5,
    reasoning: 6.0,
    cache_creation: 1.0,
  },
  "kimi-k2-thinking": {
    input: 1.5,
    output: 6.0,
    cached: 0.75,
    reasoning: 9.0,
    cache_creation: 1.5,
  },
  "kimi-k2.5": {
    input: 1.2,
    output: 4.8,
    cached: 0.6,
    reasoning: 7.2,
    cache_creation: 1.2,
  },
  "kimi-k2.5-thinking": {
    input: 1.8,
    output: 7.2,
    cached: 0.9,
    reasoning: 10.8,
    cache_creation: 1.8,
  },
  "kimi-k2.6": {
    input: 1.0,
    output: 4.0,
    cached: 0.5,
    reasoning: 6.0,
    cache_creation: 1.0,
  },
  "kimi-latest": {
    input: 1.0,
    output: 4.0,
    cached: 0.5,
    reasoning: 6.0,
    cache_creation: 1.0,
  },

  // === DeepSeek ===
  "deepseek-chat": {
    input: 0.14,
    output: 0.28,
    cached: 0.0028,
    reasoning: 0.28,
    cache_creation: 0.14,
  },
  "deepseek-reasoner": {
    input: 0.14,
    output: 0.28,
    cached: 0.0028,
    reasoning: 0.28,
    cache_creation: 0.14,
  },
  "deepseek-r1": {
    input: 0.14,
    output: 0.28,
    cached: 0.0028,
    reasoning: 0.28,
    cache_creation: 0.14,
  },
  "deepseek-v3.2-chat": {
    input: 0.14,
    output: 0.28,
    cached: 0.0028,
    reasoning: 0.28,
    cache_creation: 0.14,
  },
  "deepseek-v3.2-reasoner": {
    input: 0.14,
    output: 0.28,
    cached: 0.0028,
    reasoning: 0.28,
    cache_creation: 0.14,
  },
  "deepseek-v4-flash": {
    input: 0.14,
    output: 0.28,
    cached: 0.0028,
    reasoning: 0.28,
    cache_creation: 0.14,
  },
  "deepseek-v4-pro": {
    input: 0.435,
    output: 0.87,
    cached: 0.003625,
    reasoning: 0.87,
    cache_creation: 0.435,
  },

  // === GLM ===
  "glm-4.6": {
    input: 0.5,
    output: 2.0,
    cached: 0.25,
    reasoning: 3.0,
    cache_creation: 0.5,
  },
  "glm-4.6v": {
    input: 0.75,
    output: 3.0,
    cached: 0.375,
    reasoning: 4.5,
    cache_creation: 0.75,
  },
  "glm-4.7": {
    input: 0.75,
    output: 3.0,
    cached: 0.375,
    reasoning: 4.5,
    cache_creation: 0.75,
  },
  "glm-5": {
    input: 1.0,
    output: 4.0,
    cached: 0.5,
    reasoning: 6.0,
    cache_creation: 1.0,
  },

  // === MiniMax ===
  "MiniMax-M3": {
    input: 0.3,
    output: 1.2,
    cached: 0.06,
    reasoning: 1.8,
    cache_creation: 0.3,
  },
  "MiniMax-M2.1": {
    input: 0.5,
    output: 2.0,
    cached: 0.25,
    reasoning: 3.0,
    cache_creation: 0.5,
  },
  "MiniMax-M2.5": {
    input: 0.5,
    output: 2.0,
    cached: 0.25,
    reasoning: 3.0,
    cache_creation: 0.5,
  },
  "MiniMax-M2.7": {
    input: 0.5,
    output: 2.0,
    cached: 0.25,
    reasoning: 3.0,
    cache_creation: 0.5,
  },
  "minimax-m2.1": {
    input: 0.5,
    output: 2.0,
    cached: 0.25,
    reasoning: 3.0,
    cache_creation: 0.5,
  },
  "minimax-m2.5": {
    input: 0.6,
    output: 2.4,
    cached: 0.3,
    reasoning: 3.6,
    cache_creation: 0.6,
  },

  // === Grok ===
  "grok-code-fast-1": {
    input: 0.5,
    output: 2.0,
    cached: 0.25,
    reasoning: 3.0,
    cache_creation: 0.5,
  },

  // === OpenRouter fallback ===
  auto: {
    input: 2.0,
    output: 8.0,
    cached: 1.0,
    reasoning: 12.0,
    cache_creation: 2.0,
  },

  // === Misc ===
  "oswe-vscode-prime": {
    input: 1.0,
    output: 4.0,
    cached: 0.5,
    reasoning: 6.0,
    cache_creation: 1.0,
  },
  "gpt-oss-120b-medium": {
    input: 0.5,
    output: 2.0,
    cached: 0.25,
    reasoning: 3.0,
    cache_creation: 0.5,
  },
  "vision-model": {
    input: 1.5,
    output: 6.0,
    cached: 0.75,
    reasoning: 9.0,
    cache_creation: 1.5,
  },
  "coder-model": {
    input: 1.5,
    output: 6.0,
    cached: 0.75,
    reasoning: 9.0,
    cache_creation: 1.5,
  },
};

/**
 * Provider-specific pricing overrides.
 * Only include entries where price DIFFERS from MODEL_PRICING.
 * Keyed by provider alias (cc, cx, gc, gh, ...) or provider id (openai, anthropic, ...).
 */
export const PROVIDER_PRICING = {
  // GitHub Copilot (gh) — explicit override, matches canonical gpt-5.3-codex rate
  gh: {
    "gpt-5.3-codex": {
      input: 1.75,
      output: 14.0,
      cached: 0.175,
      reasoning: 14.0,
      cache_creation: 1.75,
    },
  },
  // TokenRouter — exact rates from https://api.tokenrouter.com/api/pricing ($1/1M tokens).
  // Ratio→USD: input = model_ratio×2, output = model_ratio×completion_ratio×2.
  // These override the canonical MODEL_PRICING/PATTERN_PRICING, whose rates often
  // differ from TokenRouter's reseller pricing.
  tokenrouter: {
    "MiniMax-M3": { input: 0.3, output: 1.2, cached: 0.06, reasoning: 1.2 },
    "anthropic/claude-fable-5": {
      input: 10,
      output: 50,
      cached: 1.0,
      cache_creation: 12.5,
      reasoning: 50,
    },
    "anthropic/claude-haiku-4.5": {
      input: 1.0,
      output: 5.0,
      cached: 0.1,
      cache_creation: 1.25,
      reasoning: 5.0,
    },
    "anthropic/claude-opus-4.5": {
      input: 5.0,
      output: 25.0,
      cached: 0.5,
      cache_creation: 6.25,
      reasoning: 25.0,
    },
    "anthropic/claude-opus-4.6": {
      input: 5.0,
      output: 25.0,
      cached: 0.5,
      cache_creation: 6.25,
      reasoning: 25.0,
    },
    "anthropic/claude-opus-4.7": {
      input: 5.0,
      output: 25.0,
      cached: 0.5,
      cache_creation: 6.25,
      reasoning: 25.0,
    },
    "anthropic/claude-opus-4.7-fast": {
      input: 30,
      output: 150,
      cached: 3.0,
      reasoning: 150,
    },
    "anthropic/claude-opus-4.8": {
      input: 5.0,
      output: 25.0,
      cached: 0.5,
      cache_creation: 6.25,
      reasoning: 25.0,
    },
    "anthropic/claude-opus-4.8-fast": {
      input: 10,
      output: 50,
      cached: 1.0,
      cache_creation: 12.5,
      reasoning: 50,
    },
    "anthropic/claude-opus-5": {
      input: 5.0,
      output: 25.0,
      cached: 0.5,
      cache_creation: 6.25,
      reasoning: 25.0,
    },
    "anthropic/claude-opus-5-fast": {
      input: 10,
      output: 50,
      cached: 1.0,
      cache_creation: 12.5,
      reasoning: 50,
    },
    "anthropic/claude-sonnet-4": {
      input: 3.0,
      output: 15.0,
      cached: 0.3,
      cache_creation: 3.75,
      reasoning: 15.0,
    },
    "anthropic/claude-sonnet-4.5": {
      input: 3.0,
      output: 15.0,
      cached: 0.3,
      cache_creation: 3.75,
      reasoning: 15.0,
    },
    "anthropic/claude-sonnet-4.6": {
      input: 3.0,
      output: 15.0,
      cached: 0.3,
      cache_creation: 3.75,
      reasoning: 15.0,
    },
    "anthropic/claude-sonnet-5": {
      input: 2,
      output: 10,
      cached: 0.2,
      reasoning: 10,
    },
    "claude-opus-4-8-m-aws": {
      input: 5.0,
      output: 25.0,
      cached: 0.5,
      cache_creation: 6.25,
      reasoning: 25.0,
    },
    "deepseek/deepseek-v3.2": {
      input: 0.26,
      output: 0.38,
      cached: 0.13,
      reasoning: 0.38,
    },
    "deepseek/deepseek-v4-flash": {
      input: 0.14,
      output: 0.28,
      cached: 0.0028,
      reasoning: 0.28,
    },
    "deepseek/deepseek-v4-flash-0731": {
      input: 0.14,
      output: 0.28,
      cached: 0.0028,
      reasoning: 0.28,
    },
    "deepseek/deepseek-v4-pro": {
      input: 0.435,
      output: 0.87,
      cached: 0.003625,
      reasoning: 0.87,
    },
    "ex/gpt-5.4": { input: 2.5, output: 15.0, cached: 0.25, reasoning: 15.0 },
    "google/gemini-2.5-flash-image": {
      input: 0.3,
      output: 2.5,
      reasoning: 2.5,
    },
    "google/gemini-3-flash-preview": {
      input: 0.5,
      output: 3.0,
      cached: 0.05,
      cache_creation: 0.08333,
      reasoning: 3.0,
    },
    "google/gemini-3-pro-image-preview": {
      input: 2,
      output: 12,
      reasoning: 12,
    },
    "google/gemini-3.1-flash-image-preview": {
      input: 0.5,
      output: 3.0,
      reasoning: 3.0,
    },
    "google/gemini-3.1-flash-lite-image": {
      input: 0.25,
      output: 1.5,
      reasoning: 1.5,
    },
    "google/gemini-3.1-pro-preview": {
      input: 2,
      output: 12,
      cached: 0.2,
      cache_creation: 0.375,
      reasoning: 12,
    },
    "google/gemini-3.5-flash": {
      input: 1.5,
      output: 9.0,
      cached: 0.15,
      cache_creation: 0.08333,
      reasoning: 9.0,
    },
    "google/gemini-3.5-flash-lite": {
      input: 0.3,
      output: 2.5,
      cached: 0.03,
      cache_creation: 0.08333,
      reasoning: 2.5,
    },
    "google/gemini-3.6-flash": {
      input: 1.5,
      output: 7.5,
      cached: 0.15,
      cache_creation: 0.08333,
      reasoning: 7.5,
    },
    "google/gemini-embedding-2": {
      input: 1.0,
      output: 6.0,
      cached: 0.1,
      reasoning: 6.0,
    },
    "google/gemma-4-26b-a4b-it": { input: 0.06, output: 0.33, reasoning: 0.33 },
    "kling-3.0-turbo": { input: 2.1, output: 2.1, reasoning: 2.1 },
    "microsoft/mai-image-2.5": { input: 5.0, output: 47.0, reasoning: 47.0 },
    "minimax/minimax-m2-her": {
      input: 0.3,
      output: 1.2,
      cached: 0.03,
      reasoning: 1.2,
    },
    "minimax/minimax-m2.1": {
      input: 0.3,
      output: 1.2,
      cached: 0.03,
      reasoning: 1.2,
    },
    "minimax/minimax-m2.1-highspeed": {
      input: 0.6,
      output: 2.4,
      cached: 0.06,
      reasoning: 2.4,
    },
    "minimax/minimax-m2.5": {
      input: 0.3,
      output: 1.2,
      cached: 0.03,
      reasoning: 1.2,
    },
    "minimax/minimax-m2.7": {
      input: 0.3,
      output: 1.2,
      cached: 0.06,
      reasoning: 1.2,
    },
    "minimax/minimax-m2.7-highspeed": {
      input: 0.6,
      output: 2.4,
      cached: 0.06,
      reasoning: 2.4,
    },
    "miromind/mirothinker-1-7-deepresearch": {
      input: 4,
      output: 25.0,
      reasoning: 25.0,
    },
    "miromind/mirothinker-1-7-deepresearch-mini": {
      input: 1.25,
      output: 10.0,
      reasoning: 10.0,
    },
    "mistralai/devstral-2512": {
      input: 0.4,
      output: 2.0,
      cached: 0.04,
      reasoning: 2.0,
    },
    "mistralai/mistral-medium-3-5": { input: 1.5, output: 7.5, reasoning: 7.5 },
    "mistralai/mistral-small-2603": {
      input: 0.15,
      output: 0.6,
      cached: 0.015,
      reasoning: 0.6,
    },
    "mistralai/voxtral-small-24b-2507": {
      input: 0.1,
      output: 0.3,
      cached: 0.01,
      reasoning: 0.3,
    },
    "moonshotai/kimi-k2.5": {
      input: 0.6,
      output: 3.0,
      cached: 0.1,
      reasoning: 3.0,
    },
    "moonshotai/kimi-k2.6": {
      input: 0.95,
      output: 4.0,
      cached: 0.16,
      reasoning: 4.0,
    },
    "moonshotai/kimi-k2.7-code": {
      input: 0.9286,
      output: 3.8571,
      cached: 0.1857,
      reasoning: 3.8571,
    },
    "moonshotai/kimi-k3": {
      input: 3.0,
      output: 15.0,
      cached: 0.3,
      reasoning: 15.0,
    },
    "nvidia/nemotron-3-super-120b-a12b": {
      input: 0.3,
      output: 0.9,
      cached: 0.1,
      reasoning: 0.9,
    },
    "openai/gpt-4o-mini": {
      input: 0.15,
      output: 0.6,
      cached: 0.075,
      reasoning: 0.6,
    },
    "openai/gpt-5": {
      input: 1.25,
      output: 10.0,
      cached: 0.125,
      reasoning: 10.0,
    },
    "openai/gpt-5-image": { input: 10, output: 40, cached: 2.5, reasoning: 40 },
    "openai/gpt-5-image-mini": {
      input: 2.5,
      output: 8.0,
      cached: 0.25,
      reasoning: 8.0,
    },
    "openai/gpt-5-mini": {
      input: 0.25,
      output: 2.0,
      cached: 0.025,
      reasoning: 2.0,
    },
    "openai/gpt-5.2": {
      input: 1.75,
      output: 14.0,
      cached: 0.175,
      reasoning: 14.0,
    },
    "openai/gpt-5.3-codex": {
      input: 1.75,
      output: 14.0,
      cached: 0.175,
      reasoning: 14.0,
    },
    "openai/gpt-5.4": {
      input: 2.5,
      output: 15.0,
      cached: 0.25,
      reasoning: 15.0,
    },
    "openai/gpt-5.4-image-2": {
      input: 8,
      output: 30.0,
      cached: 2.0,
      reasoning: 30.0,
    },
    "openai/gpt-5.4-mini": {
      input: 0.75,
      output: 4.5,
      cached: 0.075,
      reasoning: 4.5,
    },
    "openai/gpt-5.4-nano": {
      input: 0.2,
      output: 1.25,
      cached: 0.02,
      reasoning: 1.25,
    },
    "openai/gpt-5.4-pro": { input: 30, output: 180, reasoning: 180 },
    "openai/gpt-5.5": {
      input: 5.0,
      output: 30.0,
      cached: 0.5,
      reasoning: 30.0,
    },
    "openai/gpt-5.5-pro": { input: 30, output: 180, reasoning: 180 },
    "openai/gpt-5.6-luna": {
      input: 0.2,
      output: 1.2,
      cached: 0.02,
      cache_creation: 0.25,
      reasoning: 1.2,
    },
    "openai/gpt-5.6-sol": {
      input: 5.0,
      output: 30.0,
      cached: 0.5,
      cache_creation: 6.25,
      reasoning: 30.0,
    },
    "openai/gpt-5.6-terra": {
      input: 2,
      output: 12,
      cached: 0.2,
      cache_creation: 2.5,
      reasoning: 12,
    },
    "openai/gpt-audio": { input: 2.5, output: 10.0, reasoning: 10.0 },
    "openai/gpt-audio-mini": { input: 0.6, output: 2.4, reasoning: 2.4 },
    "openai/gpt-oss-120b": { input: 0.039, output: 0.18, reasoning: 0.18 },
    "qwen/qwen3-coder-next": {
      input: 0.12,
      output: 0.75,
      cached: 0.06,
      reasoning: 0.75,
    },
    "qwen/qwen3.5-122b-a10b": { input: 0.26, output: 2.08, reasoning: 2.08 },
    "qwen/qwen3.5-35b-a3b": { input: 0.1625, output: 1.3, reasoning: 1.3 },
    "qwen/qwen3.5-397b-a17b": { input: 0.39, output: 2.34, reasoning: 2.34 },
    "qwen/qwen3.5-9b": { input: 0.1, output: 0.15, reasoning: 0.15 },
    "qwen/qwen3.5-flash": { input: 0.1048, output: 0.4194, reasoning: 0.4194 },
    "qwen/qwen3.5-plus-02-15": { input: 0.26, output: 1.56, reasoning: 1.56 },
    "qwen/qwen3.6-plus": { input: 0.54, output: 3.21, reasoning: 3.21 },
    "qwen/qwen3.7-max": {
      input: 1.25,
      output: 3.75,
      cached: 0.25,
      reasoning: 3.75,
    },
    "qwen/qwen3.7-plus": {
      input: 0.4,
      output: 1.6,
      cached: 0.08,
      reasoning: 1.6,
    },
    "qwen/qwen3.8-max": {
      input: 2,
      output: 6,
      cached: 0.25,
      cache_creation: 2.5,
      reasoning: 6,
    },
    "qwen3.5-omni-plus": { input: 1.0, output: 5.7143, reasoning: 5.7143 },
    "qwen3.6-flash": {
      input: 0.171,
      output: 1.029,
      cached: 0.017,
      cache_creation: 0.214,
      reasoning: 1.029,
    },
    "sakana/fugu-ultra": {
      input: 5.0,
      output: 30.0,
      cached: 0.5,
      reasoning: 30.0,
    },
    "seed-2-0-code-preview-260328": {
      input: 1.0,
      output: 6.0,
      cached: 0.2,
      cache_creation: 0.008333,
      reasoning: 6.0,
    },
    "seed-2-0-lite-260428": {
      input: 0.5,
      output: 4.0,
      cached: 0.1,
      cache_creation: 0.008333,
      reasoning: 4.0,
    },
    "seed-2-0-mini-260428": {
      input: 0.2,
      output: 0.8,
      cached: 0.04,
      cache_creation: 0.00833,
      reasoning: 0.8,
    },
    "seed-2-0-pro-260328": {
      input: 1.0,
      output: 6.0,
      cached: 0.2,
      cache_creation: 0.008333,
      reasoning: 6.0,
    },
    "stepfun/step-3.5-flash": {
      input: 0.1,
      output: 0.3,
      cached: 0.02,
      reasoning: 0.3,
    },
    "stepfun/step-3.7-flash": {
      input: 0.2,
      output: 1.15,
      cached: 0.04,
      reasoning: 1.15,
    },
    "tencent/hy3-preview": {
      input: 0.066,
      output: 0.26,
      cached: 0.029,
      reasoning: 0.26,
    },
    "x-ai/grok-4.1-fast": {
      input: 0.2,
      output: 0.5,
      cached: 0.05,
      reasoning: 0.5,
    },
    "x-ai/grok-4.20-beta": { input: 2, output: 6, cached: 0.2, reasoning: 6 },
    "x-ai/grok-4.3": { input: 1.25, output: 2.5, cached: 0.2, reasoning: 2.5 },
    "x-ai/grok-4.5": { input: 2, output: 6, cached: 0.5, reasoning: 6 },
    "x-ai/grok-build-0.1": {
      input: 1.0,
      output: 2.0,
      cached: 0.2,
      reasoning: 2.0,
    },
    "xiaomi/mimo-v2-flash": {
      input: 0.1,
      output: 0.3,
      cached: 0.01,
      reasoning: 0.3,
    },
    "xiaomi/mimo-v2-omni": {
      input: 0.4,
      output: 2.0,
      cached: 0.08,
      reasoning: 2.0,
    },
    "xiaomi/mimo-v2-pro": {
      input: 1.0,
      output: 3.0,
      cached: 0.2,
      reasoning: 3.0,
    },
    "xiaomi/mimo-v2.5": {
      input: 0.4,
      output: 2.0,
      cached: 0.08,
      reasoning: 2.0,
    },
    "xiaomi/mimo-v2.5-pro": {
      input: 1.0,
      output: 3.0,
      cached: 0.2,
      reasoning: 3.0,
    },
    "z-ai/glm-4.5-air": {
      input: 0.13,
      output: 0.85,
      cached: 0.025,
      reasoning: 0.85,
    },
    "z-ai/glm-4.6": { input: 0.6, output: 2.2, cached: 0.11, reasoning: 2.2 },
    "z-ai/glm-4.6v": { input: 0.3, output: 0.9, reasoning: 0.9 },
    "z-ai/glm-4.7": { input: 0.6, output: 2.2, cached: 0.11, reasoning: 2.2 },
    "z-ai/glm-5": { input: 1.0, output: 3.2, cached: 0.2, reasoning: 3.2 },
    "z-ai/glm-5-turbo": {
      input: 1.2,
      output: 4.0,
      cached: 0.24,
      reasoning: 4.0,
    },
    "z-ai/glm-5.1": { input: 1.05, output: 3.5, cached: 0.525, reasoning: 3.5 },
    "z-ai/glm-5.2": { input: 1.4, output: 4.4, cached: 0.26, reasoning: 4.4 },
  },
  // Meta AI — Muse Spark via the Meta Model API (api.meta.ai, OpenAI-compatible).
  // Standard tier: $1.25 input / $0.15 cached / $4.25 output per 1M tokens;
  // reasoning tokens bill at the output rate. Contributor tier is heavily
  // discounted ($0.10 / $0.002 / $0.20). Sourced from Meta + OpenRouter pricing.
  meta: {
    "muse-spark-1.2": { input: 1.25, output: 4.25, cached: 0.15, reasoning: 4.25 },
    "muse-spark-1.1": { input: 1.25, output: 4.25, cached: 0.15, reasoning: 4.25 },
    "muse-spark-1.2-contributor": { input: 0.10, output: 0.20, cached: 0.002, reasoning: 0.20 },
  },
  // Fireworks AI — OpenAI-compatible, reasoning/cache_creation not separately
  // charged (completion_tokens already includes reasoning tokens; setting
  // reasoning/cache_creation to output/input would double-count in the
  // cost calculator).
  fireworks: {
    "accounts/fireworks/models/glm-5p2":                { input: 1.40, output: 4.40, cached: 0.14,  reasoning: 0, cache_creation: 0 },
    "accounts/fireworks/routers/glm-5p2-fast":          { input: 2.10, output: 6.60, cached: 0.21,  reasoning: 0, cache_creation: 0 },
    "accounts/fireworks/models/glm-5p1":                { input: 1.40, output: 4.40, cached: 0.26,  reasoning: 0, cache_creation: 0 },
    "accounts/fireworks/routers/glm-5p1-fast":          { input: 2.80, output: 8.80, cached: 0.52,  reasoning: 0, cache_creation: 0 },
    "accounts/fireworks/models/qwen3p7-plus":           { input: 0.40, output: 1.60, cached: 0.08,  reasoning: 0, cache_creation: 0 },
    "accounts/fireworks/models/minimax-m3":             { input: 0.30, output: 1.20, cached: 0.06,  reasoning: 0, cache_creation: 0 },
    "accounts/fireworks/models/minimax-m2p7":           { input: 0.30, output: 1.20, cached: 0.06,  reasoning: 0, cache_creation: 0 },
    "accounts/fireworks/models/kimi-k2p7-code":         { input: 0.95, output: 4.00, cached: 0.19,  reasoning: 0, cache_creation: 0 },
    "accounts/fireworks/routers/kimi-k2p7-code-fast":   { input: 1.90, output: 8.00, cached: 0.38,  reasoning: 0, cache_creation: 0 },
    "accounts/fireworks/models/kimi-k2p6":              { input: 0.95, output: 4.00, cached: 0.16,  reasoning: 0, cache_creation: 0 },
    "accounts/fireworks/routers/kimi-k2p6-turbo":       { input: 2.00, output: 8.00, cached: 0.30,  reasoning: 0, cache_creation: 0 },
    "accounts/fireworks/routers/kimi-k2p6-fast":        { input: 2.00, output: 8.00, cached: 0.30,  reasoning: 0, cache_creation: 0 },
    "accounts/fireworks/models/gpt-oss-120b":           { input: 0.15, output: 0.60, cached: 0.015, reasoning: 0, cache_creation: 0 },
    "accounts/fireworks/models/gpt-oss-20b":            { input: 0.07, output: 0.30, cached: 0.035, reasoning: 0, cache_creation: 0 },
    "accounts/fireworks/models/deepseek-v4-pro":        { input: 1.74, output: 3.48, cached: 0.145, reasoning: 0, cache_creation: 0 },
    "accounts/fireworks/models/deepseek-v4-flash":      { input: 0.14, output: 0.28, cached: 0.028, reasoning: 0, cache_creation: 0 },
  },
};

/**
 * Pattern-based pricing fallback — matched when no exact model entry found.
 * Patterns use simple glob: "*" matches any substring.
 * First match wins — order matters.
 */
export const PATTERN_PRICING = [
  // --- Codex variants ---
  {
    pattern: "*-codex-xhigh",
    pricing: {
      input: 10.0,
      output: 40.0,
      cached: 5.0,
      reasoning: 60.0,
      cache_creation: 10.0,
    },
  },
  {
    pattern: "*-codex-high",
    pricing: {
      input: 8.0,
      output: 32.0,
      cached: 4.0,
      reasoning: 48.0,
      cache_creation: 8.0,
    },
  },
  {
    pattern: "*-codex-max",
    pricing: {
      input: 8.0,
      output: 32.0,
      cached: 4.0,
      reasoning: 48.0,
      cache_creation: 8.0,
    },
  },
  {
    pattern: "*-codex-mini-*",
    pricing: {
      input: 1.5,
      output: 6.0,
      cached: 0.75,
      reasoning: 9.0,
      cache_creation: 1.5,
    },
  },
  {
    pattern: "*-codex-mini",
    pricing: {
      input: 1.5,
      output: 6.0,
      cached: 0.75,
      reasoning: 9.0,
      cache_creation: 1.5,
    },
  },
  {
    pattern: "*-codex-low",
    pricing: {
      input: 1.75,
      output: 14.0,
      cached: 0.175,
      reasoning: 14.0,
      cache_creation: 1.75,
    },
  },
  {
    pattern: "*-codex-none",
    pricing: {
      input: 1.75,
      output: 14.0,
      cached: 0.175,
      reasoning: 14.0,
      cache_creation: 1.75,
    },
  },
  {
    pattern: "*-codex-spark",
    pricing: {
      input: 3.0,
      output: 12.0,
      cached: 0.3,
      reasoning: 12.0,
      cache_creation: 3.0,
    },
  },
  {
    pattern: "codex-*",
    pricing: {
      input: 1.75,
      output: 14.0,
      cached: 0.175,
      reasoning: 14.0,
      cache_creation: 1.75,
    },
  },
  {
    pattern: "*-codex",
    pricing: {
      input: 1.75,
      output: 14.0,
      cached: 0.175,
      reasoning: 14.0,
      cache_creation: 1.75,
    },
  },

  // --- Claude ---
  {
    pattern: "claude-opus-*",
    pricing: {
      input: 5.0,
      output: 25.0,
      cached: 0.5,
      reasoning: 25.0,
      cache_creation: 6.25,
    },
  },
  {
    pattern: "claude-sonnet-*",
    pricing: {
      input: 3.0,
      output: 15.0,
      cached: 0.3,
      reasoning: 15.0,
      cache_creation: 3.75,
    },
  },
  {
    pattern: "claude-haiku-*",
    pricing: {
      input: 1.0,
      output: 5.0,
      cached: 0.1,
      reasoning: 5.0,
      cache_creation: 1.25,
    },
  },
  {
    pattern: "claude-*",
    pricing: {
      input: 3.0,
      output: 15.0,
      cached: 0.3,
      reasoning: 15.0,
      cache_creation: 3.75,
    },
  },

  // --- Gemini (specific first, generic last) ---
  {
    pattern: "gemini-*-flash-lite",
    pricing: {
      input: 0.15,
      output: 1.25,
      cached: 0.015,
      reasoning: 1.875,
      cache_creation: 0.15,
    },
  },
  {
    pattern: "gemini-*-flash",
    pricing: {
      input: 0.3,
      output: 2.5,
      cached: 0.03,
      reasoning: 3.75,
      cache_creation: 0.3,
    },
  },
  {
    pattern: "gemini-*-pro",
    pricing: {
      input: 2.0,
      output: 12.0,
      cached: 0.25,
      reasoning: 18.0,
      cache_creation: 2.0,
    },
  },
  {
    pattern: "gemini-3-*",
    pricing: {
      input: 0.5,
      output: 3.0,
      cached: 0.03,
      reasoning: 4.5,
      cache_creation: 0.5,
    },
  },
  {
    pattern: "gemini-2.5-*",
    pricing: {
      input: 0.3,
      output: 2.5,
      cached: 0.03,
      reasoning: 3.75,
      cache_creation: 0.3,
    },
  },
  {
    pattern: "gemini-*",
    pricing: {
      input: 0.5,
      output: 3.0,
      cached: 0.03,
      reasoning: 4.5,
      cache_creation: 0.5,
    },
  },

  // --- GPT (specific first, generic last) ---
  {
    pattern: "gpt-5.6-*",
    pricing: {
      input: 2.5,
      output: 15.0,
      cached: 0.25,
      reasoning: 15.0,
      cache_creation: 2.5,
    },
  },
  {
    pattern: "gpt-5.3-*",
    pricing: {
      input: 1.75,
      output: 14.0,
      cached: 0.175,
      reasoning: 14.0,
      cache_creation: 1.75,
    },
  },
  {
    pattern: "gpt-5.2-*",
    pricing: {
      input: 1.75,
      output: 14.0,
      cached: 0.175,
      reasoning: 14.0,
      cache_creation: 1.75,
    },
  },
  {
    pattern: "gpt-5.1-*",
    pricing: {
      input: 1.25,
      output: 10.0,
      cached: 0.625,
      reasoning: 10.0,
      cache_creation: 1.25,
    },
  },
  {
    pattern: "gpt-5-*",
    pricing: {
      input: 1.25,
      output: 10.0,
      cached: 0.625,
      reasoning: 10.0,
      cache_creation: 1.25,
    },
  },
  {
    pattern: "gpt-5*",
    pricing: {
      input: 1.25,
      output: 10.0,
      cached: 0.625,
      reasoning: 10.0,
      cache_creation: 1.25,
    },
  },
  {
    pattern: "gpt-4o-*",
    pricing: {
      input: 0.15,
      output: 0.6,
      cached: 0.075,
      reasoning: 0.9,
      cache_creation: 0.15,
    },
  },
  {
    pattern: "gpt-4o",
    pricing: {
      input: 2.5,
      output: 10.0,
      cached: 1.25,
      reasoning: 15.0,
      cache_creation: 2.5,
    },
  },
  {
    pattern: "gpt-4*",
    pricing: {
      input: 2.5,
      output: 10.0,
      cached: 1.25,
      reasoning: 15.0,
      cache_creation: 2.5,
    },
  },

  // --- o1 / o-series ---
  {
    pattern: "o1-*",
    pricing: {
      input: 3.0,
      output: 12.0,
      cached: 1.5,
      reasoning: 18.0,
      cache_creation: 3.0,
    },
  },
  {
    pattern: "o1",
    pricing: {
      input: 15.0,
      output: 60.0,
      cached: 7.5,
      reasoning: 90.0,
      cache_creation: 15.0,
    },
  },
  {
    pattern: "o3-*",
    pricing: {
      input: 10.0,
      output: 40.0,
      cached: 5.0,
      reasoning: 60.0,
      cache_creation: 10.0,
    },
  },
  {
    pattern: "o4-*",
    pricing: {
      input: 2.0,
      output: 8.0,
      cached: 1.0,
      reasoning: 12.0,
      cache_creation: 2.0,
    },
  },

  // --- Qwen ---
  {
    pattern: "qwen3-coder-*",
    pricing: {
      input: 1.0,
      output: 4.0,
      cached: 0.5,
      reasoning: 6.0,
      cache_creation: 1.0,
    },
  },
  {
    pattern: "qwen*-coder-*",
    pricing: {
      input: 1.0,
      output: 4.0,
      cached: 0.5,
      reasoning: 6.0,
      cache_creation: 1.0,
    },
  },
  {
    pattern: "qwen*",
    pricing: {
      input: 0.5,
      output: 2.0,
      cached: 0.25,
      reasoning: 3.0,
      cache_creation: 0.5,
    },
  },

  // --- Kimi ---
  {
    pattern: "kimi-*-thinking",
    pricing: {
      input: 1.8,
      output: 7.2,
      cached: 0.9,
      reasoning: 10.8,
      cache_creation: 1.8,
    },
  },
  {
    pattern: "kimi-k3*",
    pricing: {
      input: 3.0,
      output: 15.0,
      cached: 0.3,
      reasoning: 15.0,
      cache_creation: 3.0,
    },
  },
  {
    pattern: "kimi-k2*",
    pricing: {
      input: 1.2,
      output: 4.8,
      cached: 0.6,
      reasoning: 7.2,
      cache_creation: 1.2,
    },
  },
  {
    pattern: "kimi-*",
    pricing: {
      input: 1.0,
      output: 4.0,
      cached: 0.5,
      reasoning: 6.0,
      cache_creation: 1.0,
    },
  },

  // --- DeepSeek ---
  {
    pattern: "deepseek-*reasoner*",
    pricing: {
      input: 0.14,
      output: 0.28,
      cached: 0.0028,
      reasoning: 0.28,
      cache_creation: 0.14,
    },
  },
  {
    pattern: "deepseek-r*",
    pricing: {
      input: 0.14,
      output: 0.28,
      cached: 0.0028,
      reasoning: 0.28,
      cache_creation: 0.14,
    },
  },
  {
    pattern: "deepseek-v*",
    pricing: {
      input: 0.14,
      output: 0.28,
      cached: 0.0028,
      reasoning: 0.28,
      cache_creation: 0.14,
    },
  },
  {
    pattern: "deepseek-*",
    pricing: {
      input: 0.14,
      output: 0.28,
      cached: 0.0028,
      reasoning: 0.28,
      cache_creation: 0.14,
    },
  },

  // --- GLM ---
  {
    pattern: "glm-5*",
    pricing: {
      input: 1.0,
      output: 4.0,
      cached: 0.5,
      reasoning: 6.0,
      cache_creation: 1.0,
    },
  },
  {
    pattern: "glm-4*",
    pricing: {
      input: 0.75,
      output: 3.0,
      cached: 0.375,
      reasoning: 4.5,
      cache_creation: 0.75,
    },
  },
  {
    pattern: "glm-*",
    pricing: {
      input: 0.5,
      output: 2.0,
      cached: 0.25,
      reasoning: 3.0,
      cache_creation: 0.5,
    },
  },

  // --- MiniMax ---
  {
    pattern: "MiniMax-*",
    pricing: {
      input: 0.5,
      output: 2.0,
      cached: 0.25,
      reasoning: 3.0,
      cache_creation: 0.5,
    },
  },
  {
    pattern: "minimax-*",
    pricing: {
      input: 0.5,
      output: 2.0,
      cached: 0.25,
      reasoning: 3.0,
      cache_creation: 0.5,
    },
  },

  // --- Grok ---
  {
    pattern: "grok-code-*",
    pricing: {
      input: 0.5,
      output: 2.0,
      cached: 0.25,
      reasoning: 3.0,
      cache_creation: 0.5,
    },
  },
  {
    pattern: "grok-*",
    pricing: {
      input: 0.5,
      output: 2.0,
      cached: 0.25,
      reasoning: 3.0,
      cache_creation: 0.5,
    },
  },

  // --- Meta Muse (specific first, generic last) ---
  // Muse Spark (Meta Model API): $1.25/$4.25 standard, $0.10/$0.20 contributor.
  {
    pattern: "*muse-spark*contributor*",
    pricing: {
      input: 0.1,
      output: 0.2,
      cached: 0.002,
      reasoning: 0.3,
      cache_creation: 0.1,
    },
  },
  {
    pattern: "*muse-spark*",
    pricing: {
      input: 1.25,
      output: 4.25,
      cached: 0.15,
      reasoning: 6.375,
      cache_creation: 1.25,
    },
  },
  // Muse Glimmer (open-weight 30B): ~$0.30/$1.20 via resellers.
  {
    pattern: "*muse-glimmer*",
    pricing: {
      input: 0.3,
      output: 1.2,
      cached: 0.04,
      reasoning: 1.8,
      cache_creation: 0.3,
    },
  },
  {
    pattern: "*muse*",
    pricing: {
      input: 1.25,
      output: 4.25,
      cached: 0.15,
      reasoning: 6.375,
      cache_creation: 1.25,
    },
  },
];

/**
 * Match a model ID against a glob pattern (* = wildcard). Case-insensitive:
 * registry ids mix casing (e.g. "MiniMax-M2.5" vs "minimax-m2.5").
 */
export function matchPattern(pattern, model) {
  const regex = new RegExp(
    "^" +
      pattern
        .split("*")
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
    "i",
  );
  return regex.test(model);
}

/**
 * Resolve pricing for a model using the 3-step fallback chain:
 *   1. PROVIDER_PRICING[provider][model]
 *   2. MODEL_PRICING[model]
 *   3. PATTERN_PRICING (glob match)
 *
 * @param {string} provider
 * @param {string} model
 * @returns {object|null}
 */
export function getPricingForModel(provider, model) {
  if (!model) return null;

  // 1. Provider-specific override
  if (provider && PROVIDER_PRICING[provider]?.[model]) {
    return PROVIDER_PRICING[provider][model];
  }

  // 2. Canonical model pricing (strip vendor prefix if needed: "deepseek/deepseek-chat" → "deepseek-chat")
  const baseModel = model.includes("/") ? model.split("/").pop() : model;
  if (MODEL_PRICING[baseModel]) return MODEL_PRICING[baseModel];
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];

  // 3. Pattern match
  for (const { pattern, pricing } of PATTERN_PRICING) {
    if (matchPattern(pattern, baseModel) || matchPattern(pattern, model)) {
      return pricing;
    }
  }

  return null;
}

/**
 * Get all provider pricing (for UI / API).
 * Returns PROVIDER_PRICING — consumers should fall back to MODEL_PRICING for unlisted models.
 */
export function getDefaultPricing() {
  return PROVIDER_PRICING;
}

/**
 * Format cost for display
 * @param {number} cost
 * @returns {string}
 */
export function formatCost(cost) {
  if (cost === null || cost === undefined || isNaN(cost)) return "$0.00";
  return `$${cost.toFixed(2)}`;
}

function nonnegativeFiniteNumber(value) {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

/**
 * Calculate cost from tokens and pricing
 * @param {object} tokens
 * @param {object} pricing
 * @returns {number} cost in dollars
 */
export function calculateCostFromTokens(tokens, pricing) {
  if (!tokens) return 0;

  const directCost = nonnegativeFiniteNumber(tokens.cost_usd);
  if (directCost !== null) return directCost;
  const alternateDirectCost = nonnegativeFiniteNumber(tokens.cost_in_usd);
  if (alternateDirectCost !== null) return alternateDirectCost;
  const ticks = nonnegativeFiniteNumber(tokens.cost_in_usd_ticks);
  if (ticks !== null) return ticks / 10_000_000_000;
  if (!pricing) return 0;

  let cost = 0;

  const inputTokens = tokens.prompt_tokens || tokens.input_tokens || 0;
  const cachedTokens =
    tokens.cached_tokens || tokens.cache_read_input_tokens || 0;
  const cacheCreationTokens = tokens.cache_creation_input_tokens || 0;
  // prompt_tokens is cache-inclusive (see canonicalizeUsage): cached + cache_creation
  // are subsets, so subtract both to avoid charging them at the full input rate.
  const nonCachedInput = Math.max(
    0,
    inputTokens - cachedTokens - cacheCreationTokens,
  );

  cost += nonCachedInput * (pricing.input / 1000000);

  if (cachedTokens > 0) {
    cost += cachedTokens * ((pricing.cached ?? pricing.input) / 1000000);
  }

  const outputTokens = tokens.completion_tokens || tokens.output_tokens || 0;
  cost += outputTokens * (pricing.output / 1000000);

  // reasoning_tokens are a SUBSET of output tokens on every provider that
  // reports them (OpenAI: output_tokens_details.reasoning_tokens ⊆ output_tokens;
  // Anthropic/Gemini: thinking ⊆ output_tokens), so they are already priced at
  // the output rate above. When a pricing entry carries a distinct reasoning
  // rate, apply only the DELTA between the reasoning and output rates instead
  // of charging the full rate again.
  const reasoningTokens = Math.min(tokens.reasoning_tokens || 0, outputTokens);
  if (
    reasoningTokens > 0 &&
    pricing.reasoning != null &&
    pricing.reasoning !== pricing.output
  ) {
    cost += reasoningTokens * ((pricing.reasoning - pricing.output) / 1000000);
  }

  if (cacheCreationTokens > 0) {
    cost +=
      cacheCreationTokens *
      ((pricing.cache_creation ?? pricing.input) / 1000000);
  }

  return cost;
}
