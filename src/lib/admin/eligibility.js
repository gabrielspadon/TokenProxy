import { resolveProviderId, isProviderDisabled, isNoAuthProvider } from "@/shared/constants/providers.js";
import { accountSupportsModel } from "@/shared/utils/accountModelEligibility.js";
import { isAccountModelDisabled } from "@/shared/utils/disabledModelPolicy.js";
import { getPausedWindow } from "@/shared/utils/quotaPause.js";
import { rankAccounts } from "@/shared/utils/quotaRanking.js";
import { getExhaustedQuotaWindow, getModelLockKey } from "open-sse/services/accountFallback.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { toQuotaSnapshot } from "./project.js";

function timestamp(value) {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function reason(code, label, source, observedAt = null, until = null) {
  return { code, label, source, observedAt: timestamp(observedAt), until: timestamp(until) };
}

/** Pure projection of persisted gates. Never selects, reserves, probes or refreshes. */
export function projectEligibility({ connections, windowsByConnection, drains = {}, qualifications = {}, settings = {}, disabledModels = {}, provider, model, now = Date.now() }) {
  const providerId = resolveProviderId(provider);
  const caps = getCapabilitiesForModel(providerId, model);
  const accounts = connections.map((conn) => {
    const blockers = [];
    const notes = [];
    const configured = conn.providerSpecificData?.enabledModels;
    const hasAllowlist = Array.isArray(configured) && configured.length > 0;
    const supports = accountSupportsModel(conn, model);
    const matchingProvider = resolveProviderId(conn.provider) === providerId;
    const draining = Boolean(drains[conn.id]?.isDraining);
    const enabled = Boolean(conn.isActive);
    if (!matchingProvider) blockers.push(reason("provider-mismatch", "Account belongs to another provider.", "connection.provider"));
    if (!enabled) blockers.push(reason("account-disabled", "Account is disabled for new requests.", "connection.isActive"));
    if (draining) blockers.push(reason("account-draining", "Account is draining and cannot receive new selections.", "admin.drain", drains[conn.id].requestedAt));
    if (isProviderDisabled(settings, providerId)) {
      if (isNoAuthProvider(providerId)) blockers.push(reason("provider-disabled", "Provider is disabled by operator configuration.", "settings.disabledProviders"));
      else notes.push(reason("provider-disable-not-enforced", "A provider-disable setting exists, but account routing does not enforce this switch for authenticated providers.", "settings.disabledProviders"));
    }
    // Share routing's effective account policy, including inherited provider
    // lists, explicit empty account overrides and provider aliases.
    if (matchingProvider && isAccountModelDisabled(disabledModels, provider, model, isNoAuthProvider(providerId) ? null : conn.id)) {
      blockers.push(reason("model-disabled", "Model is disabled for this account by its effective operator policy.", "disabledModels"));
    }
    if (!supports) blockers.push(reason("account-model-excluded", "Model is excluded by this account's explicit allowlist.", "connection.providerSpecificData.enabledModels"));

    // Account-wide and model-specific locks are independent. Expired specific
    // state must not conceal a still-active account-wide lock.
    let cooldownUntil = null;
    for (const key of new Set([getModelLockKey(null), getModelLockKey(model)])) {
      const until = timestamp(conn[key]);
      if (until && Date.parse(until) > now) {
        blockers.push(reason("model-cooldown", "An active routing cooldown blocks this account for the model.", "connection.modelLock", null, until));
        if (!cooldownUntil || until > cooldownUntil) cooldownUntil = until;
      }
    }
    const exhausted = getExhaustedQuotaWindow(conn, model, now);
    if (exhausted) blockers.push(reason("model-quota-gate", "The persisted model quota triggers the routing exhaustion gate.", "connection.lastQuotaSnapshot", conn.lastQuotaSnapshot?.fetchedAt, exhausted.until));
    const pause = getPausedWindow(conn);
    if (pause) blockers.push(reason("quota-threshold", "The persisted quota snapshot triggers a configured pause threshold.", "connection.lastQuotaSnapshot", conn.lastQuotaSnapshot?.fetchedAt));
    const windows = windowsByConnection.get(conn.id) ?? [];
    const ranked = rankAccounts([{ id: conn.id, windows }], { now, model }).ranked[0];
    if (ranked && !ranked.usable) blockers.push(reason("quota-window-gate", "Stored quota windows block selection under the local ranker's rules.", "quotaWindows"));

    const support = hasAllowlist && matchingProvider ? (supports ? "configured" : "excluded") : "unknown";
    if (support === "configured") notes.push(reason("account-model-configured", "This account explicitly permits the requested model; provider support has not been verified.", "connection.providerSpecificData.enabledModels"));
    else if (support === "unknown") notes.push(reason("model-support-unverified", "No account-specific model support evidence is stored.", "connection.providerSpecificData.enabledModels"));
    const probe = qualifications[conn.id];
    const observedAt = timestamp(probe?.checkedAt);
    const quota = toQuotaSnapshot(conn, windows, { now });
    return {
      connectionId: conn.id, provider: conn.provider,
      verdict: blockers.length ? "blocked" : support === "configured" ? "admissible" : "unknown",
      localAdmission: blockers.length ? "blocked" : "allowed",
      reasons: [...blockers.map((r) => ({ ...r, effect: "blocks-selection" })), ...notes.map((r) => ({ ...r, effect: "context" }))], enabled, draining, cooldownUntil,
      legacyCooldownUntil: timestamp(conn.rateLimitedUntil),
      modelSupport: { status: support, source: hasAllowlist ? "connection.providerSpecificData.enabledModels" : null, observedAt: null, upstreamVerified: false },
      // testSingleConnection can check only token presence/expiry or accept a
      // deliberate 400. Its stored default model is not a generation proof.
      qualification: { status: probe?.ok === true ? "passed" : probe?.ok === false ? "failed" : "unknown",
        observedAt, source: probe ? "admin.qualification" : null, kind: "credential-check", modelSupportVerified: false },
      quotaEvidence: { windowCount: windows.length, source: "quotaWindows", historyAvailable: false,
        windows: quota.windows, percentageObservedAt: timestamp(conn.lastQuotaSnapshot?.fetchedAt) },
    };
  });
  return {
    asOf: new Date(now).toISOString(), mode: "passive", requested: { provider: providerId, model, routePrefix: provider },
    basis: "persisted-local-gates", upstreamVerified: false,
    limitations: ["No upstream probe or quota refresh was performed.", "In-memory quota, proxy readiness and request-specific constraints can change a live selection.", "Credential checks and past usage do not establish current model entitlement."],
    capabilities: { source: "routing-capability-resolver", upstreamVerified: false,
      vision: caps.vision, search: caps.search, reasoning: caps.reasoning, tools: caps.tools,
      contextWindow: caps.contextWindow, maxOutput: caps.maxOutput },
    accounts,
  };
}
