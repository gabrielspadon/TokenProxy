import { BaseExecutor } from "./base.js";
import { CODEX_DEFAULT_INSTRUCTIONS } from "../config/codexInstructions.js";
import { PROVIDERS } from "../config/providers.js";
import {
  refreshProviderCredentials,
  shouldRefreshCredentials,
} from "../services/oauthCredentialManager.js";
import { normalizeResponsesInput } from "../translator/formats/responsesApi.js";
import { ROLE, RESPONSES_ITEM } from "../translator/schema/index.js";
import { fetchImageAsBase64 } from "../translator/concerns/image.js";
import { getModelUpstreamId } from "../config/providerModels.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { dbg } from "../utils/debugLog.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { normalizeCodexServiceTier } from "../config/codexFastMode.js";
import { isReplaySafeRejection } from "../utils/replaySafety.js";
import { inspectErrorBody } from "../utils/inspectErrorBody.js";
import { discardResponseBody } from "../utils/discardResponseBody.js";

// Classify explicit SSE error envelopes. Accepted responses never permit replay.
const CODEX_SSE_TRANSIENT_PATTERNS = ["server_is_overloaded", "service_unavailable_error"];
const CODEX_SSE_ACCOUNT_FALLBACK_PATTERNS = ["selected model is at capacity", "model_at_capacity"];
const CODEX_SSE_CONTEXT_OVERFLOW_PATTERNS = [
  "exceeds the context window",
  "maximum context length",
  "context_length_exceeded",
];
const CODEX_SSE_PEEK_BYTES = 256 * 1024;
const CODEX_MODEL_CAPACITY_MESSAGE = "Selected model is at capacity. Please try a different model.";

// Server-generated item id prefixes that Codex /responses cannot resolve when store=false
const SERVER_ID_PATTERN = /^(rs|fc|resp|msg)_/;

// Hosted tool types that Codex/OpenAI Responses executes server-side
const CODEX_HOSTED_TOOL_TYPES = new Set([
  "image_generation", "web_search", "web_search_preview", "file_search",
  "computer", "computer_use_preview", "code_interpreter", "mcp", "local_shell",
  "tool_search"
]);

// Responses-native freeform tools carry a name plus format payload and must pass through intact.
const CODEX_PASSTHROUGH_TOOL_TYPES = new Set(["custom"]);

// Allowlist of fields accepted by Codex Responses API — anything else is stripped
const RESPONSES_API_ALLOWLIST = new Set([
  "model", "input", "instructions", "tools", "tool_choice", "stream", "store",
  "reasoning", "service_tier", "include", "prompt_cache_key", "client_metadata",
  "text",
  // Tool-calling control the official Codex CLI sends on every request to this
  // same endpoint; handlers/imageProviders/codex.js posts it here too. Stripping
  // it silently swapped the client's declared batching policy for the upstream
  // default on a path that is otherwise a passthrough (#2512).
  "parallel_tool_calls"
]);

// Convert role=system → role=developer in body.input (keeps content in cacheable prefix)
function convertSystemToDeveloperRole(body) {
  if (!Array.isArray(body.input)) return;
  for (const item of body.input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const isSystemMsg = item.role === "system" && (!item.type || item.type === "message");
    if (isSystemMsg) item.role = "developer";
  }
}

// Native Responses message items require an explicit type and typed text parts.
// Keep this narrow: it only repairs role-bearing message-shaped items, leaving
// tool calls, reasoning items, and already-valid typed content untouched.
function normalizeCodexMessageItems(body) {
  if (!Array.isArray(body.input)) return;
  for (const item of body.input) {
    if (!item || typeof item !== "object" || Array.isArray(item) || !item.role) continue;
    if (!item.type) item.type = RESPONSES_ITEM.MESSAGE;
    if (item.type !== RESPONSES_ITEM.MESSAGE) continue;
    if (typeof item.content === "string") {
      item.content = [{
        type: item.role === ROLE.ASSISTANT ? RESPONSES_ITEM.OUTPUT_TEXT : RESPONSES_ITEM.INPUT_TEXT,
        text: item.content,
      }];
      continue;
    }
    if (item.role !== ROLE.ASSISTANT || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part && typeof part === "object" && !Array.isArray(part) && part.type === RESPONSES_ITEM.INPUT_TEXT) {
        part.type = RESPONSES_ITEM.OUTPUT_TEXT;
      }
    }
  }
}

// Strip server-generated item IDs (rs_/fc_/resp_/msg_) from input — avoids 404 with store=false
function stripStoredItemReferences(body) {
  if (!Array.isArray(body.input)) return;
  body.input = body.input.filter((item) => {
    if (typeof item === "string" && SERVER_ID_PATTERN.test(item)) return false;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      if (item.type === "item_reference") return false;
      if (typeof item.id === "string" && SERVER_ID_PATTERN.test(item.id)) delete item.id;
    }
    return true;
  });
}

// Codex uses store=false, so every tool output must be paired with a call in
// the submitted input. Compacted clients can leave outputs behind after their
// calls disappear, and duplicate results are invalid for the same call.
function stripOrphanedToolOutputs(body) {
  if (!Array.isArray(body.input)) return;

  const functionCallIds = new Set();
  const customCallIds = new Set();
  let outputCount = 0;
  for (const item of body.input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (
      item.type === "function_call"
      && typeof item.call_id === "string"
      && item.call_id.trim()
    ) {
      functionCallIds.add(item.call_id);
    }
    if (
      item.type === "custom_tool_call"
      && typeof item.call_id === "string"
      && item.call_id.trim()
    ) {
      customCallIds.add(item.call_id);
    }
    if (Array.isArray(item.tool_calls)) {
      for (const toolCall of item.tool_calls) {
        if (typeof toolCall?.id === "string" && toolCall.id.trim()) {
          functionCallIds.add(toolCall.id);
        }
      }
    }
    if (
      item.type === "function_call_output"
      || item.type === "custom_tool_call_output"
    ) {
      outputCount++;
    }
  }
  if (outputCount === 0) return;

  const seenOutputs = new Set();
  body.input = body.input.filter((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return true;
    const isFunctionOutput = item.type === "function_call_output";
    const isCustomOutput = item.type === "custom_tool_call_output";
    if (!isFunctionOutput && !isCustomOutput) return true;
    if (typeof item.call_id !== "string" || !item.call_id.trim()) return false;

    const validIds = isFunctionOutput ? functionCallIds : customCallIds;
    const outputKey = `${item.type}\0${item.call_id}`;
    if (!validIds.has(item.call_id) || seenOutputs.has(outputKey)) return false;
    seenOutputs.add(outputKey);
    return true;
  });

  const removed = outputCount - seenOutputs.size;
  if (removed > 0) {
    dbg("CODEX", `stripOrphanedToolOutputs | removed=${removed} kept=${seenOutputs.size}`);
  }
}

// A reasoning blob the backend can no longer decrypt — minted by another
// account, or simply expired — comes back as a 400, and errorConfig's
// `{ status: 400, pass: true }` rule keeps the account loop from rotating past
// it, so the turn hard-failed (#2667). The blob is continuity-only, so dropping
// it and resending recovers the same turn on the same account.
const CODEX_STALE_CIPHERTEXT_PATTERNS = ["encrypted_content", "encrypted content", "decrypt"];

function isStaleCiphertextError(bodyText) {
  if (!bodyText) return false;
  const lower = bodyText.toLowerCase();
  return CODEX_STALE_CIPHERTEXT_PATTERNS.some(pattern => lower.includes(pattern));
}

// Drop every continuity blob, plus any reasoning item left with nothing to say.
// Returns the count so the caller only retries when the body actually changed.
function stripEncryptedReasoning(body) {
  if (!Array.isArray(body?.input)) return 0;
  let stripped = 0;
  body.input = body.input.filter((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return true;
    if (typeof item.encrypted_content !== "string") return true;
    delete item.encrypted_content;
    stripped++;
    return item.type !== RESPONSES_ITEM.REASONING || !!item.summary?.length;
  });
  return stripped;
}

// Flatten Chat-Completions tool shape into Responses flat format + filter unsupported tools
function normalizeCodexTools(body) {
  if (!Array.isArray(body.tools)) return;
  const validNames = new Set();
  body.tools = body.tools.filter((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
    const type = typeof tool.type === "string" ? tool.type : "";
    if (type === "namespace") {
      if (Array.isArray(tool.tools)) {
        for (const st of tool.tools) {
          const n = typeof st?.name === "string" ? st.name.trim().slice(0, 128) : "";
          if (n) validNames.add(n);
        }
      }
      return true;
    }
    if (type !== "function") {
      if (CODEX_PASSTHROUGH_TOOL_TYPES.has(type)) return true;
      if (!type || tool.function || typeof tool.name === "string") return false;
      return CODEX_HOSTED_TOOL_TYPES.has(type);
    }
    const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function) ? tool.function : null;
    const rawName = typeof tool.name === "string" ? tool.name : (typeof fn?.name === "string" ? fn.name : "");
    const name = rawName.trim();
    if (!name) return false;
    const description = typeof tool.description === "string" ? tool.description : (typeof fn?.description === "string" ? fn.description : "");
    const parameters = (tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters))
      ? tool.parameters
      : (fn?.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters) ? fn.parameters : { type: "object", properties: {} });
    // The rebuild below wipes every key, so read strict off both shapes first.
    // Only an explicit false is carried over: relaxing schema validation can
    // never make the upstream reject a body it accepted before, while
    // forwarding true could newly fail a schema that is not Structured-Outputs
    // compliant. The Codex CLI sends strict:false on its shell/apply_patch
    // tools precisely because their optional parameters are not all required.
    const strict = tool.strict === false || fn?.strict === false ? false : undefined;
    for (const k of Object.keys(tool)) delete tool[k];
    tool.type = "function";
    tool.name = name.slice(0, 128);
    if (description) tool.description = description;
    tool.parameters = parameters;
    if (strict === false) tool.strict = false;
    validNames.add(name);
    return true;
  });
  // Drop tool_choice if it references an unknown function name
  if (body.tool_choice && typeof body.tool_choice === "object" && !Array.isArray(body.tool_choice)) {
    if (body.tool_choice.type === "function") {
      const n = typeof body.tool_choice.name === "string" ? body.tool_choice.name.trim() : "";
      if (!n || !validNames.has(n)) delete body.tool_choice;
    }
  }
}

// Resolve prompt-cache session id: client session → assistant-text-hash → workspaceId → connection
function resolveCacheSessionId(body, credentials) {
  return resolveSessionId({
    headers: credentials?.rawHeaders,
    body,
    connectionId: credentials?.connectionId,
    workspaceId: credentials?.providerSpecificData?.workspaceId,
    scope: "codex"
  });
}

function normalizeReasoningEffort(model, value) {
  const supportedLevels = getThinkingLevels("codex", model);
  if (supportedLevels?.includes(value)) return value;
  if (value === "ultra" && supportedLevels?.includes("max")) return "max";
  if (value === "max" || value === "ultra") return "xhigh";
  return value;
}

function classifySseEvent(block) {
  const failureTypes = new Set(["error", "response.failed", "failed"]);
  let eventType = null;
  const dataLines = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      eventType = line.slice(6).trim().toLowerCase();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  let payload;
  try { payload = JSON.parse(dataLines.join("\n")); } catch { return null; }
  const payloadType = String(payload?.type || payload?.response?.status || "").toLowerCase();
  // Stop before any later error can replace output already generated. Inspect
  // event types, never model-controlled words inside content or tool arguments.
  const isOutput = (type) => /^response\.(?:output_|function_call|reasoning|completed|incomplete)/.test(type || "");
  if (isOutput(eventType) || isOutput(payloadType)) return { outputSeen: true };
  if (!failureTypes.has(eventType) && !failureTypes.has(payloadType)) return null;
  const error = payload?.response?.error || payload?.error || payload;
  const message = typeof error?.message === "string" ? error.message.trim() : "";
  const code = typeof error?.code === "string" ? error.code.toLowerCase() : "";
  const matches = (patterns) => code
    ? patterns.find((pattern) => pattern === code)
    : patterns.find((pattern) => message.toLowerCase().includes(pattern));
  const context = matches(CODEX_SSE_CONTEXT_OVERFLOW_PATTERNS);
  const capacity = matches(CODEX_SSE_ACCOUNT_FALLBACK_PATTERNS);
  const transient = matches(CODEX_SSE_TRANSIENT_PATTERNS);
  const matched = context || capacity || transient;
  return matched ? { matched, message: message || matched, contextOverflow: !!context, accountFallback: !!capacity } : null;
}

function codexSseErrorResponse(status, message, code = null) {
  return new Response(JSON.stringify({
    error: {
      message,
      type: status >= 500 ? "server_error" : "invalid_request_error",
      code: code || (status === HTTP_STATUS.SERVICE_UNAVAILABLE ? "service_unavailable" : "upstream_error"),
    }
  }), {
    status,
    headers: { "Content-Type": "application/json", "x-tokenproxy-replay-safe": "false" },
  });
}

/**
 * Codex Executor - handles OpenAI Codex API (Responses API format)
 * Automatically injects default instructions if missing
 */
export class CodexExecutor extends BaseExecutor {
  get supportsBudgetDispatch() { return true; }
  constructor() {
    super("codex", PROVIDERS.codex);
  }

  /**
   * Override headers to add codex-specific identity headers.
   * The session id is read off the per-request credentials object, stashed by
   * execute(); see the comment there for why it cannot be an instance field.
   */
  buildHeaders(credentials, stream = true) {
    const headers = super.buildHeaders(credentials, stream);
    headers["session_id"] = credentials?._cxSession || credentials?.connectionId || "default";
    // Identify client type to Codex backend (matches official codex CLI)
    if (!headers["originator"]) headers["originator"] = "codex_cli_rs";
    // Account/workspace binding header — required when multiple Codex accounts
    // are configured. OAuth import stores ChatGPT account ID as chatgptAccountId;
    // older/custom rows may use workspaceId/accountId. Prefer explicit workspaceId
    // but fall back to chatgptAccountId so requests don't cross-bind to the wrong
    // OpenAI account and surface as token_invalid after adding another account.
    const accountId =
      credentials?.providerSpecificData?.workspaceId ||
      credentials?.providerSpecificData?.chatgptAccountId ||
      credentials?.providerSpecificData?.accountId;
    if (typeof accountId === "string" && accountId && !headers["ChatGPT-Account-ID"]) {
      headers["ChatGPT-Account-ID"] = accountId;
    }
    return headers;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    const base = super.buildUrl(model, stream, urlIndex, credentials);
    return credentials?._cxCompact ? `${base}/compact` : base;
  }

  async refreshCredentials(credentials, log) {
    if (!credentials?.refreshToken) return null;
    return refreshProviderCredentials("codex", credentials, log);
  }

  needsRefresh(credentials) {
    return shouldRefreshCredentials("codex", credentials);
  }

  /**
   * Prefetch remote image URLs and inline them as base64 data URIs.
   * Runs before execute() because Codex backend cannot fetch remote images.
   * Mutates body.input in place.
   */
  async prefetchImages(body) {
    if (!Array.isArray(body?.input)) return;
    for (const item of body.input) {
      if (!Array.isArray(item.content)) continue;
      const pending = item.content.map(async (c) => {
        if (c.type !== "image_url") return c;
        const url = typeof c.image_url === "string" ? c.image_url : c.image_url?.url;
        const detail = c.image_url?.detail || "auto";
        if (!url) return c;
        if (url.startsWith("data:")) return { type: "input_image", image_url: url, detail };
        const fetched = await fetchImageAsBase64(url, { timeoutMs: 15000 });
        return { type: "input_image", image_url: fetched?.url || url, detail };
      });
      item.content = await Promise.all(pending);
    }
  }

  async execute(args) {
    // BaseExecutor builds the URL and the headers around transformRequest, so
    // both the session id and the compact flag have to exist before it runs.
    // They used to live on the executor instance, and executors/index.js holds
    // ONE CodexExecutor for the whole process: two concurrent requests
    // overwrote each other between transformRequest and buildHeaders, so a
    // title-generation turn could be sent under the main turn's session_id and
    // the reply came back on the wrong turn (#3164). opencode.js already
    // documents this exact failure and stashes on the per-request credentials
    // object; do the same here.
    //
    // The compact flag additionally had an ordering bug: buildUrl runs BEFORE
    // transformRequest, so it read whatever the PREVIOUS request left behind.
    // The first /v1/responses/compact call went to the plain endpoint and a
    // later ordinary call could be routed to /compact. Resolving both here,
    // ahead of the URL loop, fixes the ordering as well as the sharing.
    if (args.credentials) {
      args.credentials._cxCompact = !!args.body?._compact;
      args.credentials._cxSession = resolveCacheSessionId(args.body, args.credentials);
    }
    const imgCount = Array.isArray(args.body?.input) ? args.body.input.reduce((n, it) => n + (Array.isArray(it.content) ? it.content.filter(c => c.type === "image_url").length : 0), 0) : 0;
    const inputLen = Array.isArray(args.body?.input) ? args.body.input.length : 0;
    dbg("CODEX", `execute start | inputItems=${inputLen} | images=${imgCount} | sessionId=${args.credentials?._cxSession || "pending"}`);
    if (imgCount > 0) {
      const t0 = Date.now();
      await this.prefetchImages(args.body);
      dbg("CODEX", `prefetchImages done | ${Date.now() - t0}ms`);
    } else {
      await this.prefetchImages(args.body);
    }

    // Only an explicit ciphertext HTTP400 can authorize this body-repair retry.
    let tierLogged = false;
    let ciphertextRetried = false;
    while (true) {
      const result = await super.execute(args);
      if (!tierLogged) {
        const effectiveTier = result.transformedBody?.service_tier || "default";
        args.log?.info?.("TIER", `CODEX | ${args.model} | TIER:${effectiveTier}`);
        tierLogged = true;
      }
      // One-shot body repair. A second identical 400 means
      // the ciphertext was never the cause and the error belongs to the client.
      // clone() is guarded the way base.js guards it — unit tests script
      // minimal response doubles that do not implement it.
      if (
        !ciphertextRetried
        && result.response?.status === HTTP_STATUS.BAD_REQUEST
        && isReplaySafeRejection(result.response)
        && typeof result.response.clone === "function"
      ) {
        try {
          const inspected = await inspectErrorBody(result.response, { signal: args.signal });
          if (inspected.complete && isStaleCiphertextError(inspected.text)) {
            args.signal?.throwIfAborted();
            const stripped = stripEncryptedReasoning(args.body);
            if (stripped > 0) {
              ciphertextRetried = true;
              discardResponseBody(result.response);
              args.log?.warn?.("RETRY", `CODEX | stale reasoning ciphertext 400, dropped ${stripped}, retrying`);
              dbg("CODEX", `stale ciphertext 400 → stripped ${stripped} encrypted_content, retrying once`);
              continue;
            }
          }
        } catch (error) {
          discardResponseBody(result.response);
          throw error;
        }
      }
      const peek = await this._peekSseTransientError(result.response);
      if (!peek.matched) {
        // Replace body with re-assembled stream (prefix bytes already read + rest)
        if (peek.replacementBody) {
          result.response = new Response(peek.replacementBody, {
            status: result.response.status,
            statusText: result.response.statusText,
            headers: result.response.headers,
          });
        }
        return result;
      }
      if (peek.contextOverflow) {
        args.log?.warn?.("CODEX", `SSE context overflow "${peek.message}"`);
        result.response = codexSseErrorResponse(HTTP_STATUS.PAYLOAD_TOO_LARGE, peek.message || peek.matched, "context_length_exceeded");
        return result;
      }
      if (peek.accountFallback) {
        args.log?.warn?.("CODEX", "Accepted SSE response reported model capacity; replay disabled");
        result.response = codexSseErrorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, peek.message || CODEX_MODEL_CAPACITY_MESSAGE);
        return result;
      }
      result.response = codexSseErrorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, peek.message || peek.matched);
      return result;
    }
  }

  // Peek first N bytes of SSE body to detect upstream transient errors.
  // Returns { matched: string|null, message: string|null, accountFallback: boolean,
  // contextOverflow: boolean, replacementBody: ReadableStream|null }.
  // Caller must use replacementBody when no error matched (original body has been read).
  async _peekSseTransientError(response) {
    if (!response || !response.ok || !response.body) return { matched: null, message: null, accountFallback: false, contextOverflow: false, replacementBody: null };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks = [];
    let pending = "";
    let bytesRead = 0;
    let matched = null;
    let matchedMessage = null;
    let accountFallback = false;
    let contextOverflow = false;
    try {
      while (bytesRead < CODEX_SSE_PEEK_BYTES) {
        const { done, value } = await reader.read();
        if (done) {
          pending += decoder.decode();
        } else {
          chunks.push(value);
          const remaining = CODEX_SSE_PEEK_BYTES - bytesRead;
          const inspected = value.subarray(0, remaining);
          pending += decoder.decode(inspected, { stream: true });
          bytesRead += inspected.byteLength;
        }
        const blocks = pending.split(/\r?\n\r?\n/);
        pending = done ? "" : blocks.pop();
        let verdict = null;
        for (const block of blocks) {
          verdict = classifySseEvent(block);
          if (verdict) break;
        }
        if (verdict?.matched) {
          ({ matched, message: matchedMessage, accountFallback, contextOverflow } = verdict);
        }
        if (done || verdict) break;
      }
    } catch (e) {
      dbg("CODEX", `peek read error: ${e.message}`);
    }

    if (matched) {
      try { await reader.cancel(); } catch { /* noop */ }
      try { reader.releaseLock(); } catch { /* noop */ }
      return {
        matched,
        message: matchedMessage || matched,
        accountFallback,
        contextOverflow,
        replacementBody: null,
      };
    }

    reader.releaseLock();

    // Re-assemble stream: prefix chunks + remaining upstream body
    const upstream = response.body;
    let upstreamReader = null;
    const replacementBody = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        upstreamReader = upstream.getReader();
      },
      async pull(controller) {
        try {
          const { done, value } = await upstreamReader.read();
          if (done) { controller.close(); return; }
          controller.enqueue(value);
        } catch (e) { controller.error(e); }
      },
      cancel(reason) {
        try { upstreamReader?.cancel(reason); } catch { /* noop */ }
      },
    });
    return { matched: null, message: null, accountFallback: false, contextOverflow: false, replacementBody };
  }

  // Parse Codex usage_limit_reached to extract precise resetsAtMs; fallback to default otherwise
  parseError(response, bodyText) {
    if (response.status === 429 && bodyText) {
      try {
        const json = JSON.parse(bodyText);
        const err = json?.error;
        if (err?.type === "usage_limit_reached") {
          const now = Date.now();
          let resetsAtMs = null;
          if (typeof err.resets_at === "number" && err.resets_at > 0) {
            const ms = err.resets_at * 1000;
            if (ms > now) resetsAtMs = ms;
          }
          if (!resetsAtMs && typeof err.resets_in_seconds === "number" && err.resets_in_seconds > 0) {
            resetsAtMs = now + err.resets_in_seconds * 1000;
          }
          if (resetsAtMs) {
            return { status: 429, message: err.message || bodyText, resetsAtMs };
          }
        }
      } catch { /* fall through to default */ }
    }
    return super.parseError(response, bodyText);
  }

  /**
   * Transform request before sending - inject default instructions if missing.
   * Image fetching is handled separately in prefetchImages() so this stays sync.
   */
  transformRequest(model, body, stream, credentials) {
    delete body._compact;
    // execute() already resolved this onto the per-request credentials. Recompute
    // only when transformRequest is called on its own (tests, direct callers),
    // never overwriting what execute() stashed for the request in flight.
    if (credentials && credentials._cxSession === undefined) {
      credentials._cxSession = resolveCacheSessionId(body, credentials);
    }
    const sessionId = credentials?._cxSession ?? resolveCacheSessionId(body, credentials);
    // Convert string input to array format (Codex API requires input as array)
    const normalized = normalizeResponsesInput(body.input);
    if (normalized) body.input = normalized;

    // Keep system prompts in body.input as role=developer so they stay in the cacheable prefix
    convertSystemToDeveloperRole(body);
    // Repair legacy role/content shapes before the strict Codex Responses request is sent.
    normalizeCodexMessageItems(body);
    // Strip server-generated item IDs (rs_/fc_/resp_/msg_) — Codex /responses can't resolve when store=false
    stripStoredItemReferences(body);
    stripOrphanedToolOutputs(body);
    // Cleanup can remove every input item. Codex rejects an empty input array,
    // so restore the same typed placeholder used for an initially empty body.
    if (!body.input || (Array.isArray(body.input) && body.input.length === 0)) {
      body.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }];
    }
    // Flatten function tools + drop unsupported types
    normalizeCodexTools(body);

    // Ensure streaming is enabled (Codex API requires it)
    body.stream = true;

    // If no instructions provided, inject default Codex instructions
    if (!body.instructions || body.instructions.trim() === "") {
      body.instructions = CODEX_DEFAULT_INSTRUCTIONS;
    }

    // Ensure store is false (Codex requirement)
    body.store = false;

    // Inject prompt_cache_key for stable Codex prompt caching
    if (!body.prompt_cache_key && sessionId) {
      body.prompt_cache_key = sessionId;
    }

    // Map virtual Codex review models to the upstream Codex model before suffix parsing.
    body.model = getModelUpstreamId("cx", body.model || model);

    // Extract thinking level from model name suffix
    // e.g., gpt-5.3-codex-high → high, gpt-5.3-codex → medium (default)
    const effortLevels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
    let modelEffort = null;
    for (const level of effortLevels) {
      if (body.model.endsWith(`-${level}`)) {
        modelEffort = level;
        // Strip suffix from model name for actual API call
        body.model = body.model.replace(`-${level}`, '');
        break;
      }
    }

    // Priority: explicit reasoning.effort > reasoning_effort param > model suffix > default (medium)
    if (!body.reasoning) {
      const effort = normalizeReasoningEffort(body.model, body.reasoning_effort || modelEffort || 'low');
      body.reasoning = { effort, summary: "auto" };
    } else {
      body.reasoning.effort = normalizeReasoningEffort(body.model, body.reasoning.effort);
      if (!body.reasoning.summary) body.reasoning.summary = "auto";
    }
    delete body.reasoning_effort;

    // Include reasoning encrypted content (required by Codex backend for reasoning models)
    if (body.reasoning && body.reasoning.effort && body.reasoning.effort !== 'none') {
      body.include = ["reasoning.encrypted_content"];
    }

    // Remove unsupported parameters for Codex API
    delete body.temperature;
    delete body.top_p;
    delete body.frequency_penalty;
    delete body.presence_penalty;
    delete body.logprobs;
    delete body.top_logprobs;
    delete body.n;
    delete body.seed;
    delete body.max_tokens;
    delete body.max_completion_tokens;
    delete body.max_output_tokens; // Responses API clients send this but Codex rejects it
    delete body.user; // Cursor sends this but Codex doesn't support it
    delete body.prompt_cache_retention; // Cursor sends this but Codex doesn't support it
    delete body.metadata; // Cursor sends this but Codex doesn't support it
    delete body.stream_options; // Cursor sends this but Codex doesn't support it
    delete body.safety_identifier; // Droid CLI sends this but Codex doesn't support it
    delete body.previous_response_id; // store=false → backend can't resolve previous resp; avoid 404

    // THE single outbound normalization point for the Codex service tier. Every
    // request reaching Codex passes through here, so `fast` collapses to its
    // alias and default/priority/ultrafast survive byte-for-byte exactly once.
    // An unforwardable tier is deleted, never remapped onto a tier the caller
    // did not ask for.
    const outboundServiceTier = normalizeCodexServiceTier(body.service_tier);
    if (outboundServiceTier === undefined) delete body.service_tier;
    else body.service_tier = outboundServiceTier;

    // Final allowlist filter — strip any unknown field that could trigger upstream "routing_unsupported"
    for (const k of Object.keys(body)) {
      if (!RESPONSES_API_ALLOWLIST.has(k)) delete body[k];
    }

    return body;
  }
}
