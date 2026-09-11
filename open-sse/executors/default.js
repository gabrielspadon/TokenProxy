import { applyOperatorHeaders, forwardClientHeaders } from "../utils/clientHeaderPassthrough.js";
import { createHash } from "node:crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS, PROVIDER_OAUTH } from "../config/providers.js";
import { ANTHROPIC_API_VERSION, OPENAI_COMPAT_BASE, ANTHROPIC_COMPAT_BASE, selectAnthropicBeta } from "../providers/shared.js";
import { resolveOpenAICompatibleApiType } from "../services/provider.js";
import { OAUTH_ENDPOINTS, buildKimiHeaders } from "../config/appConstants.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { stripUnsupportedParams } from "../translator/concerns/paramSupport.js";

// Auth header descriptors — derived from registry transport.auth, fallback to hardcoded defaults.
const BEARER = { combined: true, header: "Authorization", scheme: "bearer" };
const XAPIKEY = { combined: true, header: "x-api-key", scheme: "raw" };
const AUTH_DESCRIPTORS = Object.fromEntries(
  Object.entries(PROVIDERS)
    .filter(([, t]) => t.auth)
    .map(([id, t]) => [id, t.auth])
);

// Apply a token to a header per scheme (matches legacy: combined always sets, even when undefined).
function setAuth(headers, spec, token) {
  headers[spec.header] = spec.scheme === "bearer" ? `Bearer ${token}` : token;
}

function hasHeader(headers, name) {
  return Object.keys(headers).some(key => key.toLowerCase() === name);
}

// Resolve auth onto headers from a descriptor.
function applyAuth(headers, desc, credentials) {
  if (desc.combined) {
    // combined providers set the header from whichever credential exists. With
    // NEITHER, the legacy path sent the literal string "Bearer undefined" to the
    // upstream, so a keyless endpoint could not be addressed at all (#1523).
    // Absent both, send no Authorization header; every case where a credential
    // exists is unchanged.
    const token = credentials.apiKey || credentials.accessToken;
    if (token) setAuth(headers, desc, token);
    if (desc.anthropicVersion && !hasHeader(headers, "anthropic-version")) headers["anthropic-version"] = ANTHROPIC_API_VERSION;
    return;
  }
  // split apiKey/oauth: set only the matching branch (legacy: anthropic-compatible skips when both absent)
  if (credentials.apiKey) setAuth(headers, desc.apiKey, credentials.apiKey);
  else if (credentials.accessToken) setAuth(headers, desc.oauth, credentials.accessToken);
  if (desc.anthropicVersion && !hasHeader(headers, "anthropic-version")) headers["anthropic-version"] = ANTHROPIC_API_VERSION;
}

// OpenAI's newer Chat Completions models reject the legacy max_tokens field.
// Keep this scoped to the first-party OpenAI provider: other OpenAI-compatible
// providers may still require max_tokens for models with similar names.
function usesOpenAIMaxCompletionTokens(model) {
  return /^(?:gpt-5(?:[.-]|$)|o[134](?:[.-]|$))/i.test(model || "");
}

// Cloudflare Workers AI's documented default when a client omits max_tokens (#1645).
const CLOUDFLARE_AI_DEFAULT_MAX_TOKENS = 4096;

// Some OpenAI-compatible upstreams enforce their own floor on max_tokens and
// refuse the request outright: "max_tokens must be greater than 2" (#1702).
// Matched narrowly — the field name AND the comparison AND a number — so an
// unrelated failure never costs a second upstream call.
const MAX_TOKENS_FLOOR_RE = /max_tokens\D{0,20}?must be (greater than|at least)\s*(\d+)/i;

// The floor the upstream just named, or null when it named none, when the
// request did not undershoot it, or when the body cannot be read.
async function readMaxTokensFloor(response, body) {
  if (!response || response.ok || typeof response.clone !== "function") return null;
  const sent = body?.max_tokens;
  if (typeof sent !== "number" || !Number.isFinite(sent)) return null;
  let text = "";
  try {
    text = await response.clone().text();
  } catch {
    return null; // body already gone: nothing to react to
  }
  const m = MAX_TOKENS_FLOOR_RE.exec(text || "");
  if (!m) return null;
  const bound = Number(m[2]);
  if (!Number.isFinite(bound)) return null;
  const floor = m[1].toLowerCase() === "at least" ? bound : bound + 1;
  return sent < floor ? floor : null;
}

const OPENAI_TOOL_CALL_ID_MAX_LENGTH = 64;
const OPENAI_TOOL_CALL_ID_PREFIX_LENGTH = 20;

// OpenAI Chat Completions rejects tool-call IDs longer than 64 characters.
// Normalize each distinct overlong ID once per request so assistant calls and
// their tool results always keep the same relationship. A full SHA-256 digest
// keeps IDs collision-resistant even when their retained prefixes are equal.
function normalizeOpenAIToolCallIds(body) {
  if (!Array.isArray(body?.messages)) return body;

  const normalizedIds = new Map();
  const normalize = (id) => {
    if (typeof id !== "string" || id.length <= OPENAI_TOOL_CALL_ID_MAX_LENGTH) return id;
    if (normalizedIds.has(id)) return normalizedIds.get(id);

    const prefix = id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, OPENAI_TOOL_CALL_ID_PREFIX_LENGTH) || "call";
    const digest = createHash("sha256").update(id).digest("base64url");
    const normalized = `${prefix}_${digest}`;
    normalizedIds.set(id, normalized);
    return normalized;
  };

  for (const message of body.messages) {
    if (message?.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        if (toolCall && Object.hasOwn(toolCall, "id")) toolCall.id = normalize(toolCall.id);
      }
    }
    if (message?.role === "tool" && Object.hasOwn(message, "tool_call_id")) {
      message.tool_call_id = normalize(message.tool_call_id);
    }
  }

  return body;
}

// Some GPT-5.6 models reject function tools when reasoning is enabled on the
// Chat Completions transport: "Function tools with reasoning_effort are not
// supported for <model> in /v1/chat/completions. Please use /v1/responses
// instead." Keep this compatibility override limited to the first-party
// provider and to requests that declare current function tools.
//
// Listed by exact id rather than by a gpt-5 pattern. Each entry is a model
// OpenAI has actually named in that rejection — luna when this was written, sol
// in #2540 — and a wider match would force reasoning off for gpt-5 models that
// accept tools and effort together, which is a working configuration to break.
const CHAT_TOOLS_REJECT_REASONING = new Set(["gpt-5.6-luna", "gpt-5.6-sol"]);

function normalizeChatToolsReasoning(model, body, sourceFormat) {
  if (sourceFormat === "openai-responses") return;
  if (!CHAT_TOOLS_REJECT_REASONING.has(model)) return;
  if (!Array.isArray(body?.tools) || !body.tools.some((tool) => tool?.type === "function")) return;
  body.reasoning_effort = "none";
}

// Mistral accepts an assistant prefill only when the final assistant message is
// explicitly marked as a prefix. Run this in the resolved provider executor so
// translated requests receive the marker without leaking it to other providers.
function normalizeMistralAssistantPrefix(body) {
  if (!Array.isArray(body?.messages) || body.messages.length === 0) return;
  const lastMessage = body.messages.at(-1);
  if (lastMessage?.role === "assistant" && lastMessage.prefix !== true) {
    lastMessage.prefix = true;
  }
}

// Provider-specific header quirks kept as small hooks (not pure auth).
const HEADER_HOOKS = {
  // Stable device_id from OAuth connection (CLIProxyAPI KimiTokenStorage.DeviceID)
  kimiHeaders: (h, c) => Object.assign(h, buildKimiHeaders(c?.providerSpecificData?.deviceId)),
  kilocodeOrg: (h, c) => { if (c.providerSpecificData?.orgId) h["X-Kilocode-OrganizationID"] = c.providerSpecificData.orgId; },
};

// Config-driven OAuth refresh grants — derived from registry oauth.refresh.
const REFRESH_GRANTS = Object.fromEntries(
  Object.entries(PROVIDER_OAUTH)
    .filter(([, o]) => o.refresh)
    .map(([id, o]) => {
      const tokenUrl = o.tokenUrl;
      const encoding = o.refresh.encoding;
      const extraParams = o.refresh.scope ? { scope: o.refresh.scope } : {};
      return [id, {
        encoding,
        url: () => tokenUrl,
        params: (ex) => id === "gemini"
          ? { client_id: ex.config.clientId, client_secret: ex.config.clientSecret, ...extraParams }
          : { client_id: o.clientId, ...extraParams },
      }];
    })
);

// The operation paths a provider base URL ends in. A per-connection endpoint
// is stored as a base, exactly as it is for a compatible node, so the
// provider's own operation path is appended to it rather than lost. Longest
// first, so /images/generations is not mistaken for /generations (#3253).
const OPERATION_PATHS = [
  "/audio/transcriptions",
  "/images/generations",
  "/chat/completions",
  "/audio/speech",
  "/v1/messages",
  "/embeddings",
  "/completions",
  "/responses",
  "/messages",
  "/rerank",
];

/**
 * Point a built-in provider at a different endpoint without losing the path
 * its registry entry carries.
 * @param {string|undefined} override - stored per-connection base
 * @param {string} registryUrl - the provider's own URL
 * @returns {string}
 */
export function applyEndpointOverride(override, registryUrl) {
  if (typeof override !== "string" || !override.trim()) return registryUrl;
  const base = override.trim().replace(/\/+$/, "");
  if (!registryUrl) return base;
  const tail = OPERATION_PATHS.find((p) => registryUrl.endsWith(p));
  // A registry URL that is not an operation URL (a bare host, a templated
  // path) has no tail to carry over, so the stored value stands alone.
  if (!tail) return base;
  return base.endsWith(tail) ? base : `${base}${tail}`;
}

export class DefaultExecutor extends BaseExecutor {
  get supportsBudgetDispatch() { return true; }
  constructor(provider) {
    super(provider, PROVIDERS[provider] || PROVIDERS.openai);
  }

  // Raising a small max_tokens up front would change what the caller asked for
  // on every request. React to the refusal instead: one retry, only after this
  // upstream has itself complained that the value is under its floor. #1702
  async execute(options) {
    const result = await super.execute(options);
    const floor = await readMaxTokensFloor(result?.response, options?.body);
    if (floor === null) return result;
    return super.execute({ ...options, body: { ...options.body, max_tokens: floor } });
  }

  transformRequest(model, body, stream, credentials, sourceFormat) {
    let transformed = this.applyJsonSchemaFallback(body);

    // Combo fallbacks reuse one request body across providers. Isolate every
    // message before Mistral-specific stripping or prefix normalization so a
    // failed Mistral attempt cannot change the next provider's request.
    if (this.provider === "mistral" && Array.isArray(transformed?.messages)) {
      transformed = {
        ...transformed,
        messages: transformed.messages.map((message) =>
          message && typeof message === "object" ? { ...message } : message,
        ),
      };
    }

    if (transformed && typeof transformed === "object") {
      // The official OpenAI transport is force-streamed even for JSON clients.
      // Keep the actual upstream body aligned with the executor's resolved mode;
      // the chat core still converts the SSE response back to JSON for those clients.
      if (this.provider === "openai" && stream === true) {
        const clientRequestedStreaming = transformed.stream === true;
        transformed.stream = true;
        if (!clientRequestedStreaming) {
          transformed.stream_options = {
            ...transformed.stream_options,
            include_usage: true,
          };
        }
      }
      if (this.provider === "openai" && usesOpenAIMaxCompletionTokens(model) && transformed.max_tokens !== undefined) {
        if (transformed.max_completion_tokens === undefined) {
          transformed.max_completion_tokens = transformed.max_tokens;
        }
        delete transformed.max_tokens;
      }
      if (this.provider === "openai") {
        normalizeOpenAIToolCallIds(transformed);
        normalizeChatToolsReasoning(model, transformed, sourceFormat);
      }
      // Cloudflare Workers AI's own OpenAI-compatible endpoint defaults
      // max_tokens to 256 when a client omits it, cutting the reply off mid
      // sentence (#1645). Every other source format already runs a request
      // through translator/formats/maxTokens.js, which fills DEFAULT_MAX_TOKENS
      // when absent; an OpenAI-source client hitting an OpenAI-format provider
      // skips that hop entirely (source === target, no translation), so
      // Cloudflare's stingy default is the only one left standing. Scoped to
      // this one provider rather than raised codebase-wide: Cloudflare's own
      // docs confirm larger values are accepted up to the model's context
      // window, so 4096 is comfortably inside every model this fork lists.
      if (this.provider === "cloudflare-ai" && transformed.max_tokens === undefined) {
        transformed.max_tokens = CLOUDFLARE_AI_DEFAULT_MAX_TOKENS;
      }
      // client_metadata is an Anthropic field. The claude->openai translators
      // already drop it, but an OpenAI-format CLIENT that sends it reaches an
      // OpenAI-format provider untouched, and a strict one answers 400 on the
      // unknown field. Keying that on a per-provider quirk made it whack-a-mole:
      // only mistral and cerebras ever declared it, so every other provider hit
      // the same wall (#1157, #1442). Key it on the upstream's format instead,
      // which covers all of them; anthropic also routes through this executor
      // and its format is claude, so it keeps the field it actually understands.
      // The quirk is honoured too, so a claude-format provider that dislikes the
      // field can still opt out.
      if (this.config.quirks?.dropClientMetadata || this.config.format !== "claude") {
        delete transformed.client_metadata;
      }
      this.defaultResponsesTextFormat(transformed, credentials);
      stripUnsupportedParams(this.provider, model, transformed);
      if (this.provider === "mistral") {
        normalizeMistralAssistantPrefix(transformed);
      }
    }

    // Muse Spark rejects a forced tool_choice and accepts only "auto"; demote it.
    //
    // Gated on the MODEL rather than the provider. The original guard named
    // opencode-go, which was where Muse Spark was reachable when it was written;
    // the Meta provider that actually declares these three ids landed seven
    // hours later (ead3a92f5) and never inherited it, so meta/muse-spark-* went
    // to the upstream with the forced value still on the body (#3662). The
    // constraint belongs to the model, so both routes are covered and a fourth
    // muse id needs no third edit. A registry quirk is the wrong shape here
    // because quirks are provider-wide and this is one model family.
    const suffix = typeof model === "string" ? model.match(/\((?:none|off|auto|minimal|low|medium|high|xhigh|max|ultra|\d+)\)\s*$/i) : null;
    const bare = suffix ? model.slice(0, suffix.index).trim() : model;
    if (typeof bare === "string" && bare.startsWith("muse-spark") && transformed && "tool_choice" in transformed) {
      if (transformed.tool_choice !== "auto") transformed.tool_choice = "auto";
    }

    return injectReasoningContent({
      provider: this.provider,
      model,
      body: transformed,
      targetFormat: credentials?.runtimeTransport?.format,
    });
  }

  // Some Responses-compatible upstreams (e.g. LM Studio) reject a request whose
  // `text` is an object missing `text.format` with a 400 missing_required_parameter.
  // The Responses API default for that field is { type: "text" }, so default it
  // for openai-compatible "responses" providers before forwarding upstream. #2093
  defaultResponsesTextFormat(body, credentials) {
    if (!this.provider?.startsWith?.("openai-compatible-")) return;
    if (resolveOpenAICompatibleApiType(this.provider, credentials) !== "responses") return;
    const text = body.text;
    if (!text || typeof text !== "object" || Array.isArray(text)) return;
    if (text.format !== undefined) return;
    body.text = { ...text, format: { type: "text" } };
  }

  // Fallback json_schema → json_object for openai-compatible providers without native Structured Output.
  applyJsonSchemaFallback(body) {
    if (!this.provider?.startsWith?.("openai-compatible-")) return body;
    const rf = body?.response_format;
    if (rf?.type !== "json_schema" || !rf.json_schema?.schema) return body;

    const schemaJson = JSON.stringify(rf.json_schema.schema, null, 2);
    const prompt = `You must respond with valid JSON that strictly follows this JSON schema:\n\`\`\`json\n${schemaJson}\n\`\`\`\nRespond ONLY with the JSON object, no other text and no markdown code fences.`;

    const messages = Array.isArray(body.messages) ? body.messages.map(m => ({ ...m })) : [];
    const sys = messages.find(m => m.role === "system");
    if (sys) {
      if (typeof sys.content === "string") sys.content = `${sys.content}\n\n${prompt}`;
      else if (Array.isArray(sys.content)) sys.content.push({ type: "text", text: `\n\n${prompt}` });
    } else {
      messages.unshift({ role: "system", content: prompt });
    }
    return { ...body, messages, response_format: { type: "json_object" } };
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    // Runtime transport (multi-endpoint providers): use the sourceFormat-matched endpoint
    const rt = credentials?.runtimeTransport;
    if (rt?.baseUrl) {
      return rt.urlSuffix ? `${rt.baseUrl}${rt.urlSuffix}` : rt.baseUrl;
    }
    if (this.provider?.startsWith?.("openai-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || OPENAI_COMPAT_BASE;
      const normalized = baseUrl.replace(/\/$/, "");
      const path = resolveOpenAICompatibleApiType(this.provider, credentials) === "responses" ? "/responses" : "/chat/completions";
      return `${normalized}${path}`;
    }
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || ANTHROPIC_COMPAT_BASE;
      const normalized = baseUrl.replace(/\/$/, "");
      return `${normalized}/messages`;
    }
    const configBaseUrl = applyEndpointOverride(
      credentials?.providerSpecificData?.baseUrl,
      this.config.baseUrl,
    );
    // gemini-format: build :streamGenerateContent / :generateContent path
    if (this.config.format === "gemini") {
      return `${configBaseUrl}/${model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
    }
    // urlSuffix (e.g. ?beta=true) declared per-provider in registry
    if (this.config.urlSuffix) {
      return `${configBaseUrl}${this.config.urlSuffix}`;
    }
    const url = configBaseUrl;
    if (url?.includes("{accountId}")) {
      const accountId = credentials?.providerSpecificData?.accountId;
      if (!accountId) throw new Error(`${this.provider} requires accountId in providerSpecificData`);
      return url.replace("{accountId}", accountId);
    }
    return url;
  }

  // Fallback descriptor for providers without an explicit entry in AUTH_DESCRIPTORS.
  resolveAuthDescriptor() {
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      return { apiKey: { header: "x-api-key", scheme: "raw" }, oauth: { header: "Authorization", scheme: "bearer" }, anthropicVersion: true };
    }
    if (this.config?.format === "claude") {
      return { ...XAPIKEY, anthropicVersion: true };
    }
    return BEARER;
  }

  buildHeaders(credentials, stream = true, url, model) {
    const rt = credentials?.runtimeTransport;
    const headers = { "Content-Type": "application/json", ...(rt ? rt.headers : this.config.headers) };
    const desc = rt?.auth || AUTH_DESCRIPTORS[this.provider] || this.resolveAuthDescriptor();
    // Hooks run BEFORE auth so dynamic overlays can't clobber the token.
    for (const hook of desc.hooks || []) HEADER_HOOKS[hook]?.(headers, credentials);
    applyAuth(headers, desc, credentials);
    const isAnthropicOfficial =
      this.provider === "claude" ||
      this.provider === "anthropic" ||
      (this.provider?.startsWith?.("anthropic-compatible-") &&
        (() => {
          const baseUrl = credentials?.providerSpecificData?.baseUrl || "";
          return baseUrl === "" || baseUrl.includes("api.anthropic.com");
        })());

    if (isAnthropicOfficial && model) {
      const baseBeta = selectAnthropicBeta(model);
      const rawBeta = credentials?.rawHeaders?.["anthropic-beta"] || credentials?.rawHeaders?.["Anthropic-Beta"];
      if (rawBeta) {
        const set = new Set(baseBeta.split(",").map(s => s.trim()).filter(Boolean));
        for (const flag of rawBeta.split(",").map(s => s.trim()).filter(Boolean)) {
          set.add(flag);
        }
        headers["Anthropic-Beta"] = Array.from(set).join(",");
      } else {
        headers["Anthropic-Beta"] = baseBeta;
      }
    }

    // Strip first-party Claude Code identity headers for non-Anthropic anthropic-compatible upstreams
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || "";
      const isOfficialAnthropic = baseUrl === "" || baseUrl.includes("api.anthropic.com");
      if (!isOfficialAnthropic) {
        // Some third-party Anthropic-compatible gateways require Bearer auth in
        // addition to x-api-key. Send both (x-api-key already set above) so
        // gateways that read either header succeed.
        if (credentials.apiKey && !headers["Authorization"]) {
          headers["Authorization"] = `Bearer ${credentials.apiKey}`;
        }
        delete headers["anthropic-dangerous-direct-browser-access"];
        delete headers["Anthropic-Dangerous-Direct-Browser-Access"];
        delete headers["x-app"];
        delete headers["X-App"];
        // Strip claude-code-20250219 from Anthropic-Beta / anthropic-beta
        for (const betaKey of ["anthropic-beta", "Anthropic-Beta"]) {
          if (headers[betaKey]) {
            const filtered = headers[betaKey]
              .split(",")
              .map(s => s.trim())
              .filter(f => f && f !== "claude-code-20250219")
              .join(",");
            if (filtered) {
              headers[betaKey] = filtered;
            } else {
              delete headers[betaKey];
            }
          }
        }
      }
    }

    if (stream) headers["Accept"] = "text/event-stream";
    // Operator configuration first: it must be able to override this router's
    // own auth, which is how an endpoint behind an API gateway is reached at
    // all (#2660). Then the caller's headers, which only fill what is still
    // unset and so can override neither.
    applyOperatorHeaders(headers, credentials?.providerSpecificData);
    forwardClientHeaders(headers, credentials?.rawHeaders);
    return headers;
  }

  // Generic OAuth refresh for the common {grant_type, refresh_token, client_id[, ...]} shape.
  // grant = REFRESH_GRANTS[provider]; client creds resolved from PROVIDERS or this.config.
  refreshFromGrant(credentials, proxyOptions) {
    const grant = REFRESH_GRANTS[this.provider];
    const params = { grant_type: "refresh_token", refresh_token: credentials.refreshToken, ...grant.params(this) };
    return grant.encoding === "json"
      ? this.refreshWithJSON(grant.url(), params, proxyOptions)
      : this.refreshWithForm(grant.url(), params, proxyOptions);
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials.refreshToken) return null;

    const refreshers = {
      claude: () => this.refreshFromGrant(credentials, proxyOptions),
      codex: () => this.refreshFromGrant(credentials, proxyOptions),
      iflow: () => this.refreshIflow(credentials.refreshToken, proxyOptions),
      gemini: () => this.refreshFromGrant(credentials, proxyOptions),
      kiro: () => this.refreshKiro(credentials.refreshToken, proxyOptions),
      kimi: () => this.refreshKimi(credentials, proxyOptions),
      "kimi-coding": () => this.refreshKimi(credentials, proxyOptions),
      kilocode: () => this.refreshKilocode(credentials.refreshToken, proxyOptions)
    };

    const refresher = refreshers[this.provider];
    if (!refresher) return null;

    try {
      const result = await refresher();
      if (result) log?.info?.("TOKEN", `${this.provider} refreshed`);
      return result;
    } catch (error) {
      log?.error?.("TOKEN", `${this.provider} refresh error: ${error.message}`);
      return null;
    }
  }

  async refreshWithJSON(url, body, proxyOptions = null) {
    const response = await proxyAwareFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body)
    }, proxyOptions);
    if (!response.ok) return null;
    const tokens = await response.json();
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || body.refresh_token, expiresIn: tokens.expires_in };
  }

  async refreshWithForm(url, params, proxyOptions = null) {
    const response = await proxyAwareFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
      body: new URLSearchParams(params)
    }, proxyOptions);
    if (!response.ok) return null;
    const tokens = await response.json();
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || params.refresh_token, expiresIn: tokens.expires_in };
  }

  async refreshIflow(refreshToken, proxyOptions = null) {
    const basicAuth = btoa(`${PROVIDERS.iflow.clientId}:${PROVIDERS.iflow.clientSecret}`);
    const response = await proxyAwareFetch(OAUTH_ENDPOINTS.iflow.token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json", "Authorization": `Basic ${basicAuth}` },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: PROVIDERS.iflow.clientId, client_secret: PROVIDERS.iflow.clientSecret })
    }, proxyOptions);
    if (!response.ok) return null;
    const tokens = await response.json();
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || refreshToken, expiresIn: tokens.expires_in };
  }

  async refreshKiro(refreshToken, proxyOptions = null) {
    const response = await proxyAwareFetch(PROVIDERS.kiro.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": "kiro-cli/1.0.0" },
      body: JSON.stringify({ refreshToken })
    }, proxyOptions);
    if (!response.ok) return null;
    const tokens = await response.json();
    return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken || refreshToken, expiresIn: tokens.expiresIn };
  }

  // CLIProxyAPI DeviceFlowClient.RefreshToken — form body + X-Msh-* headers + stable device_id
  async refreshKimi(credentials, proxyOptions = null) {
    const refreshToken = credentials.refreshToken;
    const cfg = PROVIDERS.kimi || PROVIDERS["kimi-coding"];
    if (!cfg?.refreshUrl || !cfg?.clientId) return null;
    const kimiHeaders = buildKimiHeaders(credentials?.providerSpecificData?.deviceId);
    const response = await proxyAwareFetch(cfg.refreshUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        ...kimiHeaders
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: cfg.clientId })
    }, proxyOptions);
    if (!response.ok) return null;
    const tokens = await response.json();
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || refreshToken, expiresIn: tokens.expires_in };
  }

  async refreshKilocode(refreshToken, proxyOptions = null) {
    // Kilocode uses device code flow, no refresh token support
    return null;
  }
}

export default DefaultExecutor;
