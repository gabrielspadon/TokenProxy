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
const bytes = (value) => Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
const fingerprint = (key, label, value) => createHmac("sha256", key).update(`context-v1:${label}\0`).update(JSON.stringify(value), "utf8").digest("hex");

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
  const instructions = {}, tools = {}, history = {}, blocks = [];
  for (const field of CONTEXT_INSTRUCTION_FIELDS) if (body[field] !== undefined) {
    instructions[field] = body[field]; result.instructionBytes += bytes(body[field]);
    if (typeof body[field] === "object") blocks.push(body[field]);
  }
  for (const field of CONTEXT_TOOL_FIELDS) if (body[field] !== undefined) {
    tools[field] = body[field]; result.toolSchemaBytes += bytes(body[field]);
  }
  let roleBytes = 0;
  for (const field of CONTEXT_MESSAGE_FIELDS) if (body[field] !== undefined) {
    result.messageBytes += bytes(body[field]);
    const messages = Array.isArray(body[field]) ? body[field] : [body[field]];
    if (messages.length > CONTEXT_CAPTURE_LIMITS.nodes) throw new ContextStructureError("Structural measurement exceeds capture limits");
    blocks.push(messages);
    for (const item of messages) {
      const size = bytes(item), role = contextRole(item);
      result.roles[role].count++; result.roles[role].bytes += size; roleBytes += size;
    }
    const latestUser = messages.findLastIndex((item) => contextRole(item) === ROLE.USER);
    history[field] = latestUser >= 0 ? messages.slice(0, latestUser) : [];
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
  const prefix = { instructions, tools, history };
  result.historyPrefixBytes = bytes(prefix);
  result.fingerprints = {
    body: createHmac("sha256", key).update("context-v1:body\0").update(encoded, "utf8").digest("hex"),
    instructions: fingerprint(key, "instructions", instructions), tools: fingerprint(key, "tools", tools), historyPrefix: fingerprint(key, "history-prefix", prefix),
  };
  return result;
}
