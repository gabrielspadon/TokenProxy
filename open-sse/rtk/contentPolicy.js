import { jsonCompact } from "./filters/jsonCompact.js";

function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function userRequest(message) {
  if (message?.role !== "user") return null;
  const content = Array.isArray(message.content)
    ? message.content.filter((part) => part?.type !== "tool_result")
    : message.content;
  if (content == null || (Array.isArray(content) && content.length === 0)) return null;
  return { ...message, content };
}

function currentUserRequest(body) {
  const messages = body?.messages || body?.params?.messages || body?.input;
  if (typeof messages === "string") return messages;
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const request = userRequest(messages[i]);
      if (request) return request;
    }
  }
  const root = body?.request || body;
  if (Array.isArray(root?.contents)) {
    for (let i = root.contents.length - 1; i >= 0; i--) {
      const item = root.contents[i];
      const parts = item?.parts?.filter((part) => !part?.functionResponse);
      if (item?.role === "user" && parts?.length) return { ...item, parts };
    }
  }
  const user = body?.conversationState?.currentMessage?.userInputMessage;
  if (user) {
    // Tool results are separate data; current request text/media stay exact.
    const { userInputMessageContext: _toolContext, ...request } = user;
    return request;
  }
  return null;
}

export function currentUserRequestMatches(source, candidate) {
  return equal(currentUserRequest(source), currentUserRequest(candidate));
}

// The only editable leaves are text payloads. Tool calls, signed thinking,
// media, citations stored as metadata, cache controls and envelope keys stay exact.
function contentAllowed(source, candidate, editable, allowLossy) {
  if (equal(source, candidate)) return true;
  if (typeof source === "string") {
    if (allowLossy && Array.isArray(candidate) && candidate.length > 0 &&
        candidate.every((part) => part?.type === "text" && typeof part.text === "string" &&
          Object.keys(part).every((key) => key === "type" || key === "text"))) {
      candidate = candidate.map((part) => part.text).join("\n");
    }
    return editable && typeof candidate === "string" && candidate.length > 0 &&
      (allowLossy || jsonCompact(source) === candidate);
  }
  if (Array.isArray(source)) {
    if (allowLossy && editable && typeof candidate === "string" && candidate.length > 0 &&
        source.every((part) => part?.type === "text" && typeof part.text === "string" &&
          Object.keys(part).every((key) => key === "type" || key === "text"))) return true;
    return Array.isArray(candidate) && source.length === candidate.length &&
      source.every((part, i) => contentAllowed(part, candidate[i], editable, allowLossy));
  }
  if (!source || !candidate || typeof source !== "object" || typeof candidate !== "object") return false;
  const keys = Object.keys(source);
  if (keys.length !== Object.keys(candidate).length || keys.some((key) => !Object.hasOwn(candidate, key))) return false;
  if (source.type === "tool_result") {
    return keys.every((key) => key === "content"
      ? contentAllowed(source.content, candidate.content, true, allowLossy)
      : equal(source[key], candidate[key]));
  }
  if (source.type === "text" || source.type === "input_text") {
    return keys.every((key) => key === "text"
      ? contentAllowed(source.text, candidate.text, editable, allowLossy)
      : equal(source[key], candidate[key]));
  }
  return false;
}

export function validateCompressedMessages(source, candidate, { allowLossy = false, compressUserMessages = false } = {}) {
  if (!Array.isArray(candidate) || candidate.length !== source.length) return false;
  const currentUserIndex = source.findLastIndex((message) => userRequest(message) !== null);
  return source.every((message, i) => {
    const next = candidate[i];
    if (!message || !next || typeof next !== "object") return equal(message, next);
    if (message.role === "system" || message.role === "developer") return equal(message, next);
    // JSON transport omits undefined properties. Optional envelope fields may
    // also be omitted by the proxy: the caller restores them from the source.
    // A conflicting echoed field is rejected, as is a missing routing identity.
    const keys = Object.keys(message).filter((key) => message[key] !== undefined);
    if (["role", "tool_call_id", "tool_calls"].some((key) => !equal(message[key], next[key]))) return false;
    return keys.every((key) => key === "content"
      ? contentAllowed(message.content, next.content,
        message.role === "tool" || (allowLossy && (message.role !== "user" || (compressUserMessages && i !== currentUserIndex))), allowLossy)
      : !Object.hasOwn(next, key) || equal(message[key], next[key]));
  });
}
