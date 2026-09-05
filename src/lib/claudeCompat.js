// Claude compatibility layer — lets Anthropic-protocol clients (Claude Code)
// discover and select non-Claude models through /v1/models + /v1/messages.
//
// Mechanism mirrors cc-switch's proxy but fixes two of its bugs:
//  - official claude-* names are never stripped (cc-switch strips blindly)
//  - the [1m] context suffix is matched case-insensitively
//
// Trigger: clients sending an `anthropic-version` header. The embedded
// @anthropic-ai/sdk hardcodes it on every request and OpenAI clients never send
// it, which is what makes the header a reliable discriminator.

import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import {
  getCustomModels,
  getCombos,
  getModelAliases,
} from "@/lib/localDb";

const CLAUDE_PREFIX = "claude-";
const CONTEXT_SUFFIX_RE = /\[1m\]$/i;
const ONE_MILLION = 1_000_000;

// Read + sanitize claudeCompat settings. Unknown shapes fall back to defaults
// so a hand-edited settings blob can never crash request handling.
export function readClaudeCompat(settings) {
  const raw = settings?.claudeCompat || {};
  const suffixMode = ["off", "auto", "keywords"].includes(raw.suffixMode)
    ? raw.suffixMode
    : "auto";
  return {
    enabled: raw.enabled !== false,
    suffixMode,
    keywords: Array.isArray(raw.keywords)
      ? raw.keywords.filter((k) => typeof k === "string" && k.trim() !== "")
      : [],
  };
}

// Build the set of routable model identifiers used by request-side
// normalization. Deliberately local-reads only (kv + static catalog): no live
// upstream fetches, so the check stays fast on the hot request path.
// ponytail: uncached — SQLite reads here are sub-ms; cache invalidation would
// cost more than it saves.
export async function buildClaudeRoutingIndex() {
  const pairs = new Set(); // "alias/model" forms accepted by routing
  const bare = new Set(); // slash-free names: combos, alias-map keys

  // Static catalog under every alias spelling (alias + provider id)
  for (const [alias, models] of Object.entries(PROVIDER_MODELS || {})) {
    for (const m of models || []) {
      if (!m?.id) continue;
      pairs.add(`${alias}/${m.id}`);
    }
  }
  for (const [providerId, alias] of Object.entries(PROVIDER_ID_TO_ALIAS || {})) {
    for (const m of PROVIDER_MODELS?.[alias] || []) {
      if (m?.id) pairs.add(`${providerId}/${m.id}`);
    }
  }

  try {
    for (const cm of await getCustomModels()) {
      if (!cm?.id) continue;
      const pa = cm.providerAlias;
      if (!pa) continue;
      pairs.add(`${pa}/${cm.id}`);
      const mappedAlias = PROVIDER_ID_TO_ALIAS[pa];
      if (mappedAlias && mappedAlias !== pa) pairs.add(`${mappedAlias}/${cm.id}`);
    }
  } catch {
    // db unavailable — static catalog alone still covers the common cases
  }

  try {
    const aliases = await getModelAliases();
    for (const [key, value] of Object.entries(aliases || {})) {
      bare.add(key);
      if (typeof value === "string" && value.includes("/")) pairs.add(value);
    }
  } catch {
    // ignore — aliases optional
  }

  try {
    for (const combo of await getCombos()) {
      if (combo?.name) bare.add(combo.name);
    }
  } catch {
    // ignore — combos optional
  }

  return { pairs, bare };
}

// Map an incoming client model name to the routable name:
//   "claude-bai/deepseek-v4-flash[1m]" -> "bai/deepseek-v4-flash"
//   "claude-my-combo"                  -> "my-combo"          (when it exists)
//   "claude-sonnet-4-5"                -> unchanged           (official name)
// Anti-mis-strip: only strip when the remainder is recognizably one of ours
// (slash route form, or a known bare name). Unknown claude-* names are kept —
// they're far likelier to be official Anthropic models than typos of ours.
// ponytail: deviates from the approved plan's unconditional fallback-strip on
// purpose — fallback strip would mangle official names when no anthropic
// connection is configured (the exact bug class cc-switch shipped).
export function normalizeClaudeModelName(modelStr, index) {
  if (typeof modelStr !== "string") return modelStr;
  const stripped = modelStr.replace(CONTEXT_SUFFIX_RE, "");
  if (!stripped.startsWith(CLAUDE_PREFIX)) return stripped;

  const rest = stripped.slice(CLAUDE_PREFIX.length);
  if (!rest) return stripped;

  // Derived route form: claude-<alias>/<model>
  if (rest.includes("/")) return rest;

  // Known bare name (combo or alias-map key)
  if (index?.bare?.has(rest) || index?.pairs?.has(rest)) return rest;

  return stripped;
}

// True when the incoming name carries our markers and needs normalizing.
// Cheap pre-guard so non-Claude traffic never pays for the index build.
/**
 * Strip the [1m] context suffix, which tokenproxy appends to its own rewritten
 * /v1/models ids and nothing upstream ever accepts.
 *
 * This is deliberately NOT gated on the claude-compat toggle. A client caches
 * the model list, so an id minted while compat was on is still echoed back
 * after it is turned off, and forwarding the suffix verbatim gives a 404 that
 * looks like a missing model (#2531). Since tokenproxy is the only thing that
 * emits the marker, removing it is always correct.
 *
 * @param {string} modelStr
 * @returns {string} the id with a trailing [1m] removed
 */
export function stripContextSuffix(modelStr) {
  if (typeof modelStr !== "string") return modelStr;
  return modelStr.replace(CONTEXT_SUFFIX_RE, "") || modelStr;
}

export function looksLikeClaudeWrappedModel(modelStr) {
  if (typeof modelStr !== "string") return false;
  if (/^claude-/i.test(modelStr)) return true;
  return CONTEXT_SUFFIX_RE.test(modelStr);
}

// Claude Code's /model picker shows display_name only — same model under
// different providers must stay distinguishable, so keep the provider
// segment (full routable id) instead of the bare model name.
function displayNameFor(id) {
  return id.replace(CONTEXT_SUFFIX_RE, "") || id;
}

// display_name mirrors the id's [1m] suffix (stripped above to avoid doubling,
// re-appended with the same policy) so the picker shows the 1M window too.

function shouldAppendSuffix(entry, compat) {
  if (compat.suffixMode === "off") return false;
  const modelPart = entry.id.includes("/")
    ? entry.id.slice(entry.id.indexOf("/") + 1)
    : entry.id;
  if (compat.suffixMode === "keywords") {
    const lower = modelPart.toLowerCase();
    return compat.keywords.some((k) => lower.includes(k.toLowerCase()));
  }
  // auto: only flag models whose advertised window actually reaches 1M
  return Number.isFinite(entry.context_length) && entry.context_length >= ONE_MILLION;
}

// Rewrite a buildModelsList result for Anthropic-protocol eyes:
// every id gains the claude- prefix (Claude Code filters ids by
// /(claude|anthropic)/i and hides everything else), display_name keeps the
// human-readable model name, and the [1m] beta-toggle suffix follows the
// configured policy.
export function rewriteModelsListForClaude(models, compat) {
  const rewritten = (models || []).map((entry) => {
    const id = typeof entry?.id === "string" ? entry.id : "";
    if (!id) return entry;
    const alreadySuffixed = CONTEXT_SUFFIX_RE.test(id);
    const suffix = !alreadySuffixed && shouldAppendSuffix(entry, compat) ? "[1m]" : "";
    return {
      ...entry,
      id: `${CLAUDE_PREFIX}${id}${suffix}`,
      display_name: `${displayNameFor(id)}${suffix}`,
    };
  });

  // Official Anthropic model names must ALSO appear bare. A Claude Code
  // session launched with --model claude-sonnet-5 matches its model id against
  // this listing verbatim; when only claude-<alias>/claude-sonnet-5[1m] rows
  // exist, nothing matches and the client falls back to its built-in 200k
  // window and auto-compacts at ~160k while the gateway serves 1M (measured:
  // compactMetadata preTokens 168172 against context_served 1000000). The
  // bare name is already routable — the router resolves claude-sonnet-5 to a
  // provider lane without any prefix — so listing it only tells the client
  // the truth about the window it already has. One row per official name,
  // widest window wins when several providers serve it; thinking variants
  // like (high) are provider spellings, not client model ids, so skipped.
  const official = new Map();
  for (const entry of models || []) {
    const id = typeof entry?.id === "string" ? entry.id : "";
    const modelPart = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
    if (!/^claude-[a-z0-9][a-z0-9.-]*$/.test(modelPart)) continue;
    const prev = official.get(modelPart);
    if (!prev || (entry.context_length || 0) > (prev.context_length || 0)) {
      official.set(modelPart, entry);
    }
  }
  for (const [name, entry] of official) {
    if (rewritten.some((m) => m?.id === name)) continue;
    rewritten.push({ ...entry, id: name, display_name: name });
  }
  return rewritten;
}

// Default-model mapping helpers (one-click write to ~/.claude/settings.json)
// live in shared/utils so client bundles can import them without dragging in
// the db layer. Re-exported here to keep the server-side import path stable.
export {
  CLAUDE_ROLE_KEYS,
  emptyClaudeDefaults,
  sanitizeDefaultModels,
  buildClaudeEnvOverrides,
  sanitizeEnvOverrides,
  mergeClaudeEnv,
} from "@/shared/utils/claudeEnv";
