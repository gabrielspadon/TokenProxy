import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS, getModelKind } from "@/shared/constants/models";
import {
  AI_PROVIDERS,
  FREE_PROVIDERS,
  FREE_TIER_PROVIDERS,
  getProviderAlias,
  isAnthropicCompatibleProvider,
  isOpenAICompatibleProvider,
  NO_AUTH_PROVIDER_IDS,
} from "@/shared/constants/providers";
import {
  getProviderConnections,
  getCombos,
  getCustomModels,
  getModelAliases,
  getFreeModels,
  updateConnectionProxyPoolSnapshotIfBound,
} from "@/lib/localDb";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { AUTO_ROUTER_MODEL_ID } from "@/sse/services/autoRouter.js";
import { resolveKiroModels } from "open-sse/services/kiroModels.js";
import { resolveKimchiModels } from "open-sse/services/kimchiModels.js";
import { resolveQoderModels } from "open-sse/services/qoderModels.js";
import { resolveCopilotModels } from "open-sse/services/copilotModels.js";
import { resolveClinepassModels } from "open-sse/services/clinepassModels.js";
import { resolveClineModels } from "open-sse/services/clineModels.js";
import { resolveGrokCliModels } from "open-sse/services/grokCliModels.js";
import { resolveCursorModels } from "open-sse/services/cursorModels.js";
import { resolveZedModels } from "open-sse/shared/zedAuth.js";
import { discoverDevinModels } from "open-sse/services/devinModels.js";
import { updateProviderCredentials } from "@/sse/services/tokenRefresh";
import {
  isRequiredProxyUnavailableError,
  resolveConnectionProxyConfig,
  toConnectionProxyOptions,
} from "@/lib/network/connectionProxy";
import { capabilitiesFromServiceKind, getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import { getSettings } from "@/lib/localDb";
import { readClaudeCompat, rewriteModelsListForClaude } from "@/lib/claudeCompat";
import { buildCodexCatalog } from "@/lib/codexCatalog";
// Authenticated OpenAI/Codex catalogs, shared with the provider detail route (#2654).
import {
  resolveLiveCodexModels,
  resolveLiveOpenAIModels,
} from "@/app/api/providers/[id]/models/liveCatalog.js";
import { detectClientTool } from "open-sse/utils/clientDetector.js";

// Per-provider live model resolvers. Each receives a connection record and
// returns { models: [{ id, name? }, ...] } | null on failure.
// Adding a provider here makes /v1/models prefer the live catalog for it.
const LIVE_MODEL_RESOLVERS = {
  kiro: async (conn) => {
    const result = await resolveKiroModels({
      accessToken: conn.accessToken,
      refreshToken: conn.refreshToken,
      providerSpecificData: conn.providerSpecificData || {}
    }, { log: console });
    return result?.models?.length ? { models: result.models } : null;
  },
  qoder: async (conn) => {
    const result = await resolveQoderModels({
      accessToken: conn.accessToken,
      refreshToken: conn.refreshToken,
      email: conn.email,
      displayName: conn.displayName,
      providerSpecificData: conn.providerSpecificData || {}
    });
    if (!result?.models?.length) return null;
    return {
      models: result.models.map((m) => ({ id: m.id, name: m.name })),
    };
  },
  kimchi: async (conn) => {
    const result = await resolveKimchiModels({
      accessToken: conn.accessToken,
      apiKey: conn.apiKey,
      providerSpecificData: conn.providerSpecificData || {}
    }, { log: console });
    return result?.models?.length ? { models: result.models } : null;
  },
  github: async (conn) => {
    const result = await resolveCopilotModels({
      accessToken: conn.accessToken,
      refreshToken: conn.refreshToken,
      providerSpecificData: conn.providerSpecificData || {}
    }, {
      log: console,
      onCredentialsRefreshed: async (refreshed) => {
        await updateProviderCredentials(conn.id, {
          copilotToken: refreshed.copilotToken,
          copilotTokenExpiresAt: refreshed.copilotTokenExpiresAt,
          existingProviderSpecificData: conn.providerSpecificData || {},
        });
      },
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  clinepass: async (conn) => {
    const result = await resolveClinepassModels({
      accessToken: conn.accessToken,
      apiKey: conn.apiKey,
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  cline: async (conn) => {
    const proxy = await resolveConnectionProxyConfig(conn.providerSpecificData || {});
    const result = await resolveClineModels({
      log: console,
      proxyOptions: {
        connectionProxyEnabled: proxy?.connectionProxyEnabled === true,
        connectionProxyUrl: proxy?.connectionProxyUrl || "",
        connectionNoProxy: proxy?.connectionNoProxy || "",
        vercelRelayUrl: proxy?.vercelRelayUrl || "",
        strictProxy: proxy?.strictProxy === true,
      },
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  "grok-cli": async (conn) => {
    const proxy = await resolveConnectionProxyConfig(conn.providerSpecificData || {});
    const result = await resolveGrokCliModels({
      ...conn,
      connectionId: conn.id,
    }, {
      log: console,
      proxyOptions: {
        connectionProxyEnabled: proxy.connectionProxyEnabled === true,
        connectionProxyUrl: proxy.connectionProxyUrl || "",
        connectionNoProxy: proxy.connectionNoProxy || "",
        vercelRelayUrl: proxy.vercelRelayUrl || "",
        strictProxy: proxy.strictProxy === true,
      },
      onCredentialsRefreshed: async (refreshed) => {
        await updateProviderCredentials(conn.id, {
          ...refreshed,
          existingProviderSpecificData: conn.providerSpecificData || {},
        });
      },
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  cursor: async (conn, proxyOptions) => {
    const result = await resolveCursorModels({
      accessToken: conn.accessToken,
      providerSpecificData: conn.providerSpecificData || {},
    }, { log: console, proxyOptions });
    return result?.models?.length ? { models: result.models } : null;
  },
  zed: async (conn) => {
    const result = await resolveZedModels({
      accessToken: conn.accessToken,
      providerSpecificData: conn.providerSpecificData || {},
    });
    if (!result?.models?.length) return null;
    return {
      models: result.models
        .filter((m) => !m.isDisabled)
        .map((m) => ({
          id: m.id,
          name: m.name,
          capabilities: m.supportsTools ? { tools: true } : undefined,
        })),
    };
  },
  devin: async (conn) => {
    const models = await discoverDevinModels(conn.accessToken);
    return models.length ? { models } : null;
  },
  // The provider detail page already fetched these two per connection, so the
  // dashboard could show a current catalog while /v1/models, combo selection
  // and every downstream client still read the static registry (#2654). Both
  // resolve per connection and fail open to that registry, so an expired key or
  // a slow upstream costs a stale listing rather than an empty one.
  openai: (conn) => resolveLiveOpenAIModels(conn),
  codex: (conn) => resolveLiveCodexModels(conn),
};

function cursorSnapshotOwner(connection) {
  const data = connection?.providerSpecificData || {};
  return {
    persistPoolSnapshot: data.proxyPoolId && typeof updateConnectionProxyPoolSnapshotIfBound === "function"
      ? (pair) => updateConnectionProxyPoolSnapshotIfBound(connection.id, data.proxyPoolId, pair)
      : undefined,
  };
}

// Park a started promise as { value } | { error } so a rejection is handled the
// moment it happens and the caller can decide what to do with it later (#2459).
function settled(promise) {
  return promise == null
    ? null
    : Promise.resolve(promise).then((value) => ({ value }), (error) => ({ error }));
}

async function resolveCursorModelProxyOptions(connection) {
  const config = await resolveConnectionProxyConfig(
    connection?.providerSpecificData || {},
    cursorSnapshotOwner(connection),
  );
  return toConnectionProxyOptions(config);
}

export async function assertCursorModelRoutesAvailable(connections) {
  let candidates = connections;
  if (!candidates) {
    try {
      candidates = await getProviderConnections();
    } catch {
      return;
    }
  }
  for (const connection of candidates) {
    if (connection?.provider !== "cursor" || connection.isActive === false) continue;
    await resolveCursorModelProxyOptions(connection);
  }
}

// LLM kind sentinel — combos/models with no explicit kind default to LLM
const LLM_KIND = "llm";

// Map per-model `type` field (in PROVIDER_MODELS) to service kind.
// Models without `type` are treated as LLM.
const MODEL_TYPE_TO_KIND = {
  image: "image",
  tts: "tts",
  embedding: "embedding",
  stt: "stt",
  imageToText: "imageToText",
  video: "video",
  ocr: "ocr",
  moderation: "moderation",
};

function modelKind(model) {
  const k = model?.kind || model?.type;
  if (!k) return LLM_KIND;
  return MODEL_TYPE_TO_KIND[k] || LLM_KIND;
}

// For dynamic/unknown model IDs (compatible providers, alias map, custom models)
// fall back to provider-level kind matching when per-model type is unavailable.
function inferKindFromUnknownModelId(modelId) {
  const lower = String(modelId).toLowerCase();
  if (/embed/.test(lower)) return "embedding";
  if (/tts|speech|audio|voice/.test(lower)) return "tts";
  if (/image|imagen|dall-?e|flux|sdxl|sd-|stable-diffusion/.test(lower)) return "image";
  return LLM_KIND;
}

// Provider matches kindFilter when its serviceKinds intersect the requested kinds.
// LLM is the default kind for providers missing serviceKinds.
function providerMatchesKinds(providerId, kindFilter) {
  const provider = AI_PROVIDERS[providerId];
  const kinds = Array.isArray(provider?.serviceKinds) && provider.serviceKinds.length > 0
    ? provider.serviceKinds
    : [LLM_KIND];
  return kindFilter.some((k) => kinds.includes(k));
}

// Combo matches kindFilter when its `kind` field is in the list.
// Combos with no kind are treated as LLM.
function comboMatchesKinds(combo, kindFilter) {
  const kind = combo?.kind || LLM_KIND;
  return kindFilter.includes(kind);
}

// Claude Code (2.1.263) resolves a model's window from
// `entry.runtime.max_input_tokens ?? entry.context_window`, clamped to
// [8192, 1e6]. It reads neither context_length nor capabilities.contextWindow,
// the only two spellings this gateway emitted, so every listed model missed
// both keys and the client fell back to its built-in catalogue -- the same
// guess-low-against-a-wide-lane failure the bare-id listing already fixed.
// An alias, not a rename: other clients match on context_length, which stays.
// Applied at buildModelsList's two exits rather than beside each of the three
// context_length assignments, so a fourth cannot be added without it.
function withContextWindow(entry) {
  if (Number.isFinite(entry?.context_length) && entry.context_length > 0) {
    entry.context_window = entry.context_length;
  }
  return entry;
}

/**
 * Build OpenAI-format models list filtered by service kinds.
 * @param {string[]} kindFilter - List of service kinds to include (e.g. ["llm"], ["webSearch","webFetch"]).
 * @param {{thinkingVariants?: boolean}} [options] - thinkingVariants adds the
 *   "model(level)" reasoning spellings. Off by default: this is the catalogue
 *   the auto-router, the combo suggester and the dashboard picker all read, and
 *   none of them may see six spellings of one model. Only the public /v1/models
 *   listing turns it on.
 */
export async function buildModelsList(kindFilter, { thinkingVariants = false } = {}) {
  let connections = [];
  // The static-catalogue dump below is a fail-open for an unreadable connection
  // store, and it was gated on `connections.length === 0`, which is also what a
  // healthy store reports for an install with nothing configured. So a user with
  // no credentials at all was served every model of every provider, none of them
  // usable (#1861). Only a genuine read failure takes that path now.
  let connectionsUnavailable = false;
  try {
    connections = await getProviderConnections();
    connections = connections.filter(c => c.isActive !== false);
    await assertCursorModelRoutesAvailable(connections);
  } catch (e) {
    if (isRequiredProxyUnavailableError(e)) throw e;
    connectionsUnavailable = true;
    console.log("Could not fetch providers, returning all models");
  }

  let combos = [];
  try {
    combos = await getCombos();
  } catch (e) {
    console.log("Could not fetch combos");
  }

  let customModels = [];
  try {
    customModels = await getCustomModels();
  } catch (e) {
    console.log("Could not fetch custom models");
  }

  let modelAliases = {};
  try {
    modelAliases = await getModelAliases();
  } catch (e) {
    console.log("Could not fetch model aliases");
  }

  let disabledByAlias = {};
  try {
    disabledByAlias = await getDisabledModels();
  } catch (e) {
    console.log("Could not fetch disabled models");
  }
  const isDisabled = (alias, modelId) => Array.isArray(disabledByAlias[alias]) && disabledByAlias[alias].includes(modelId);

  let settings = {};
  try {
    settings = await getSettings();
  } catch (e) {
    console.log("Could not fetch settings, using defaults");
  }

  const activeConnectionByProvider = new Map();
  // `enabledModels` is read by this listing and nowhere else — routing never
  // filters on it — so a model enabled on the second account of a provider was
  // routable but absent from /v1/models, because only the first connection was
  // consulted (#2702). null means "no restriction": an account that selected
  // nothing serves the whole catalogue, so it lifts the restriction for the
  // provider instead of contributing to the union.
  const enabledModelsByProvider = new Map();
  for (const conn of connections) {
    if (!activeConnectionByProvider.has(conn.provider)) {
      activeConnectionByProvider.set(conn.provider, conn);
    }
    const enabled = conn?.providerSpecificData?.enabledModels;
    const merged = enabledModelsByProvider.get(conn.provider);
    if (!Array.isArray(enabled) || enabled.length === 0) {
      enabledModelsByProvider.set(conn.provider, null);
      continue;
    }
    if (merged === null) continue;
    enabledModelsByProvider.set(conn.provider, [...(merged || []), ...enabled]);
  }

  // A provider that needs no credential never gets a stored connection, so a
  // loop over connections alone dropped its entire catalogue the moment any
  // other provider was connected — the edge-tts, google-tts and local-device
  // voices, and the search/fetch entries of searxng, ddgs and firecrawl_custom
  // (#2702). Seeded with no connection of its own.
  for (const providerId of NO_AUTH_PROVIDER_IDS) {
    if (!activeConnectionByProvider.has(providerId)) {
      activeConnectionByProvider.set(providerId, null);
    }
  }

  const models = [];

  // Combos first (filtered by kind). Web combos expose `kind` so AI knows search vs fetch.
  for (const combo of combos) {
    if (!comboMatchesKinds(combo, kindFilter)) continue;
    const entry = {
      id: combo.name,
      object: "model",
      owned_by: "combo",
    };
    if (combo.kind === "webSearch" || combo.kind === "webFetch") {
      entry.kind = combo.kind;
    }
    // For LLM combos, aggregate token limits across member models:
    // contextWindow takes the minimum (pool bottleneck) and maxOutput takes the maximum.
    if (!combo.kind || combo.kind === LLM_KIND) {
      if (Array.isArray(combo.models) && combo.models.length > 0) {
        let minContext = Infinity;
        let maxOutput = -Infinity;
        let hasContext = false;
        let hasMaxOutput = false;
        let comboCaps = null;

        for (const rawModel of combo.models) {
          if (!rawModel || typeof rawModel !== "string") continue;
          const trimmed = rawModel.trim();
          if (!trimmed) continue;
          const slashIdx = trimmed.indexOf("/");
          const provider = slashIdx !== -1 ? trimmed.slice(0, slashIdx) : "";
          const modelId = slashIdx !== -1 ? trimmed.slice(slashIdx + 1) : trimmed;
          if (!modelId) continue;

          const caps = getCapabilitiesForModel(provider, modelId);
          if (caps) {
            if (Number.isFinite(caps.contextWindow)) {
              minContext = Math.min(minContext, caps.contextWindow);
              hasContext = true;
            }
            if (Number.isFinite(caps.maxOutput)) {
              maxOutput = Math.max(maxOutput, caps.maxOutput);
              hasMaxOutput = true;
            }
            // A combo may route to ANY member, so a boolean capability is only
            // safe to advertise when EVERY member has it — the same conservative
            // reading that makes contextWindow the minimum above. A client that
            // sends an image to a combo whose second member is text-only gets a
            // failure the combo cannot fall back out of.
            if (comboCaps === null) {
              comboCaps = {};
              for (const [key, value] of Object.entries(caps)) {
                if (typeof value === "boolean") comboCaps[key] = value;
              }
            } else {
              for (const key of Object.keys(comboCaps)) {
                if (caps[key] !== true) comboCaps[key] = false;
              }
            }
          }
        }

        if (hasContext && Number.isFinite(minContext)) {
          entry.context_length = minContext;
        }
        if (hasMaxOutput && Number.isFinite(maxOutput)) {
          entry.max_completion_tokens = maxOutput;
        }
        // Same emission condition a single-model entry uses below: publish the
        // block only when one of the three headline flags survived the
        // intersection, so a combo of plain text models stays unadorned.
        if (comboCaps && (comboCaps.vision || comboCaps.search || comboCaps.reasoning)) {
          entry.capabilities = comboCaps;
        }
      }
    }
    models.push(entry);
  }

  // Combo-only exposure: return the deduplicated combo entries built above.
  // This early-return sits AFTER the combo loop (not before it, as upstream
  // PR 3429 does) because fork combo entries carry context_length /
  // max_completion_tokens enrichment that a bare comboToEntry would drop.
  if (settings.exposeComboOnly) {
    const seenComboIds = new Set();
    return models
      .filter((m) => {
        if (m?.owned_by !== "combo" || seenComboIds.has(m.id)) return false;
        seenComboIds.add(m.id);
        return true;
      })
      .map(withContextWindow);
  }

  if (connectionsUnavailable) {
    // DB unavailable -> return static models, filtered by per-model kind
    const aliasToProviderId = Object.fromEntries(
      Object.entries(PROVIDER_ID_TO_ALIAS).map(([id, alias]) => [alias, id])
    );
    for (const [alias, providerModels] of Object.entries(PROVIDER_MODELS)) {
      const providerId = aliasToProviderId[alias] || alias;
      if (!providerMatchesKinds(providerId, kindFilter)) continue;
      for (const model of providerModels) {
        if (!kindFilter.includes(modelKind(model))) continue;
        if (isDisabled(alias, model.id)) continue;
        models.push({
          id: `${alias}/${model.id}`,
          object: "model",
          owned_by: alias,
        });
      }
    }

    for (const customModel of customModels) {
      if (!customModel?.id || (customModel.type && customModel.type !== "llm")) continue;
      // Custom models without active connection are LLM-only by current schema
      if (!kindFilter.includes(LLM_KIND)) continue;
      const providerAlias = customModel.providerAlias;
      if (!providerAlias) continue;

      const modelId = String(customModel.id).trim();
      if (!modelId) continue;

      models.push({
        id: `${providerAlias}/${modelId}`,
        object: "model",
        owned_by: providerAlias,
      });
    }
  } else {
    // The cursor proxy resolution and the live catalog resolver are upstream
    // round trips of seconds each. Awaited inside the loop below their waits
    // summed, so the listing cost as much as every connected provider added
    // together (#2459). Starting them here lets them overlap; the loop still
    // awaits each provider's own pair in its own turn, so one slow or failing
    // upstream costs only its own catalog.
    const inFlightByProvider = new Map();
    for (const [providerId, conn] of activeConnectionByProvider.entries()) {
      if (!providerMatchesKinds(providerId, kindFilter)) continue;
      const enabled = enabledModelsByProvider.get(providerId);
      const wantsLive = Boolean(
        conn
        && LIVE_MODEL_RESOLVERS[providerId]
        && !(Array.isArray(enabled) && enabled.length > 0),
      );
      const cursorProxy = providerId === "cursor"
        ? resolveCursorModelProxyOptions(conn)
        : null;
      if (!cursorProxy && !wantsLive) continue;
      // Settle both now so a rejection cannot surface as an unhandled one while
      // the loop is still working through the providers ahead of this one.
      const live = wantsLive
        ? Promise.resolve(cursorProxy).then(
          (proxyOptions) => LIVE_MODEL_RESOLVERS[providerId](conn, proxyOptions),
        )
        : null;
      inFlightByProvider.set(providerId, {
        cursorProxy: settled(cursorProxy),
        live: settled(live),
      });
    }

    for (const [providerId, conn] of activeConnectionByProvider.entries()) {
      if (!providerMatchesKinds(providerId, kindFilter)) continue;
      const inFlight = inFlightByProvider.get(providerId);

      const staticAlias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
      const outputAlias = (
        conn?.providerSpecificData?.prefix
        || getProviderAlias(providerId)
        || staticAlias
      ).trim();
      const providerModels = PROVIDER_MODELS[staticAlias] || [];
      const enabledModels = enabledModelsByProvider.get(providerId);
      const hasExplicitEnabledModels =
        Array.isArray(enabledModels) && enabledModels.length > 0;
      const isCompatibleProvider =
        isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId);
      // The proxy options were already handed to the live resolver above; this
      // await only surfaces a required-proxy failure before any catalog work.
      if (inFlight?.cursorProxy) {
        const resolved = await inFlight.cursorProxy;
        if (resolved.error) throw resolved.error;
      }

      // Build kind lookup for static models so we can filter even when only IDs are exposed
      const staticModelKindById = new Map(
        providerModels.map((m) => [m.id, modelKind(m)])
      );
      let liveModelKindById = new Map();
      let liveCapabilitiesById = new Map();

      let rawModelIds = isCompatibleProvider
        ? []
        : hasExplicitEnabledModels
        ? Array.from(
            new Set(
              enabledModels.filter(
                (modelId) => typeof modelId === "string" && modelId.trim() !== "",
              ),
            ),
          )
        : providerModels.map((model) => model.id);

      const customModelKindById = new Map();
      const customModelIds = customModels
        .filter((m) => {
          if (!m?.id) return false;
          const kind = getModelKind(m) || LLM_KIND;
          // imageToText custom models are vision-capable chat models: expose them
          // both in the default LLM list and in /v1/models/image-to-text.
          if (!kindFilter.includes(kind) && !(kind === "imageToText" && kindFilter.includes(LLM_KIND))) return false;
          const alias = m.providerAlias;
          return alias === staticAlias || alias === outputAlias || alias === providerId;
        })
        .map((m) => {
          const modelId = String(m.id).trim();
          if (modelId) customModelKindById.set(modelId, getModelKind(m) || LLM_KIND);
          return modelId;
        })
        .filter((modelId) => modelId !== "");

      // Config-driven live catalog override (e.g. Kiro returns dynamic
      // -thinking/-agentic variants per account). On failure, fall back to
      // whatever rawModelIds already holds.
      if (inFlight?.live) {
        const resolved = await inFlight.live;
        if (resolved.error) {
          const err = resolved.error;
          if (isRequiredProxyUnavailableError(err)) throw err;
          console.log(`Live model fetch failed for ${providerId}: ${err?.message || err}`);
        } else {
          const live = resolved.value;
          if (live?.models?.length) {
            rawModelIds = live.models.map((m) => m.id);
            liveModelKindById = new Map(
              live.models
                .filter((m) => m?.id)
                .map((m) => [m.id, modelKind(m)])
            );
            liveCapabilitiesById = new Map(
              live.models
                .filter((m) => m?.id && m.capabilities)
                .map((m) => [m.id, m.capabilities])
            );
          }
        }
      }

      const modelIds = rawModelIds
        .map((modelId) => {
          if (modelId.startsWith(`${outputAlias}/`)) {
            return modelId.slice(outputAlias.length + 1);
          }
          if (modelId.startsWith(`${staticAlias}/`)) {
            return modelId.slice(staticAlias.length + 1);
          }
          if (modelId.startsWith(`${providerId}/`)) {
            return modelId.slice(providerId.length + 1);
          }
          return modelId;
        })
        .filter((modelId) => typeof modelId === "string" && modelId.trim() !== "");

      const aliasModelIds = Object.values(modelAliases || {})
        .filter((fullModel) => {
          if (typeof fullModel !== "string" || !fullModel.includes("/")) return false;
          return (
            fullModel.startsWith(`${outputAlias}/`) ||
            fullModel.startsWith(`${staticAlias}/`) ||
            fullModel.startsWith(`${providerId}/`)
          );
        })
        .map((fullModel) => {
          if (fullModel.startsWith(`${outputAlias}/`)) {
            return fullModel.slice(outputAlias.length + 1);
          }
          if (fullModel.startsWith(`${staticAlias}/`)) {
            return fullModel.slice(staticAlias.length + 1);
          }
          if (fullModel.startsWith(`${providerId}/`)) {
            return fullModel.slice(providerId.length + 1);
          }
          return fullModel;
        })
        .filter((modelId) => typeof modelId === "string" && modelId.trim() !== "");

      const mergedModelIds = Array.from(new Set([
        ...modelIds,
        ...customModelIds,
        ...aliasModelIds,
      ]));

      for (const modelId of mergedModelIds) {
        // Resolve kind: prefer custom/live metadata, then static, then ID heuristics.
        const customKind = customModelKindById.get(modelId);
        const liveKind = liveModelKindById.get(modelId);
        const kind = customKind || liveKind || staticModelKindById.get(modelId) || inferKindFromUnknownModelId(modelId);
        // imageToText custom models stay in the LLM list (vision-capable chat models)
        const allowAsLlm = kind === "imageToText" && kindFilter.includes(LLM_KIND);
        if (!kindFilter.includes(kind) && !allowAsLlm) continue;
        if (isDisabled(outputAlias, modelId) || isDisabled(staticAlias, modelId)) continue;

        const model = {
          id: `${outputAlias}/${modelId}`,
          object: "model",
          owned_by: outputAlias,
        };
        // Live-catalog resolvers (kiro/qoder/github/clinepass) mostly only return
        // { id, name } — no per-model capability data. Fall back to the same
        // pattern-matched capabilities the dashboard uses (useModelCaps.js) so
        // dynamically-discovered LLM models still surface vision/reasoning/search/tools.
        const caps = liveCapabilitiesById.get(modelId)
          || capabilitiesFromServiceKind(customKind || liveKind)
          || (kind === LLM_KIND ? getCapabilitiesForModel(providerId, modelId) : null);
        if (caps) model.capabilities = caps;
        // Token limits under the snake_case names the OpenAI/OpenRouter
        // convention uses. `capabilities.contextWindow` is camelCase and nested,
        // so clients matching context_length find nothing, fall back to guessing
        // the window from the model name, and guess high — a 372k model read as
        // 1.05M never reaches its compaction threshold and hard-fails upstream.
        // Emitted at top level because not every client recurses into nested
        // objects; the camelCase `capabilities` block stays for compatibility.
        if (kind === LLM_KIND || allowAsLlm) {
          let contextWindow = caps?.contextWindow;
          let maxOutput = caps?.maxOutput;
          // Live-catalog and service-kind capabilities are usually partial
          // (often just { tools: true }), so fill the gaps from the static
          // table rather than emitting null and leaving clients to guess.
          if (!Number.isFinite(contextWindow) || !Number.isFinite(maxOutput)) {
            const fallback = getCapabilitiesForModel(providerId, modelId);
            if (!Number.isFinite(contextWindow)) contextWindow = fallback.contextWindow;
            if (!Number.isFinite(maxOutput)) maxOutput = fallback.maxOutput;
          }
          if (Number.isFinite(contextWindow)) model.context_length = contextWindow;
          if (Number.isFinite(maxOutput)) model.max_completion_tokens = maxOutput;
        }
        models.push(model);
        // The router already accepts a "model(level)" thinking suffix, but the
        // listing carried only the bare id, so a client had to know the exact
        // spelling instead of discovering it (#2702). getThinkingLevels returns
        // null for a model that declares no ladder, so a variant is only ever
        // offered for a level the model actually supports.
        if (thinkingVariants && (kind === LLM_KIND || allowAsLlm)) {
          for (const level of getThinkingLevels(providerId, modelId) || []) {
            models.push({ ...model, id: `${model.id}(${level})` });
          }
        }
      }

      // Web search/fetch — provider IS the model, expose as {alias}/search and/or {alias}/fetch with explicit kind
      const providerInfo = AI_PROVIDERS[providerId];
      if (kindFilter.includes("webSearch") && providerInfo?.searchConfig) {
        models.push({
          id: `${outputAlias}/search`,
          object: "model",
          kind: "webSearch",
          owned_by: outputAlias,
        });
      }
      if (kindFilter.includes("webFetch") && providerInfo?.fetchConfig) {
        models.push({
          id: `${outputAlias}/fetch`,
          object: "model",
          kind: "webFetch",
          owned_by: outputAlias,
        });
      }
    }
  }

  // Free-tier catalogs synced by the freeModelSync scheduler. noAuth providers
  // never get stored connections (auth is injected virtually per request), so
  // without this merge their discovered models would never be listed.
  let syncedFreeCatalogs = {};
  try {
    syncedFreeCatalogs = await getFreeModels();
  } catch (e) {
    console.log("Could not fetch free-model catalogs");
  }
  for (const [freeProviderId, freeCatalog] of Object.entries(syncedFreeCatalogs)) {
    if (!FREE_PROVIDERS[freeProviderId] && !FREE_TIER_PROVIDERS[freeProviderId]) continue;
    if (!providerMatchesKinds(freeProviderId, kindFilter)) continue;
    const freeAlias = getProviderAlias(freeProviderId);
    for (const modelId of freeCatalog.ids || []) {
      const kind = inferKindFromUnknownModelId(modelId);
      if (!kindFilter.includes(kind)) continue;
      if (isDisabled(freeAlias, modelId)) continue;

      const model = {
        id: `${freeAlias}/${modelId}`,
        object: "model",
        owned_by: freeAlias,
      };
      const caps = kind === LLM_KIND ? getCapabilitiesForModel(freeProviderId, modelId) : null;
      if (caps) {
        if (caps.vision || caps.search || caps.reasoning) model.capabilities = caps;
        if (Number.isFinite(caps.contextWindow)) model.context_length = caps.contextWindow;
        if (Number.isFinite(caps.maxOutput)) model.max_completion_tokens = caps.maxOutput;
      }
      models.push(model);
    }
  }

  const dedupedModels = [];
  const seenModelIds = new Set();
  for (const model of models) {
    if (!model?.id || seenModelIds.has(model.id)) continue;
    seenModelIds.add(model.id);
    dedupedModels.push(withContextWindow(model));
  }

  return dedupedModels;
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * GET /v1/models - OpenAI compatible models list (LLM/chat models only by default).
 * For other capabilities use /v1/models/{kind} (image, tts, stt, embedding, image-to-text, web).
 */
export async function GET(request) {
  try {
    const data = await buildModelsList([LLM_KIND], { thinkingVariants: true });

    // Anthropic-protocol clients (Claude Code) filter model ids by
    // /(claude|anthropic)/i and would see nothing — rewrite ids with the
    // claude- prefix. OpenAI clients never send the header and get the
    // untouched list.
    // Built before the rewrite below, because that gate needs the detector too.
    const headers = {};
    for (const [key, value] of request.headers) headers[key.toLowerCase()] = value;
    const clientTool = detectClientTool(headers, {});

    let out = data;
    let rewroteForClaude = false;
    if (
      // Protocol-keyed, not identity-keyed: anthropic-version is what the
      // @anthropic-ai/sdk sends on every real request, so ANY client built on
      // it gets this rewrite the moment it sends one, not only Claude Code.
      //
      // The `clientTool === "claude"` half exists only to cover the one
      // request shape that has no anthropic-version to key off: the bare
      // discovery GET, where Claude Code lists models with credential headers
      // and nothing else, so without it every model this router offers got
      // filtered out client-side by /(claude|anthropic)/i and dropped (#2947).
      // It is not a better-hidden identity check standing in reserve — it is
      // the only signal this one call carries. x-api-key (Anthropic's own
      // auth-header convention, and the one this app's own
      // collectClientApiKeyCandidates already treats as protocol-level rather
      // than tool-specific) was considered and rejected: this app's Claude
      // Code integration writes ANTHROPIC_AUTH_TOKEN, so Claude Code presents
      // Authorization: Bearer here too — indistinguishable from a plain
      // OpenAI client's Bearer token, so it settles nothing that
      // anthropic-version does not already settle. There is also no
      // protocol-distinct endpoint to key off instead, unlike /v1/messages vs
      // /v1/responses: catalog discovery is one shared /v1/models GET for
      // every client. Detector reused rather than re-run, since the request
      // path above already computed it.
      (request?.headers?.get("anthropic-version") || clientTool === "claude") &&
      process.env.DISABLE_CLAUDE_COMPAT !== "true"
    ) {
      const compat = readClaudeCompat(await getSettings());
      if (compat.enabled) {
        out = rewriteModelsListForClaude(data, compat);
        rewroteForClaude = true;
      }
    }

    // The auto router is a real routable id that belongs to no provider, so it
    // appeared in no listing and a client had to already know the string
    // (#1386). Added HERE rather than in buildModelsList for two reasons: that
    // function is the catalogue every internal consumer reads, including the
    // router itself and the combo suggester, none of which may see a virtual
    // id; and it is added after the Claude rewrite, because that rewrite would
    // prefix it into "claude-auto-router", a spelling the router does not
    // accept. Only offered when something was actually listed to route to,
    // since an id that answers 503 is worse than no id. Combos do not count:
    // the router never routes to one.
    // Not offered to a Claude-compat client: that client filters ids by
    // /(claude|anthropic)/i and would drop this one anyway, and the rewrite it
    // needs would turn it into a spelling the router does not accept.
    if (!rewroteForClaude && out.some((m) => m.owned_by !== "combo")) {
      out = [...out, { id: AUTO_ROUTER_MODEL_ID, object: "model", owned_by: "tokenproxy" }];
    }

    // Deterministic alphabetical order by the final (possibly rewritten) id.
    out = [...out].sort((a, b) => (a.id || "").localeCompare(b.id || ""));

    // Codex clients read this endpoint as a Codex catalog rather than an OpenAI
    // list, and fail on ours with "failed to decode models response: missing
    // field `models`" (#1908). Same detector the request path uses, so a client
    // that routes as Codex also reads its catalog as Codex.
    //
    // Envelope only, never content: buildCodexCatalog() re-shapes `out` in
    // place — same ids, same order, same set, just `{models:[...]}` instead
    // of `{object:"list",data:[...]}` — so this branch never gives Codex a
    // model Non-Codex clients don't also see. No endpoint- or header-based
    // alternative exists to key this off: Codex's config always sets
    // wire_api = "responses" and it lists models by GETting this same shared
    // /v1/models — there is
    // no separate /v1/responses/models path, and it sends no inbound header
    // naming its wire dialect (the outbound "OpenAI-Beta": "codex-1" in
    // open-sse/services/usage/codex.js is this gateway talking to the
    // provider, not Codex talking to this gateway) — so detectClientTool is
    // the only signal this one call carries, same as the claude- prefix case
    // above.
    if (clientTool === "codex") {
      return Response.json(buildCodexCatalog(out), {
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    return Response.json({ object: "list", data: out }, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  } catch (error) {
    if (isRequiredProxyUnavailableError(error)) {
      return Response.json(
        { error: "Required proxy is unavailable", code: error.code },
        { status: error.status, headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }
    console.log("Error fetching models:", error);
    return Response.json(
      { error: { message: error.message, type: "server_error" } },
      { status: 500 }
    );
  }
}
