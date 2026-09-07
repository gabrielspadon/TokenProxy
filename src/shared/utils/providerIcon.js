// Provider icon paths under /public/providers.
// Alias related brands; session-cache 404s so one miss never spams again.
import {
  AI_PROVIDERS,
  isAnthropicCompatibleProvider,
  isCustomEmbeddingProvider,
  isOpenAICompatibleProvider,
} from "@/shared/constants/providers";

const ICON_ALIASES = {
  "perplexity-agent": "perplexity",
  "gitlab-duo": "gitlab",
  "vercel-ai-gateway": "vercel",
  "opencode-zen": "opencode",
  // A regional sibling is the same brand. Aliasing beats a second copy of the
  // same bytes, which is what glm-cn was: two files that can drift apart when
  // one is updated.
  "kimi-cn": "kimi",
  "glm-cn": "glm",
  // Search rides the same brand as the chat provider whose key it borrows.
  "ollama-search": "ollama",
  "devin": "devin-cli",
};

// These providers deliberately use their declared text badge. Requesting a
// nonexistent path just to discover that produces a browser-visible 404.
const NO_BRAND_MARK = new Set([
  "selfhosted-embedding",
  "selfhosted-stt",
  "selfhosted-tts",
  "kenari",
  "gitlawb-opengateway",
  "ddgs",
]);

// Runtime only — first 404 remembers id for the whole session
const failedIds = new Set();

function normalizeId(providerId) {
  if (!providerId || typeof providerId !== "string") return "";
  return providerId.trim().toLowerCase();
}

/** Resolve icon file id (after alias). Empty if previously failed this session. */
export function resolveProviderIconId(providerId) {
  const id = normalizeId(providerId);
  if (!id) return "";
  if (failedIds.has(id)) return "";
  const aliased = ICON_ALIASES[id] || id;
  if (failedIds.has(aliased)) return "";
  return aliased;
}

/** `/providers/{id}.png` or null when previously failed. */
export function getProviderIconSrc(providerId) {
  const normalized = normalizeId(providerId);
  if (NO_BRAND_MARK.has(normalized)) return null;
  // Protocol compatibility does not establish the identity of the operator's
  // upstream. Custom nodes use the neutral compatibility badge.
  if (isOpenAICompatibleProvider(normalized)
      || isAnthropicCompatibleProvider(normalized)
      || isCustomEmbeddingProvider(normalized)) return null;
  const id = resolveProviderIconId(providerId);
  return id ? `/providers/${id}.png` : null;
}

/** Call from img onError so later mounts skip the request. */
export function markProviderIconMissing(providerId) {
  const id = normalizeId(providerId);
  if (id) failedIds.add(id);
  const aliased = ICON_ALIASES[id];
  if (aliased) failedIds.add(aliased);
}

// The badge shown when no icon file resolves. Every surface used to derive its
// own, so the same custom provider read as its registry initials in one place
// and as its compatibility initials in another (#1831). One rule, in one place,
// so a caller cannot invent a third.
//
// Order: the provider's own declared badge wins, because a registry entry that
// states one has stated it deliberately. A custom provider has no registry
// entry, so it falls back to what it is compatible WITH, which is the only
// thing actually known about it. Anything else takes the first two letters of
// the name a human sees, never of the internal id.
export function getProviderFallbackInitials(providerId, displayName) {
  // AI_PROVIDERS flattens the registry display block onto the entry, so the
  // badge sits at the top level here rather than under `display`.
  const declared = AI_PROVIDERS[normalizeId(providerId)]?.textIcon;
  if (declared) return declared;

  if (isOpenAICompatibleProvider(providerId)) return "OC";
  if (isAnthropicCompatibleProvider(providerId)) return "AC";
  if (isCustomEmbeddingProvider(providerId)) return "CE";

  const source = (typeof displayName === "string" && displayName.trim())
    || (typeof providerId === "string" ? providerId : "");
  return source.trim().slice(0, 2).toUpperCase() || "??";
}
