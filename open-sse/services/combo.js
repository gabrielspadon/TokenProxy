/**
 * Shared combo (model combo) handling with fallback support
 */

import { checkFallbackError, formatRetryAfter } from "./accountFallback.js";
import { TRANSIENT_COOLDOWN_MS } from "../config/errorConfig.js";
import { errorResponse, unavailableResponse } from "../utils/error.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { extractTextContent } from "../translator/formats/gemini.js";
import { peekStreamForContent } from "../utils/streamContent.js";
import { estimateTokenCount } from "./memory/contextCompactor.js";

// Hard capabilities = input modalities; missing one drops request data (e.g. image
// stripped). Must be prioritized. Soft (e.g. search) only degrades a feature.
const HARD_CAPS = new Set(["vision", "pdf", "audioInput", "videoInput"]);

// A transient upstream failure carrying a short cooldown is the provider asking
// to be tried again, not a reason to leave it. Bounded so one struggling member
// cannot hold the whole chain: a few extra attempts, and only while the wait
// itself is short (#337).
const COMBO_RETRY_MAX_DELAY_MS = 10000;
const COMBO_RETRY_MAX_ATTEMPTS = 2;

// Server-side transients only. A 429 is a fact about the ACCOUNT rather than the
// member, so retrying the same one just spends the same credential again --
// account rotation and the next combo member are the right answers there.
const COMBO_RETRY_STATUSES = new Set([502, 503, 504]);

// Retry-After in seconds or as an HTTP-date. The provider's own number beats the
// classifier's guess, and a long one is exactly what tells the combo to move on
// instead of parking the request.
function retryAfterDelayMs(response) {
  const raw = response?.headers?.get?.("retry-after");
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return secs > 0 ? secs * 1000 : null;
  const dateMs = Date.parse(raw);
  return Number.isFinite(dateMs) && dateMs > Date.now() ? dateMs - Date.now() : null;
}

// Prefixes used when flattening tool turns into plain prose for panel models.
const TOOL_CALL_PREFIX = "[Called tools: ";
const TOOL_RESULT_PREFIX = "[Tool result: ";

// Flatten tool turns into prose so panel models keep the context but can't loop
// on tools: drop the request's tools, turn tool/function results into user
// text, and inline assistant tool_calls names instead of the structured field.
// Tool results become user turns (matching the claude-to-openai translator's
// ROLE.TOOL -> USER mapping): a trailing assistant turn is rejected by Anthropic
// as unsupported prefill on newer Claude models.
// Input-modality blocks across the client formats this fork accepts. These carry
// data no text summary can reconstruct, so a flatten must move them, never drop
// them.
const MEDIA_BLOCK_TYPES = new Set([
  "image", "image_url", "input_image",
  "audio", "audio_url", "input_audio",
  "video", "video_url", "input_video",
  "file", "document", "input_file",
]);

function isMediaBlock(block) {
  return !!block && typeof block === "object" && MEDIA_BLOCK_TYPES.has(block.type);
}

function flattenToolHistory(messages) {
  return messages
    .filter((msg) => msg)
    .map((msg) => {
      if (msg.role === "tool" || msg.role === "function") {
        const summary = `${TOOL_RESULT_PREFIX}${extractTextContent(msg.content) || String(msg.content ?? "")}]`;
        // Same rule as the array branch below: a tool result carrying a
        // screenshot must not lose it to the text summary.
        const media = Array.isArray(msg.content) ? msg.content.filter(isMediaBlock) : [];
        if (media.length === 0) return { role: "user", content: summary };
        return { role: "user", content: [{ type: "text", text: summary }, ...media] };
      }
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        const { tool_calls, ...rest } = msg;
        const names = tool_calls.map((c) => c?.function?.name || c?.name || "tool").join(", ");
        const base = extractTextContent(rest.content) || (typeof rest.content === "string" ? rest.content : "");
        return { ...rest, content: `${base}${base ? "\n" : ""}${TOOL_CALL_PREFIX}${names}]` };
      }
      if (Array.isArray(msg.content)) {
        const hasToolUse = msg.content.some((c) => c.type === "tool_use");
        const hasToolResult = msg.content.some((c) => c.type === "tool_result");
        if (hasToolUse || hasToolResult) {
          const textParts = [];
          const toolNames = [];
          const toolResults = [];
          // Media blocks sharing a message with a tool block must survive the
          // flatten. Collapsing the whole array to a string dropped them, so a
          // fusion panel could not see an image whenever it arrived alongside a
          // tool_result — the normal shape in an agentic session, which is why
          // the loss looked intermittent rather than total.
          const mediaParts = [];
          for (const block of msg.content) {
            if (block.type === "text" && block.text) textParts.push(block.text);
            else if (block.type === "tool_use") toolNames.push(block.name || "tool");
            else if (block.type === "tool_result") {
              toolResults.push(extractTextContent(block.content) || String(block.content ?? ""));
              // A tool_result may itself carry media (a screenshot from a browser
              // tool). Its text is summarized above; carry the media through.
              if (Array.isArray(block.content)) {
                for (const inner of block.content) if (isMediaBlock(inner)) mediaParts.push(inner);
              }
            } else if (isMediaBlock(block)) mediaParts.push(block);
          }
          const { ...rest } = msg;
          let newContent = textParts.join("\n");
          if (toolNames.length > 0) {
            newContent = `${newContent}${newContent ? "\n" : ""}${TOOL_CALL_PREFIX}${toolNames.join(", ")}]`;
          }
          if (toolResults.length > 0) {
            newContent = `${newContent}${newContent ? "\n" : ""}${TOOL_RESULT_PREFIX}${toolResults.join("\n")}]`;
          }
          // Keep a plain string when nothing but text survived, so the pure-text
          // path is byte-identical to before.
          if (mediaParts.length === 0) return { ...rest, content: newContent };
          const blocks = newContent ? [{ type: "text", text: newContent }] : [];
          return { ...rest, content: [...blocks, ...mediaParts] };
        }
      }
      return msg;
    });
}

const CONTINUE_TURN_TEXT = "Continue from where the previous assistant message left off.";

// Roles that cannot end a synthesized panel request. Anthropic rejects a
// trailing assistant turn ("assistant message prefill"), Gemini rejects a
// trailing model turn ("Requests ending with a model turn are not supported"),
// and several OpenAI-compatible upstreams require the last message to be a user
// turn outright ("The last message must have role=user"), which a trailing
// system turn also violates.
const NON_TERMINAL_ROLES = new Set(["assistant", "model", "system", "developer"]);

// Close any such trailing turn with a user turn, matching the shape of the array
// it is appended to: Gemini-native turns carry `parts`, every other client format
// carries `content`.
function ensureTrailingUserTurn(messages) {
  const last = messages[messages.length - 1];
  if (!last || !NON_TERMINAL_ROLES.has(last.role)) return messages;
  const turn = Array.isArray(last.parts)
    ? { role: "user", parts: [{ text: CONTINUE_TURN_TEXT }] }
    : { role: "user", content: CONTINUE_TURN_TEXT };
  return [...messages, turn];
}

// Reorder combo models by capability fit. Stable; never drops a model (fallback intact).
// Tier 0: satisfies all hard + all soft. Tier 1: all hard only. Tier 2: rest.
export function reorderByCapabilities(models, required) {
  if (!required || required.size === 0 || !Array.isArray(models) || models.length <= 1) return models;
  const hard = [...required].filter((c) => HARD_CAPS.has(c));
  const soft = [...required].filter((c) => !HARD_CAPS.has(c));

  const tierOf = (m) => {
    const slash = typeof m === "string" ? m.indexOf("/") : -1;
    const provider = slash > 0 ? m.slice(0, slash) : "";
    const model = slash > 0 ? m.slice(slash + 1) : m;
    const caps = getCapabilitiesForModel(provider, model);
    if (!hard.every((c) => caps[c] === true)) return 2;
    return soft.every((c) => caps[c] === true) ? 0 : 1;
  };

  // Stable sort by tier (Array.prototype.sort is stable in modern engines).
  return models
    .map((m, i) => ({ m, i, t: tierOf(m) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.m);
}

// Estimate the size of the WHOLE request (not just the current turn -- unlike
// detectRequiredCapabilities below, a context-window fit check needs the full
// conversation, since that is what actually gets sent upstream) using the same
// rough chars/token estimator the memory compactor already ships (#1089).
function estimateRequestContextTokens(body) {
  if (!body || typeof body !== "object") return 0;
  const items = Array.isArray(body.messages) ? body.messages
    : Array.isArray(body.input) ? body.input
    : Array.isArray(body.contents) ? body.contents
    : Array.isArray(body.request?.contents) ? body.request.contents
    : null;
  if (!items) return 0;
  return estimateTokenCount(items);
}

// Tier combo/fallback models by whether their declared context window can
// plausibly fit the estimated request size (#1089). Never drops a model: a
// request too big for every candidate still needs one tried, and the existing
// isContextOrModelLimitation fallback further down (triggered by the
// provider's own "context_length"/"too many tokens" rejection) still catches
// that failure and moves on, exactly as before this reorder existed. Stable,
// so within a tier the incoming (round-robin / capability) order survives.
export function reorderByContextFit(models, requiredTokens) {
  if (!requiredTokens || requiredTokens <= 0 || !Array.isArray(models) || models.length <= 1) return models;
  const fits = (m) => {
    const slash = typeof m === "string" ? m.indexOf("/") : -1;
    const provider = slash > 0 ? m.slice(0, slash) : "";
    const model = slash > 0 ? m.slice(slash + 1) : m;
    const { contextWindow } = getCapabilitiesForModel(provider, model);
    return (contextWindow || 0) >= requiredTokens;
  };
  return models
    .map((m, i) => ({ m, i, t: fits(m) ? 0 : 1 }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.m);
}

/**
 * Track rotation state per combo (for round-robin strategy)
 * @type {Map<string, { index: number, consecutiveUseCount: number }>}
 */
const comboRotationState = new Map();

// Trailing run of items after the last assistant/model turn = the current user
// turn. It may span several messages (e.g. text + image split across blocks),
// so we return all of them. History media (older turns) must not pin the combo
// to a vision model — those get stripped + placeholdered downstream instead.
function trailingUserItems(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const isAssistant = (r) => r === "assistant" || r === "model";
  let i = arr.length - 1;
  while (i >= 0 && !isAssistant(arr[i]?.role)) i--;
  return arr.slice(i + 1);
}

// Detect which capabilities a request needs. Modalities (vision/pdf) are scanned
// only on the current user turn; "search" is request-wide (lives in tools).
// Returns a Set of: "vision" | "pdf" | "search".
export function detectRequiredCapabilities(body) {
  const required = new Set();
  if (!body || typeof body !== "object") return required;

  const addByMime = (mime) => {
    if (typeof mime !== "string") return;
    if (mime.startsWith("image/")) required.add("vision");
    else if (mime === "application/pdf") required.add("pdf");
    else if (mime.startsWith("audio/")) required.add("audioInput");
    else if (mime.startsWith("video/")) required.add("videoInput");
  };

  const scanBlock = (b) => {
    if (!b || typeof b !== "object") return;
    const t = b.type;
    if (t === "image_url" || t === "image" || t === "input_image") required.add("vision");
    if (t === "input_audio" || t === "audio_url" || t === "audio") required.add("audioInput");
    if (t === "input_video" || t === "video_url" || t === "video") required.add("videoInput");
    if (t === "file" || t === "document" || t === "input_file") {
      // Infer modality from embedded mime when available; fall back to pdf for generic files.
      let fmime = null;
      if (b.input_audio?.format) fmime = `audio/${b.input_audio.format}`;
      else if (b.file?.file_data) fmime = String(b.file.file_data).match(/^data:([^;,]+)/)?.[1];
      else if (b.source?.media_type) fmime = b.source.media_type;
      else if (b.source?.data) fmime = String(b.source.data).match(/^data:([^;,]+)/)?.[1];
      if (fmime) addByMime(fmime);
      else required.add("pdf");
    }
    // gemini parts: inlineData/fileData carry a mime
    addByMime(b.inlineData?.mimeType || b.fileData?.mimeType);
  };

  const scanContent = (content) => {
    if (Array.isArray(content)) for (const b of content) scanBlock(b);
  };

  const scanMessage = (m) => {
    if (!m || typeof m !== "object") return;

    // Ollama / Hermes images array (strings or objects)
    if (Array.isArray(m.images) && m.images.length > 0) {
      required.add("vision");
    }

    // Vercel AI SDK / Hermes attachments / experimental_attachments
    const attachments = m.experimental_attachments || m.attachments;
    if (Array.isArray(attachments)) {
      for (const att of attachments) {
        if (!att) continue;
        const mime = att.contentType || att.mediaType || (typeof att.url === "string" && att.url.match(/^data:([^;,]+)/)?.[1]);
        if (mime) addByMime(mime);
        else if (att.url || att.data) required.add("vision");
      }
    }

    // Direct message-level modality properties
    if (m.image_url || m.image) required.add("vision");
    if (m.audio_url || m.audio) required.add("audioInput");

    // Scan array content blocks
    scanContent(m.content);

    // Scan string content for embedded data URIs
    if (typeof m.content === "string") {
      if (m.content.includes("data:image/")) required.add("vision");
      else if (m.content.includes("data:audio/")) required.add("audioInput");
      else if (m.content.includes("data:application/pdf")) required.add("pdf");
    }
  };

  // Modalities: current user turn only (trailing user run across each known shape).
  for (const m of trailingUserItems(body.messages)) scanMessage(m);              // openai / claude / hermes / ollama
  for (const it of trailingUserItems(body.input)) scanContent(it.content);       // responses
  const contents = body.contents || body.request?.contents;                      // gemini / antigravity
  for (const c of trailingUserItems(contents)) scanContent(c.parts);

  // search: temporarily disabled in auto-switch (feature not wired yet).

  return required;
}

function normalizeStickyLimit(stickyLimit) {
  const parsed = Number.parseInt(stickyLimit, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function rotateModelsFromIndex(models, currentIndex) {
  const rotatedModels = [...models];
  for (let i = 0; i < currentIndex; i++) {
    const moved = rotatedModels.shift();
    rotatedModels.push(moved);
  }
  return rotatedModels;
}

/**
 * Get rotated model list based on strategy
 * @param {string[]} models - Array of model strings
 * @param {string} comboName - Name of the combo
 * @param {string} strategy - "fallback" or "round-robin"
 * @param {number|string} [stickyLimit=1] - Requests per combo model before switching
 * @returns {string[]} Rotated models array
 */
export function getRotatedModels(models, comboName, strategy, stickyLimit = 1) {
  if (!models || models.length <= 1 || strategy !== "round-robin") {
    return models;
  }

  const rotationKey = comboName || "__default__";
  const normalizedStickyLimit = normalizeStickyLimit(stickyLimit);
  const existingState = comboRotationState.get(rotationKey);
  const state = typeof existingState === "number"
    ? { index: existingState, consecutiveUseCount: 0 }
    : (existingState || { index: 0, consecutiveUseCount: 0 });

  const currentIndex = state.index % models.length;
  const rotatedModels = rotateModelsFromIndex(models, currentIndex);
  const nextUseCount = state.consecutiveUseCount + 1;

  if (nextUseCount >= normalizedStickyLimit) {
    comboRotationState.set(rotationKey, {
      index: (currentIndex + 1) % models.length,
      consecutiveUseCount: 0,
    });
  } else {
    comboRotationState.set(rotationKey, {
      index: currentIndex,
      consecutiveUseCount: nextUseCount,
    });
  }

  return rotatedModels;
}

/**
 * Same order getRotatedModels would return, WITHOUT touching the rotation
 * cursor. For diagnostics only (the combo Test button): getRotatedModels writes
 * comboRotationState on every call, so asking it what the order IS also moves
 * the order live traffic gets next. One combo tested = one cursor advance
 * today; a batch test across every combo shifts every round-robin combo at
 * once (#3404).
 * @param {string[]} models - Array of model strings
 * @param {string} comboName - Name of the combo
 * @param {string} strategy - "fallback" or "round-robin"
 * @returns {string[]} Rotated models array
 */
export function peekRotatedModels(models, comboName, strategy) {
  if (!models || models.length <= 1 || strategy !== "round-robin") return models;
  const state = comboRotationState.get(comboName || "__default__");
  const index = typeof state === "number" ? state : (state?.index || 0);
  return rotateModelsFromIndex(models, index % models.length);
}

function advanceRotationAfterSuccessfulFallback(models, comboName, strategy, servedModelIndex) {
  if (!models || models.length <= 1 || strategy !== "round-robin") return;
  if (!Number.isInteger(servedModelIndex) || servedModelIndex < 0 || servedModelIndex >= models.length) return;

  comboRotationState.set(comboName || "__default__", {
    index: (servedModelIndex + 1) % models.length,
    consecutiveUseCount: 0,
  });
}

function withComboTrackingHeaders(response, modelStr, body = response.body) {
  const headers = new Headers(response.headers);
  headers.set("x-tokenproxy-combo", "true");
  if (modelStr) headers.set("x-tokenproxy-model", modelStr);
  else headers.delete("x-tokenproxy-model");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Apply a pre-computed model order to entries carrying { modelStr, originalIndex },
// preserving each duplicate modelStr's own entries in original relative order.
function reorderEntries(entries, reorderedModels) {
  const entriesByModel = new Map();

  for (const entry of entries) {
    const matchingEntries = entriesByModel.get(entry.modelStr) || [];
    matchingEntries.push(entry);
    entriesByModel.set(entry.modelStr, matchingEntries);
  }

  return reorderedModels.map((modelStr) => entriesByModel.get(modelStr).shift());
}

function reorderModelEntriesByCapabilities(entries, required) {
  const reorderedModels = reorderByCapabilities(entries.map(({ modelStr }) => modelStr), required);
  return reorderEntries(entries, reorderedModels);
}

// (#1089) Same shape as reorderModelEntriesByCapabilities, keyed on context fit
// instead of modality capabilities.
function reorderEntriesByContextFit(entries, requiredTokens) {
  const reorderedModels = reorderByContextFit(entries.map(({ modelStr }) => modelStr), requiredTokens);
  return reorderEntries(entries, reorderedModels);
}

/**
 * Reset in-memory rotation state when combo/settings change
 * @param {string} [comboName] - Combo name to reset; omit to clear all
 */
export function resetComboRotation(comboName) {
  if (comboName) comboRotationState.delete(comboName);
  else comboRotationState.clear();
}

// Token-saver flags a combo may override, keyed by the short name stored in the
// combo bag and mapped to the parameter name handleChatCore takes. The schema
// distiller is combo-wired like the others. Anything not listed here (privacy
// filter, tool disclosure, memory pruning) stays global.
const COMBO_TOKEN_SAVER_KEYS = Object.freeze({
  rtk: "rtkEnabled",
  schema: "schemaDistillEnabled",
  headroom: "headroomEnabled",
  caveman: "cavemanEnabled",
  ponytail: "ponytailEnabled",
  pxpipe: "pxpipeEnabled",
  thinking: "thinkingStripEnabled",
  qac: "queryAwareCompressionEnabled",
  pairs: "pairDropEnabled",
  reorder: "embedReorderEnabled",
  midinject: "midPrefixInjectEnabled",
  epochMicro: "epochMicroEnabled",
  epochAuto: "epochAutoEnabled",
});

// Read the override off the bag settings already keeps per combo
// (settings.comboStrategies[name], which carries fallbackStrategy / judgeModel /
// fusionTuning today), so storage needs no schema change and no migration.
//
// `chain` is the combo names being expanded, outermost first — the cycle-guard
// Set the chat handler already threads through nested combos. The outermost
// declaration wins: it is the name the client asked for and the one the operator
// configured against, so a member combo cannot silently override the entry
// point's choice.
function findComboTokenSaverOverride(comboChain, settings) {
  const bag = settings?.comboStrategies;
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) return null;
  const names = typeof comboChain === "string"
    ? [comboChain]
    : comboChain && typeof comboChain[Symbol.iterator] === "function"
      ? [...comboChain]
      : [];
  for (const name of names) {
    // Combo names are user-supplied and "constructor" passes the name regex, so
    // an inherited property must not read as a configured override.
    if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(bag, name)) continue;
    const entry = bag[name];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const tokenSaver = entry.tokenSaver;
    // Shorthand: `tokenSaver: false` is the whole request in #2037's second form.
    if (typeof tokenSaver === "boolean") return { enabled: tokenSaver };
    if (tokenSaver && typeof tokenSaver === "object" && !Array.isArray(tokenSaver)) return tokenSaver;
  }
  return null;
}

/**
 * Resolve the token-saver flags for one request (#2037, #2289).
 *
 * Token saving is beneficial for a coding combo and harmful for a translation
 * or creative-writing one, and until now the flags were global, so enabling it
 * for the first rewrote prompts for the second. A combo may now declare its own
 * settings in settings.comboStrategies[<name>].tokenSaver:
 *
 *   { enabled?: boolean, rtk?: boolean, headroom?: boolean,
 *     caveman?: boolean, ponytail?: boolean, pxpipe?: boolean,
 *     schema?: boolean, thinking?: boolean, qac?: boolean,
 *     pairs?: boolean, reorder?: boolean, midinject?: boolean,
 *     epochMicro?: boolean, epochAuto?: boolean }
 *
 * `enabled` is the same kind of master gate chatCore's own tokenSaverEnabled is:
 * false forces every saver off for this combo, true (the default) leaves the
 * individual flags to decide. A per-saver key overrides its global flag in
 * either direction and outranks `enabled`.
 *
 * A combo that declares nothing returns the global flags unchanged, so an
 * install that never configures one behaves exactly as it does today.
 *
 * @param {Set<string>|string[]|string|null} comboChain - combo names, outermost first
 * @param {Object} settings - the global settings object
 * @returns {{rtkEnabled: boolean, schemaDistillEnabled: boolean, headroomEnabled: boolean, cavemanEnabled: boolean, ponytailEnabled: boolean, pxpipeEnabled: boolean, epochMicroEnabled: boolean, epochAutoEnabled: boolean}}
 */
export function resolveComboTokenSaver(comboChain, settings) {
  const flags = Object.values(COMBO_TOKEN_SAVER_KEYS);
  const resolved = {};
  for (const flag of flags) resolved[flag] = !!settings?.[flag];

  const override = findComboTokenSaverOverride(comboChain, settings);
  if (!override) return resolved;

  if (override.enabled === false) for (const flag of flags) resolved[flag] = false;
  for (const [key, flag] of Object.entries(COMBO_TOKEN_SAVER_KEYS)) {
    if (typeof override[key] === "boolean") resolved[flag] = override[key];
  }
  return resolved;
}

/**
 * Resolve the account a combo pins one of its members to (#1477).
 *
 * Not every account of a provider is equivalent: a user may hold a paid
 * subscription and a free one, and a combo built to try the free tier first
 * cannot express that when account selection is provider-wide. A combo may now
 * name a connection per member in the same settings bag as its other
 * per-combo choices:
 *
 *   settings.comboStrategies[<combo>].memberConnections = { "<provider/model>": "<connectionId>" }
 *
 * The pin is STRICT by design. A user who names an account has chosen it, so
 * falling back to a different one silently would spend the wrong subscription;
 * when that account is unavailable the member fails and the combo advances to
 * the next member, which is what a combo is for.
 *
 * Returns null when nothing is pinned, so a request outside a combo and a combo
 * that names no account both behave exactly as they do today.
 *
 * @param {Set<string>|string[]|string|null} comboChain - combo names, outermost first
 * @param {string} modelStr - the member being attempted, as stored in the combo
 * @param {Object} settings - the global settings object
 * @returns {string|null} the connection id to pin, or null
 */
export function resolveComboMemberConnection(comboChain, modelStr, settings) {
  if (typeof modelStr !== "string" || !modelStr) return null;
  const bag = settings?.comboStrategies;
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) return null;
  const names = typeof comboChain === "string"
    ? [comboChain]
    : comboChain && typeof comboChain[Symbol.iterator] === "function"
      ? [...comboChain]
      : [];
  for (const name of names) {
    // Same guard as the token-saver lookup: a combo name is user-supplied and
    // an inherited property must not read as a configured pin.
    if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(bag, name)) continue;
    const entry = bag[name];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const map = entry.memberConnections;
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    if (!Object.prototype.hasOwnProperty.call(map, modelStr)) continue;
    const id = map[modelStr];
    if (typeof id === "string" && id) return id;
  }
  return null;
}

function normalizeCombosData(combosData) {
  return Array.isArray(combosData) ? combosData : (combosData?.combos || []);
}

function buildComboMap(combosData) {
  return new Map(
    normalizeCombosData(combosData)
      .filter((combo) => typeof combo?.name === "string" && combo.name)
      .map((combo) => [combo.name, combo]),
  );
}

function resolveComboReference(modelStr, comboMap) {
  if (typeof modelStr !== "string") return null;
  const direct = comboMap.get(modelStr);
  if (direct) return direct;
  const baseName = modelStr.includes("/") ? modelStr.split("/").pop() : null;
  return baseName ? comboMap.get(baseName) || null : null;
}

export function findComboCycle(combosData, startName = null) {
  const comboMap = buildComboMap(combosData);
  const visited = new Set();

  const visit = (name, path) => {
    const existingIndex = path.indexOf(name);
    if (existingIndex !== -1) return [...path.slice(existingIndex), name];
    if (visited.has(name)) return null;

    const combo = comboMap.get(name);
    if (!combo) return null;

    const nextPath = [...path, name];
    for (const model of Array.isArray(combo.models) ? combo.models : []) {
      const nextCombo = resolveComboReference(model, comboMap);
      if (!nextCombo) continue;
      const cycle = visit(nextCombo.name, nextPath);
      if (cycle) return cycle;
    }

    visited.add(name);
    return null;
  };

  if (startName) return visit(startName, []);
  for (const name of comboMap.keys()) {
    const cycle = visit(name, []);
    if (cycle) return cycle;
  }
  return null;
}

export function validateComboAcyclic({ name, models = [], combosData = [], currentId = null } = {}) {
  const comboName = typeof name === "string" ? name : "";
  if (!comboName) return { valid: false, error: "Combo name is required" };

  const candidate = {
    id: currentId || "__pending_combo__",
    name: comboName,
    models: Array.isArray(models) ? models : [],
  };
  const nextCombos = normalizeCombosData(combosData)
    .filter((combo) => combo && combo.id !== currentId && combo.name !== comboName)
    .concat(candidate);
  const cycle = findComboCycle(nextCombos, comboName);

  return cycle
    ? { valid: false, error: `Combo circular dependency detected: ${cycle.join(" -> ")}` }
    : { valid: true, error: null };
}

/**
 * Get combo models from combos data
 * @param {string} modelStr - Model string to check
 * @param {Array|Object} combosData - Array of combos or object with combos
 * @returns {string[]|null} Array of models or null if not a combo
 */
export function getComboModelsFromData(modelStr, combosData) {
  // Resolve combo by full name first, then by basename (part after the last
  // slash) so client configs like `provider/combo-name` still hit the combo
  // instead of forwarding the raw string to the upstream provider.
  const combo = resolveComboReference(modelStr, buildComboMap(combosData));
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}

/**
 * Handle combo chat with fallback
 * @param {Object} options
 * @param {Object} options.body - Request body
 * @param {string[]} options.models - Array of model strings to try
 * @param {Function} options.handleSingleModel - Function to handle single model: (body, modelStr) => Promise<Response>
 * @param {Object} options.log - Logger object
 * @param {string} [options.comboName] - Name of the combo (for round-robin tracking)
 * @param {string} [options.comboStrategy] - Strategy: "fallback" or "round-robin"
 * @param {number|string} [options.comboStickyLimit=1] - Requests per combo model before switching
 * @returns {Promise<Response>}
 */
// Each sequential or concurrent combo dispatch starts from the original body.
// The chat coordinator and core also isolate their own nested request data.
// Direct callers may attach non-cloneable handles; the core preserves those
// handles while copying their surrounding JSON containers.
function bodyForAttempt(body) {
  try {
    return structuredClone(body);
  } catch {
    return body;
  }
}

export async function handleComboChat({ body, models, handleSingleModel, log, comboName, comboStrategy, comboStickyLimit = 1, autoSwitch = true }) {
  // Apply rotation strategy if enabled
  let rotatedModels = getRotatedModels(
    models.map((modelStr, originalIndex) => ({ modelStr, originalIndex })),
    comboName,
    comboStrategy,
    comboStickyLimit,
  );

  // Auto-switch: float models that satisfy the request's required capabilities to the front.
  if (autoSwitch) {
    // Context-aware rotation runs first so it only breaks ties within a
    // capability tier (stable sort) -- a hard modality requirement (vision/pdf/
    // ...) still wins over context fit, matching how reorderByCapabilities
    // itself prioritizes hard over soft (#1089).
    const requiredContextTokens = estimateRequestContextTokens(body);
    if (requiredContextTokens > 0) {
      rotatedModels = reorderEntriesByContextFit(rotatedModels, requiredContextTokens);
    }

    const required = detectRequiredCapabilities(body);
    if (required.size > 0) {
      const reordered = reorderModelEntriesByCapabilities(rotatedModels, required);
      if (reordered[0].modelStr !== rotatedModels[0].modelStr) {
        log.info("COMBO", `auto-switch for [${[...required].join(",")}] → ${reordered[0].modelStr}`);
      }
      rotatedModels = reordered;
    }
  }
  
  let lastError = null;
  let earliestRetryAfter = null;
  let lastStatus = null;
  const retryAttempts = new Map();

  for (let i = 0; i < rotatedModels.length; i++) {
    const { modelStr, originalIndex } = rotatedModels[i];
    log.info("COMBO", `Trying model ${i + 1}/${rotatedModels.length}: ${modelStr}`);

    try {
      const result = await handleSingleModel(bodyForAttempt(body), modelStr);
      if (result.headers.get("x-tokenproxy-replay-safe") === "false") {
        const terminal = withComboTrackingHeaders(result, modelStr);
        if (!terminal.headers.has("x-should-retry")) terminal.headers.set("x-should-retry", "false");
        return terminal;
      }
      
      // An accepted request can still be billable when its stream has no
      // usable answer. Inspect it without dispatching a replacement generation.
      if (result.ok) {
        const { hasContent, body: replayBody, upstreamError } = await peekStreamForContent(result);
        if (hasContent) {
          log.info("COMBO", `Model ${modelStr} succeeded`);
          if (i > 0) {
            advanceRotationAfterSuccessfulFallback(models, comboName, comboStrategy, originalIndex);
          }
          return withComboTrackingHeaders(result, modelStr, replayBody || result.body);
        }

        // Preserve a typed upstream error instead of obscuring its cause with
        // the empty-stream diagnosis. Neither outcome authorizes regeneration.
        const response = errorResponse(upstreamError?.status || 502,
          upstreamError?.reason || "Provider accepted the request but returned no usable content");
        response.headers.set("x-tokenproxy-replay-safe", "false");
        response.headers.set("x-should-retry", "false");
        return withComboTrackingHeaders(response, modelStr);
      }

      // A caller abort is terminal, not a model result. Preserve its exact
      // response so outer abort handling cannot mistake it for a served combo.
      if (result.status === 499) return result;
      if (result.headers.get("x-tokenproxy-replay-safe") !== "true") {
        const terminal = withComboTrackingHeaders(result, modelStr);
        terminal.headers.set("x-should-retry", "false");
        return terminal;
      }

      // Extract error info from response
      let errorText = result.statusText || "";
      let retryAfter = null;
      try {
        const errorBody = await result.clone().json();
        errorText = errorBody?.error?.message || errorBody?.error || errorBody?.message || errorText;
        retryAfter = errorBody?.retryAfter || null;
      } catch {
        // Ignore JSON parse errors
      }

      // Track earliest retryAfter across all combo models
      if (retryAfter && (!earliestRetryAfter || new Date(retryAfter) < new Date(earliestRetryAfter))) {
        earliestRetryAfter = retryAfter;
      }

      // Normalize error text to string (Worker-safe)
      if (typeof errorText !== "string") {
        try { errorText = JSON.stringify(errorText); } catch { errorText = String(errorText); }
      }

      // Check if should fallback to next model. Model-specific context length / max_tokens
      // limits must not abort the combo — allow fallback to models with larger context.
      const lowerErr = errorText.toLowerCase();
      // A model the provider does not serve belongs here too. checkFallbackError
      // marks model_not_found `pass: true` so the ACCOUNT is not locked for a
      // user-side model name (#2032), which is right for account rotation and
      // wrong for a combo: trying the next MODEL is the entire purpose of one.
      // Without this the combo aborted on the first member with a bad id and
      // never reached the working ones (#1946).
      //
      // Matched on the structured code and the exact phrase only. A bare
      // "does not exist" is deliberately not matched, for the same reason #2032
      // refused it: it is generic enough to turn a real account failure into a
      // silent walk through every member.
      const isContextOrModelLimitation = lowerErr.includes("max_tokens") ||
        lowerErr.includes("context_length") ||
        lowerErr.includes("context length") ||
        lowerErr.includes("prompt is too long") ||
        lowerErr.includes("too many tokens") ||
        lowerErr.includes("exceeds the limit") ||
        lowerErr.includes("not supported") ||
        lowerErr.includes("model_not_found") ||
        lowerErr.includes("model not found");

      const { shouldFallback, cooldownMs } = checkFallbackError(result.status, errorText);

      if (!shouldFallback && !isContextOrModelLimitation) {
        log.warn("COMBO", `Model ${modelStr} failed (no fallback)`, { status: result.status });
        return withComboTrackingHeaders(result, modelStr);
      }

      // Waiting out the cooldown and then advancing anyway spent the delay and
      // still left the member, so a chain whose first entry was briefly
      // overloaded fell onto one that may have no credentials at all (#337).
      // Retry the SAME member while the wait is short and the budget holds; a
      // long Retry-After or a spent budget falls through as before.
      //
      // Only on a delay the provider actually stated: checkFallbackError answers
      // TRANSIENT_COOLDOWN_MS for anything it could not classify, and that is a
      // placeholder, not retry info. Sleeping on it would park the chain for
      // seconds per member on the strength of a guess.
      const classifiedDelayMs = cooldownMs === TRANSIENT_COOLDOWN_MS ? null : cooldownMs;
      const retryDelayMs = retryAfterDelayMs(result) ?? classifiedDelayMs;
      const attempts = retryAttempts.get(i) || 0;
      if (COMBO_RETRY_STATUSES.has(result.status) && attempts < COMBO_RETRY_MAX_ATTEMPTS &&
          retryDelayMs !== null && retryDelayMs > 0 && retryDelayMs <= COMBO_RETRY_MAX_DELAY_MS) {
        retryAttempts.set(i, attempts + 1);
        log.info("COMBO", `Model ${modelStr} transient ${result.status}, retry ${attempts + 1}/${COMBO_RETRY_MAX_ATTEMPTS} in ${retryDelayMs}ms`);
        await new Promise(r => setTimeout(r, retryDelayMs));
        i--;
        continue;
      }

      // Fallback to next model
      lastError = errorText || String(result.status);
      if (!lastStatus) lastStatus = result.status;
      log.warn("COMBO", `Model ${modelStr} failed, trying next`, { status: result.status });
    } catch (error) {
      const response = errorResponse(502, error.message || "Provider attempt failed with an uncertain outcome");
      response.headers.set("x-tokenproxy-replay-safe", "false");
      response.headers.set("x-should-retry", "false");
      return withComboTrackingHeaders(response);
    }
  }

  // All models failed
  // Use 503 (Service Unavailable) rather than 406 (Not Acceptable) — 406 implies
  // the request itself is invalid, but here the providers are simply unavailable
  // or have no active credentials. 503 is more accurate and retryable by clients.
  const allDisabled = lastError && lastError.toLowerCase().includes("no credentials");
  const status = allDisabled ? 503 : (lastStatus || 503);
  const msg = lastError || "All combo models unavailable";

  if (earliestRetryAfter) {
    const retryHuman = formatRetryAfter(earliestRetryAfter);
    log.warn("COMBO", `All models failed | ${msg} (${retryHuman})`);
    return withComboTrackingHeaders(unavailableResponse(status, msg, earliestRetryAfter, retryHuman));
  }

  log.warn("COMBO", `All models failed | ${msg}`);
  return new Response(
    JSON.stringify({ error: { message: msg } }),
    { status, headers: { "Content-Type": "application/json", "x-tokenproxy-combo": "true" } }
  );
}

/**
 * Extract assistant text from a non-stream completion across formats
 * (OpenAI chat, Claude messages, Gemini, OpenAI Responses). Returns "" if none.
 * Panel responses are already translated to the client format by chatCore, so the
 * leaf content→string step reuses the translator's own extractTextContent.
 */
export function extractPanelText(json) {
  if (!json || typeof json !== "object") return "";

  // OpenAI chat completion
  const choice = json.choices?.[0];
  if (choice) {
    const msg = choice.message ?? choice.delta ?? {};
    const t = extractTextContent(msg.content);
    if (t.trim()) return t;
    if (typeof choice.text === "string" && choice.text.trim()) return choice.text;
  }

  // Claude messages (text blocks share OpenAI's {type:"text"} shape)
  const claudeText = extractTextContent(json.content);
  if (claudeText.trim()) return claudeText;

  // Gemini (parts carry .text without a type discriminator)
  const parts = json.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const t = parts.map((p) => p?.text || "").join("");
    if (t.trim()) return t;
  }

  // OpenAI Responses API
  if (Array.isArray(json.output)) {
    const t = json.output
      .flatMap((o) => (Array.isArray(o.content) ? o.content.map((c) => c?.text || "") : []))
      .join("");
    if (t.trim()) return t;
  }

  return "";
}

/**
 * Append a synthesized user turn to whichever message array the request format uses.
 * Preserves the original conversation + system prompt so the judge has full context.
 */
function appendUserTurn(body, text) {
  const next = { ...body };
  if (Array.isArray(body.messages)) {
    next.messages = [...body.messages, { role: "user", content: text }];
  } else if (Array.isArray(body.input)) {
    next.input = [...body.input, { role: "user", content: text }];
  } else if (Array.isArray(body.contents)) {
    next.contents = [...body.contents, { role: "user", parts: [{ text }] }];
  } else {
    next.messages = [{ role: "user", content: text }];
  }
  return next;
}

/**
 * Build the judge directive. Per OpenRouter's Fusion design, the judge does NOT
 * merge — it analyzes (consensus / contradictions / partial coverage / unique
 * insights / blind spots) then writes one answer grounded in that analysis.
 * ~3/4 of fusion's quality lift comes from this synthesis step.
 *
 * Sources are anonymized ("Source N") so the judge weighs substance, not the
 * reputation of a model brand.
 */
function buildJudgePrompt(answers) {
  const panel = answers
    .map((a, i) => `[Source ${i + 1}]\n${a.text}`)
    .join("\n\n");

  return [
    `You are the JUDGE in a model-fusion panel. ${answers.length} expert models independently answered the user's most recent request. Their responses are below, anonymized by source.`,
    "",
    "Do NOT mention that multiple models were used, and do NOT refer to the sources. Produce ONE authoritative final answer addressed directly to the user.",
    "",
    "First, internally analyze the panel along these dimensions: consensus (points most sources agree on — treat as higher-confidence), contradictions (where they disagree — resolve with your own judgment), partial coverage, unique insights only one source surfaced, and blind spots every source missed. Then write the best possible final answer grounded in that analysis — more complete and correct than any single response, with no filler.",
    "",
    "=== PANEL RESPONSES ===",
    panel,
    "=== END PANEL RESPONSES ===",
    "",
    "Now write the final answer to the user's original request.",
  ].join("\n");
}

// Fusion tuning. Overridable per-combo via settings.comboStrategies[name].
const FUSION_DEFAULTS = {
  minPanel: 2,             // answers needed before stragglers get a grace window
  stragglerGraceMs: 8000,  // wait this long for laggards once quorum is reached
  panelHardTimeoutMs: 90000, // absolute cap so one hung model can't stall forever
};

// Resolve a Response (or {__error}) within ms; the loser keeps running but is ignored.
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ __timeout: true }), ms);
    Promise.resolve(promise)
      .then((v) => { clearTimeout(t); resolve(v); })
      .catch((e) => { clearTimeout(t); resolve({ __error: e }); });
  });
}

/**
 * Collect panel responses with quorum-grace: as soon as `minPanel` calls succeed,
 * start a short grace timer for the rest, then proceed with whatever arrived. This
 * caps the straggler penalty (the slowest model otherwise dominates wall time) while
 * still preferring a full panel when everyone is fast. Bounded by a hard timeout.
 * Returns a sparse array aligned to `calls` (undefined = not yet / dropped).
 */
function collectPanel(calls, { minPanel, stragglerGraceMs, panelHardTimeoutMs }) {
  return new Promise((resolve) => {
    const out = new Array(calls.length);
    let settled = 0;
    let ok = 0;
    let finished = false;
    let graceTimer = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(hardTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve(out);
    };
    const hardTimer = setTimeout(finish, panelHardTimeoutMs);
    calls.forEach((p, i) => {
      Promise.resolve(p)
        .then((v) => { out[i] = v; })
        .catch((e) => { out[i] = { __error: e }; })
        .finally(() => {
          settled++;
          if (out[i] && out[i].ok) ok++;
          if (settled === calls.length) return finish();
          if (ok >= minPanel && !graceTimer) graceTimer = setTimeout(finish, stragglerGraceMs);
        });
    });
  });
}

/**
 * Handle a fusion combo: fan the prompt out to every panel model in parallel,
 * then a judge model synthesizes one final answer from all panel responses.
 *
 * Panel calls are forced non-streaming with tools stripped (the judge needs
 * complete prose to synthesize). The judge call keeps the client's original
 * stream flag + tools, so streaming and downstream tool use still work.
 *
 * Speed: quorum-grace collection caps the straggler penalty. Quality: the judge
 * runs the consensus/contradiction/blind-spot analysis before writing.
 *
 * Degrades gracefully: 0 panel answers -> 503, exactly 1 -> return it directly.
 *
 * @param {Object} options
 * @param {Object} options.body - Request body (client format)
 * @param {string[]} options.models - Panel model strings
 * @param {Function} options.handleSingleModel - (body, modelStr) => Promise<Response>
 * @param {Object} options.log - Logger
 * @param {string} [options.comboName] - Combo name (logging)
 * @param {string} [options.judgeModel] - Judge model; falls back to panel[0]
 * @param {Object} [options.tuning] - Override FUSION_DEFAULTS (minPanel, grace, timeout)
 * @returns {Promise<Response>}
 */
export async function handleFusionChat({ body, models, handleSingleModel, log, comboName, judgeModel, tuning }) {
  const panel = Array.isArray(models) ? models.filter(Boolean) : [];
  if (panel.length === 0) {
    return new Response(
      JSON.stringify({ error: { message: "Fusion combo has no models" } }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // A single-model fusion has nothing to fuse — just answer directly.
  if (panel.length === 1) {
    return handleSingleModel(body, panel[0]);
  }

  const cfg = { ...FUSION_DEFAULTS, ...(tuning || {}) };
  const minPanel = Math.min(Math.max(2, cfg.minPanel), panel.length);
  const judge = judgeModel && judgeModel.trim() ? judgeModel.trim() : panel[0];
  log.info("FUSION", `Combo "${comboName}" | panel=${panel.length} [${panel.join(", ")}] | judge=${judge} | quorum=${minPanel}`);

  // 1. Fan out to the panel in parallel: non-streaming, tools stripped (we want prose).
  const { tools, tool_choice, stream_options, ...rest } = body;
  // Fusion runs panel models non-streaming; drop stream_options too, or providers
  // like DeepSeek reject it with "stream_options should be set along with stream = true".
  // See issue #3024.
  const panelBody = { ...rest, stream: false };

  // Flatten tool turns to prose so panel models keep context without emitting tool_calls.
  if (Array.isArray(panelBody.messages)) {
    panelBody.messages = ensureTrailingUserTurn(flattenToolHistory(panelBody.messages));
  } else if (Array.isArray(panelBody.input)) {
    panelBody.input = ensureTrailingUserTurn(flattenToolHistory(panelBody.input));
  } else if (Array.isArray(panelBody.contents)) {
    // Gemini-native clients carry the turns on `contents`, which neither branch
    // above reaches, so a trailing model turn survived into every panel call.
    // flattenToolHistory is a no-op on this shape (parts, not content), but it
    // stays in the chain so a future tool-flattening rule applies here too.
    panelBody.contents = ensureTrailingUserTurn(flattenToolHistory(panelBody.contents));
  }

  const t0 = Date.now();
  const calls = panel.map((m) =>
    withTimeout(handleSingleModel(bodyForAttempt(panelBody), m, true), cfg.panelHardTimeoutMs));
  const settled = await collectPanel(calls, { ...cfg, minPanel });
  log.info("FUSION", `fan-out collected in ${Date.now() - t0}ms`);

  // 2. Collect successful answers.
  const answers = [];
  for (let i = 0; i < settled.length; i++) {
    const res = settled[i];
    const model = panel[i];
    if (!res) { log.warn("FUSION", `Panel ${model} dropped (straggler/timeout)`); continue; }
    if (res.__timeout) { log.warn("FUSION", `Panel ${model} timed out`); continue; }
    if (res.__error) { log.warn("FUSION", `Panel ${model} threw`, { error: res.__error?.message || String(res.__error) }); continue; }
    if (!res.ok) { log.warn("FUSION", `Panel ${model} failed`, { status: res.status }); continue; }
    try {
      const json = await res.clone().json();
      const text = extractPanelText(json);
      if (text) {
        answers.push({ model, text });
        log.info("FUSION", `Panel ${model} ok (${text.length} chars)`);
      } else {
        log.warn("FUSION", `Panel ${model} returned empty content`);
      }
    } catch (e) {
      log.warn("FUSION", `Panel ${model} unparseable`, { error: e.message || String(e) });
    }
  }

  // 3. Degrade gracefully when the panel is too thin to fuse.
  if (answers.length === 0) {
    log.warn("FUSION", "All panel models failed");
    return new Response(
      JSON.stringify({ error: { message: "All fusion panel models failed" } }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }
  if (answers.length === 1) {
    log.info("FUSION", `Only ${answers[0].model} succeeded — answering directly (no fusion)`);
    return handleSingleModel(body, answers[0].model);
  }

  // 4. Judge analyzes + writes one final answer (streams to client if requested).
  const judgeBody = appendUserTurn(body, buildJudgePrompt(answers));
  log.info("FUSION", `Judging ${answers.length} answers with ${judge}`);
  return handleSingleModel(judgeBody, judge);
}
