import { ANTIGRAVITY_IDE_BASE_URL, ANTIGRAVITY_IDE_USER_AGENT, ANTIGRAVITY_OAUTH_CLIENT } from "../shared.js";

export default {
  id: "antigravity",
  priority: 20,
  alias: "ag",
  uiAlias: "ag",
  display: {
    name: "Antigravity",
    icon: "rocket_launch",
    color: "#F59E0B",
    website: "https://antigravity.google",
    notice: {
      signupUrl: "https://antigravity.google",
    },
    deprecated: true,
    deprecationNotice: "RISK_NOTICE",
  },
  category: "oauth",
  serviceKinds: ["llm", "image", "webSearch"],
  transport: {
    baseUrls: [ANTIGRAVITY_IDE_BASE_URL],
    format: "antigravity",
    headers: {
      "User-Agent": ANTIGRAVITY_IDE_USER_AGENT,
    },
    retry: {
      "429": {
        // Intentionally higher than the 5xx attempts: Antigravity's abuse
        // gate answers 429 Quota Exhausted on bursts that clear within
        // seconds, so it earns more retries than a real server error.
        attempts: 6,
      },
      "500": {
        attempts: 3,
      },
      "503": {
        attempts: 3,
      },
    },
    usage: {
      // Discovery (quota/project) on PROD; daily host rejects these.
      quotaApiUrl: "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
      loadProjectApiUrl: "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
      tokenUrl: "https://oauth2.googleapis.com/token",
    },
    clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    clientSecret: "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",
  },
  models: [
    { id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)", upstreamModelId: "gemini-3.7-flash-tiered(high)" },
    { id: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)", upstreamModelId: "gemini-3.7-flash-tiered(medium)" },
    { id: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)", upstreamModelId: "gemini-3.7-flash-tiered(low)" },
    { id: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)", upstreamModelId: "gemini-3.6-flash-tiered(high)" },
    { id: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash (Medium)", upstreamModelId: "gemini-3.6-flash-tiered(medium)" },
    { id: "gemini-3.6-flash-low", name: "Gemini 3.6 Flash (Low)", upstreamModelId: "gemini-3.6-flash-tiered(low)" },
    // The GA name Google publishes for this model, which is what clients ask for
    // (#2757). Antigravity itself has no bare key for it: the IDE sends
    // gemini-3.6-flash-tiered plus a thinkingLevel, so the bare id routes onto
    // the tiered key rather than going upstream verbatim, at the level
    // src/mitm/config.js already treats as this model's default.
    { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash", upstreamModelId: "gemini-3.6-flash-tiered(medium)" },
    // Friendly synonym, not an Antigravity model key: every other enumeration of
    // this catalog in the tree (src/mitm/config.js MODEL_SYNONYMS,
    // the quota display-name and
    // important-model lists in open-sse/services/usage/google.js, and
    // tests/translator/real/antigravity-models.real.test.js) carries
    // gemini-3-flash-agent and omits this id, so it is routed onto that key
    // rather than sent upstream verbatim.
    { id: "gemini-3.5-flash-high", name: "Gemini 3.5 Flash (High)", upstreamModelId: "gemini-3-flash-agent" },
    { id: "gemini-3-flash-agent", name: "Gemini 3.5 Flash (High)" },
    { id: "gemini-3.5-flash-low", name: "Gemini 3.5 Flash (Medium)" },
    { id: "gemini-3.5-flash-extra-low", name: "Gemini 3.5 Flash (Low)" },
    { id: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)" },
    { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
    { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
    { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
    { id: "gemini-3-flash", name: "Gemini 3 Flash", thinking: false },
    // Image generation models
    { id: "gemini-3.1-flash-image", name: "Gemini 3.1 Flash (Image)", kind: "image", imageGen: true, capabilities: ["textToImage"] },
  ],
  oauth: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://www.googleapis.com/oauth2/v1/userinfo",
    scopes: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/cclog",
      "https://www.googleapis.com/auth/experimentsandconfigs",
    ],
    apiEndpoint: "https://daily-cloudcode-pa.googleapis.com",
    apiVersion: "v1internal",
    loadCodeAssistEndpoint: "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    onboardUserEndpoint: "https://cloudcode-pa.googleapis.com/v1internal:onboardUser",
    loadCodeAssistUserAgent: ANTIGRAVITY_IDE_USER_AGENT,
    refreshLeadMs: 300000,
  },
  // Google Search grounding over the Antigravity OAuth pool. chatSearch.js
  // derives both the model and the endpoint from here, so this block is the
  // single source for the /v1/search route.
  searchViaChat: {
    defaultModel: "gemini-2.5-flash",
    endpoint: `${ANTIGRAVITY_IDE_BASE_URL}/v1internal:generateContent`,
    freeTier: "Free — Google Search grounding through an Antigravity OAuth account.",
  },
  features: {
    usage: true,
  },
};
