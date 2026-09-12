import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const redact = (value) => digest(value);
const VALUE_BEARING_CONTROLS = new Set(["reasoning_effort", "reasoning", "thinking", "temperature", "top_p", "stop", "tool_choice", "parallel_tool_calls", "response_format", "seed"]);

function mappedControl(key, value) {
  if (key === "reasoning") return { key: "reasoning_effort", value: value?.effort };
  if (key === "thinking") {
    const budget = Number(value?.budget_tokens);
    const effort = budget <= 0 ? "none" : budget <= 768 ? "minimal" : budget <= 4096 ? "low" : budget <= 16384 ? "medium" : budget <= 28672 ? "high" : "xhigh";
    return { key: "reasoning_effort", value: effort };
  }
  return { key, value };
}

function canonicalJson(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function canonicalToolContent(value) {
  if (!Array.isArray(value)) return value;
  const parts = value.map((part) => part?.type === "text" && typeof part.text === "string" ? part.text : part);
  return parts.every((part) => typeof part === "string") ? parts.join("") : parts;
}

function redactedValue(value) {
  if (value === null) return { type: "null", digest: redact(null) };
  if (Array.isArray(value)) return value.map(redactedValue);
  if (typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, redactedValue(value[key])]));
  return { type: typeof value, digest: redact(value) };
}

function redactedImage(image, fallbackMime = "") {
  const value = typeof image === "string" ? image : "";
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(value);
  return { mime: match?.[1] || fallbackMime, digest: redact(match?.[2] || value) };
}

function addAtom(shape, role, kind, value) {
  shape.ordered.push({ role, kind, value: redactedValue(value) });
}

function textParts(value, shape, role) {
  if (typeof value === "string") {
    shape.text.push(redact(value));
    addAtom(shape, role, "text", value);
    return;
  }
  if (!Array.isArray(value)) return;
  for (const part of value) {
    if (!part || typeof part !== "object") continue;
    if (["text", "input_text", "output_text", "summary_text"].includes(part.type) && typeof part.text === "string") {
      shape.text.push(redact(part.text));
      addAtom(shape, role, "text", part.text);
    }
    if (part.type === "thinking" && typeof part.thinking === "string") {
      shape.reasoning.push(redact(part.thinking));
      addAtom(shape, role, "reasoning", part.thinking);
    }
    if (["image", "image_url", "input_image"].includes(part.type)) {
      const image = part.image_url?.url || part.image_url || part.source?.data || part.source?.url || null;
      const redacted = redactedImage(image, part.source?.media_type || "");
      shape.images.push(`${redacted.mime}:${redacted.digest}`);
      addAtom(shape, role, "image", redacted);
    }
    if (part.type === "tool_use") {
      const call = { id: part.id, name: part.name, input: canonicalJson(part.input) };
      shape.toolCalls.push(`${redact(call.id)}:${redact(call.name)}:${redact(call.input)}`);
      addAtom(shape, role, "tool_call", call);
    }
    if (part.type === "tool_result") {
      const result = { id: part.tool_use_id, content: canonicalToolContent(part.content) };
      shape.toolResults.push(`${redact(result.id)}:${redact(result.content)}`);
      addAtom(shape, role, "tool_result", result);
    }
  }
}

function addMessage(shape, role) {
  const normalizedRole = role === "developer" ? "system" : role;
  shape.roles.push(normalizedRole);
  addAtom(shape, normalizedRole, "message", normalizedRole);
  return normalizedRole;
}

function collectMessage(message, shape) {
  if (!message || typeof message !== "object" || typeof message.role !== "string") return;
  // Anthropic encodes tool results in user turns; OpenAI carries each result in
  // a tool turn. Preserve the actual transactional role in the ordered shape.
  if (message.role === "user" && Array.isArray(message.content) && message.content.every((part) => part?.type === "tool_result")) {
    for (const part of message.content) {
      const role = addMessage(shape, "tool");
      const result = { id: part.tool_use_id, content: canonicalToolContent(part.content) };
      shape.toolResults.push(`${redact(result.id)}:${redact(result.content)}`);
      addAtom(shape, role, "tool_result", result);
    }
    return;
  }
  const role = addMessage(shape, message.role);
  // OpenAI represents reasoning alongside content rather than as a typed
  // content block. Canonicalize it first within the same message so a Claude
  // thinking block and its OpenAI equivalent retain the same message shape.
  if (typeof message.reasoning_content === "string") {
    shape.reasoning.push(redact(message.reasoning_content));
    addAtom(shape, role, "reasoning", message.reasoning_content);
  }
  textParts(message.content, shape, role);
  for (const call of message.tool_calls || []) {
    const toolCall = { id: call.id, name: call.function?.name, input: canonicalJson(call.function?.arguments) };
    shape.toolCalls.push(`${redact(toolCall.id)}:${redact(toolCall.name)}:${redact(toolCall.input)}`);
    addAtom(shape, role, "tool_call", toolCall);
  }
  if (role === "tool") {
    const result = { id: message.tool_call_id, content: canonicalToolContent(message.content) };
    shape.toolResults.push(`${redact(result.id)}:${redact(result.content)}`);
    addAtom(shape, role, "tool_result", result);
  }
}

function collectResponseItem(item, shape) {
  if (!item || typeof item !== "object") return;
  if (item.type === "message") collectMessage(item, shape);
  if (item.type === "function_call") {
    const role = addMessage(shape, "assistant");
    collectResponseFunctionCall(item, shape, role);
  }
  if (item.type === "function_call_output") {
    const role = addMessage(shape, "tool");
    const result = { id: item.call_id, content: canonicalToolContent(item.output) };
    shape.toolResults.push(`${redact(result.id)}:${redact(result.content)}`);
    addAtom(shape, role, "tool_result", result);
  }
  if (item.type === "reasoning") {
    const role = addMessage(shape, "assistant");
    const text = Array.isArray(item.summary) ? item.summary.map((part) => part?.text || "").filter(Boolean).join("\n") : item.summary;
    shape.reasoning.push(redact(text));
    addAtom(shape, role, "reasoning", text);
  }
}

function collectResponseFunctionCall(item, shape, role) {
    const call = { id: item.call_id, name: item.name, input: canonicalJson(item.arguments) };
    shape.toolCalls.push(`${redact(call.id)}:${redact(call.name)}:${redact(call.input)}`);
    addAtom(shape, role, "tool_call", call);
}

/** Redacted, ordered, value-bearing semantic evidence at provider ingress. */
export function semanticShape(body) {
  const shape = { roles: [], text: [], tools: [], toolCalls: [], toolResults: [], reasoning: [], images: [], controls: [], ordered: [] };
  if (body?.system !== undefined) {
    const role = addMessage(shape, "system");
    textParts(body.system, shape, role);
  }
  if (body?.instructions !== undefined) {
    const role = addMessage(shape, "system");
    textParts(body.instructions, shape, role);
  }
  for (const message of body?.messages || []) collectMessage(message, shape);
  const input = body?.input || [];
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (item?.type !== "function_call") {
      collectResponseItem(item, shape);
      continue;
    }
    const role = addMessage(shape, "assistant");
    do {
      collectResponseFunctionCall(input[index], shape, role);
      index += 1;
    } while (input[index]?.type === "function_call");
    index -= 1;
  }
  for (const tool of body?.tools || []) {
    const definition = tool.function || tool;
    const value = { name: definition?.name, schema: definition?.parameters || definition?.input_schema };
    shape.tools.push(`${redact(value.name)}:${redact(value.schema)}`);
    addAtom(shape, null, "tool_definition", value);
  }
  for (const [key, value] of Object.entries(body || {})) {
    if (!VALUE_BEARING_CONTROLS.has(key) || value === undefined) continue;
    const control = mappedControl(key, value);
    shape.controls.push({ key: control.key, value: redactedValue(control.value) });
    addAtom(shape, null, "control", control);
  }
  return shape;
}

export function semanticReceipt(body) {
  const shape = semanticShape(body);
  return { shape, digest: digest(shape) };
}

function requireSubsequence(expected, actual, label) {
  let cursor = 0;
  for (const atom of expected) {
    const encoded = JSON.stringify(atom);
    while (cursor < actual.length && JSON.stringify(actual[cursor]) !== encoded) cursor += 1;
    assert.ok(cursor < actual.length, `${label} lost ordered semantic ${encoded}; received ${JSON.stringify(actual)}`);
    cursor += 1;
  }
}

/** Require source semantics in order at the upstream, without retaining values. */
export function assertSemanticPreserved(sourceBody, receipt, label) {
  assert.equal(receipt?.digest, digest(receipt?.shape), `${label} semantic digest integrity`);
  const expected = semanticShape(sourceBody);
  const actual = receipt.shape;
  const ordered = actual?.ordered || [];
  requireSubsequence(expected.ordered.filter((atom) => atom.kind !== "control"), ordered, label);
  for (const control of expected.ordered.filter((atom) => atom.kind === "control")) {
    requireSubsequence([control], ordered, label);
  }
  return { expected, actual };
}
