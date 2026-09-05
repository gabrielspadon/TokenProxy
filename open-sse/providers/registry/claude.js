import { CLAUDE_CLI_SPOOF_HEADERS } from "../shared.js";

export default {
  id: "claude",
  priority: 10,
  alias: "cc",
  uiAlias: "cc",
  display: {
    name: "Claude Code",
    icon: "smart_toy",
    color: "#D97757",
    website: "https://claude.ai",
    notice: {
      signupUrl: "https://claude.ai",
    },
    deprecated: true,
    deprecationNotice: "RISK_NOTICE",
  },
  category: "oauth",
  transport: {
    baseUrl: "https://api.anthropic.com/v1/messages",
    format: "claude",
    urlSuffix: "?beta=true",
    headers: {
      "Anthropic-Version": "2023-06-01",
      "Anthropic-Beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24,structured-outputs-2025-12-15,fast-mode-2026-02-01,redact-thinking-2026-02-12,token-efficient-tools-2026-03-28",
      "Anthropic-Dangerous-Direct-Browser-Access": "true",
      "User-Agent": "claude-cli/2.1.92 (external, sdk-cli)",
      "X-App": "cli",
      "X-Stainless-Helper-Method": "stream",
      "X-Stainless-Retry-Count": "0",
      "X-Stainless-Runtime-Version": "v24.14.0",
      "X-Stainless-Package-Version": "0.80.0",
      "X-Stainless-Runtime": "node",
      "X-Stainless-Lang": "js",
      "X-Stainless-Arch": "arm64",
      "X-Stainless-Os": "MacOS",
      "X-Stainless-Timeout": "600",
    },
    // Response-header deadline. The 15s global default is a CONNECT budget and
    // it is wrong for this provider, because Anthropic sends no headers until
    // prefill is done: header latency scales with the prompt. Measured on RTX
    // 2026-09-04 over 601 requests, every one of the 7 at a 150k-token prompt
    // timed out at exactly 15s while 599 of 601 below it succeeded, and TTFT
    // among the successes ran to a p90 of 19.5s and a max of 98s. A 1M-token
    // window makes a 15s header budget unusable at the top of its own range.
    // 120s is CONNECT_TIMEOUT_MAX_MS, the ceiling isValidConnectTimeoutMs
    // enforces -- anything above it is silently rejected and falls through to
    // the 60s env default, which is still under the measured max. It clears
    // that 98s observation with headroom. A genuinely dead socket still fails
    // fast on ECONNREFUSED/ENOTFOUND, and a hung stream is still bounded by
    // STREAM_FIRST_CHUNK_TIMEOUT_MS (200s), STREAM_STALL_TIMEOUT_MS (360s) and
    // RESPONSE_BODY_TIMEOUT_MS (300s), so this only stops aborting live
    // prefills that were about to succeed.
    timeoutMs: 120000,
    quirks: {
      cloakToolsOnOAuth: true,
    },
    auth: {
      apiKey: {
        header: "x-api-key",
        scheme: "raw",
      },
      oauth: {
        header: "Authorization",
        scheme: "bearer",
      },
    },
    usage: {
      oauthUrl: "https://api.anthropic.com/api/oauth/usage",
      orgUrl: "https://api.anthropic.com/v1/organizations/{org_id}/usage",
      settingsUrl: "https://api.anthropic.com/v1/settings",
    },
  },
  models: [
    { id: "claude-opus-5", name: "Claude Opus 5" },
    { id: "claude-fable-5", name: "Claude Fable 5" },
    { id: "claude-fable-5-1", name: "Claude Fable 5.1" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "claude-haiku-4-5-20251001", name: "Claude 4.5 Haiku" },
  ],
  oauth: {
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    authorizeUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://api.anthropic.com/v1/oauth/token",
    scopes: [
      "org:create_api_key",
      "user:profile",
      "user:inference",
    ],
    codeChallengeMethod: "S256",
    refreshLeadMs: 14400000,
    refresh: {
      encoding: "json",
    },
  },
  features: {
    usage: true,
  },
};
