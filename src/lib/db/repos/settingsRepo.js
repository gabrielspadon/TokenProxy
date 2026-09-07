import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import {
  CONNECT_TIMEOUT_DEFAULT_MS,
  isValidConnectTimeoutMs,
} from "../../../../open-sse/config/connectTimeout.js";

import { CONFIG_SETTINGS_KEYS, readRoutingConfig, recordConfigMutation } from "../helpers/configHistory.js";

const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20128";
const DEFAULT_HEADROOM_URL =
  process.env.HEADROOM_URL || "http://localhost:8787";

// Same window parseHeadroomTimeoutMs() accepts for HEADROOM_TIMEOUT_MS, so the
// dashboard and the env var cannot disagree about what a usable timeout is.
const isValidHeadroomTimeoutMs = (value) =>
  Number.isInteger(value) && value > 0 && value < 600000;

const DEFAULT_SETTINGS = {
  cloudEnabled: false,
  analyticsEnabled: false,
  tunnelEnabled: false,
  tunnelUrl: "",
  tunnelProvider: "cloudflare",
  tailscaleEnabled: false,
  tailscaleUrl: "",
  stickyRoundRobinLimit: 3,
  providerStrategies: {},
  // Operator kill switch for the no-auth free providers. They have no
  // connection row to deactivate, so without this there was no way to take one
  // out of rotation at all (#2650). Provider id -> true; absent means enabled.
  disabledProviders: {},
  connectTimeoutMs: CONNECT_TIMEOUT_DEFAULT_MS,
  quotaVisibility: {},
  comboStrategy: "fallback",
  comboStickyRoundRobinLimit: 1,
  comboStrategies: {},
  exposeComboOnly: false,
  capacityAdapter: {
    vision: { enabled: true, roundRobin: false, models: [] },
    pdf: { enabled: false, roundRobin: false, models: [] },
    audioInput: { enabled: true, roundRobin: false, models: [] },
    videoInput: { enabled: false, roundRobin: false, models: [] },
  },
  requireLogin: true,
  requireApiKey: true,
  tunnelDashboardAccess: true,
  authMode: "password",
  ssoType: "oidc",
  oidcIssuerUrl: "",
  oidcClientId: "",
  oidcClientSecret: "",
  oidcScopes: "openid profile email",
  oidcLoginLabel: "Sign in with OIDC",
  samlEntryPoint: "",
  samlIssuer: "urn:tokenproxy:sp",
  samlCert: "",
  samlLoginLabel: "Sign in with SAML SSO",
  samlAttributeEmail: "email",
  samlAttributeName: "name",
  enableObservability: false,
  observabilityMaxRecords: 1000,
  observabilityBatchSize: 20,
  observabilityFlushIntervalMs: 5000,
  observabilityMaxJsonSize: 5,
  outboundProxyEnabled: false,
  outboundProxyUrl: "",
  outboundNoProxy: "",
  mitmRouterBaseUrl: DEFAULT_MITM_ROUTER_BASE,
  dnsToolEnabled: {},
  contextStructureEnabled: true,
  rtkEnabled: true,
  // Schema distillation: strip validation-noise JSON-Schema keywords from
  // tool input_schemas before dispatch. Off by default; engages only past an
  // 8KB serialized-tools floor (open-sse/utils/schemaDistiller.js).
  schemaDistillEnabled: false,
  // Thinking strip: remove thinking/redacted_thinking blocks from historical
  // assistant turns; the live turn keeps its reasoning chain. Off by default.
  thinkingStripEnabled: false,
  // Query-aware compression: collapse low-relevance historical turns to a
  // one-line placeholder against the current query. Off by default.
  queryAwareCompressionEnabled: false,
  // Pair dropping: drop oldest complete text-only turn pairs when the request
  // overruns its context budget. Off by default.
  pairDropEnabled: false,
  // Embedding reorder: move relevant earlier turns next to the recent tail via
  // local OpenAI-compatible embeddings (open-sse/utils/embedReorder.js).
  // Fail-open: an unreachable embed endpoint leaves the prefix untouched.
  embedReorderEnabled: false,
  embedReorderUrl: "http://127.0.0.1:11434/v1/embeddings",
  embedReorderModel: "nomic-embed-text",
  // Mid-prefix note: inject a boundary note summarizing what the prefix
  // stages optimized. Off by default.
  midPrefixInjectEnabled: false,
  // Epoch-aligned compaction cascade (open-sse/utils/epochCompact.js):
  // microcompact stubs old tool_result payloads; autocompact replaces the
  // pre-tail history with one summary message at >= 75% of the context
  // window. Both mutate only below the session's cache-epoch cut. Off by
  // default.
  epochMicroEnabled: false,
  epochAutoEnabled: false,
  // AgentDiet-style expired tool-result pruning (open-sse/utils/dietPrune.js):
  // stubs old, unreferenced tool_result payloads below the cache-epoch cut.
  // Off by default.
  dietEnabled: false,
  // Privacy filter (#2728): pseudonymise emails and the terms below in the
  // outbound body, restored before the client sees the answer. Off by
  // default — it walks every request, so it costs nothing until asked for.
  privacyFilterEnabled: false,
  privacyFilterTerms: [],
  headroomEnabled: false,
  headroomUrl: DEFAULT_HEADROOM_URL,
  headroomCompressUserMessages: false,
  // null means "not configured": chat.js then falls back to HEADROOM_TIMEOUT_MS,
  // and headroom.js to its own default after that. A concrete default here would
  // shadow the env var for every operator who already sets it.
  headroomTimeoutMs: null,
  headroomLossless: false,
  cavemanEnabled: false,
  cavemanLevel: "full",
  ponytailEnabled: false,
  ponytailLevel: "full",
  pxpipeEnabled: false,
  pxpipeAutoInstall: true,
  pxpipeMinChars: 25000,
  pxpipeTimeoutMs: 15000,
  memoryToolPruningEnabled: true,
  memoryMaxToolTurnsKeepFull: 2,
  memoryMaxHistoricalToolChars: 800,
  memoryMediaPruningEnabled: true,
  memoryCompactionEnabled: false,
  memoryCompactionThresholdTokens: 32000,
  memoryRecentTurnsToKeep: 8,
  memoryHandoffEnabled: false,
  freeModelSync: { enabled: false, intervalHours: 4, autoComboIds: [] },
  // Outbound webhook notifications (#3141). Endpoints are operator-supplied
  // URLs; delivery lives in src/lib/notifications/webhooks.js and is
  // strictly fail-open, so nothing here can affect a routed request.
  notifications: {
    enabled: false,
    endpoints: [],
    errorRate: { threshold: 0.5, windowSeconds: 300, minSamples: 20 },
  },
  // Claude compat layer (see src/lib/claudeCompat.js): suffixMode controls
  // when [1m] is appended to rewritten /v1/models ids.
  claudeCompat: {
    enabled: true,
    suffixMode: "auto",
    keywords: [],
  },
  // User contextWindow overrides, keyed by model id or glob pattern (e.g.
  // "glm-5.3" or "glm-5*"). Consumed by open-sse/providers/capabilities.js
  // via setContextWindowOverrides(); managed on /dashboard/model-context.
  contextWindowOverrides: {},
  toolDisclosureEnabled: false,
  toolDisclosureFilterEnabled: false,
  toolDisclosureMaxTools: 20,
  toolDisclosureExcludeServers: [],
  toolDisclosureExcludeTools: [],
};

// Second line of defence behind parseJson's byte decoding. Every writer in this
// file reads the row, spreads it, and writes the result back, so anything that
// is not a plain object turns into a persisted byte-spread that erases the real
// settings. Throwing keeps a damaged row readable for repair; falling back to
// {} would overwrite it with defaults on the very next patch.
function asSettingsObject(value) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value) || ArrayBuffer.isView(value)) {
    throw new TypeError(
      `settings row did not parse to a plain object (got ${Object.prototype.toString.call(value)}); refusing to overwrite it`,
    );
  }
  return value;
}

async function readRaw() {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  return row ? asSettingsObject(parseJson(row.data, {})) : {};
}

function deleteClearedProxyPoolSnapshots(providerStrategies) {
  if (!providerStrategies || typeof providerStrategies !== "object" || Array.isArray(providerStrategies)) {
    return providerStrategies;
  }
  return Object.fromEntries(Object.entries(providerStrategies).map(([providerId, values]) => {
    if (!values || typeof values !== "object" || Array.isArray(values) || values.proxyPoolId !== null) {
      return [providerId, values];
    }
    const normalized = { ...values };
    delete normalized.proxyPoolId;
    delete normalized.strictProxy;
    return [providerId, normalized];
  }));
}

// Merge raw settings with defaults; backward-compat for missing keys
export function mergeWithDefaults(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  for (const [key, defVal] of Object.entries(DEFAULT_SETTINGS)) {
    if (merged[key] === undefined) {
      if (
        key === "outboundProxyEnabled" &&
        typeof merged.outboundProxyUrl === "string" &&
        merged.outboundProxyUrl.trim()
      ) {
        merged[key] = true;
      } else {
        merged[key] = defVal;
      }
    }
  }
  if (!isValidConnectTimeoutMs(merged.connectTimeoutMs)) {
    merged.connectTimeoutMs = CONNECT_TIMEOUT_DEFAULT_MS;
  }
  // Back to unset, not to a number: AbortSignal.timeout coerces a bad value to 0
  // and aborts instantly, which disables compression silently.
  if (merged.headroomTimeoutMs !== null && !isValidHeadroomTimeoutMs(merged.headroomTimeoutMs)) {
    merged.headroomTimeoutMs = null;
  }
  const providerStrategies = { ...(merged.providerStrategies || {}) };
  for (const [providerId, rawOverride] of Object.entries(providerStrategies)) {
    if (!rawOverride || typeof rawOverride !== "object" || Array.isArray(rawOverride)) {
      delete providerStrategies[providerId];
      continue;
    }
    const override = { ...rawOverride };
    if (Object.prototype.hasOwnProperty.call(override, "connectTimeoutMs")
        && !isValidConnectTimeoutMs(override.connectTimeoutMs)) {
      delete override.connectTimeoutMs;
    }
    providerStrategies[providerId] = override;
  }
  merged.providerStrategies = providerStrategies;
  return merged;
}

export async function getSettings() {
  const raw = await readRaw();
  return mergeWithDefaults(raw);
}

// Atomic read-merge-write inside transaction (prevents losing concurrent updates)
export async function updateSettings(updates) {
  const tracked = CONFIG_SETTINGS_KEYS.some(key => Object.hasOwn(updates, key));
  const db = await getAdapter();
  let next;
  db.transaction(function () {
    const before = tracked ? readRoutingConfig(db) : null;
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    const current = row ? asSettingsObject(parseJson(row.data, {})) : {};
    // Nested config objects arrive as partial PATCHes from the dashboard;
    // shallow top-level spread would replace them wholesale and drop
    // sibling keys (e.g. { claudeCompat: { keywords } } losing enabled).
    // Seed from defaults first so even the FIRST patch merges correctly
    // (raw current may not have the key yet).
    const seeded = mergeWithDefaults(current);
    const mergedCurrent = { ...current };
    // claudeCompat arrives as a partial PATCH (e.g. only { keywords }) and
    // needs merging to keep sibling keys like enabled. contextWindowOverrides
    // is deliberately excluded: the model-context API sends the WHOLE map
    // (delete removes a key), and merging would resurrect deleted keys.
    for (const key of ["claudeCompat", "notifications"]) {
      if (
        updates[key] &&
        typeof updates[key] === "object" &&
        seeded[key] &&
        typeof seeded[key] === "object"
      ) {
        updates = { ...updates, [key]: { ...seeded[key], ...updates[key] } };
      }
    }
    if (Object.prototype.hasOwnProperty.call(updates, "providerStrategies")) {
      updates = {
        ...updates,
        providerStrategies: deleteClearedProxyPoolSnapshots(updates.providerStrategies),
      };
    }
    next = { ...mergedCurrent, ...updates };
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(next)],
    );
    if (tracked) recordConfigMutation(db, before, "repo.settings.update");
  });
  return mergeWithDefaults(next);
}

export async function updateProviderStrategy(providerId, values) {
  const dangerousKeys = new Set(["__proto__", "prototype", "constructor"]);
  if (dangerousKeys.has(providerId) || Object.keys(values).some((key) => dangerousKeys.has(key))) {
    throw new TypeError("Invalid provider strategy key");
  }
  const db = await getAdapter();
  let next;
  db.transaction(function () {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    const current = row ? asSettingsObject(parseJson(row.data, {})) : {};
    const strategies = { ...(current.providerStrategies || {}) };
    const provider = { ...(strategies[providerId] || {}) };
    for (const [key, value] of Object.entries(values)) {
      if (value === null) delete provider[key];
      else provider[key] = value;
    }
    if (Object.keys(provider).length === 0) delete strategies[providerId];
    else strategies[providerId] = provider;
    next = { ...current, providerStrategies: strategies };
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(next)],
    );
  });
  return mergeWithDefaults(next);
}

// Conditional ownership prevents a migration writer from overwriting a newer
// no-auth strategy selection that raced with its read.
export async function updateProviderStrategyProxyPoolSnapshotIfBound(providerId, expectedPoolId, pair) {
  const dangerousKeys = new Set(["__proto__", "prototype", "constructor"]);
  if (dangerousKeys.has(providerId)) {
    throw new TypeError("Invalid provider strategy key");
  }
  const db = await getAdapter();
  let result = null;
  db.transaction(function () {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    const current = row ? asSettingsObject(parseJson(row.data, {})) : {};
    const strategies = { ...(current.providerStrategies || {}) };
    const strategy = strategies[providerId];
    if (
      !strategy
      || typeof strategy !== "object"
      || Array.isArray(strategy)
      || strategy.proxyPoolId !== expectedPoolId
    ) {
      return;
    }
    const updatedStrategy = {
      ...strategy,
      proxyPoolId: pair.proxyPoolId,
      strictProxy: pair.strictProxy === true,
    };
    strategies[providerId] = updatedStrategy;
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson({ ...current, providerStrategies: strategies })],
    );
    result = updatedStrategy;
  });
  return result;
}

export async function isCloudEnabled() {
  const settings = await getSettings();
  return settings.cloudEnabled === true;
}

export async function getCloudUrl() {
  const settings = await getSettings();
  return (
    settings.cloudUrl ||
    process.env.CLOUD_URL ||
    process.env.NEXT_PUBLIC_CLOUD_URL ||
    ""
  );
}

export async function exportSettings() {
  return await readRaw();
}
