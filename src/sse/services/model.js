// Re-export from open-sse with localDb integration
import { getDisabledModels } from "@/lib/disabledModelsDb";
import {
  getModelAliases,
  getCustomModels,
  getComboByName,
  getProviderNodes,
  getProviderConnections,
} from "@/lib/localDb";
import {
  parseModel as parseModelCore,
  resolveModelAliasFromMap,
  getModelInfoCore,
  resolveProviderAlias,
  resolveBareModelStaticOwner,
} from "open-sse/services/model.js";
import { PROVIDER_MODELS } from "open-sse/config/providerModels.js";
import { getFreeModelsForProvider } from "@/lib/db/repos/freeModelsRepo.js";
import { isAccountModelDisabled } from "@/shared/utils/disabledModelPolicy.js";
import { getProviderNodeById } from "@/lib/db/repos/nodesRepo.js";

// Local provider alias overrides (HMR-friendly, applied on top of open-sse map)
const LOCAL_PROVIDER_ALIASES = {
  xmtp: "xiaomi-tokenplan",
  "xiaomi-tokenplan": "xiaomi-tokenplan",
};

export function parseModel(modelStr) {
  const parsed = parseModelCore(modelStr);
  if (parsed?.providerAlias && LOCAL_PROVIDER_ALIASES[parsed.providerAlias]) {
    return {
      ...parsed,
      provider: LOCAL_PROVIDER_ALIASES[parsed.providerAlias],
    };
  }
  return parsed;
}

/**
 * Resolve model alias from localDb
 */
export async function resolveModelAlias(alias) {
  const aliases = await getModelAliases();
  return resolveModelAliasFromMap(alias, aliases);
}

/**
 * Get full model info (parse or resolve)
 */
export async function getModelInfo(modelStr) {
  const parsed = parseModel(modelStr);

  if (!parsed.isAlias) {
    // Provider-node prefixes are user-defined. Check custom nodes first — if the
    // user explicitly created a node with a given prefix, route to it even when
    // the prefix collides with a built-in provider id/alias (e.g. a custom
    // "tokenrouter" node with prefix "tr"). The user's credentials are stored
    // under the node ID; routing to the built-in provider instead would fail
    // with "No credentials for provider". When no custom node matches, fall
    // through to the built-in provider resolution below.
    const openaiNodes = await getProviderNodes({ type: "openai-compatible" });
    const matchedOpenAI = openaiNodes.find(
      (node) => node.prefix === parsed.providerAlias,
    );
    if (matchedOpenAI) {
      return { provider: matchedOpenAI.id, model: parsed.model };
    }

    const anthropicNodes = await getProviderNodes({
      type: "anthropic-compatible",
    });
    const matchedAnthropic = anthropicNodes.find(
      (node) => node.prefix === parsed.providerAlias,
    );
    if (matchedAnthropic) {
      return { provider: matchedAnthropic.id, model: parsed.model };
    }

    const multiNodes = await getProviderNodes({ type: "multi-compatible" });
    const matchedMulti = multiNodes.find(
      (node) => node.prefix === parsed.providerAlias,
    );
    if (matchedMulti) {
      return { provider: matchedMulti.id, model: parsed.model };
    }

    const embeddingNodes = await getProviderNodes({ type: "custom-embedding" });
    const matchedEmbedding = embeddingNodes.find(
      (node) => node.prefix === parsed.providerAlias,
    );
    if (matchedEmbedding) {
      return { provider: matchedEmbedding.id, model: parsed.model };
    }

    return {
      provider: parsed.provider,
      model: parsed.model,
    };
  }

  // Check if this is a combo name before resolving as alias
  // This prevents combo names from being incorrectly routed to providers
  const combo = await getComboByName(parsed.model);
  if (combo) {
    // Return null provider to signal this should be handled as combo
    // The caller (handleChat) will detect this and handle it as combo
    return { provider: null, model: parsed.model };
  }

  // Bare (provider-less) model name: resolve to whichever provider actually
  // serves it (custom registry → static catalog → opencode free catalog),
  // before the generic prefix-inference fallback can blind-route it to the
  // wrong provider.
  const dynamic = await resolveBareModelToProvider(parsed.model);
  if (dynamic) {
    return dynamic;
  }

  return getModelInfoCore(modelStr, getModelAliases);
}

/**
 * Dynamic fallback for bare (provider-less) model names, in priority order:
 * 1. admin-registered custom models (explicit intent — wins over everything),
 * 2. user-defined model aliases (explicit intent — wins over catalog hits),
 * 3. the synced free-model catalog (opencode free tier — hourly fetch+cache
 *    via freeModelSync, no per-request fetch; checked first because the static
 *    registry also declares free-tier ids under opencode-go),
 * 4. static registry declarations (deterministic, no admin data needed).
 * This replaces the brittle hardcoded prefix→provider inference for opencode
 * free tier, mimo, and any other connection-less/providerless provider — a
 * bare name resolves to the real owner instead of being blind-routed to a
 * provider that will reject it.
 */
export async function resolveBareModelToProvider(modelStr) {
  try {
    const custom = await getCustomModels();
    const hit = custom.find(
      (m) => m && m.id === modelStr && (m.type === "llm" || !m.type),
    );
    if (hit && hit.providerAlias) {
      const provider = resolveProviderAlias(hit.providerAlias);
      return { provider, model: hit.id };
    }
  } catch {
    /* fail open: fall through to normal resolution */
  }

  // 2) user-defined model aliases — explicit intent, must win over catalog hits
  try {
    const aliases = await getModelAliases();
    const aliasHit = resolveModelAliasFromMap(modelStr, aliases);
    if (aliasHit) return aliasHit;
  } catch {
    /* fail open: fall through to normal resolution */
  }

  try {
    // Connection-less providers with a synced free catalog: ids are stored per
    // provider id by freeModelSync. Checked before the static scan because the
    // fork's static registry also declares free-tier ids under opencode-go,
    // and the free-tier (noAuth) provider is the intended owner of its names.
    for (const id of ["opencode", "mimo-free"]) {
      const entry = await getFreeModelsForProvider(id);
      if (entry?.ids?.includes(modelStr)) {
        return { provider: id, model: modelStr };
      }
    }
  } catch {
    /* fail open: fall through to normal resolution */
  }

  const staticOwner = await resolveConnectedStaticOwner(modelStr);
  if (staticOwner) {
    return { provider: staticOwner, model: modelStr };
  }

  return null;
}

/**
 * Every provider that statically declares `modelStr`, deduplicated, in the
 * registry's own declaration order — the same order resolveBareModelStaticOwner
 * falls back to.
 */
function staticOwnersOf(modelStr) {
  const owners = [];
  for (const [alias, models] of Object.entries(PROVIDER_MODELS)) {
    if (!Array.isArray(models)) continue;
    if (!models.some((m) => m && m.id === modelStr)) continue;
    const id = resolveProviderAlias(alias);
    if (!owners.includes(id)) owners.push(id);
  }
  return owners;
}

/**
 * A bare id declared by several providers resolved to the FIRST one in registry
 * import order, which is alphabetical and has nothing to do with the user
 * (#710): connect openai, ask for "gpt-5.4", and the request goes to blackbox
 * with a truthful "no credentials" error naming a provider never chosen.
 *
 * Prefer an owner the user has actually connected. The import-order winner
 * still decides when it is itself connected, when none of the owners is, and
 * when the connection list cannot be read — so nothing moves on an install with
 * no connections, which is what the alias/provider baselines snapshot.
 */
async function resolveConnectedStaticOwner(modelStr) {
  const fallback = resolveBareModelStaticOwner(modelStr);
  if (!fallback) return null;

  const owners = staticOwnersOf(modelStr);
  if (owners.length < 2) return fallback;

  try {
    const connections = await getProviderConnections({ isActive: true });
    const connected = new Set(connections.map((c) => c && c.provider));
    if (connected.has(fallback)) return fallback;
    return owners.find((id) => connected.has(id)) || fallback;
  } catch {
    return fallback; // fail open: keep the deterministic order
  }
}

/**
 * Check if model is a combo and get models list
 * @returns {Promise<string[]|null>} Array of models or null if not a combo
 */
export async function getComboModels(modelStr) {
  // Resolve combo by full name first, then by basename (part after the last
  // slash) so client configs like `provider/combo-name` still hit the combo
  // instead of forwarding the raw string to the upstream provider.
  let combo = await getComboByName(modelStr);
  if (!combo && modelStr.includes("/")) {
    combo = await getComboByName(modelStr.split("/").pop());
  }
  if (combo && combo.models && combo.models.length > 0) {
    return filterDisabledComboMembers(combo.models, modelStr);
  }
  return null;
}

// Preflight may refuse a model only when no active account overrides its
// disable. Credential admission repeats the check for the selected account.
// Resolve using the same path as routing, including user model aliases and
// custom provider nodes, rather than trusting the caller's prefix spelling.
async function disabledForEveryAccount(modelStr, disabledModels) {
  if (typeof modelStr !== "string" || !modelStr || modelStr.startsWith("/")) return false;
  if (!disabledModels || typeof disabledModels !== "object" || Object.keys(disabledModels).length === 0) return false;
  try {
    const { provider, model } = await getModelInfo(modelStr);
    if (!provider || !model) return false; // combos and unknown virtual IDs
    const providerNode = await getProviderNodeById(provider);
    const providerAliases = providerNode?.prefix ? [providerNode.prefix] : [];
    const connections = await getProviderConnections({ provider, isActive: true });
    if (!connections.length) return isAccountModelDisabled(disabledModels, provider, model, null, providerAliases);
    return connections.every((connection) =>
      isAccountModelDisabled(disabledModels, provider, model, connection.id, providerAliases));
  } catch {
    // Resolution/admission owns the final error. A failed preflight never
    // substitutes a model or fabricates a disabled verdict.
    return false;
  }
}

export async function isModelDisabled(modelStr) {
  try {
    return await disabledForEveryAccount(modelStr, await getDisabledModels());
  } catch {
    return false; // authoritative credential admission still requires this policy
  }
}

/** Drop disabled combo members, including when every member is disabled. */
export async function filterDisabledComboMembers(models, comboName) {
  let disabledByAlias;
  try {
    disabledByAlias = await getDisabledModels();
  } catch {
    return models; // never fail a route because the disabled list is unreadable
  }
  if (!disabledByAlias || typeof disabledByAlias !== "object") return models;

  const disabled = await Promise.all(models.map((model) => disabledForEveryAccount(model, disabledByAlias)));
  const kept = models.filter((_, index) => !disabled[index]);
  if (kept.length === models.length) return models;
  console.log(`[Combo] "${comboName}": skipping ${models.length - kept.length} disabled member(s)`);
  return kept;
}
