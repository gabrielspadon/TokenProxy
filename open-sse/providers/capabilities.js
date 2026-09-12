// Model capabilities — what each model can read/do beyond plain text.
//
// Fallback order (first match wins), result merged over DEFAULT_CAPABILITIES:
//   1. PROVIDER_CAPABILITIES[provider][model]  — provider-specific override
//   2. MODEL_CAPABILITIES[model]               — canonical exact id (handles exceptions)
//   3. PATTERN_CAPABILITIES                     — glob match, ordered specific -> generic
//   4. DEFAULT_CAPABILITIES                     — safe floor (always returned)
//
// Two extra layers then refine the result, and neither can override the hand
// written tables above (steps 1-2 short-circuit before they are consulted):
//   • the synced catalog — modalities keyed by model, limits keyed by provider
//     + model, refreshed from models.dev in the background. It reads a file, so
//     the server installs it via setCatalogSource(); this module stays free of
//     node:fs because the dashboard bundles it into the browser too.
//   • visionPatterns.js — name-based vision detection, last resort so a model
//     nobody has catalogued yet still accepts images.
// Both only ever turn a capability ON, and the user's own overrides still sit
// above both (applyCapabilityOverrides / applyContextOverrides run after).
//
// ── HOW TO ADD / UPDATE A MODEL ──────────────────────────────────────
// Authoritative data source: https://models.dev/api.json (145 providers, 4000+
// models, MIT). Each model exposes the exact fields we map below:
//   modalities.input  ["text","image","pdf","audio","video"] -> vision / pdf / audioInput / videoInput
//   modalities.output ["text","image","audio"]               -> imageOutput / audioOutput
//   reasoning   -> reasoning      tool_call    -> tools
//   limit.context -> contextWindow   limit.output -> maxOutput
// Look up the model id, then:
//   • If a PATTERN below already covers it correctly -> nothing to do.
//   • If it is an exception (pattern would mis-match) -> add an exact entry to
//     MODEL_CAPABILITIES (only the fields that differ from DEFAULT).
//   • If a whole new family -> add an ordered PATTERN (specific before generic).
// NOTE: models.dev has NO "search" flag (web search is a runtime tool, not a
// model spec); set `search` from vendor docs (Claude 4.x+, GPT-5.x/4o, Gemini
// 2.0+, Grok, Perplexity). Verify with: curl -s https://models.dev/api.json

import { matchPattern } from "./pricing.js";
import { looksLikeVisionModel } from "./visionPatterns.js";

/**
 * Safe floor — every resolved result is merged over this so consumers
 * never need null-checks. Most modern LLMs meet these limits.
 */
export const DEFAULT_CAPABILITIES = {
  // input modalities
  vision: false,        // read images
  pdf: false,           // read PDF / documents
  audioInput: false,    // read audio
  videoInput: false,    // read video
  // output modalities
  imageOutput: false,   // generate images
  audioOutput: false,   // generate audio
  // features
  search: false,        // built-in web search tool / grounding
  tools: true,          // function / tool calling
  reasoning: false,     // thinking / reasoning
  // thinking wire format (only meaningful when reasoning:true). null → derive from transport.format.
  // enum: openai|claude-adaptive|claude-budget|gemini-level|gemini-budget|zai|qwen|deepseek|kimi|opencode|minimax|hunyuan|step|nous|meta
  thinkingFormat: null,
  thinkingCanDisable: true,  // false → model cannot turn thinking off (clamp to min instead of disable)
  thinkingRange: null,       // { min, max } for budget formats; null = no clamp
  thinkingEffortSupported: false, // zai format only: model reads a reasoning_effort level (GLM-5.2+; older GLM ignores it)
  // limits (tokens)
  contextWindow: 200000,
  maxOutput: 64000,
};

// User-added model metadata can carry dashboard service kinds instead of the
// runtime capability names used here. Map those typed model kinds into input /
// output capabilities so custom vision models are not treated as text-only.
const SERVICE_KIND_CAPABILITIES = {
  imageToText: { vision: true },
  image: { imageOutput: true },
  stt: { audioInput: true },
  tts: { audioOutput: true },
  embedding: { tools: false },
  ocr: { tools: false },
  moderation: { tools: false },
};

export function capabilitiesFromServiceKind(kind) {
  return SERVICE_KIND_CAPABILITIES[kind] || null;
}

// OpenCode Ox Alpha Free (opencode-go "ox-alpha-free", upstream #3483) — image
// input + reasoning via the shared "opencode" gateway enum. Provider-scoped so
// other providers' same-named models keep pattern/default caps. Upstream PR
// claims ox-alpha accepts only low|high|max (no none/medium) — UNVERIFIED, no
// functional clamp: the generic opencode enum allows none/medium until a live
// probe confirms otherwise.
const OX_ALPHA_CAPABILITIES = {
  vision: true,
  reasoning: true,
  thinkingFormat: "opencode",
  contextWindow: 1000000,
  maxOutput: 131072,
};

/**
 * Canonical exact-id overrides — used for exceptions that patterns would
 * otherwise mis-match. Only declare deltas vs DEFAULT.
 */
export const MODEL_CAPABILITIES = {
  // Claude Opus 5, 4.6/4.7/4.8, and Kiro Sonnet 5 have 1M context + adaptive thinking (override generic claude pattern)
  "claude-opus-5":     { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-5-thinking": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-5-agentic": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-5-thinking-agentic": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4.6":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4.7":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4-7":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4.8":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4-6":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4-8":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4.8-thinking": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4-8-thinking": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-4.6": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-4-6": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-5": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-5-thinking": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-5-agentic": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-5-thinking-agentic": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },

  // Gemini image-gen / OpenAI image / xai image variants
  "gpt-image-1":       { imageOutput: true, tools: false },

  // GLM vision variant (text GLM has no vision)
  "glm-4.6v":          { vision: true, reasoning: true, thinkingFormat: "zai", contextWindow: 128000 },

  // Qwen plain coder/text (no vision) — registry "vision-model" / "coder-model" aliases
  "vision-model":      { vision: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000 },
  "coder-model":       { reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000 },

  // OpenCode zen stealth/free originals — exact ids no pattern covers. Reasoning via
  // the gateway's own reasoning_effort enum (none|low|medium|high|max), not the
  // upstream vendor's (verified live: xhigh/minimal/auto rejected with 1210).
  "x-preview-f-free":  { vision: true, videoInput: true, reasoning: true, thinkingFormat: "opencode", contextWindow: 1000000, maxOutput: 131072 },
  "big-pickle":        { reasoning: true, thinkingFormat: "opencode", contextWindow: 200000, maxOutput: 32000 },
  "muse-spark-1.2":    { vision: true, audioInput: true, videoInput: true, reasoning: true, thinkingFormat: "opencode", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 131072 },
  "muse-spark-1.2-contributor-free": { vision: true, audioInput: true, videoInput: true, reasoning: true, thinkingFormat: "opencode", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 131072 },
  // MiMo v2.5 free resurface — "*mimo*" patterns are non-reasoning; this one reasons.
  "mimo-v2.5-free":    { vision: true, audioInput: true, videoInput: true, reasoning: true, thinkingFormat: "opencode", contextWindow: 200000, maxOutput: 32000 },

  "deepseek-v4-flash-vision-exp": { vision: true, reasoning: true, thinkingFormat: "deepseek", contextWindow: 1000000, maxOutput: 384000 },
  // Kimi flagship + coding (platform + Kimi Code ids) — vision/video native
  "kimi-k3":           { vision: true, videoInput: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 131072 },
  "k3":                { vision: true, videoInput: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 131072 },
  "kimi-for-coding":   { vision: true, videoInput: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 262144, maxOutput: 65536 },
  "kimi-for-coding-highspeed": { vision: true, videoInput: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 262144, maxOutput: 65536 },
  "kimi-k2.7-code":    { vision: true, videoInput: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 262144, maxOutput: 65536 },
  "kimi-k2.7-code-highspeed": { vision: true, videoInput: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 262144, maxOutput: 65536 },
};

const KIRO_GPT_5_6_CAPABILITIES = { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 272000, maxOutput: 128000 };

// Codex OAuth (ChatGPT backend) — per-model context window reported by upstream
// (lower than OpenAI API's 1.05M). Sol differs from Terra/Luna. #2720
const CODEX_GPT_56_SOL_CAPS  = { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 372000, maxOutput: 128000 };
const CODEX_GPT_56_DEFAULT_CAPS = { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 272000, maxOutput: 128000 };

const XIAOMI_TOKENPLAN_TEXT_CAPS = { vision: false, audioInput: false, videoInput: false, contextWindow: 1048576, maxOutput: 131072 };
// The Token Plan TTS ids live in the same `models:` array as the chat ones and
// carry no service kind, so without an entry here they fall through to the
// pattern table: "*mimo*v2.5*" hands a text-to-speech model vision, audioInput
// and videoInput, and "*mimo*" hands the V2 one vision. A TTS model advertising
// vision is wrong whatever the upstream supports, and the provider comment
// above already says Token Plan is text-only. audioOutput is the capability
// these actually have, spelled the way capabilitiesFromServiceKind spells it.
const XIAOMI_TOKENPLAN_TTS_CAPS = {
  vision: false, audioInput: false, videoInput: false, audioOutput: true, tools: false,
};

const XIAOMI_TOKENPLAN_CAPABILITIES = {
  "mimo-v2.5-pro": XIAOMI_TOKENPLAN_TEXT_CAPS,
  "mimo-v2.5-pro-claude": XIAOMI_TOKENPLAN_TEXT_CAPS,
  "mimo-v2.5": XIAOMI_TOKENPLAN_TEXT_CAPS,
  // Scoped to the TTS ids only. #3304 claims the provider has no vision models
  // at all, but that is overbroad: mimo-v2-omni genuinely is multimodal and
  // tests/unit/xiaomi-tokenplan-capabilities.test.js asserts so deliberately.
  // The V2 chat ids therefore keep falling through to the pattern table. What
  // is not defensible either way is a text-to-speech model advertising vision
  // and video input, which is what "*mimo*v2.5*" was granting these four.
  "mimo-v2-tts": XIAOMI_TOKENPLAN_TTS_CAPS,
  "mimo-v2.5-tts": XIAOMI_TOKENPLAN_TTS_CAPS,
  "mimo-v2.5-tts-voiceclone": XIAOMI_TOKENPLAN_TTS_CAPS,
  "mimo-v2.5-tts-voicedesign": XIAOMI_TOKENPLAN_TTS_CAPS,
};


/**
 * Provider-specific capability overrides. Keyed by provider alias/id.
 */
export const PROVIDER_CAPABILITIES = {
  // Token Plan exposes text-only V2.5 chat models under the same IDs that the
  // standard MiMo API uses for a multimodal family. Keep both the canonical ID
  // and the routed model alias because combo/capacity checks receive either.
  "xiaomi-tokenplan": XIAOMI_TOKENPLAN_CAPABILITIES,
  "xmtp": XIAOMI_TOKENPLAN_CAPABILITIES,
  // NVIDIA NIM is OpenAI-compatible → rejects MiniMax/GLM native `thinking` field.
  // Force openai reasoning_effort format for its reasoning models. #issue
  "nvidia": {
    "minimaxai/minimax-m3": { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 512000, maxOutput: 131072 },
    "z-ai/glm-5.2": { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 128000 },
    "deepseek-ai/deepseek-v4-flash-0731": { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 65536 },
    // A provider entry REPLACES the pattern caps rather than merging over them
    // (see getStaticCapabilitiesForModel step 1), so each row restates every
    // non-default capability the pattern would have supplied. Dropping one here
    // silently reverts that capability to the floor.
    "moonshotai/kimi-k2.6": { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 262144, maxOutput: 262144 },
    "stepfun-ai/step-3.7-flash": { vision: true, videoInput: true, reasoning: true, thinkingFormat: "openai", contextWindow: 262144, maxOutput: 65536 },
    // nvidia/nemotron-3-ultra-550b-a55b resolves to thinkingFormat null and needs
    // no override: nothing native is emitted for it in the first place.
  },
  // ClinePass is OpenAI-compatible, so MiMo's effort control is reasoning_effort
  // rather than anything native. The generic "*mimo*v2.5*" pattern grants the
  // multimodal capabilities but no reasoning, which left the model with no
  // effort control at all even though the family is reasoning-tuned and other
  // gateways expose one for it (#3464). Scoped to this provider so a MiMo
  "codex": {
    "gpt-5.6-sol":               CODEX_GPT_56_SOL_CAPS,
    "gpt-5.6-sol-review":        CODEX_GPT_56_SOL_CAPS,
    "gpt-5.6-terra":             CODEX_GPT_56_DEFAULT_CAPS,
    "gpt-5.6-terra-review":      CODEX_GPT_56_DEFAULT_CAPS,
    "gpt-5.6-luna":              CODEX_GPT_56_DEFAULT_CAPS,
    "gpt-5.6-luna-review":       CODEX_GPT_56_DEFAULT_CAPS,
  },
  "kiro": {
    "gpt-5.6-sol": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-terra": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-luna": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-sol-thinking": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-terra-thinking": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-luna-thinking": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-sol-agentic": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-terra-agentic": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-luna-agentic": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-sol-thinking-agentic": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-terra-thinking-agentic": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-luna-thinking-agentic": KIRO_GPT_5_6_CAPABILITIES,
  },
  // Fireworks AI — all models served via OpenAI-compatible API, so
  // thinkingFormat must be "openai" (overrides family-native patterns like
  // zai/deepseek/kimi/minimax/qwen that would produce wrong wire shapes).
  // vision derived from modalities.input, not attachment field.
  fireworks: {
    "accounts/fireworks/models/glm-5p2":                { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true,  contextWindow: 1048575, maxOutput: 131072 },
    "accounts/fireworks/routers/glm-5p2-fast":          { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true,  contextWindow: 1048575, maxOutput: 131072 },
    "accounts/fireworks/models/glm-5p1":                { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true,  contextWindow: 202800,  maxOutput: 131072 },
    "accounts/fireworks/routers/glm-5p1-fast":          { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true,  contextWindow: 202800,  maxOutput: 131072 },
    "accounts/fireworks/models/qwen3p7-plus":           { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true,  contextWindow: 262143, maxOutput: 65536 },
    "accounts/fireworks/models/minimax-m3":             { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 524287,  maxOutput: 512000 },
    "accounts/fireworks/models/minimax-m2p7":           { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 196607,  maxOutput: 196608 },
    "accounts/fireworks/models/kimi-k2p7-code":         { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true,  contextWindow: 262143, maxOutput: 262000 },
    "accounts/fireworks/routers/kimi-k2p7-code-fast":   { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true,  contextWindow: 262143, maxOutput: 262000 },
    "accounts/fireworks/models/kimi-k2p6":              { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true,  contextWindow: 262143, maxOutput: 262000 },
    "accounts/fireworks/routers/kimi-k2p6-turbo":       { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true,  contextWindow: 262143, maxOutput: 262000 },
    "accounts/fireworks/routers/kimi-k2p6-fast":        { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true,  contextWindow: 262143, maxOutput: 262000 },
    "accounts/fireworks/models/gpt-oss-120b":           { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 131071,  maxOutput: 32768 },
    "accounts/fireworks/models/gpt-oss-20b":            { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 131071,  maxOutput: 32768 },
    "accounts/fireworks/models/deepseek-v4-pro":        { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true,  contextWindow: 1048575, maxOutput: 384000 },
    "accounts/fireworks/models/deepseek-v4-flash":      { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true,  contextWindow: 1048575, maxOutput: 384000 },
  },

  // CodeBuddy.cn — authoritative per-model metadata from the gateway's model
  // config (contextWindow=maxInputTokens, maxOutput=maxOutputTokens, vision=
  // supportsImages). Every model reasons via OpenAI-style reasoning_effort
  // (see registry thinkingFormat). `onlyReasoning` models can't turn thinking
  // off → thinkingCanDisable:false (clamped to minimal instead of disabled).
  "codebuddy-cn": {
    "glm-5.2":            { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 48000 },
    "glm-5.1":            { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 48000 },
    "glm-5.0":            { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 48000 },
    "glm-5.0-turbo":      { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 48000 },
    "glm-5v-turbo":       { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 38000 },
    "glm-4.7":            { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 48000 },
    "minimax-m3":         { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 512000, maxOutput: 48000 },
    "minimax-m2.7":       { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 48000 },
    "kimi-k2.7":          { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 256000, maxOutput: 32000 },
    "kimi-k2.6":          { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 256000, maxOutput: 32000 },
    "kimi-k2.5":          { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 164000, maxOutput: 32000 },
    "hy3-preview":        { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 192000, maxOutput: 64000 },
    "deepseek-v4-pro":    { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 50000 },
    "deepseek-v4-flash":  { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 50000 },
    "deepseek-v3-2-volc": { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 96000, maxOutput: 32000 },
  },
  // Qoder — upstream exposes opaque internal ids (dfmodel, kmodel, …); the
  // registry `name` is display-only and capability lookup matches on the raw
  // id, so every qoder model would fall through to DEFAULT_CAPABILITIES
  // (200K) without this map. contextWindow follows the real model family's
  // spec: the /algo/api/v2/model/list max_input_tokens under-reports some
  // windows (GLM-5.3 / Kimi-K3 / Qwen3.8-Max claim 180K but accept more).
  // max_output_tokens arrives as 0 for every model, so outputs are
  // best-guess from the real model family. Vision tags below follow the
  // upstream is_vl flag per explicit request, even though the executor
  // currently sends image_urls:null (image pass-through over the agent_chat
  // SSE protocol is unverified). reasoning:true on all of them — every model can
  // reason; the upstream is_reasoning flag only drives model_config selection.
  // thinkingFormat keeps the true-model family for documentation/UI, but
  // thinkingCanDisable:false everywhere: the executor only forwards
  // messages/tools/max_tokens, and thinking is fixed upstream via
  // modelConfig.is_reasoning — client thinking intent is dropped, so "none"
  // must never be offered as an option.
  "qoder": {
    "ultimate":       { vision: true, reasoning: true, thinkingFormat: "claude-adaptive", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 128000 }, // Claude Opus 5
    "performance":    { vision: true, reasoning: true, thinkingFormat: "claude-adaptive", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 128000 }, // Claude Sonnet 5
    "dmodel":         { reasoning: true, thinkingFormat: "deepseek", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 65536 },  // DeepSeek-V4-Pro
    "dfmodel":        { reasoning: true, thinkingFormat: "deepseek", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 65536 },  // DeepSeek-V4-Flash
    "gmodel":         { reasoning: true, thinkingFormat: "zai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 128000 },      // GLM-5.3
    "kmodel_latest":  { vision: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 65536 },      // Kimi-K3
    "kmodel":         { vision: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 256000, maxOutput: 65536 },  // Kimi-K2.7-Code
    "mmodel":         { reasoning: true, thinkingFormat: "minimax", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 512000 }, // MiniMax-M3
    "qmodel_latest":  { vision: true, reasoning: true, thinkingFormat: "qwen", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 65536 },  // Qwen3.7-Max
    "qmodel":         { vision: true, reasoning: true, thinkingFormat: "qwen", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 65536 },  // Qwen3.7-Plus
    "qmodel_38max":   { vision: true, reasoning: true, thinkingFormat: "qwen", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 65536 },      // Qwen3.8-Max
  },
  // Poolside Laguna — OpenAI-compatible, all reasoning-capable (32K max output).
  "poolside": {
    "laguna-s-2.1":  { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 32000 },
    "laguna-xs-2.1": { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 32000 },
  },
  // Ox Alpha Free — full id (opencode-go) + aliases (ocg/oc) so alias-routed
  // lookups resolve; opencode/x-preview-f-free already covered in
  // MODEL_CAPABILITIES with videoInput:true and the "opencode" format.
  // Meta AI (Muse Spark) — OpenAI-compatible reasoning models. Muse Spark
  // always reasons and rejects "none" (HTTP 400); it accepts
  // minimal/low/medium/high/xhigh and has no "max".
  // A provider entry REPLACES the pattern caps rather than merging over them,
  // so these rows restate the input modalities. Added for thinkingFormat
  // alone, they silently dropped vision/audioInput/videoInput to the floor,
  // which made the Meta-served Muse Spark the one place the family reads as
  // text-only: MODEL_CAPABILITIES["muse-spark-1.2"] and the "*muse-spark*"
  // pattern below both grant all three for the same ids. maxOutput stays at
  // the 64K this endpoint documents; search stays off because the two tables
  // disagree on it and nothing here settles the disagreement.
  "meta": {
    "muse-spark-1.2-contributor": { vision: true, audioInput: true, videoInput: true, reasoning: true, thinkingFormat: "meta", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 64000 },
    "muse-spark-1.2": { vision: true, audioInput: true, videoInput: true, reasoning: true, thinkingFormat: "meta", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 64000 },
    "muse-spark-1.1": { vision: true, audioInput: true, videoInput: true, reasoning: true, thinkingFormat: "meta", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 64000 },
  },
  // The same family reaches OpenRouter under a cloaked id and an
  // OpenAI-compatible wire, so it needs its OWN entry: with none, it fell
  // through to the defaults (reasoning:false, contextWindow 200000) and the
  // request came back HTTP 200 with a body of pure whitespace, because the
  // pipeline was not told to expect reasoning output. Direct-to-OpenRouter with
  // the same body works, which is what rules the upstream out (#3472).
  //
  // A provider entry REPLACES pattern caps rather than merging over them, so
  // every non-default capability is restated here. thinkingCanDisable is false:
  // the Stealth endpoint rejects a disabled reasoning field. The window and
  // output figures come from the reporter's own probing of a cloaked model
  // rather than from a published card; they only steer this router's own
  // truncation, and OpenRouter enforces the real ceiling itself.
  openrouter: {
    "stealth/ox-alpha": {
      vision: false,
      reasoning: true,
      tools: true,
      thinkingFormat: "openai",
      thinkingCanDisable: false,
      contextWindow: 1048576,
      maxOutput: 131072,
    },
    // OpenRouter serves both of these at its own top_provider ceiling of
    // 1048576, which the pattern and canonical tables understate as 1000000
    // (a round number, not a measured one). The gap is not cosmetic: a client
    // that trusts the listed window sizes its compaction threshold from it, so
    // an understated window wastes 48576 tokens of a paid context on every
    // long session. Verified against https://openrouter.ai/api/v1/models on
    // 2026-09-06, where each row reads context_length 1310720 with
    // top_provider.context_length 1048576; the routable ceiling is the
    // provider's, so that is the figure here.
    //
    // A provider entry REPLACES pattern caps rather than merging over them
    // (getStaticCapabilitiesForModel step 1), so every non-default capability
    // the pattern would have supplied is restated. Dropping one silently
    // reverts that capability to the floor.
    "z-ai/glm-5.3-flash": {
      vision: true,
      pdf: true,
      videoInput: true,
      reasoning: true,
      thinkingFormat: "zai",
      thinkingEffortSupported: true,
      thinkingCanDisable: false,
      contextWindow: 1048576,
      maxOutput: 131072,
    },
    "deepseek/deepseek-v4-flash-0731": {
      reasoning: true,
      thinkingFormat: "deepseek",
      thinkingCanDisable: true,
      contextWindow: 1048576,
      maxOutput: 384000,
    },
  },
    opencode: { "ox-alpha-free": OX_ALPHA_CAPABILITIES },
  oc: { "ox-alpha-free": OX_ALPHA_CAPABILITIES },
  "opencode-go": { "ox-alpha-free": OX_ALPHA_CAPABILITIES },
  ocg: { "ox-alpha-free": OX_ALPHA_CAPABILITIES },
  // The current Nous catalogue does not advertise tools/tool_choice for Hermes
  // 4. Its first-party client sends reasoning as a nested object and omits that
  // object when disabled; the public API documents a 32K output ceiling.
  "nous": {
    "nousresearch/hermes-4-70b":  { tools: false, reasoning: true, thinkingFormat: "nous", contextWindow: 131072, maxOutput: 32000 },
    "nousresearch/hermes-4-405b": { tools: false, reasoning: true, thinkingFormat: "nous", contextWindow: 131072, maxOutput: 32000 },
  },
};

// A capability entry is keyed by whatever string reaches lookup, and both the
// canonical provider id and its UI alias do — a combo is stored as
// "alias/model" and reaches getCapabilitiesForModel unresolved. deepseek/ds and
// xiaomi-tokenplan/xmtp register both for that reason; codex, kiro,
// codebuddy-cn and qoder registered only the canonical id, so an alias-routed
// lookup fell through to the pattern table or to the floor. That dropped vision
// on cbcn/glm-5v-turbo (a vision model), on cbcn/deepseek-v4-pro|flash, and on
// every qd/* id, whose opaque upstream ids match no pattern at all.
for (const [alias, canonical] of [["cx", "codex"], ["kr", "kiro"], ["cbcn", "codebuddy-cn"], ["qd", "qoder"]]) {
  PROVIDER_CAPABILITIES[alias] = PROVIDER_CAPABILITIES[canonical];
}

/**
 * Pattern fallback — glob (* = wildcard), matched case-insensitively and
 * anchored (^...$) so a pattern must match the full model id. ORDER MATTERS:
 * vision/specific variants first, text-only/generic families last, to avoid
 * a broad family pattern swallowing an exception (e.g. glm-4.6v vs glm-5).
 */
export const PATTERN_CAPABILITIES = [
  // ── Claude (4.6+ = adaptive thinking; older/haiku = budget) ──────
  { pattern: "*claude*opus-5*",     caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude*sonnet-5*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude*opus-4.6*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive" } },
  { pattern: "*claude*opus-4.7*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive" } },
  { pattern: "*claude*opus-4.8*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive" } },
  { pattern: "*claude*sonnet-4.6*", caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive" } },
  { pattern: "*claude*sonnet-4.7*", caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive" } },
  { pattern: "*claude*haiku*",  caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget" } },
  { pattern: "*claude*opus*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget" } },
  { pattern: "*claude*sonnet*", caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget" } },
  { pattern: "*claude*fable*",  caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude*mythos*", caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude-3*",      caps: { vision: true } },
  { pattern: "*claude*",        caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget" } },

  // ── Gemini (all 2.0+ multimodal + google_search grounding, 1M ctx) ─
  { pattern: "*gemini*image*",  caps: { vision: true, imageOutput: true, contextWindow: 1048576 } },
  { pattern: "*gemini-3.7*",    caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, search: true, thinkingFormat: "gemini-level", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini-3*pro*",  caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, search: true, thinkingFormat: "gemini-level", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 65535 } },
  { pattern: "*gemini-3*",      caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, search: true, thinkingFormat: "gemini-level", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini-2.5*",    caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, search: true, thinkingFormat: "gemini-budget", thinkingRange: { min: 0, max: 24576 }, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini-2*",      caps: { vision: true, audioInput: true, videoInput: true, search: true, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini*",        caps: { vision: true, search: true, contextWindow: 1048576 } },
  // Gemma 4 on the Gemini API takes thinkingLevel; the gemini-2.5 thinkingBudget
  // it would otherwise inherit is answered with 400 INVALID_ARGUMENT (#2480).
  { pattern: "*gemma-4*",       caps: { vision: true, reasoning: true, thinkingFormat: "gemini-level", contextWindow: 128000 } },
  { pattern: "*gemma*",         caps: { vision: true, contextWindow: 128000 } },
  { pattern: "*nanobanana*",    caps: { vision: true, imageOutput: true } },

  // ── OpenAI GPT-5.x (vision + thinking + web search) ──────────────
  { pattern: "*gpt-5*image*",   caps: { imageOutput: true } },
  // models.dev lists "image" in modalities.input for every codex id served
  // here (gpt-5-codex, -5.1-codex, -5.1-codex-max, -5.1-codex-mini,
  // -5.2-codex, -5.3-codex, -5.3-codex-spark). This pattern precedes the
  // generic "*gpt-5*" one, so omitting vision resolved the whole family
  // text-only and stripUnsupportedModalities replaced every image the
  // client sent with "[image omitted: model has no vision support]"
  // before it ever left the router (#1302, #1201).
  { pattern: "*gpt-5*codex*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 400000, maxOutput: 128000 } },
  { pattern: "*gpt-5*",         caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 400000, maxOutput: 128000 } },
  { pattern: "*gpt-4o*",        caps: { vision: true, search: true, contextWindow: 128000, maxOutput: 16384 } },
  { pattern: "*gpt-4.1*",       caps: { vision: true, contextWindow: 1000000, maxOutput: 32768 } },
  { pattern: "*gpt-4-turbo*",   caps: { vision: true, contextWindow: 128000 } },
  { pattern: "*gpt-4*",         caps: { contextWindow: 128000 } },
  { pattern: "*gpt-3.5*",       caps: { contextWindow: 16385, maxOutput: 4096 } },
  { pattern: "*gpt-oss*",       caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 128000 } },

  // ── OpenAI o-series (reasoning, vision) ──────────────────────────
  { pattern: "*o1-mini*",       caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 128000 } },
  { pattern: "*o1*",            caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 100000 } },
  { pattern: "*o3*",            caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 100000 } },
  { pattern: "*o4*",            caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 100000 } },

  // ── Grok (vision + Live Search) ──────────────────────────────────
  { pattern: "*grok*image*",    caps: { imageOutput: true } },
  { pattern: "*grok-code*",     caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 256000 } },
  // Grok 4.6: 500k context, no text output limit (docs.x.ai/developers/grok-4-6)
  { pattern: "*grok-4.6*",      caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 500000, maxOutput: 500000 } },
  // Grok 4.5 (Grok CLI / Grok Build): 500k context per cli-chat-proxy /v1/models
  { pattern: "*grok-4.5*",      caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 500000, maxOutput: 64000 } },
  { pattern: "*grok-4*",        caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 256000 } },
  { pattern: "*grok-3*",        caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 131072 } },
  { pattern: "*grok*",          caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 256000 } },

  // ── Qwen (3.5+ = native vision/video; coder & max = text-only; QwQ = thinking-only) ─
  { pattern: "*qwen*vl*",       caps: { vision: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 262144 } },
  { pattern: "*qwen*omni*",     caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 262144, maxOutput: 65536 } },
  { pattern: "*qwen*coder*",    caps: { reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000 } },
  // Qwen3.8-Max is multimodal (vision/video) but *qwen*max* is text-only (3.6/3.7-max
  // are text-only) → 3.8 patterns must precede *qwen*max* so qwen3.8-max resolve multimodal.
  // Qwen3.8 2.4T open model is NOT multimodal.
  { pattern: "*qwen3.8-2.4t*",  caps: { reasoning: true, thinkingFormat: "qwen", contextWindow: 262144 } },
  { pattern: "*qwen3.8*",       caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen*max*",      caps: { reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen3.5*",       caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen3.6*",       caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen3.7*",       caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen*plus*",     caps: { vision: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen*235b*",     caps: { reasoning: true, thinkingFormat: "qwen", contextWindow: 262144 } },
  { pattern: "*qwq*",           caps: { reasoning: true, thinkingFormat: "qwen", thinkingCanDisable: false, contextWindow: 131072 } },
  { pattern: "*qwen*",          caps: { reasoning: true, thinkingFormat: "qwen", contextWindow: 262144 } },

  // ── Kimi (enabled→reasoning_effort; K2.7-code cannot disable) ─────
  { pattern: "*kimi*k3*",       caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 131072 } },
  { pattern: "*kimi*for-coding*", caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 262144, maxOutput: 65536 } },
  { pattern: "*kimi*k2.7*code*", caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 262144, maxOutput: 65536 } },
  { pattern: "*kimi*k2*",       caps: { vision: true, reasoning: true, thinkingFormat: "kimi", contextWindow: 262144, maxOutput: 262144 } },
  { pattern: "*kimi*",          caps: { reasoning: true, thinkingFormat: "kimi", contextWindow: 262144 } },

  // ── GLM / Z.ai (thinking.enabled; disable via enable_thinking:false) ─
  // GLM-5.3-Flash (multimodal) on top so it override text only GLM-5.3
  { pattern: "*glm-5.3-flash*", caps: { vision: true, videoInput: true, pdf: true, reasoning: true, thinkingFormat: "zai", thinkingEffortSupported: true, thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 131072 } },
  { pattern: "*glm-5.3*",       caps: { reasoning: true, thinkingFormat: "zai", thinkingEffortSupported: true, contextWindow: 1000000, maxOutput: 131072 } },
  { pattern: "*glm-5.2*",       caps: { reasoning: true, thinkingFormat: "zai", thinkingEffortSupported: true, contextWindow: 200000, maxOutput: 128000 } },
  { pattern: "*glm-5*",         caps: { reasoning: true, thinkingFormat: "zai", contextWindow: 200000, maxOutput: 128000 } },
  { pattern: "*glm-4.7*",       caps: { reasoning: true, thinkingFormat: "zai", contextWindow: 200000, maxOutput: 128000 } },
  { pattern: "*glm-4*",         caps: { reasoning: true, thinkingFormat: "zai", contextWindow: 200000 } },
  { pattern: "*glm*",           caps: { reasoning: true, thinkingFormat: "zai", contextWindow: 200000 } },

  // ── DeepSeek (thinking.enabled + reasoning_effort; r1 = thinking-only) ─
  { pattern: "*deepseek-v4*vision*", caps: { vision: true, reasoning: true, thinkingFormat: "deepseek", contextWindow: 1000000, maxOutput: 384000 } },
  { pattern: "*deepseek-v4*",   caps: { reasoning: true, thinkingFormat: "deepseek", contextWindow: 1000000, maxOutput: 384000 } },
  { pattern: "*reasoner*",      caps: { reasoning: true, thinkingFormat: "deepseek", thinkingCanDisable: false, contextWindow: 128000 } },
  { pattern: "*deepseek-r*",    caps: { reasoning: true, thinkingFormat: "deepseek", thinkingCanDisable: false, contextWindow: 128000 } },
  { pattern: "*deepseek-chat*", caps: { contextWindow: 128000 } },
  { pattern: "*deepseek*",      caps: { reasoning: true, thinkingFormat: "deepseek", contextWindow: 128000 } },

  // ── MiniMax (M3 = adaptive; M2.x cannot disable) ─────────────────
  { pattern: "*minimax*image*", caps: { imageOutput: true } },
  { pattern: "*minimax-m3*",    caps: { vision: true, reasoning: true, thinkingFormat: "minimax", contextWindow: 1048576, maxOutput: 512000 } },
  { pattern: "*minimax-m2.7*",  caps: { reasoning: true, thinkingFormat: "minimax", thinkingCanDisable: false, contextWindow: 204800, maxOutput: 131072 } },
  { pattern: "*minimax*",       caps: { reasoning: true, thinkingFormat: "minimax", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 131072 } },

  // ── Xiaomi MiMo (vision, 1M / 262K ctx) ──────────────────────────
  { pattern: "*mimo*v2.5*",     caps: { vision: true, audioInput: true, videoInput: true, contextWindow: 1048576, maxOutput: 131072 } },
  { pattern: "*mimo*omni*",     caps: { vision: true, audioInput: true, contextWindow: 262144, maxOutput: 131072 } },
  { pattern: "*mimo*",          caps: { vision: true, contextWindow: 262144, maxOutput: 131072 } },

  // ── Llama (4 = vision/1M; 3.x = text-only/128K) ──────────────────
  { pattern: "*llama-4*",       caps: { vision: true, contextWindow: 1000000 } },
  { pattern: "*llama*",         caps: { contextWindow: 128000 } },

  // ── Mistral (Large 3 = vision/256K; codestral text) ──────────────
  { pattern: "*codestral*",     caps: { contextWindow: 256000 } },
  { pattern: "*mistral-large*", caps: { vision: true, contextWindow: 256000 } },
  { pattern: "*mistral*",       caps: { contextWindow: 128000 } },

  // ── Cohere (Command A Vision = vision; others text) ──────────────
  { pattern: "*command-a-vision*", caps: { vision: true, contextWindow: 128000 } },
  { pattern: "*command*",       caps: { contextWindow: 128000 } },

  // ── Perplexity (web search native) ───────────────────────────────
  { pattern: "*sonar*",         caps: { search: true, contextWindow: 128000 } },
  { pattern: "*pplx*",          caps: { search: true, contextWindow: 128000 } },
  { pattern: "*perplexity*",    caps: { search: true, contextWindow: 128000 } },

  // ── Poolside Laguna (resellers: openrouter/nvidia/kilocode/vercel/...) ──
  // Free tiers cap S 2.1 well below the paid 1M window → match the free suffix
  // (":free" or "-free", depending on reseller) before the plain id.
  { pattern: "*laguna-s-2.1*free*", caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 32000 } },
  { pattern: "*laguna-s-2.1*",  caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 32000 } },
  { pattern: "*laguna*",        caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 32000 } },

  // ── Meta Muse ────────────────────────────────────────────────────
  // Muse Spark (Meta Model API) always reasons — rejects "none" → cannot disable.
  // Fork live-verified opencode thinking format; upstream claims openai.
  { pattern: "*muse-spark*",    caps: { vision: true, videoInput: true, audioInput: true, reasoning: true, search: true, thinkingFormat: "opencode", thinkingCanDisable: false, contextWindow: 1048576 } },
  { pattern: "*muse-glimmer*",  caps: { vision: true, reasoning: true, thinkingFormat: "opencode", contextWindow: 128000 } },
  { pattern: "*muse*",          caps: { vision: true, reasoning: true, thinkingFormat: "opencode", contextWindow: 128000 } },

  // ── Others ───────────────────────────────────────────────────────
  { pattern: "*hunyuan*",       caps: { reasoning: true, thinkingFormat: "hunyuan", contextWindow: 262144, maxOutput: 262144 } },
  { pattern: "hy3*",            caps: { reasoning: true, thinkingFormat: "hunyuan", contextWindow: 262144, maxOutput: 262144 } },
  { pattern: "*step-3.7*",      caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "step", contextWindow: 262144, maxOutput: 65536 } },
  { pattern: "*step-*",         caps: { reasoning: true, thinkingFormat: "step", contextWindow: 128000 } },
  { pattern: "*nemotron*",      caps: { reasoning: true, contextWindow: 128000 } },
  { pattern: "*ling-*",         caps: { reasoning: true, contextWindow: 128000 } },
];

// Runtime user overrides — contextWindow per model id / glob pattern, injected
// by the app layer (src/lib) via setContextWindowOverrides(). Engine stays
// provider-agnostic: this map lives here, the dashboard owns the persistence.
// Stored on globalThis because Next.js loads instrumentation.js in a separate
// webpack module graph from API routes — a module-level map set at boot would
// never be visible to /v1/models etc., so boot-loaded overrides silently no-op.
const CONTEXT_OVERRIDES_KEY = "__TOKENPROXY_CTX_WINDOW_OVERRIDES__";

function getContextOverridesMap() {
  const existing = globalThis[CONTEXT_OVERRIDES_KEY];
  if (existing instanceof Map) return existing;
  const fresh = new Map();
  globalThis[CONTEXT_OVERRIDES_KEY] = fresh;
  return fresh;
}

// Replace the whole override map (called at boot and after every dashboard edit).
export function setContextWindowOverrides(map) {
  globalThis[CONTEXT_OVERRIDES_KEY] =
    map instanceof Map ? map : new Map(Object.entries(map || {}));
}

export function getContextWindowOverrides() {
  return Object.fromEntries(getContextOverridesMap());
}

// Same globalThis reasoning as the contextWindow map above: Next.js loads
// instrumentation.js in a separate module graph from the API routes, so a
// module-level map set at boot would never be visible where routing reads it.
const CAPABILITY_OVERRIDES_KEY = "__TOKENPROXY_MODEL_CAP_OVERRIDES__";

function getCapabilityOverridesMap() {
  const existing = globalThis[CAPABILITY_OVERRIDES_KEY];
  if (existing instanceof Map) return existing;
  const fresh = new Map();
  globalThis[CAPABILITY_OVERRIDES_KEY] = fresh;
  return fresh;
}

// Replace the whole map (called at boot and after every custom-model edit).
// Values are partial capability objects, e.g. { vision: true, contextWindow: 1e6 }.
export function setModelCapabilityOverrides(map) {
  globalThis[CAPABILITY_OVERRIDES_KEY] =
    map instanceof Map ? map : new Map(Object.entries(map || {}));
}

export function getModelCapabilityOverrides() {
  return Object.fromEntries(getCapabilityOverridesMap());
}

// Operator-supplied capability overrides, read from the environment. The map
// above only ever carries CUSTOM models (bring-your-own endpoint), so an
// existing provider's model this file gets wrong stays wrong until a release —
// which is why #3455 and #3472 report hand-patching the installed package, a
// patch every `npm update` throws away. MODEL_CAPABILITY_OVERRIDES is a JSON
// object keyed exactly as lookupOverride resolves: "provider/model", a bare
// model id, or a glob.
//   MODEL_CAPABILITY_OVERRIDES='{"openrouter/stealth/ox-alpha":{"vision":true}}'
// Fails open — anything unparseable is ignored rather than thrown, because a
// bad value must not take the gateway down. Re-parsed only when the raw string
// changes, so a per-request lookup does not re-run JSON.parse.
let envCapsRaw = null;
let envCapsMap = new Map();

function getEnvCapabilityOverridesMap() {
  const raw = process.env.MODEL_CAPABILITY_OVERRIDES || "";
  if (raw === envCapsRaw) return envCapsMap;
  envCapsRaw = raw;
  envCapsMap = new Map();
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, caps] of Object.entries(parsed)) {
        if (caps && typeof caps === "object" && !Array.isArray(caps)) envCapsMap.set(key, caps);
      }
    }
  } catch {
    // Ignore a malformed value: the static table is still a working answer.
  }
  return envCapsMap;
}

const MODALITY_KEYS = ["vision", "pdf", "audioInput", "videoInput"];

// Catalog lookups, installed by the server at startup. Left as no-ops in the
// browser bundle, where there is no file to read.
let catalogSource = null;

/**
 * Install the synced catalog reader (server only).
 * @param {{ getModalities: Function, getLimits: Function } | null} source
 */
export function setCatalogSource(source) {
  catalogSource = source;
}

// Apply the synced catalog + name heuristic on top of a table-resolved result.
// Strictly additive: a capability already true stays true, and a false one only
// flips when an outside source positively declares support. Reached from steps
// 3 and 4 only — a hand-written entry returns before this runs.
function refine(base, provider, model) {
  const result = { ...DEFAULT_CAPABILITIES, ...base };

  if (catalogSource) {
    const modalities = catalogSource.getModalities(model);
    if (modalities) {
      for (const key of MODALITY_KEYS) {
        if (modalities[key] === true) result[key] = true;
      }
    }

    const limits = catalogSource.getLimits(provider, model);
    if (limits) {
      if (limits.contextWindow > 0) result.contextWindow = limits.contextWindow;
      if (limits.maxOutput > 0) result.maxOutput = limits.maxOutput;
    }
  }

  if (!result.vision && looksLikeVisionModel(model)) result.vision = true;

  return result;
}

/**
 * Resolve capabilities for a model using the 4-step fallback chain,
 * merged over DEFAULT_CAPABILITIES so the result is always complete.
 * WITHOUT user context-window overrides — the "registered default" view.
 *
 * @param {string} provider
 * @param {string} model
 * @returns {object} full capabilities object
 */
export function getStaticCapabilitiesForModel(provider, model) {
  if (!model) return { ...DEFAULT_CAPABILITIES };

  // Strip a trailing thinking suffix "model(value)" so lookups resolve the base id.
  const normalizedModel = model.replace(/\([^()]+\)\s*$/, "").trim();
  // Canonical exact lookup strips vendor prefix: "anthropic/claude-opus-4.7" -> "claude-opus-4.7".
  const baseModel = normalizedModel.includes("/") ? normalizedModel.split("/").pop() : normalizedModel;

  // 1. Provider-specific override
  if (provider) {
    const providerCaps = PROVIDER_CAPABILITIES[provider];
    if (providerCaps?.[normalizedModel]) return { ...DEFAULT_CAPABILITIES, ...providerCaps[normalizedModel] };
    if (providerCaps?.[baseModel]) return { ...DEFAULT_CAPABILITIES, ...providerCaps[baseModel] };
  }

  // 2. Canonical exact
  if (MODEL_CAPABILITIES[baseModel]) return { ...DEFAULT_CAPABILITIES, ...MODEL_CAPABILITIES[baseModel] };
  if (MODEL_CAPABILITIES[normalizedModel]) return { ...DEFAULT_CAPABILITIES, ...MODEL_CAPABILITIES[normalizedModel] };

  // 3. Pattern match (first match wins), refined by catalog + name heuristic
  for (const { pattern, caps } of PATTERN_CAPABILITIES) {
    if (matchPattern(pattern, baseModel) || matchPattern(pattern, normalizedModel)) {
      return refine(caps, provider, model);
    }
  }

  // 4. Floor
  return refine(null, provider, model);
}

// Resolve one entry out of an override map for this provider/model pair.
// Most specific first: a key prefixed with the provider (e.g. "glm/glm-5.3")
// only affects that provider; a bare key (e.g. "glm-5.3") affects every
// provider that serves it, preserving the original global semantics.
// Returns undefined when nothing matches, so a stored falsy value is still
// distinguishable from a miss.
function lookupOverride(map, model, provider) {
  if (!(map instanceof Map) || map.size === 0) return undefined;
  const baseModel = typeof model === "string" && model.includes("/") ? model.split("/").pop() : model;
  const fullKey = provider && baseModel ? `${provider}/${baseModel}` : null;
  // A vendor-prefixed id ("stealth/ox-alpha") loses its prefix in baseModel, so
  // the provider-scoped key built from it ("openrouter/ox-alpha") never matched
  // how the key is actually written: the custom-model store spells it
  // `${providerAlias}/${id}` with the id intact. Try that unstripped form
  // first — it is the most specific key either side can express.
  const rawKey = provider && typeof model === "string" ? `${provider}/${model}` : null;

  if (rawKey && map.has(rawKey)) return map.get(rawKey);
  if (fullKey && map.has(fullKey)) return map.get(fullKey);
  if (map.has(baseModel)) return map.get(baseModel);
  if (typeof model === "string" && map.has(model)) return map.get(model);
  for (const [pattern, value] of map) {
    if (pattern.includes("*") && (
      (rawKey && matchPattern(pattern, rawKey)) ||
      (fullKey && matchPattern(pattern, fullKey)) ||
      matchPattern(pattern, baseModel) ||
      (typeof model === "string" && matchPattern(pattern, model))
    )) {
      return value;
    }
  }
  return undefined;
}

function applyContextOverrides(caps, model, provider) {
  const window = lookupOverride(getContextOverridesMap(), model, provider);
  return window === undefined ? caps : { ...caps, contextWindow: window };
}

// Per-model capability overrides, injected by the app layer from the custom-model
// store. A custom model whose id matches no pattern in this file falls to
// DEFAULT_CAPABILITIES, which says vision:false, so an image-capable model added
// by hand silently dropped every image (#1904). The declared flags are layered
// over the resolved capabilities; contextWindow overrides are applied AFTER, so
// the dedicated /dashboard/model-context surface still wins where the two meet.
// MODEL_CAPABILITY_OVERRIDES sits UNDER the injected map: both are the user's,
// but a per-model entry written through the dashboard is more specific than an
// environment-wide one, so it wins where the two name the same flag.
function applyCapabilityOverrides(caps, model, provider) {
  const overrides = lookupOverride(getCapabilityOverridesMap(), model, provider);
  const fromEnv = lookupOverride(getEnvCapabilityOverridesMap(), model, provider);
  if (!overrides && !fromEnv) return caps;
  return { ...caps, ...fromEnv, ...overrides };
}

/**
 * Resolve capabilities for a model using the 4-step fallback chain,
 * then layer user contextWindow overrides on top.
 *
 * @param {string} provider
 * @param {string} model
 * @returns {object} full capabilities object
 */
export function getCapabilitiesForModel(provider, model) {
  const resolved = applyCapabilityOverrides(getStaticCapabilitiesForModel(provider, model), model, provider);
  return applyContextOverrides(resolved, model, provider);
}
