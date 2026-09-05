import pkg from "../../../package.json" with { type: "json" };

// App configuration
export const APP_CONFIG = {
  name: "TokenProxy",
  description: "AI Infrastructure Management",
  version: pkg.version,
};

// Changelog source. TokenProxy ships its own CHANGELOG.md and serves it from the
// running instance, so the dashboard reads no external repository feed.
export const GITHUB_CONFIG = {
  changelogUrl: "/api/changelog",
};

// Updater configuration
export const UPDATER_CONFIG = {
  npmPackageName: "tokenproxy",
  installCmd: "npm i -g tokenproxy",
  installCmdLatest: "npm i -g tokenproxy@latest --prefer-online",
  shutdownCountdownSec: 3,
  exitDelayMs: 500,
  statusPort: 20129,
  statusPollIntervalMs: 1000,
  statusLogTailLines: 8,
  installRetries: 3,
  installRetryDelayMs: 5000,
  lingerAfterDoneMs: 30000,
  waitForExitMinMs: 5000,
  waitForExitMaxMs: 20000,
  waitForExitCheckMs: 500,
  appPort: 20128,
};

// Theme configuration
export const THEME_CONFIG = {
  storageKey: "theme",
  defaultTheme: "system", // "light" | "dark" | "system"
};

// Subscription
export const SUBSCRIPTION_CONFIG = {
  price: 1.0,
  currency: "USD",
  interval: "month",
  planName: "Pro Plan",
};

// API endpoints
export const API_ENDPOINTS = {
  users: "/api/users",
  providers: "/api/providers",
  payments: "/api/payments",
  auth: "/api/auth",
};

export const CONSOLE_LOG_CONFIG = {
  maxLines: 200,
  pollIntervalMs: 1000,
  streamTimeoutMs: 5000,
};

// Client-side store TTL: how long fetched data stays fresh before re-fetching
export const CLIENT_STORE_TTL_MS = 60000;

// One cheapest model per Antigravity quota family (Gemini, and Claude/GPT).
// Antigravity meters per model, and the families roll independently, so both the
// manual hot reload and the auto-ping poke one model out of each. Same truth,
// one owner: a model id renamed upstream must move for both.
const ANTIGRAVITY_QUOTA_MODELS = ["gemini-3.5-flash-extra-low", "gpt-oss-120b-medium"];

// Quota auto-ping: keep 5h windows warm by sending a tiny request right after reset.
export const QUOTA_AUTOPING_CONFIG = {
  tickIntervalMs: 60000,                // scheduler tick
  refreshAheadMs: 300000,               // refetch usage when within 5min of reset
  failureCooldownMs: 900000,            // avoid failed ping spam while upstream/auth is unhealthy
  failureCooldownCapMs: 21600000,       // repeat failures double the cooldown up to 6h
  // WARMING BRAKES. A family that will never be reported by a given plan looks
  // permanently cold, so the interval keeps that from costing a request every
  // tick, and the unstarted backoff drops a family we warmed without effect to
  // one attempt per period. See src/shared/services/quotaWindowWarm.js.
  minWarmIntervalMs: 600000,
  warmIntervalDivisor: 12,              // a 5h window admits an attempt every 25min
  unstartedBackoffPeriods: 1,
  // The clock has to be SEEN to start: a 2xx only says the request was
  // accepted, not that the provider counted it against a window. The check is
  // the NEXT tick's usage read rather than a sleep after the request, so this
  // is the grace period before a family that is still not reporting counts as
  // never having started. Two ticks, because usage endpoints lag metering.
  warmVerifyAfterMs: 120000,
  providers: {
    claude: {
      settingsKey: "claudeAutoPing",    // preserve existing settings contract
      quotaKey: "session (5h)",         // the governing window, for reporting
      // EVERY family this provider meters, not just the governing one. Naming
      // only "session (5h)" meant the 7d window was never kept rolling, and —
      // worse — an ABSENT window is invisible without an expected set to
      // compare the payload against, which is exactly the state an idle
      // account is in. Claude also reports per-model weekly windows; those are
      // picked up dynamically once seen, so they need no entry here.
      expectedWindows: ["session (5h)", "weekly (7d)"],
      authTypes: ["oauth"],
      pingModel: "claude-haiku-4-5-20251001",
      pingText: "hi",
      pingMaxTokens: 1,
    },
    codex: {
      settingsKey: "codexAutoPing",
      quotaKey: "session",
      expectedWindows: ["session"],
      authTypes: ["oauth"],
      // Codex reports a session window with a FUTURE reset even while idle and
      // pushes that reset forward as time passes, so one reading cannot tell an
      // idle window from a running one. A reset that moved this far since the
      // previous tick has been sliding, which means nothing was counted.
      resetAtDriftMs: 30000,
      skipWhenBlockingQuotaExhausted: true,
      // Free and Plus Codex accounts both expose gpt-5.5; avoid fallback probes that waste requests.
      pingModel: "gpt-5.5",
      pingText: "hi",
      pingInstructions: "Reply with OK.",
      pingReasoningEffort: "none",
    },
    antigravity: {
      // Opt-in like the others: absent settings read OFF, so this scheduler
      // makes no real request until an operator turns it on per connection.
      settingsKey: "antigravityAutoPing",
      // Antigravity meters per MODEL rather than by one named window, so this is
      // a SET of quota keys — one per family — not a single literal.
      quotaKeys: ANTIGRAVITY_QUOTA_MODELS,
      expectedWindows: ANTIGRAVITY_QUOTA_MODELS,
      authTypes: ["oauth"],
      // Per-model metering is the one case where one request cannot warm every
      // family, so each is poked in turn.
      pingPerWindow: true,
      pingText: "hi",
      pingMaxTokens: 1,
    },
    kimi: {
      settingsKey: "kimiAutoPing",
      // The registry's small-tier regex matches no kimi id, so without this
      // the generic ping fell through to the LAST registry entry, which is
      // whatever the registry happens to end with. Named so the warm cost is
      // deliberate rather than accidental.
      pingModel: "kimi-latest",
      // Kimi names its windows "Ratelimit" and "Weekly", neither of which
      // carries a parseable duration, so their periods are declared rather
      // than inferred.
      expectedWindows: ["Ratelimit", "Weekly"],
      windowPeriodsMs: { Ratelimit: 18000000, Weekly: 604800000 },
      authTypes: ["oauth", "api_key"],
      pingText: "hi",
      pingMaxTokens: 1,
    },
  },
};

// What the warming toggle promises, per provider. A two-branch ternary in the
// row component described a 5h Claude window on every provider that was not
// Codex, which is wrong for per-model and weekly metering.
export const QUOTA_AUTOPING_TOOLTIPS = {
  claude:
    "When your 5h quota runs out, auto-sends a request the moment it resets so a new window starts right away.",
  codex:
    "Auto-starts the next 5h Codex window after reset by sending a tiny gpt-5.5 request. Consumes a small amount of quota.",
  antigravity:
    "Antigravity meters per model, so this pokes each quota family in turn the moment its window resets.",
  kimi:
    "Auto-sends a tiny request the moment the Ratelimit or Weekly window resets, so the next window starts counting right away.",
};

export const quotaAutoPingTooltip = (provider) =>
  QUOTA_AUTOPING_TOOLTIPS[provider] ||
  "Auto-sends a tiny request the moment a quota window resets, so the next window starts counting right away.";

// provider id -> settings key. The dashboard used to carry its own hardcoded
// copy of this map holding only claude and codex, so antigravity was configured
// here, scheduled here, and had no button anywhere in the UI. Derived now, so a
// provider added above is reachable.
export const QUOTA_AUTOPING_SETTINGS_KEY_BY_PROVIDER = Object.fromEntries(
  Object.entries(QUOTA_AUTOPING_CONFIG.providers)
    .filter(([, cfg]) => cfg.settingsKey)
    .map(([id, cfg]) => [id, cfg.settingsKey])
);

// Which credential kinds a provider's warming can drive. The dashboard gated
// the button on `authType === "oauth"` for every provider, which is right for
// the OAuth three and wrong for a provider metered on an API key.
export const quotaAutoPingSupportsAuthType = (provider, authType) => {
  const cfg = QUOTA_AUTOPING_CONFIG.providers[provider];
  if (!cfg) return false;
  const allowed = cfg.authTypes || ["oauth"];
  return allowed.includes(authType);
};

// Every settings key the auto-ping scheduler recognises, derived from the table
// above rather than listed again. Three call sites used to enumerate the two
// original providers by hand (the settings-write reconfigure, the boot check,
// and the CLI menu), so adding a third provider left it unreachable from any of
// them until each was edited (#2564).
export const QUOTA_AUTOPING_SETTINGS_KEYS = Object.values(QUOTA_AUTOPING_CONFIG.providers)
  .map((p) => p.settingsKey)
  .filter(Boolean);

// The same table as label pairs, so a menu can be generated from it.
export const QUOTA_AUTOPING_PROVIDERS = Object.entries(QUOTA_AUTOPING_CONFIG.providers)
  .map(([id, cfg]) => ({ id, settingsKey: cfg.settingsKey }))
  .filter((p) => p.settingsKey);

// Quota hot-reload: one location for all hot-reloadable providers + target models.
// Add a provider key here and it automatically enables the button in providers/[id]
// page, per-row ConnectionRow, QuotaTracker, and the backend /hotreload route.
export const HOT_RELOAD_CONFIG = {
  providers: {
    antigravity: {
      authType: "oauth",
      models: ANTIGRAVITY_QUOTA_MODELS,
      tooltip: "Hot reload: poke the quota models so the pending 7-day countdown starts now",
    },
  },
};

export const getHotReloadConfig = (provider, authType = "oauth") => {
  const cfg = HOT_RELOAD_CONFIG.providers[provider];
  return cfg && (!cfg.authType || cfg.authType === authType) ? cfg : null;
};

// Re-export from providers.js for backward compatibility
export {
  FREE_PROVIDERS,
  OAUTH_PROVIDERS,
  APIKEY_PROVIDERS,
  WEB_COOKIE_PROVIDERS,
  AI_PROVIDERS,
  AUTH_METHODS,
} from "./providers.js";

// Re-export from models.js for backward compatibility
export {
  PROVIDER_MODELS,
  AI_MODELS,
} from "./models.js";
