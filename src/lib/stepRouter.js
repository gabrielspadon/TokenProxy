// Step-level model routing cascade: a configured strong model serves
// exploration-class steps through its cheap pair member, and escalates back
// to the strong model when the cheap dispatch hits a retryable-class error.
// Deterministic only — no learned model. Feature is inert while cascadePairs
// is empty (the default), which must stay the zero-behavior-change state.

export const CASCADE_ROUTE_KINDS = Object.freeze({
  cheap: "cascade-cheap",
  strong: "cascade-strong",
});

// Exploration ceiling: estimated prompt tokens (chars/4 on the serialized
// body) below this count as exploration-class.
export const EXPLORATION_PROMPT_TOKEN_CEILING = 64 * 1024;
export const CHARS_PER_TOKEN = 4;

// A session that escalated keeps taking the strong model for this long.
export const SESSION_PIN_TTL_MS = 30 * 60 * 1000;

// Edit/write tool names that disqualify exploration-class: they carry content
// the cheap model must not be trusted to produce.
const EDIT_WRITE_TOOL = /^(edit|write|str_replace(_editor)?)$/i;

const sessionPins = new Map(); // sid -> { pinnedAt }

function nowMs(now) {
  return Number.isFinite(now) ? now : Date.now();
}

export function normalizeModelRef(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Accept both "provider/model" (request model field format) and the
  // "provider:model" spelling operators may copy from provider docs.
  return trimmed.replace(/^([^:/]+)[:/]/, "$1/");
}

// Config lands from the settings blob unvalidated; anything malformed is
// dropped so a bad entry can never change routing.
export function normalizeCascadePairs(raw) {
  const pairs = new Map();
  if (!Array.isArray(raw)) return pairs;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const strong = normalizeModelRef(entry.strong);
    const cheap = normalizeModelRef(entry.cheap);
    if (!strong || !cheap || strong === cheap) continue;
    pairs.set(strong, cheap);
  }
  return pairs;
}

function messageBlocks(message) {
  return Array.isArray(message?.content) ? message.content : [];
}

function isToolErrorMessage(message) {
  if (!message || typeof message !== "object") return false;
  if (message.is_error === true || message.status === "error") return true;
  // Claude shape: content blocks of type tool_result carry is_error.
  return messageBlocks(message).some((block) => block && typeof block === "object"
    && block.type === "tool_result" && block.is_error === true);
}

function toolCallsOf(message) {
  const calls = [];
  // OpenAI shape: tool_calls[{ function: { name, arguments } }].
  for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
    calls.push({ name: call?.function?.name || call?.name, args: call?.function?.arguments ?? call?.arguments });
  }
  // Claude shape: content blocks of type tool_use.
  for (const block of messageBlocks(message)) {
    if (block && typeof block === "object" && block.type === "tool_use") {
      calls.push({ name: block.name, args: block.input });
    }
  }
  return calls;
}

function callCarriesContent({ name, args }) {
  if (!name) return false;
  if (EDIT_WRITE_TOOL.test(name)) return true;
  // Bash only counts when it writes via a heredoc. The command arrives as a
  // JSON string in OpenAI tool_calls.arguments and as input.command in a
  // Claude tool_use block.
  if (/^bash$/i.test(name)) {
    const command = typeof args === "string" ? args : typeof args?.command === "string" ? args.command : "";
    return command.includes("<<");
  }
  return false;
}

// Exploration-class iff ALL of: no tool_result with is_error in the last 3
// turns; the last assistant turn made no edit/write tool calls carrying
// content; estimated prompt tokens < 64K (chars/4 on the serialized body).
export function classifyExploration(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const turns = messages.filter((m) => m && m.role !== "system");
  for (const turn of turns.slice(-3)) {
    if (isToolErrorMessage(turn)) return false;
  }
  const lastAssistant = [...turns].reverse().find((m) => m.role === "assistant");
  if (lastAssistant && toolCallsOf(lastAssistant).some(callCarriesContent)) return false;
  try {
    if (JSON.stringify(body ?? {}).length / CHARS_PER_TOKEN >= EXPLORATION_PROMPT_TOKEN_CEILING) return false;
  } catch {
    return false; // unserializable body: not exploration-class
  }
  return true;
}

function sweepPins(now) {
  for (const [sid, entry] of sessionPins) {
    if (now - entry.pinnedAt >= SESSION_PIN_TTL_MS) sessionPins.delete(sid);
  }
}

export function isSessionEscalated(sid, now = Date.now()) {
  if (!sid) return false;
  const at = nowMs(now);
  sweepPins(at);
  const entry = sessionPins.get(sid);
  return !!entry && at - entry.pinnedAt < SESSION_PIN_TTL_MS;
}

export function pinEscalatedSession(sid, now = Date.now()) {
  if (!sid) return;
  const at = nowMs(now);
  sweepPins(at);
  sessionPins.set(sid, { pinnedAt: at });
}

// Test seam: the store is a module-level singleton like every other in-memory
// registry in this codebase.
export const __cascadeSessionPins = {
  size: () => sessionPins.size,
  clear: () => sessionPins.clear(),
};

// Retryable-class errors escalate cheap -> strong. 4xx (except 408/429) do
// not: the strong model would be told the same thing.
export function isRetryableCascadeStatus(status) {
  const code = Number(status);
  return code === 408 || code === 429 || (code >= 500 && code <= 599);
}

// Decide how one request dispatches. Returns one of:
//   { action: "none" }                                    — dispatch as asked
//   { action: "cheap",  cheapModel, strongModel, tag, sid } — dispatch cheap, escalate on retryable
//   { action: "strong", strongModel, tag, sid }             — pinned session goes straight strong
export function planCascade({ body, modelStr, cascadePairs, sid, now = Date.now() }) {
  const pairs = cascadePairs instanceof Map ? cascadePairs : normalizeCascadePairs(cascadePairs);
  if (pairs.size === 0 || typeof modelStr !== "string" || !modelStr.trim()) {
    return { action: "none" };
  }
  const cheapModel = pairs.get(normalizeModelRef(modelStr));
  if (!cheapModel) return { action: "none" };
  const escalated = isSessionEscalated(sid, now);
  return planCascadeFromEvidence({ modelStr, cheapModel, sid, escalated, exploration: !escalated && classifyExploration(body) });
}

/** Pure decision from already classified request facts; no session-store access. */
export function planCascadeFromEvidence({ modelStr, cheapModel, sid = null, escalated, exploration }) {
  if (!cheapModel) return { action: "none" };
  if (escalated) {
    return { action: "strong", strongModel: modelStr, tag: CASCADE_ROUTE_KINDS.strong, sid };
  }
  if (!exploration) return { action: "none" };
  return { action: "cheap", cheapModel, strongModel: modelStr, tag: CASCADE_ROUTE_KINDS.cheap, sid };
}
