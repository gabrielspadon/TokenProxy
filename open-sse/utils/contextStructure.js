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
  const array = (parts) => ({ encoded: `[${parts.map((part) => part.encoded).join(",")}]`, bytes: arrayBytes(parts) });
  const object = (entries) => `{${entries.map(([name, value]) => `${JSON.stringify(name)}:${value}`).join(",")}}`;
  return { serialize, array, arrayBytes, object };
}

// Counts describe serialized JSON, not tokenizer input or decoded media size.
// Component values partition bodyBytes with envelopeBytes. Subsets overlap roles.
export function measureContextStructure(body, boundary, key, { serialized } = {}) {
  if (!object(body) || !CONTEXT_BOUNDARIES.includes(boundary) || !Buffer.isBuffer(key) || key.length < 32) throw new ContextStructureError("Structural measurement unavailable");
  // Internal callers may supply the exact JSON they already prepared for wire
  // serialization. Never accept this option from a client-supplied field.
  const encoded = typeof serialized === "string" ? serialized : JSON.stringify(body);
  const bodyBytes = Buffer.byteLength(encoded, "utf8");
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
    history.push([field, json.array(latestUser >= 0 ? parts.slice(0, latestUser) : []).encoded]);
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
      for (const child of value) stack.push({ ...current, value: child, depth: current.depth + 1 });
      continue;
    }
    const categories = {
      toolCalls: CONTEXT_CALL_TYPES.has(value.type) || value.functionCall !== undefined,
      toolResults: CONTEXT_RESULT_TYPES.has(value.type) || value.role === ROLE.TOOL || value.functionResponse !== undefined,
      attachments: CONTEXT_ATTACHMENT_TYPES.has(value.type) || value.inlineData !== undefined || value.fileData !== undefined,
    };
    const flags = {};
    for (const [category, detected] of Object.entries(categories)) {
      if (detected && !current[category]) { result.subsets[category].count++; result.subsets[category].bytes += bytes(value); }
      flags[category] = current[category] || detected;
    }
    // Inspect protocol containers only. Tool arguments, schema examples and
    // arbitrary result objects must not be mistaken for real content blocks.
    for (const field of ["content", "parts", "tool_calls"]) {
      const child = value[field];
      if (!Array.isArray(child) && !object(child)) continue;
      if (field === "tool_calls" && Array.isArray(child) && !flags.toolCalls) {
        for (const call of child) { result.subsets.toolCalls.count++; result.subsets.toolCalls.bytes += bytes(call); }
        stack.push({ value: child, depth: current.depth + 1, ...flags, toolCalls: true });
      } else stack.push({ value: child, depth: current.depth + 1, ...flags });
    }
  }
  const instructionJson = json.object(instructions), toolJson = json.object(tools);
  const prefixJson = `{"instructions":${instructionJson},"tools":${toolJson},"history":${json.object(history)}}`;
  result.historyPrefixBytes = Buffer.byteLength(prefixJson, "utf8");
  result.fingerprints = {
    body: createHmac("sha256", key).update("context-v1:body\0").update(encoded, "utf8").digest("hex"),
    instructions: fingerprint(key, "instructions", instructionJson), tools: fingerprint(key, "tools", toolJson), historyPrefix: fingerprint(key, "history-prefix", prefixJson),
  };
  return result;
}
