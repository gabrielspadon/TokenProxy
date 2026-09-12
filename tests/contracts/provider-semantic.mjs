import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const redact = (value) => digest(value);
const sorted = (values) => [...values].sort();

function canonicalJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function canonicalToolContent(value) {
  if (!Array.isArray(value)) return value;
  const parts = value.map((part) => {
    if (part?.type === "text" && typeof part.text === "string") return part.text;
    return part;
  });
  return parts.every((part) => typeof part === "string") ? parts.join("") : parts;
}

function redactedImage(image, fallbackMime = "") {
  const value = typeof image === "string" ? image : "";
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(value);
  return `${match?.[1] || fallbackMime}:${redact(match?.[2] || value)}`;
}

function textParts(value, shape) {
  if (typeof value === "string") {
    shape.text.push(redact(value));
    return;
  }
  if (!Array.isArray(value)) return;
  for (const part of value) {
    if (!part || typeof part !== "object") continue;
    if (["text", "input_text", "output_text", "summary_text"].includes(part.type) && typeof part.text === "string") {
      shape.text.push(redact(part.text));
    }
    if (part.type === "thinking" && typeof part.thinking === "string") {
      shape.reasoning.push(redact(part.thinking));
    }
    if (["image", "image_url", "input_image"].includes(part.type)) {
      const image = part.image_url?.url || part.image_url || part.source?.data || part.source?.url || null;
      shape.images.push(redactedImage(image, part.source?.media_type || ""));
    }
    if (part.type === "tool_use") {
      shape.toolCalls.push(`${redact(part.id)}:${redact(part.name)}:${redact(canonicalJson(part.input))}`);
    }
    if (part.type === "tool_result") {
      shape.toolResults.push(`${redact(part.tool_use_id)}:${redact(canonicalToolContent(part.content))}`);
    }
  }
}

function collectMessage(message, shape) {
  if (!message || typeof message !== "object") return;
  if (typeof message.role === "string") {
    if (message.role === "system" || message.role === "developer") textParts(message.content, shape.system);
    else {
      shape.roles.push(message.role);
      textParts(message.content, shape);
    }
  }
  for (const call of message.tool_calls || []) {
    shape.toolCalls.push(`${redact(call.id)}:${redact(call.function?.name)}:${redact(canonicalJson(call.function?.arguments))}`);
  }
  if (message.role === "tool") shape.toolResults.push(`${redact(message.tool_call_id)}:${redact(canonicalToolContent(message.content))}`);
  if (typeof message.reasoning_content === "string") shape.reasoning.push(redact(message.reasoning_content));
}

function collectResponseItem(item, shape) {
  if (!item || typeof item !== "object") return;
  if (item.type === "message") collectMessage(item, shape);
  if (item.type === "function_call") {
    shape.toolCalls.push(`${redact(item.call_id)}:${redact(item.name)}:${redact(canonicalJson(item.arguments))}`);
  }
  if (item.type === "function_call_output") {
    shape.toolResults.push(`${redact(item.call_id)}:${redact(canonicalToolContent(item.output))}`);
  }
  if (item.type === "reasoning") {
    const text = Array.isArray(item.summary)
      ? item.summary.map((part) => part?.text || "").filter(Boolean).join("\n")
      : item.summary;
    shape.reasoning.push(redact(text));
  }
}

/** Redacted, content-free semantic evidence for a request at provider ingress. */
export function semanticShape(body) {
  const shape = {
    system: { text: [] },
    roles: [],
    text: [],
    tools: [],
    toolCalls: [],
    toolResults: [],
    reasoning: [],
    images: [],
    fields: [],
  };
  textParts(body?.system, shape.system);
  textParts(body?.instructions, shape.system);
  for (const message of body?.messages || []) collectMessage(message, shape);
  for (const item of body?.input || []) collectResponseItem(item, shape);
  for (const tool of body?.tools || []) {
    const definition = tool.function || tool;
    shape.tools.push(`${redact(definition?.name)}:${redact(definition?.parameters || definition?.input_schema)}`);
  }
  if (body?.reasoning_effort) shape.fields.push("reasoning_effort:string");
  if (body?.reasoning) shape.fields.push("reasoning:object");
  if (body?.thinking) shape.fields.push("thinking:object");
  for (const [key, value] of Object.entries(body || {})) {
    if (["model", "stream", "messages", "input", "system", "instructions", "tools", "reasoning", "thinking", "reasoning_effort"].includes(key)) continue;
    if (value !== undefined) shape.fields.push(`${key}:${typeof value}`);
  }
  for (const values of [shape.system.text, shape.roles, shape.text, shape.tools, shape.toolCalls, shape.toolResults, shape.reasoning, shape.images, shape.fields]) {
    values.sort();
  }
  return shape;
}

export function semanticReceipt(body) {
  const shape = semanticShape(body);
  return { shape, digest: digest(shape) };
}

function requireSubset(expected, actual, field, label) {
  for (const item of expected) {
    assert.ok(actual.includes(item), `${label} lost ${field} semantic ${item}; received ${JSON.stringify(actual)}`);
  }
}

/** Require every source semantic atom to reach the upstream, without retaining text. */
export function assertSemanticPreserved(sourceBody, receipt, label) {
  assert.equal(receipt?.digest, digest(receipt?.shape), `${label} semantic digest integrity`);
  const expected = semanticShape(sourceBody);
  const actual = receipt.shape;
  requireSubset(expected.system.text, actual.system?.text || [], "system", label);
  for (const field of ["roles", "text", "tools", "toolCalls", "toolResults", "reasoning", "images"]) {
    requireSubset(expected[field], actual[field] || [], field, label);
  }
  return { expected, actual };
}
