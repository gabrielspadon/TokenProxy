// Resolve valid thinking levels per model — drives UI level picker (suffix "model(level)").
// Reuses capabilities.js (thinkingFormat/canDisable) so this file only maps format→levels (DRY).
import { getCapabilitiesForModel } from "./capabilities.js";
import { matchPattern } from "./pricing.js";
import { resolveKiroEffortPath } from "../config/kiroConstants.js";
import { PROVIDERS } from "./index.js";

// Shared level sets (deduped) — verified against provider docs + wire in thinkingUnified.applyFormat.
const L = {
  base: ["none", "low", "medium", "high"], // qwen, step, hunyuan, gemini-budget
  onOff: ["none", "thinking"], // zai (binary), minimax (adaptive)
  openai: ["none", "minimal", "low", "medium", "high", "xhigh"], // GPT-5.x / o-series (no "max")
  levelMax: ["none", "low", "medium", "high", "max"], // claude-adaptive, kimi
  budgetX: ["none", "low", "medium", "high", "xhigh", "max"], // claude-budget
  gemini: ["minimal", "low", "medium", "high"], // gemini-3 thinkingLevel (no disable)
  hiMax: ["none", "high", "max"], // deepseek (low/med→high, xhigh→max)
};

// thinkingFormat → valid selectable levels (source of truth for UI options).
const FORMAT_LEVELS = {
  openai: L.openai,
  "claude-adaptive": L.levelMax,
  "claude-budget": L.budgetX,
  "gemini-level": L.gemini,
  "gemini-budget": L.base,
  zai: L.onOff,
  qwen: L.base,
  kimi: L.levelMax,
  opencode: L.levelMax, // zen gateway enum: none|low|medium|high|max (no xhigh/minimal)
  deepseek: L.hiMax,
  // TokenRouter's reasoning_effort enum is low|medium|high|xhigh|max: it answers
  // 400 on "none"/"auto" and takes "max" natively (see thinkingUnified.js
  // applyFormat case "tokenrouter", added with the enum in 41588bea0). Without an
  // entry here the provider-declared format resolved to no level set and fell back
  // to L.base, so the picker advertised a "none" TokenRouter rejects and hid the
  // xhigh/max it accepts.
  tokenrouter: ["low", "medium", "high", "xhigh", "max"],
  minimax: L.onOff,
  hunyuan: L.base,
  step: L.base,
  ollama: L.levelMax,
  nous: L.base,
  meta: ["minimal", "low", "medium", "high", "xhigh"], // Muse Spark — no disable, no max

};

const CODEX_GPT_5_6_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

// Model-name pattern overrides (glob, first match wins) — more precise than format default.
const PATTERN_THINKING = [
  {
    provider: "codex",
    pattern: "*gpt-5.6-sol*",
    levels: [...CODEX_GPT_5_6_LEVELS, "ultra"],
  },
  {
    provider: "codex",
    pattern: "*gpt-5.6-terra*",
    levels: [...CODEX_GPT_5_6_LEVELS, "ultra"],
  },
  {
    provider: "codex",
    pattern: "*gpt-5.6-luna*",
    levels: CODEX_GPT_5_6_LEVELS,
  },
  { pattern: "*codex*", levels: ["low", "medium", "high", "xhigh"] }, // codex cannot disable thinking
  // Ollama GPT-OSS only supports low/medium/high (no max, per Ollama docs)
  {
    provider: "ollama",
    pattern: "*gpt-oss*",
    levels: ["none", "low", "medium", "high"],
  },
  {
    provider: "ollama-local",
    pattern: "*gpt-oss*",
    levels: ["none", "low", "medium", "high"],
  },
  // Cloudflare Workers AI is an OpenAI-compatible GATEWAY, so the provider
  // declares thinkingFormat "openai" and every model on it inherits the full
  // OpenAI ladder, xhigh included. Cloudflare's own validator rejects xhigh, so
  // a request that reached it answered 400 with a validation error and the
  // account was marked unavailable (#2665). The format is right; the level set
  // is the gateway's, not OpenAI's.
  {
    provider: "cloudflare-ai",
    pattern: "*",
    levels: ["none", "minimal", "low", "medium", "high"],
  },
  // ClinePass is an aggregator: its ids carry the upstream vendor's name, so a
];

// Returns valid thinking levels for a model, or null when the model has no reasoning.
export function getThinkingLevels(provider, model) {
  if (provider === "kiro" && resolveKiroEffortPath(model) === null) return null;
  const caps = getCapabilitiesForModel(provider, model);
  if (!caps.reasoning) return null;
  const hit = PATTERN_THINKING.find(
    (entry) =>
      (!entry.provider || entry.provider === provider) &&
      matchPattern(entry.pattern, model),
  );
  // Provider-declared format wins over per-model caps (same precedence as
  // thinkingUnified.resolveFormat) — e.g. opencode routes every model through
  // one gateway enum regardless of the upstream vendor the id looks like.
  // Same precedence as thinkingUnified.resolveFormat, including the
  // openai-compatible node case: those speak OpenAI's wire whatever their model
  // ids look like, so their levels are OpenAI's too (#2752).
  const routeFmt =
    (provider && PROVIDERS[provider]?.thinkingFormat) ||
    (typeof provider === "string" && provider.startsWith("openai-compatible-") ? "openai" : null);
  const fmt = routeFmt || caps.thinkingFormat;

  // Levels come from the ROUTE, not the model name. A PATTERN_THINKING entry
  // carrying a `provider` is route-scoped and stays authoritative. An entry with
  // no provider is pure NAME inference, and a gateway that declares its own
  // format serves every model through one enum whatever the upstream vendor the
  // id names — so name inference must not override it. Without this, "*codex*"
  // handed the four-level Codex ladder to every gateway: the opencode picker
  // lost the "max"/"none" its enum takes, ollama's gpt-oss-codex offered an
  // "xhigh" that format has no level for, and meta advertised a "max" its
  // ladder stops short of. Same defect fe41dec32 named — resolve from the
  // route, not the name — reached through the pattern table rather than caps.
  const nameOnlyHit = hit && !hit.provider;
  const hitLevels = nameOnlyHit && routeFmt ? null : hit?.levels;
  let levels = hitLevels || FORMAT_LEVELS[fmt] || L.base;
  if (caps.thinkingCanDisable === false)
    levels = levels.filter((l) => l !== "none");
  return levels;
}
