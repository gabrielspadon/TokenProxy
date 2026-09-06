import { isErrorResult } from "./errorFlags.js";
import { validateCompressedMessages } from "./contentPolicy.js";
// ponytail: Claude OpenAI-pivot imports dropped — direct Claude path ships;
// re-enable only with a round-trip no-loss proof (tool ids, is_error, cache_control).
import {
  openaiResponsesToOpenAIRequest,
  openaiToOpenAIResponsesRequest,
} from "../translator/request/openai-responses.js";
import { Agent } from "undici";

const DEFAULT_TIMEOUT_MS = 15000;

// Windows commonly resolves the bare "localhost" hostname to the IPv6
// loopback (::1) before the IPv4 one, while headroom-ai's `proxy` command
// binds only 127.0.0.1 by default. Every compress call to the default
// "http://localhost:8787" then fails with ECONNREFUSED even though the proxy
// is up and reachable — reported as "headroom itself works [when hit
// directly], tokenproxy integration is not applying it" (#2476). Force IPv4
// resolution only for the literal "localhost" host; an explicit IP or a real
// hostname (a remote/tunneled headroom instance) is untouched.
const IPV4_LOOPBACK_DISPATCHER = new Agent({ connect: { family: 4 } });
function dispatcherForEndpoint(endpoint) {
  try {
    return new URL(endpoint).hostname === "localhost" ? IPV4_LOOPBACK_DISPATCHER : undefined;
  } catch {
    return undefined;
  }
}

// Skip compression for oversized payloads (fail-open).
//
// The size curve this cap was first justified by does not exist. Re-measured
// 2026-09-04 against the live proxy at N=5 per size: latency is BIMODAL, not
// size-dependent — a call either returns in tens of milliseconds or sits at
// ~30000ms, and the 30s figure is headroom's own COMPRESSION_TIMEOUT_SECONDS
// (proxy/helpers.py, default 30.0, fail-open), which the same payload hits or
// misses across repeats. So the cap does not cut off a pathological size range,
// because there isn't one.
//
// It stays anyway, for the reason that survives: a body this large is a body
// whose whole prefix is about to be rewritten by the proxy, and the cache-write
// re-prime that costs is real money. The cap bounds the blast radius of one
// doomed round trip. Raise it only with a cr/cw measurement, never on a
// latency argument.
const MAX_COMPRESS_BODY_BYTES = 256 * 1024;

function jsonBytes(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value) || "").length;
  } catch {
    return 0;
  }
}

function messagePayload(body) {
  if (Array.isArray(body?.messages)) return body.messages;
  if (Array.isArray(body?.input)) return body.input;
  if (Array.isArray(body?.params?.messages)) return body.params.messages;
  const kiro = collectKiroHeadroomMessages(body);
  if (kiro) return kiro.messages;
  const gemini = collectGeminiHeadroomMessages(body);
  if (gemini) return gemini.messages;
  return null;
}

function captureSizeSnapshot(body) {
  const messages = messagePayload(body);
  const toolHistory = messages?.filter((message) =>
    message?.role === "tool"
    || message?.role === "function"
    || message?.tool_calls?.length
    || message?.content?.some?.((part) => part?.type === "tool_use" || part?.type === "tool_result")
  ) || [];
  return {
    bodyBytes: jsonBytes(body),
    messageBytes: messages ? jsonBytes(messages) : 0,
    toolSchemaBytes: jsonBytes(body?.tools || []),
    toolHistoryBytes: jsonBytes(toolHistory),
  };
}

function sanitizeReason(text) {
  let s = String(text ?? "").trim().replace(/\s+/g, " ");
  s = scrubSensitiveUrlText(s);
  if (s.length > 200) s = s.slice(0, 200);
  return s;
}

function setDiagnostic(diagnostics, reason) {
  if (diagnostics && !diagnostics.reason) diagnostics.reason = sanitizeReason(reason);
}

// OpenAI shape structural guard: same count, ordered role, valid content shape,
// and tool-pairing identity preserved (tool_call_id + assistant tool_calls).
// Any fixup (e.g. reindexing tool_call_id) is dangerous — reject instead.
function validateOpenAIMessageShape(sourceMessages, candidateMessages, diagnostics) {
  if (!Array.isArray(candidateMessages) || candidateMessages.length !== sourceMessages.length) {
    setDiagnostic(diagnostics, "proxy response did not preserve message count or order");
    return false;
  }
  for (let i = 0; i < sourceMessages.length; i++) {
    const src = sourceMessages[i] || {};
    const cand = candidateMessages[i] || {};
    if (cand.role !== src.role) {
      setDiagnostic(diagnostics, "proxy response did not preserve message count or order");
      return false;
    }
    // content: string | array blocks | null/empty (assistant tool_calls-only)
    const candContent = cand.content;
    const srcHasToolCalls = Array.isArray(src.tool_calls) && src.tool_calls.length > 0;
    const candHasToolCalls = Array.isArray(cand.tool_calls) && cand.tool_calls.length > 0;
    const contentShape =
      typeof candContent === "string" || Array.isArray(candContent) ||
      candContent === null || candContent === undefined ||
      typeof candContent === "object";
    if (candContent === null || candContent === undefined) {
      if (!candHasToolCalls && !srcHasToolCalls) {
        setDiagnostic(diagnostics, "proxy response did not preserve message count or order");
        return false;
      }
    } else if (!contentShape) {
      setDiagnostic(diagnostics, "proxy response did not preserve message count or order");
      return false;
    }
    // Tool pairing: do not let the proxy rewrite routing metadata.
    if (src.tool_call_id != null || cand.tool_call_id != null) {
      if (String(cand.tool_call_id ?? "") !== String(src.tool_call_id ?? "")) {
        setDiagnostic(diagnostics, "proxy response did not preserve message count or order");
        return false;
      }
    }
    const srcCalls = src.tool_calls;
    const candCalls = cand.tool_calls;
    if ((Array.isArray(srcCalls) && srcCalls.length > 0) || (Array.isArray(candCalls) && candCalls.length > 0)) {
      if (!Array.isArray(candCalls) || candCalls.length !== (srcCalls?.length ?? 0)) {
        setDiagnostic(diagnostics, "proxy response did not preserve tool pairing identity");
        return false;
      }
      for (let j = 0; j < srcCalls.length; j++) {
        const sCall = srcCalls[j] || {};
        const cCall = candCalls[j] || {};
        if (String(cCall.id ?? "") !== String(sCall.id ?? "") ||
            String(cCall.type ?? "function") !== String(sCall.type ?? "function") ||
            String(cCall.function?.name ?? "") !== String(sCall.function?.name ?? "") ||
            String(cCall.function?.arguments ?? "") !== String(sCall.function?.arguments ?? "")) {
          setDiagnostic(diagnostics, "proxy response did not preserve tool pairing identity");
          return false;
        }
      }
    }
  }
  return true;
}

// Copy each message with only its content replaced. Runs after
// validateOpenAIMessageShape, so everything else is already known identical.
function mergeCompressedContent(sourceMessages, compressedMessages) {
  return sourceMessages.map((src, i) => {
    const cand = compressedMessages[i];
    if (!src || typeof src !== "object" || Array.isArray(src)) return src;
    if (!cand || typeof cand !== "object" || cand.content === undefined) return src;
    return { ...src, content: cand.content };
  });
}

function resolveHeadroomAuth() {
  const key = (process.env.HEADROOM_API_KEY || "").trim();
  return key || null;
}

function containsCcrMarker(messages) {
  if (!Array.isArray(messages)) return false;
  for (const m of messages) {
    // Scan the whole message: `<<ccr:` hides in tool_calls.function.arguments
    // and non-text content parts, not just message.content text.
    try {
      if (JSON.stringify(m).includes("<<ccr:")) return true;
    } catch { /* circular/odd shape — fall through to text scan */ }
  }
  return false;
}

function hasCcrHashes(data) {
  return Array.isArray(data?.ccr_hashes) && data.ccr_hashes.length > 0;
}

function scrubSensitiveUrlText(text) {
  let s = String(text);
  s = s.replace(/\/\/[^/@\s]+@/g, "//");
  s = s.replace(/(https?:\/\/[^\s?#]+)[?#][^\s)]*/g, "$1");
  // Secrets must NEVER be emitted in diagnostics or logs.
  const key = (process.env.HEADROOM_API_KEY || "").trim();
  const tok = (process.env.HEADROOM_PROXY_TOKEN || "").trim();
  for (const secret of [key, tok]) {
    if (!secret || secret.length < 8) continue;
    // Exact match only — no partial masking on short fragments.
    s = s.replaceAll(secret, "[redacted]");
  }
  return s;
}

function describeFetchError(error) {
  const cause = error?.cause;
  const code = cause?.code || error?.code;
  const message = scrubSensitiveUrlText(cause?.message || error?.message || String(error));
  return code ? `${code}: ${message}` : message;
}

function buildCompressEndpoint(url) {
  try {
    const parsed = new URL(url);
    parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/v1/compress`;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    const raw = String(url).replace(/#.*$/, "");
    const [base, query = ""] = raw.split("?", 2);
    const endpoint = `${base.replace(/\/$/, "")}/v1/compress`;
    return query ? `${endpoint}?${query}` : endpoint;
  }
}

function maskEndpoint(endpoint) {
  try {
    const parsed = new URL(endpoint);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return String(endpoint).replace(/\/\/[^/@\s]+@/, "//").replace(/[?#].*$/, "");
  }
}

/**
 * Should this Responses request skip compression entirely?
 *
 * Yes for ANY input item that is not a plain message. That is deliberately
 * blunt, and it is not an oversight to be narrowed:
 *
 * Compression runs on the Chat-style projection, so a Responses body has to go
 * Responses -> messages -> Responses. That round-trip is NOT lossless. An
 * allowlist admitting reasoning / function_call / function_call_output was
 * tried and reported in #3571, looked correct in short runs, and then failed a
 * long Codex agentic workload with "Missing required parameter:
 * 'input[66].summary'" — the reconstruction had dropped reasoning.summary. The
 * reporter retracted their own proposal on that evidence.
 *
 * So: translator support does not imply round-trip safety, and widening this
 * predicate re-opens a failure someone has already paid to discover. Making
 * compression participate in agentic turns needs a projection that does not
 * rebuild the upstream body, which is a larger change than this guard.
 *
 * (A previous version carried a second branch checking function_call_output for
 * an error shape. It was unreachable — the type check above already returned
 * for it — so it described a nuance that never operated. Removed rather than
 * left to imply one.)
 */
function hasUnsafeResponsesInputForCompression(body) {
  if (!Array.isArray(body?.input)) return false;
  return body.input.some((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    return typeof item.type === "string" && item.type !== "message";
  });
}

// Responses "message" items whose role is an instruction role.
//
// The Chat projection turns these into system messages, and the way back
// (openaiToOpenAIResponsesRequest) hoists the FIRST one into `instructions` and
// then `continue`s past every later one. compressWithHeadroom only copies the
// rebuilt `input` back, so the hoisted text is discarded with the rest of the
// candidate — the item is simply gone from the request.
//
// That is #2132: Codex CLI carries its plan-mode directive as a developer item
// in `input`, so once the Responses branch started running (#1998, shipped in
// 0.5.12) plan mode stopped producing a plan, while 0.5.8 — where this branch
// did not exist — was fine. Instruction items are exactly the content a client's
// mode depends on, so they get the same treatment the Claude branch already
// gives `system`: kept local, never replaced by what the proxy sends back.
const RESPONSES_INSTRUCTION_ROLES = new Set(["system", "developer"]);

function isResponsesInstructionItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  const isMessage = item.type === "message" || (!item.type && !!item.role);
  return isMessage && RESPONSES_INSTRUCTION_ROLES.has(item.role);
}

// Responses input item types that have a Chat projection slot in the request
// translator (openaiResponsesToOpenAIRequest).
const RESPONSES_PROJECTED_ITEM_TYPES = new Set([
  "message",
  "function_call",
  "custom_tool_call",
  "function_call_output",
  "custom_tool_call_output",
  "additional_tools",
  "namespace",
  "reasoning",
]);

// hh-rsp-1: fail-safe — any Responses item that would be LOST in the
// projection/rebuild round trip silently disappears from body.input when a
// real shrink is committed. Detect before dispatch so compression skips the
// whole request instead of deleting the item.
function findResponsesProjectionLoss(input) {
  if (!Array.isArray(input)) return null;
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (isResponsesInstructionItem(item)) continue; // restored untouched after rebuild
    if (typeof item.type === "string" && !RESPONSES_PROJECTED_ITEM_TYPES.has(item.type)) {
      return `skipped: responses item type '${item.type}' has no chat projection — headroom not applied`;
    }
    if (typeof item.type !== "string" && item.role == null) {
      return "skipped: untyped responses item has no chat projection — headroom not applied";
    }
    if (item.type === "message" || (typeof item.type !== "string" && typeof item.role === "string")) {
      // Message items whose content projects to nothing vanish on the way
      // back (the translator only re-emits non-empty content).
      const content = item.content;
      const vanishes = Array.isArray(content)
        ? content.length === 0 || !content.some((p) => p && typeof p === "object" && ((typeof p.text === "string" && p.text.length > 0) || p.type === "input_image" || p.image_url != null))
        : typeof content !== "string" || content.length === 0;
      if (vanishes) {
        return "skipped: responses message item with empty content has no chat projection — headroom not applied";
      }
    }
    if ((item.type === "function_call" || item.type === "custom_tool_call")
      && (typeof item.name !== "string" || item.name.trim() === "")) {
      return `skipped: ${item.type} item without a name has no chat projection — headroom not applied`;
    }
  }
  return null;
}

// hh-rsp-2: message-item fields with no Chat projection slot (name on the
// item, cache_control on content parts) are dropped on round-trip; the
// cache_control loss silently disables prompt caching. Re-attach them from
// the original input by position after the rebuild. If positions or part
// shapes no longer align, the fields cannot be preserved — fail safe and
// skip the whole request.
function restoreResponsesMessageItemExtras(originalInput, rebuiltInput) {
  if (!Array.isArray(originalInput) || !Array.isArray(rebuiltInput)) return { ok: true };
  for (let i = 0; i < originalInput.length; i++) {
    const orig = originalInput[i];
    if (!orig || typeof orig !== "object" || Array.isArray(orig)) continue;
    const isMessage = orig.type === "message" || (typeof orig.type !== "string" && typeof orig.role === "string");
    if (!isMessage || isResponsesInstructionItem(orig)) continue;
    const needsName = typeof orig.name === "string" && orig.name.length > 0;
    const origParts = Array.isArray(orig.content) ? orig.content : null;
    const needsCacheControl = !!origParts?.some((p) => p && typeof p === "object" && p.cache_control != null);
    if (!needsName && !needsCacheControl) continue;
    const rebuilt = rebuiltInput[i];
    if (!rebuilt || typeof rebuilt !== "object" || Array.isArray(rebuilt) || rebuilt.type !== "message") {
      return { ok: false, reason: "skipped: responses item reshaped - name/cache_control cannot be preserved — headroom not applied" };
    }
    if (needsName) rebuilt.name = orig.name;
    if (needsCacheControl) {
      if (!Array.isArray(rebuilt.content) || rebuilt.content.length !== origParts.length) {
        return { ok: false, reason: "skipped: responses content parts reshaped - cache_control cannot be preserved — headroom not applied" };
      }
      for (let j = 0; j < origParts.length; j++) {
        const origPart = origParts[j];
        if (origPart && typeof origPart === "object" && origPart.cache_control != null && rebuilt.content[j]) {
          rebuilt.content[j].cache_control = origPart.cache_control;
        }
      }
    }
  }
  return { ok: true };
}

// Put the untouched instruction items back where they started. The rebuilt input
// holds only the non-instruction items, in their original order, so walking the
// original and drawing from the rebuilt one restores every position exactly.
// A count mismatch means the round trip lost or invented something else too;
// return null so the caller keeps the original body rather than guess.
function restoreResponsesInstructionItems(originalInput, rebuiltInput) {
  const remaining = rebuiltInput.slice();
  const merged = [];
  for (const item of originalInput) {
    if (isResponsesInstructionItem(item)) {
      merged.push(item);
      continue;
    }
    if (remaining.length === 0) return null;
    merged.push(remaining.shift());
  }
  return remaining.length === 0 ? merged : null;
}

// Scan only tool-result envelopes and their content. Malformed/cyclic bodies
// are refused rather than treating an unreadable subtree as evidence-free.
function hasErrorToolBlock(body) {
  const visit = (node, inResult = false) => {
    if (!node || typeof node !== "object") return false;
    if (Array.isArray(node)) return node.some((part) => visit(part, inResult));
    const tool = inResult || node.role === "tool" || node.type === "tool_result" || node.type === "function_call_output";
    if (tool && isErrorResult(node)) return true;
    return Object.entries(node).some(([key, value]) => visit(value, tool || key === "toolResults"));
  };
  try { return visit(body); } catch { return true; }
}

function collectKiroHeadroomMessages(body) {
  const state = body?.conversationState;
  if (!state || typeof state !== "object") return null;

  const messages = [];
  const targets = [];

  const addTextTarget = (role, text, target, extra = {}) => {
    if (typeof text !== "string") return;
    messages.push({ role, content: text, ...extra });
    targets.push(target);
  };

  const toToolCalls = (toolUses) => {
    if (!Array.isArray(toolUses) || toolUses.length === 0) return undefined;
    const calls = toolUses.map((toolUse) => ({
      id: toolUse?.toolUseId,
      type: "function",
      function: {
        name: toolUse?.name || "",
        arguments: JSON.stringify(toolUse?.input || {}),
      },
    })).filter((call) => call.id || call.function.name);
    return calls.length > 0 ? calls : undefined;
  };

  const visit = (item) => {
    const user = item?.userInputMessage;
    if (user) {
      addTextTarget("system", user.systemInstruction, { object: user, key: "systemInstruction" });
      addTextTarget("user", user.content, { object: user, key: "content" });

      const toolResults = user.userInputMessageContext?.toolResults;
      if (Array.isArray(toolResults)) {
        for (const toolResult of toolResults) {
          const content = toolResult?.content;
          if (!Array.isArray(content)) continue;
          for (const part of content) {
            addTextTarget(
              "tool",
              part?.text,
              { object: part, key: "text" },
              toolResult?.toolUseId ? { tool_call_id: toolResult.toolUseId } : {}
            );
          }
        }
      }
      return;
    }

    const assistant = item?.assistantResponseMessage;
    if (assistant) {
      const toolCalls = toToolCalls(assistant.toolUses);
      addTextTarget(
        "assistant",
        assistant.content,
        { object: assistant, key: "content" },
        toolCalls ? { tool_calls: toolCalls } : {}
      );
    }
  };

  if (Array.isArray(state.history)) {
    for (const item of state.history) visit(item);
  }
  if (state.currentMessage) visit(state.currentMessage);

  return messages.length > 0 ? { messages, targets } : null;
}

// Gemini family: contents[].parts[].text plus the system instruction. gemini,
// gemini-cli and vertex keep it at the top level; antigravity nests the same
// object under body.request. Same projection contract as Kiro — only `text`
// parts become messages and only those fields are written back, so functionCall,
// functionResponse, inlineData and fileData parts are never rewritten. That also
// keeps the error-trace contract for free: a failed tool result lives in
// functionResponse.response, which this never reaches.
const GEMINI_FAMILY_FORMATS = new Set(["gemini", "gemini-cli", "vertex", "antigravity"]);

function collectGeminiHeadroomMessages(body) {
  const root = body?.request && typeof body.request === "object" ? body.request : body;
  if (!root || typeof root !== "object") return null;

  const messages = [];
  const targets = [];
  const addTextTarget = (role, text, target) => {
    if (typeof text !== "string" || text.length === 0) return;
    messages.push({ role, content: text });
    targets.push(target);
  };

  const system = root.systemInstruction || root.system_instruction;
  if (system && Array.isArray(system.parts)) {
    for (const part of system.parts) addTextTarget("system", part?.text, { object: part, key: "text" });
  }

  if (Array.isArray(root.contents)) {
    for (const content of root.contents) {
      if (!Array.isArray(content?.parts)) continue;
      const role = content.role === "model" ? "assistant" : "user";
      for (const part of content.parts) addTextTarget(role, part?.text, { object: part, key: "text" });
    }
  }

  return messages.length > 0 ? { messages, targets } : null;
}

function textFromHeadroomMessage(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  const parts = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
    } else if (typeof part?.text === "string") {
      parts.push(part.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function applyProjectedMessages(projection, compressedMessages, diagnostics, label) {
  if (!Array.isArray(compressedMessages) || compressedMessages.length !== projection.messages.length) {
    setDiagnostic(diagnostics, `proxy response did not match ${label} message count`);
    return false;
  }

  const updates = [];
  for (let i = 0; i < projection.messages.length; i++) {
    const expected = projection.messages[i];
    const actual = compressedMessages[i];
    if (!actual || actual.role !== expected.role) {
      setDiagnostic(diagnostics, `proxy response did not preserve ${label} message order`);
      return false;
    }

    const text = textFromHeadroomMessage(actual);
    if (text === null) {
      setDiagnostic(diagnostics, `proxy response missing ${label} text content`);
      return false;
    }
    updates.push({ target: projection.targets[i], text });
  }

  for (const update of updates) {
    update.target.object[update.target.key] = update.text;
  }
  return true;
}

const CIRCUIT_BREAKER = new Map();
const CB_FAILURE_THRESHOLD = 2;
const CB_COOLDOWN_MS = 30000;

export function resetHeadroomCircuitBreaker() {
  CIRCUIT_BREAKER.clear();
}

// POST messages to Headroom /v1/compress; returns compressed messages + stats or null.
async function callCompress(url, messages, model, timeoutMs, compressUserMessages, diagnostics, allowLossy) {
  const endpoint = buildCompressEndpoint(url);
  diagnostics.endpoint = maskEndpoint(endpoint);
  const cb = CIRCUIT_BREAKER.get(endpoint);
  if (cb && cb.failures >= CB_FAILURE_THRESHOLD && Date.now() - cb.lastFailureTime < CB_COOLDOWN_MS) {
    const remainingSec = Math.ceil((CB_COOLDOWN_MS - (Date.now() - cb.lastFailureTime)) / 1000);
    setDiagnostic(diagnostics, `proxy temporarily unavailable (circuit breaker active, retrying in ${remainingSec}s)`);
    return null;
  }

  // Exactly one outbound POST. Config is lossy-only. No frozen_message_count.
  const payload = { messages, model, config: { mode: "lossy_inline", ...(compressUserMessages ? { compress_user_messages: true } : {}) } };
  const headroomAuth = resolveHeadroomAuth();
  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(headroomAuth ? { Authorization: `Bearer ${headroomAuth}` } : {}) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher: dispatcherForEndpoint(endpoint),
    });
  } catch (error) {
    const state = cb || { failures: 0, lastFailureTime: 0 };
    state.failures += 1;
    state.lastFailureTime = Date.now();
    CIRCUIT_BREAKER.set(endpoint, state);
    setDiagnostic(diagnostics, `request failed: ${describeFetchError(error)}`);
    return null;
  }
  if (!res.ok) {
    const state = cb || { failures: 0, lastFailureTime: 0 };
    state.failures += 1;
    state.lastFailureTime = Date.now();
    CIRCUIT_BREAKER.set(endpoint, state);
    if (res.status === 400 || res.status === 404) setDiagnostic(diagnostics, `proxy rejected config.mode (HTTP ${res.status})`);
    else setDiagnostic(diagnostics, `proxy returned HTTP ${res.status}`);
    return null; // no fallback retry — one call only
  }
  const data = await res.json();
  // CCR gate: gateway has no headroom_retrieve path — reject any CCR-marked response.
  if (hasCcrHashes(data)) {
    setDiagnostic(diagnostics, "rejected: response contains CCR markers");
    return null;
  }
  if (Array.isArray(data?.messages) && containsCcrMarker(data.messages)) {
    setDiagnostic(diagnostics, "rejected: response contains CCR markers");
    return null;
  }
  if (data?.compression_skipped === true) {
    setDiagnostic(diagnostics, sanitizeReason(data.skip_reason || "compression_skipped"));
    return null;
  }
  if (data?.skip_reason && !Array.isArray(data?.messages)) {
    setDiagnostic(diagnostics, sanitizeReason(data.skip_reason));
    return null;
  }
  if (!Array.isArray(data?.messages)) {
    setDiagnostic(diagnostics, "proxy response missing messages[]");
    return null;
  }
  // Token phantom / conflicting metrics gate — null means keep original.
  // Gates run on the PARSED numbers: a proxy returning string-encoded metrics
  // ("1000") must not bypass them via raw-value Number.isFinite checks.
  const tokensBefore = Number(data.tokens_before);
  const tokensAfter = Number(data.tokens_after);
  const tokensSaved = Number(data.tokens_saved);
  if (Number.isFinite(tokensSaved) && tokensSaved <= 0) {
    setDiagnostic(diagnostics, sanitizeReason(data.skip_reason || "no token saving — keeping original"));
    return null;
  }
  if (Number.isFinite(tokensBefore) && Number.isFinite(tokensAfter)) {
    if (tokensAfter >= tokensBefore * 0.95) {
      setDiagnostic(diagnostics, "phantom savings — keeping original (>95% tokens)");
      return null;
    }
    if (tokensAfter > tokensBefore) {
      setDiagnostic(diagnostics, "conflicting token metrics — keeping original");
      return null;
    }
  }
  if (!validateCompressedMessages(messages, data.messages, { allowLossy })) {
    setDiagnostic(diagnostics, "proxy changed protected content or metadata (tool pairing identity/message count or order)");
    return null;
  }
  data.mode = allowLossy ? "lossy-opt-in" : "semantic-preserving";
  data.semanticPreserving = !allowLossy;
  CIRCUIT_BREAKER.delete(endpoint);
  return data;
}

// Work on private data and commit only after every guard and diagnostic ran.
// Failed Kiro/Gemini projection previously left replacement containers behind.
export async function compressWithHeadroom(body, options = {}) {
  if (!body || !options.enabled) return compressCandidate(body, options);
  try {
    const candidate = structuredClone(body);
    const result = await compressCandidate(candidate, options);
    if (!result) return null;
    const keys = Object.keys(candidate).filter((key) => JSON.stringify(body[key]) !== JSON.stringify(candidate[key]));
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(body, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.writable) {
        setDiagnostic(options.diagnostics, "request target is not a writable data property");
        return null;
      }
    }
    for (const key of keys) body[key] = candidate[key];
    return result;
  } catch (error) {
    setDiagnostic(options.diagnostics, `unexpected error: ${error?.message || String(error)}`);
    return null;
  }
}

async function compressCandidate(body, { allowLossy = false, enabled, url, model, format, compressUserMessages, timeoutMs = DEFAULT_TIMEOUT_MS, contextPressure = null, diagnostics = null } = {}) {
  if (!enabled) {
    setDiagnostic(diagnostics, "disabled");
    return null;
  }
  // ONLY UNDER PRESSURE (2026-09-04). Every gate in this function turns on
  // volatile content — the payload's size, an error tool result being present,
  // whether the proxy finds more than 5% to cut — so within ONE conversation
  // the apply/skip outcome oscillates, and each flip rewrites the prompt prefix
  // the provider has cached. Measured live on the RTX seam over 422 requests: a
  // turn whose outcome flipped from the previous one shared a mean 62,568 bytes
  // of prefix with it, 49% of them under 2 KB, against 152,892 bytes and 17%
  // under 2 KB when the outcome held. The cache-write re-prime that buys costs
  // more than the tokens compression saves.
  //
  // So the caller measures how far over budget the request is
  // (services/memory/contextBudget.js) and passes it here. Inside the budget
  // the body is left exactly as the client sent it, which is what keeps the
  // prefix byte-identical turn to turn; over budget, the prefix is going to
  // move anyway and the saved tokens are what keep the request in the window.
  // Same discipline as services/memory/toolPruner.js.
  //
  // A caller that passes no measurement is not gated, so this module's own
  // suites keep exercising the compression path directly.
  if (contextPressure && !contextPressure.over) {
    setDiagnostic(
      diagnostics,
      `within context budget (~${contextPressure.projected} of ${contextPressure.budget} tokens,`
      + ` window ${contextPressure.limit}) — prefix left intact`,
    );
    return null;
  }
  if (!url) {
    setDiagnostic(diagnostics, "missing proxy URL");
    return null;
  }
  if (!body) {
    setDiagnostic(diagnostics, "missing request body");
    return null;
  }

  try {
    const sizeSnapshot = captureSizeSnapshot(body);
    if (diagnostics) diagnostics.before = sizeSnapshot;
    // The Claude branch below compresses a bounded slice of the oldest
    // messages instead of skipping: under the context-pressure gate above a
    // Claude body is by definition near its window, so on a 1M-token model
    // it is 3-4 MB and the whole-body cap made this stage unreachable exactly
    // when it was allowed to run. Every other shape keeps the skip.
    if (sizeSnapshot.bodyBytes > MAX_COMPRESS_BODY_BYTES && format !== "claude") {
      setDiagnostic(diagnostics, `skipped: payload too large (${sizeSnapshot.bodyBytes}B > ${MAX_COMPRESS_BODY_BYTES}B limit)`);
      return null;
    }
    if (hasErrorToolBlock(body, format)) {
      setDiagnostic(diagnostics, "skipped: error tool result present — headroom not applied");
      return null;
    }

    // Claude shape: send native Claude messages directly (no OpenAI pivot, no retry).
    // system + tools stay local — duplicating them in the proxy payload would
    // double-bill on the response and risk losing them on a lossy round-trip.
    // ponytail: OpenAI pivot helpers kept for legacy consumers, direct path is canonical.
    if (format === "claude") {
      const allMessages = Array.isArray(body?.messages) ? body.messages : null;
      if (!allMessages) {
        setDiagnostic(diagnostics, "unsupported claude request shape");
        return null;
      }
      // Oldest-first slice under the size cap, never the last two turns. The
      // slice is a pure function of the history's head, so consecutive turns
      // send the proxy the same input and (it is deterministic) get the same
      // output back: the compressed prefix stays byte-identical turn to turn.
      let sliceEnd = allMessages.length;
      if (jsonBytes(allMessages) > MAX_COMPRESS_BODY_BYTES) {
        let acc = 2;
        sliceEnd = 0;
        for (let i = 0; i < allMessages.length - 2; i++) {
          const next = acc + jsonBytes(allMessages[i]) + 1;
          if (next > MAX_COMPRESS_BODY_BYTES) break;
          acc = next;
          sliceEnd = i + 1;
        }
        if (sliceEnd < 2) {
          setDiagnostic(diagnostics, `skipped: no message slice fits under ${MAX_COMPRESS_BODY_BYTES}B`);
          return null;
        }
      }
      const sourceMessages = allMessages.slice(0, sliceEnd);
      const data = await callCompress(url, sourceMessages, model, timeoutMs, compressUserMessages, diagnostics || {}, allowLossy);
      if (!data) return null;
      // Validate response preserves identity (count + ordered roles) before commit.
      const compressed = data.messages;
      if (!Array.isArray(compressed) || compressed.length !== sourceMessages.length) {
        setDiagnostic(diagnostics, "proxy response did not preserve Claude message count");
        return null;
      }
      for (let i = 0; i < compressed.length; i++) {
        const expected = sourceMessages[i]?.role;
        const actual = compressed[i]?.role;
        const shaped = typeof compressed[i]?.content === "string" || Array.isArray(compressed[i]?.content);
        if (actual !== expected || !shaped) {
          setDiagnostic(diagnostics, "proxy response did not preserve Claude message shape");
          return null;
        }
      }
      // hh-cld-1: pairing identity, same positions pattern as the OpenAI
      // guard (validateOpenAIMessageShape) — every tool_use block's id must
      // appear as a tool_result's tool_use_id and vice versa.
      const claudeToolUseIds = new Map();
      const claudeToolResultIds = new Map();
      const claudeCandidateUseIds = new Map();
      const claudeCandidateResultIds = new Map();
      const collectClaudePairingIds = (blocks, useMap, resultMap) => {
        if (!Array.isArray(blocks)) return;
        for (const part of blocks) {
          if (part?.type === "tool_use" && typeof part?.id === "string") useMap.set(part.id, useMap.size);
          else if (part?.type === "tool_result" && typeof part?.tool_use_id === "string") resultMap.set(part.tool_use_id, resultMap.size);
        }
      };
      for (let i = 0; i < sourceMessages.length; i++) {
        collectClaudePairingIds(sourceMessages[i]?.content, claudeToolUseIds, claudeToolResultIds);
        collectClaudePairingIds(compressed[i]?.content, claudeCandidateUseIds, claudeCandidateResultIds);
      }
      const claudePairingMismatch =
        claudeToolUseIds.size !== claudeCandidateUseIds.size ||
        claudeToolResultIds.size !== claudeCandidateResultIds.size ||
        [...claudeToolUseIds].some(([id, pos]) => claudeCandidateUseIds.get(id) !== pos) ||
        [...claudeToolResultIds].some(([id, pos]) => claudeCandidateResultIds.get(id) !== pos);
      if (claudePairingMismatch) {
        setDiagnostic(diagnostics, "tool pairing identity");
        return null;
      }
      // Byte-gain guard — candidate bytes compared to before snapshot. On a
      // sliced body the guard reads the slice: a 5% cut of the head is real
      // even when it is 1% of the whole request.
      const restored = mergeCompressedContent(sourceMessages, compressed);
      const merged = sliceEnd < allMessages.length ? [...restored, ...allMessages.slice(sliceEnd)] : restored;
      const candidateBytes = sliceEnd < allMessages.length ? jsonBytes(compressed) : jsonBytes({ ...body, messages: merged });
      const beforeBytes = sliceEnd < allMessages.length ? jsonBytes(sourceMessages) : (diagnostics?.before?.bodyBytes ?? jsonBytes(body));
      if (candidateBytes >= beforeBytes * 0.95) {
        setDiagnostic(diagnostics, "phantom savings — keeping original (>95% size)");
        return null;
      }
      if (sliceEnd < allMessages.length && diagnostics) diagnostics.sliced = { messages: sliceEnd, of: allMessages.length };
      body.messages = merged; // system + tools preserved locally, untouched
      if (diagnostics) diagnostics.after = captureSizeSnapshot(body);
      return data;
    }

    // OpenAI Responses shape (Codex): body.input holds Responses items, NOT OpenAI
    // messages. Translate input -> OpenAI -> compress -> translate back to input so
    // body.input keeps the Responses contract (the proxy only understands OpenAI). (#1998)
    if (format === "openai-responses") {
      if (hasUnsafeResponsesInputForCompression(body)) {
        setDiagnostic(diagnostics, "skipped: openai-responses tool/reasoning input is not safe to compress");
        return null;
      }
      // hh-rsp-1: fail-safe — skip before dispatch when any item would be
      // lost in projection/rebuild (e.g. empty-content message items).
      const projectionLoss = findResponsesProjectionLoss(body.input);
      if (projectionLoss) {
        setDiagnostic(diagnostics, projectionLoss);
        return null;
      }
      const oai = openaiResponsesToOpenAIRequest(model, body, false);
      if (!Array.isArray(oai?.messages)) {
        setDiagnostic(diagnostics, "openai-responses request did not translate to messages[]");
        return null;
      }
      const data = await callCompress(url, oai.messages, model, timeoutMs, compressUserMessages, diagnostics || {}, allowLossy);
      if (!data) return null;
      // Candidate-before-mutate guard: require >5% byte shrink before committing input rewrite.
      const candidateResponses = openaiToOpenAIResponsesRequest(model, { ...oai, input: undefined, messages: data.messages }, false);
      if (!Array.isArray(candidateResponses?.input)) {
        setDiagnostic(diagnostics, "Responses translation did not produce compressed input");
        return null;
      }
      const mergedInput = Array.isArray(body.input)
        ? restoreResponsesInstructionItems(body.input, candidateResponses.input)
        : candidateResponses.input;
      if (!mergedInput) {
        setDiagnostic(diagnostics, "Responses round trip did not preserve input items");
        return null;
      }
      // hh-rsp-2: restore name / cache_control lost in the round trip;
      // skip the request if they cannot be re-attached safely.
      const extrasRestore = restoreResponsesMessageItemExtras(body.input, mergedInput);
      if (!extrasRestore.ok) {
        setDiagnostic(diagnostics, extrasRestore.reason);
        return null;
      }
      const beforeBytes = diagnostics?.before?.bodyBytes ?? jsonBytes(body);
      // Measured on the merged input, not on the rebuilt one: the rebuilt input
      // is missing the instruction items, so it reads as a saving that the
      // request never makes.
      const candidateBytes = jsonBytes({ ...body, input: mergedInput });
      if (candidateBytes >= beforeBytes * 0.95) {
        setDiagnostic(diagnostics, "phantom savings — keeping original (>95% size)");
        return null;
      }
      body.input = mergedInput;
      if (diagnostics) diagnostics.after = captureSizeSnapshot(body);
      return data;
    }

    // Kiro shape: conversationState.history/currentMessage are projected to
    // OpenAI messages for the proxy, then copied back into the original Kiro
    // fields. Keep the provider payload shape intact for Kiro's executor.
    if (format === "kiro") {
      // R-F1: on the passthrough path with rtk and privacy both off,
      // chatCore's isolateCompressibleItems never ran, so conversationState is
      // still the caller's own object — writing through the projection targets
      // would let an account-fallback retry re-compress our output (#3566
      // shape). Clone the state the projection targets; on clone refusal the
      // shared object is a worse result on retry, not a broken one.
      if (body?.conversationState && typeof body.conversationState === "object") {
        try {
          body.conversationState = structuredClone(body.conversationState);
        } catch { /* as above */ }
      }
      const projection = collectKiroHeadroomMessages(body);
      if (!projection) {
        setDiagnostic(diagnostics, "Kiro request did not project to messages[]");
        return null;
      }
      const data = await callCompress(url, projection.messages, model, timeoutMs, compressUserMessages, diagnostics || {}, allowLossy);
      if (!data) return null;
      // Byte-shrink guard BEFORE mutating any Kiro state: projected-message sizes
      // proxy for body shrink (targets are unchanged by compression).
      const beforeProjectedBytes = jsonBytes(projection.messages);
      const afterProjectedBytes = jsonBytes(data.messages);
      if (afterProjectedBytes >= beforeProjectedBytes * 0.95) {
        setDiagnostic(diagnostics, "phantom savings — keeping original (>95% size)");
        return null;
      }
      if (!applyProjectedMessages(projection, data.messages, diagnostics, "Kiro")) return null;
      if (diagnostics) diagnostics.after = captureSizeSnapshot(body);
      return data;
    }

    // Gemini family: contents[] projects to OpenAI messages exactly the way
    // Kiro's conversationState does. Without this branch a gemini/vertex body
    // fell through to the messages/input lookup below, matched neither key, and
    // every request to a Gemini-shaped upstream was skipped with
    // "unsupported gemini request shape" (#2620). Gated on the format rather
    // than on the presence of contents[], so a body that merely looks Gemish is
    // still left alone.
    if (GEMINI_FAMILY_FORMATS.has(format)) {
      // R-F1: same caller-object hazard as Kiro — and chatCore's isolation
      // never covered contents[] at all, so this shape was shared even with
      // rtk/privacy on. Clone the containers the projection targets (contents
      // plus systemInstruction, top-level or nested under body.request)
      // before any write-back. A nested request is envelope-copied first:
      // reassigning keys directly on it would still mutate the caller's own
      // request object from the passthrough shallow spread.
      const GEMINI_TARGET_KEYS = ["contents", "systemInstruction", "system_instruction"];
      try {
        if (body?.request && typeof body.request === "object") {
          const requestCopy = { ...body.request };
          for (const key of GEMINI_TARGET_KEYS) {
            if (requestCopy[key] != null) requestCopy[key] = structuredClone(requestCopy[key]);
          }
          body.request = requestCopy;
        } else {
          for (const key of GEMINI_TARGET_KEYS) {
            if (body?.[key] != null) body[key] = structuredClone(body[key]);
          }
        }
      } catch { /* shared: a worse result on retry, not a broken one */ }
      const projection = collectGeminiHeadroomMessages(body);
      if (!projection) {
        setDiagnostic(diagnostics, `${format} request did not project to messages[]`);
        return null;
      }
      const data = await callCompress(url, projection.messages, model, timeoutMs, compressUserMessages, diagnostics || {}, allowLossy);
      if (!data) return null;
      // Byte-shrink guard BEFORE mutating any part: projected-message sizes
      // proxy for body shrink (targets are unchanged by compression).
      const beforeProjectedBytes = jsonBytes(projection.messages);
      const afterProjectedBytes = jsonBytes(data.messages);
      if (afterProjectedBytes >= beforeProjectedBytes * 0.95) {
        setDiagnostic(diagnostics, "phantom savings — keeping original (>95% size)");
        return null;
      }
      if (!applyProjectedMessages(projection, data.messages, diagnostics, "Gemini")) return null;
      if (diagnostics) diagnostics.after = captureSizeSnapshot(body);
      return data;
    }

    // OpenAI shape: messages/input go straight to the proxy.
    // CommandCode carries the same OpenAI-role message list one level down under
    // `params`, so the top-level lookup matched neither key and skipped every
    // commandcode request as an unsupported shape (#2620). Format-gated, so a
    // stray `params.messages` on any other body is still ignored.
    const container = format === "commandcode" && Array.isArray(body?.params?.messages)
      ? body.params
      : body;
    const key = Array.isArray(container.messages) ? "messages"
      : Array.isArray(container.input) ? "input"
      : null;
    if (!key) {
      setDiagnostic(diagnostics, `unsupported ${format || "unknown"} request shape`);
      return null;
    }
    const sourceMessages = container[key];
    const data = await callCompress(url, sourceMessages, model, timeoutMs, compressUserMessages, diagnostics || {}, allowLossy);
    if (!data) return null;
    // Structural guard BEFORE any byte math or mutation: a buggy/compromised
    // proxy must not be able to drop/reorder/retag history (silent context loss).
    if (!validateOpenAIMessageShape(sourceMessages, data.messages, diagnostics)) return null;
    // Commit the compressed CONTENT into copies of our own messages instead of
    // swapping in the proxy's objects. The validator has already proved role,
    // tool_call_id and tool_calls identical, so content is the only field that
    // may legitimately differ — while a wholesale swap silently dropped every
    // field outside the OpenAI contract that the target format needs: Ollama's
    // `tool_name` (its only tool-pairing key, since Ollama messages carry no
    // tool_call_id for the validator to catch), its `images[]` and `thinking`,
    // and a plain OpenAI `name`.
    const candidateMessages = mergeCompressedContent(sourceMessages, data.messages);
    // Candidate-before-mutate byte guard: require >5% shrink before committing.
    // Measured by writing the merged array in and reading the whole body, so the
    // number gates what actually commits even when the container is body.params.
    const expectedBeforeBytes = diagnostics?.before?.bodyBytes ?? jsonBytes(body);
    const candidateBody = container === body
      ? { ...body, [key]: candidateMessages }
      : { ...body, params: { ...container, [key]: candidateMessages } };
    const candidateBytes = jsonBytes(candidateBody);
    if (candidateBytes >= expectedBeforeBytes * 0.95) {
      setDiagnostic(diagnostics, "phantom savings — keeping original (>95% size)");
      return null;
    }
    container[key] = candidateMessages;
    if (diagnostics) diagnostics.after = captureSizeSnapshot(body);
    return data;
  } catch (error) {
    setDiagnostic(diagnostics, `unexpected error: ${error?.message || String(error)}`);
    return null;
  }
}

export function formatHeadroomLog(stats) {
  if (!stats) return null;
  const before = stats.tokens_before || 0;
  const after = stats.tokens_after || 0;
  const delta = stats.tokens_saved || 0;
  const pct = before > 0 ? ((delta / before) * 100).toFixed(1) : "0";
  return `reported token delta=${delta} before=${before}${after ? ` after=${after}` : ""} (${pct}%)`.trim();
}

export function formatHeadroomSizeLog(diagnostics) {
  const before = diagnostics?.before;
  const after = diagnostics?.after;
  if (!before || !after) return "";
  const effective = before.bodyBytes > 0
    ? (((before.bodyBytes - after.bodyBytes) / before.bodyBytes) * 100).toFixed(1)
    : "0.0";
  return `body=${before.bodyBytes}B→${after.bodyBytes}B messages=${before.messageBytes}B→${after.messageBytes}B tools=${before.toolSchemaBytes || 0}B→${after.toolSchemaBytes || 0}B toolHistory=${before.toolHistoryBytes || 0}B→${after.toolHistoryBytes || 0}B effective=${effective}%`;
}

export function isHeadroomPhantomSavings(stats, diagnostics, minShrinkRatio = 0.05) {
  if (!stats?.tokens_saved || stats.tokens_saved <= 0) return false;
  const before = diagnostics?.before?.bodyBytes || 0;
  const after = diagnostics?.after?.bodyBytes || 0;
  if (before <= 0 || after <= 0) return false;
  return after >= before * (1 - minShrinkRatio);
}
