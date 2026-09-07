import { createHmac } from "node:crypto";
import { ROLE } from "../translator/schema/index.js";
import {
  CONTEXT_ATTACHMENT_TYPES, CONTEXT_BOUNDARIES, CONTEXT_CALL_TYPES, CONTEXT_CAPTURE_LIMITS,
  CONTEXT_INSTRUCTION_FIELDS, CONTEXT_MESSAGE_FIELDS, CONTEXT_RESULT_TYPES,
  CONTEXT_ROLES, CONTEXT_TOOL_FIELDS, contextRole,
} from "../config/contextEvidence.js";

import { ContextStructureError } from "../../src/lib/db/analytics/contextStructure.mjs";
export { normalizeContextStructure } from "../../src/lib/db/analytics/contextStructure.mjs";
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fingerprint = (key, label, encoded) => createHmac("sha256", key).update(`context-v1:${label}\0`).update(encoded, "utf8").digest("hex");

// Feeding a megabyte string straight to `hash.update(text, "utf8")` makes V8
// materialize its whole UTF-8 encoding as one transient buffer, and that single
// allocation is what drives the major-GC pause this measurement used to pay
// once per call. Encode through a shared scratch instead, in bounded slices.
// UTF-8 never needs more than three bytes per UTF-16 code unit (a surrogate
// pair is two units and four bytes, a lone surrogate becomes a three-byte
// replacement), so a slice of CHUNK_CHARS always fits. Slices never split a
// surrogate pair, so the concatenated slice encodings are byte-for-byte the
// encoding of the whole string and every digest is unchanged.
const CHUNK_CHARS = 65536;
const scratch = Buffer.allocUnsafe(CHUNK_CHARS * 3);
// Returns the UTF-8 byte length fed in. Stops early once `limit` is passed,
// because the only caller that sets one throws on that result and discards the
// digest rather than encoding a body it has already rejected.
function updateUtf8(hash, text, limit = Infinity) {
  let bytes = 0;
  for (let index = 0; index < text.length; ) {
    let end = index + CHUNK_CHARS;
    if (end >= text.length) end = text.length;
    else if ((text.charCodeAt(end - 1) & 0xfc00) === 0xd800) end -= 1;
    const written = scratch.write(index === 0 && end === text.length ? text : text.slice(index, end), 0, "utf8");
    hash.update(scratch.subarray(0, written));
    bytes += written;
    if (bytes > limit) return bytes;
    index = end;
  }
  return bytes;
}
// Reuse exact JSON fragments within this one synchronous observation. Nothing
// survives the call, and the composed bytes match the version-1 JSON contract.
function fragments() {
  const cache = new WeakMap();
  const serialize = (value) => {
    if (value !== null && typeof value === "object" && cache.has(value)) return cache.get(value);
    const encoded = JSON.stringify(value) ?? "null";
    const result = { encoded, bytes: Buffer.byteLength(encoded, "utf8") };
    if (value !== null && typeof value === "object") cache.set(value, result);
    return result;
  };
  const arrayBytes = (parts) => 2 + Math.max(0, parts.length - 1) + parts.reduce((sum, part) => sum + part.bytes, 0);
  const object = (entries) => `{${entries.map(([name, value]) => `${JSON.stringify(name)}:${value}`).join(",")}}`;
  return { serialize, arrayBytes, object };
}

// Counts describe serialized JSON, not tokenizer input or decoded media size.
// Component values partition bodyBytes with envelopeBytes. Subsets overlap roles.
export function measureContextStructure(body, boundary, key, { serialized } = {}) {
  if (!object(body) || !CONTEXT_BOUNDARIES.includes(boundary) || !Buffer.isBuffer(key) || key.length < 32) throw new ContextStructureError("Structural measurement unavailable");
  // Internal callers may supply the exact JSON they already prepared for wire
  // serialization. Never accept this option from a client-supplied field.
  const encoded = typeof serialized === "string" ? serialized : JSON.stringify(body);
  // Encode once, streaming: this single pass produces the byte count and the
  // body digest together, so neither the count nor the HMAC re-walks the string.
  const bodyHash = createHmac("sha256", key).update("context-v1:body\0");
  const bodyBytes = updateUtf8(bodyHash, encoded, CONTEXT_CAPTURE_LIMITS.bytes);
  if (bodyBytes > CONTEXT_CAPTURE_LIMITS.bytes) throw new ContextStructureError("Structural measurement exceeds capture limits");
  const result = {
    version: 1, boundary, bodyBytes, messageBytes: 0, messageContainerBytes: 0,
    instructionBytes: 0, toolSchemaBytes: 0, envelopeBytes: 0,
    roles: Object.fromEntries(CONTEXT_ROLES.map((role) => [role, { count: 0, bytes: 0 }])),
    subsets: { toolCalls: { count: 0, bytes: 0 }, toolResults: { count: 0, bytes: 0 }, attachments: { count: 0, bytes: 0 } },
  };
  const json = fragments();
  const bytes = (value) => json.serialize(value).bytes;
  const instructions = [], tools = [], history = [], blocks = [];
  for (const field of CONTEXT_INSTRUCTION_FIELDS) if (body[field] !== undefined) {
    const fragment = json.serialize(body[field]);
    instructions.push([field, fragment.encoded]); result.instructionBytes += fragment.bytes;
    if (typeof body[field] === "object") blocks.push(body[field]);
  }
  for (const field of CONTEXT_TOOL_FIELDS) if (body[field] !== undefined) {
    const fragment = json.serialize(body[field]);
    tools.push([field, fragment.encoded]); result.toolSchemaBytes += fragment.bytes;
  }
  let roleBytes = 0;
  for (const field of CONTEXT_MESSAGE_FIELDS) if (body[field] !== undefined) {
    const messages = Array.isArray(body[field]) ? body[field] : [body[field]];
    if (messages.length > CONTEXT_CAPTURE_LIMITS.nodes) throw new ContextStructureError("Structural measurement exceeds capture limits");
    const parts = Array.from(messages, (item) => json.serialize(item));
    result.messageBytes += Array.isArray(body[field]) ? json.arrayBytes(parts) : parts[0].bytes;
    blocks.push(messages);
    for (let index = 0; index < messages.length; index++) {
      const item = messages[index], size = parts[index].bytes, role = contextRole(item);
      result.roles[role].count++; result.roles[role].bytes += size; roleBytes += size;
    }
    const latestUser = messages.findLastIndex((item) => contextRole(item) === ROLE.USER);
    history.push([field, latestUser >= 0 ? parts.slice(0, latestUser) : []]);
  }
  result.messageContainerBytes = result.messageBytes - roleBytes;
  result.envelopeBytes = bodyBytes - result.messageBytes - result.instructionBytes - result.toolSchemaBytes;
  const stack = blocks.map((value) => ({ value, depth: 0, toolCalls: false, toolResults: false, attachments: false }));
  let visited = 0;
  while (stack.length) {
    const current = stack.pop(), value = current.value;
    if (++visited > CONTEXT_CAPTURE_LIMITS.nodes || current.depth > CONTEXT_CAPTURE_LIMITS.depth) throw new ContextStructureError("Structural measurement exceeds capture limits");
    if (value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      const depth = current.depth + 1;
      for (const child of value) stack.push({ value: child, depth, toolCalls: current.toolCalls, toolResults: current.toolResults, attachments: current.attachments });
      continue;
    }
    const isToolCall = CONTEXT_CALL_TYPES.has(value.type) || value.functionCall !== undefined;
    const isToolResult = CONTEXT_RESULT_TYPES.has(value.type) || value.role === ROLE.TOOL || value.functionResponse !== undefined;
    const isAttachment = CONTEXT_ATTACHMENT_TYPES.has(value.type) || value.inlineData !== undefined || value.fileData !== undefined;
    if (isToolCall && !current.toolCalls) { result.subsets.toolCalls.count++; result.subsets.toolCalls.bytes += bytes(value); }
    if (isToolResult && !current.toolResults) { result.subsets.toolResults.count++; result.subsets.toolResults.bytes += bytes(value); }
    if (isAttachment && !current.attachments) { result.subsets.attachments.count++; result.subsets.attachments.bytes += bytes(value); }
    const toolCalls = current.toolCalls || isToolCall, toolResults = current.toolResults || isToolResult, attachments = current.attachments || isAttachment;
    // Inspect protocol containers only. Tool arguments, schema examples and
    // arbitrary result objects must not be mistaken for real content blocks.
    for (const field of ["content", "parts", "tool_calls"]) {
      const child = value[field];
      if (!Array.isArray(child) && !object(child)) continue;
      if (field === "tool_calls" && Array.isArray(child) && !toolCalls) {
        for (const call of child) { result.subsets.toolCalls.count++; result.subsets.toolCalls.bytes += bytes(call); }
        stack.push({ value: child, depth: current.depth + 1, toolCalls: true, toolResults, attachments });
      } else stack.push({ value: child, depth: current.depth + 1, toolCalls, toolResults, attachments });
    }
  }
  const instructionJson = json.object(instructions), toolJson = json.object(tools);
  const instructionBuffer = Buffer.from(instructionJson, "utf8"), toolBuffer = Buffer.from(toolJson, "utf8");
  // Stream the prefix HMAC over the exact fragment sequence the version-1 JSON
  // contract concatenates. Fragment boundaries sit between complete JSON values,
  // so per-fragment UTF-8 encoding is byte-identical to encoding the whole
  // string, and the digest and byte count match the materialized form exactly.
  const prefix = createHmac("sha256", key).update("context-v1:history-prefix\0");
  let prefixBytes = 0;
  const text = (part) => { prefixBytes += updateUtf8(prefix, part); };
  const buffer = (part) => { prefix.update(part); prefixBytes += part.length; };
  text('{"instructions":'); buffer(instructionBuffer);
  text(',"tools":'); buffer(toolBuffer);
  text(',"history":{');
  for (let index = 0; index < history.length; index++) {
    const [field, parts] = history[index];
    text(`${index ? "," : ""}${JSON.stringify(field)}:[`);
    for (let position = 0; position < parts.length; position++) {
      if (position) text(",");
      prefixBytes += updateUtf8(prefix, parts[position].encoded);
    }
    text("]");
  }
  text("}}");
  result.historyPrefixBytes = prefixBytes;
  result.fingerprints = {
    body: bodyHash.digest("hex"),
    instructions: fingerprint(key, "instructions", instructionBuffer), tools: fingerprint(key, "tools", toolBuffer), historyPrefix: prefix.digest("hex"),
  };
  return result;
}
