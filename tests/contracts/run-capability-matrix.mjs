#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describeTranslationRoute } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { startProviderStub } from "./provider-stub.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const manifestPath = `${root}/tests/contracts/capabilities.json`;
const clone = (value) => JSON.parse(JSON.stringify(value));
const loadJson = async (path) => JSON.parse(await readFile(path.startsWith("/") ? path : `${root}/${path}`, "utf8"));

function toolTransactions(endpoint, body) {
  if (endpoint === "/v1/messages") {
    const blocks = body.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []);
    return {
      calls: blocks.filter((block) => block.type === "tool_use").map((block) => block.id),
      results: blocks.filter((block) => block.type === "tool_result").map((block) => block.tool_use_id),
    };
  }
  if (endpoint === "/v1/responses") {
    return {
      calls: body.input.filter((item) => item.type === "function_call").map((item) => item.call_id),
      results: body.input.filter((item) => item.type === "function_call_output").map((item) => item.call_id),
    };
  }
  return {
    calls: body.messages.flatMap((message) => message.tool_calls || []).map((call) => call.id),
    results: body.messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id),
  };
}

export function validatePrimaryFixture(entry, body) {
  const issues = [];
  const collection = entry.endpoint === "/v1/responses" ? body?.input : body?.messages;
  if (!Array.isArray(collection)) issues.push("message collection must be an array");
  if (entry.scenario === "malformed") return { valid: false, issues };
  if (!Array.isArray(collection) || !collection.length) return { valid: false, issues };
  const roles = new Set(entry.endpoint === "/v1/messages" ? ["user", "assistant"] : ["system", "developer", "user", "assistant", "tool"]);
  for (const item of collection) {
    if (item?.role && !roles.has(item.role)) issues.push(`unsupported role ${item.role}`);
  }
  if (entry.scenario === "tool-cycle" || entry.scenario === "parallel-tools") {
    const { calls, results } = toolTransactions(entry.endpoint, body);
    if (!calls.length || new Set(calls).size !== calls.length) issues.push("tool call IDs must be present and unique");
    if (calls.length !== results.length || calls.some((id) => !results.includes(id))) issues.push("each tool call must have one matching result");
    if (entry.scenario === "parallel-tools" && calls.length !== 2) issues.push("parallel case must contain two calls");
  }
  if (entry.scenario === "reasoning" && !JSON.stringify(body).match(/reasoning|thinking/)) issues.push("reasoning intent missing");
  if (entry.scenario === "image" && !JSON.stringify(body).match(/image/)) issues.push("image input missing");
  return { valid: issues.length === 0, issues };
}

function parseSse(text) {
  return text.split(/\n\n+/).map((record) => {
    const event = record.split("\n").find((line) => line.startsWith("event: "))?.slice(7) || null;
    const data = record.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
    if (!data) return null;
    return { event, data: data === "[DONE]" ? data : JSON.parse(data) };
  }).filter(Boolean);
}

function assertStream(endpoint, text) {
  const records = parseSse(text);
  if (endpoint === "/v1/messages") {
    assert.deepEqual(records.map(({ event }) => event), ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    assert.equal(records[4].data.delta.stop_reason, "end_turn");
    assert.equal(records[4].data.usage.output_tokens, 2);
  } else if (endpoint === "/v1/responses") {
    assert.deepEqual(records.map(({ event }) => event), ["response.created", "response.output_item.added", "response.content_part.added", "response.output_text.delta", "response.output_text.done", "response.content_part.done", "response.output_item.done", "response.completed"]);
    assert.equal(records.at(-1).data.response.status, "completed");
    assert.equal(records.at(-1).data.response.usage.total_tokens, 9);
  } else {
    assert.equal(records.at(-1).data, "[DONE]");
    assert.equal(records.at(-2).data.choices[0].finish_reason, "stop");
    assert.equal(records.at(-2).data.usage.total_tokens, 9);
  }
  assert.match(text, /fixture-ok/);
}

function assertJson(endpoint, body) {
  if (endpoint === "/v1/messages") {
    assert.equal(body.stop_reason, "end_turn");
    assert.equal(body.usage.output_tokens, 2);
  } else if (endpoint === "/v1/responses") {
    assert.equal(body.status, "completed");
    assert.equal(body.usage.total_tokens, 9);
  } else {
    assert.equal(body.choices[0].finish_reason, "stop");
    assert.equal(body.usage.total_tokens, 9);
  }
  assert.match(JSON.stringify(body), /fixture-ok/);
}

export async function validateCapabilityManifest() {
  const manifest = await loadJson(manifestPath);
  assert.deepEqual(manifest.formats, Object.values(FORMATS));
  assert.equal(manifest.cells.length, 121);
  assert.equal(new Set(manifest.cells.map(({ source, target }) => `${source}>${target}`)).size, 121);
  for (const cell of manifest.cells) {
    for (const kind of ["request", "response"]) {
      const route = describeTranslationRoute(cell.source, cell.target, kind);
      assert.equal(cell[kind].status === "rejected", !route.supported, `${kind} ${cell.source}>${cell.target}`);
      assert.equal(cell[kind].mode, route.mode, `${kind} mode ${cell.source}>${cell.target}`);
      if (cell[kind].status === "documented-loss") assert.ok(cell[kind].lossPolicy.length > 0);
    }
  }
  assert.equal(manifest.primaryEndpoints.length, 36);
  for (const entry of [...manifest.primaryEndpoints, ...manifest.binaryProtocols]) await loadJson(entry.fixture);
  for (const route of manifest.modalityRoutes) for (const entry of route.cases) await loadJson(entry.fixture);
  return manifest;
}

async function send(baseUrl, entry, body, outcome = "success") {
  const response = await fetch(`${baseUrl}${entry.endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-capability-scenario": entry.scenario, "x-capability-outcome": outcome },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { response, text };
}

export async function runCapabilityMatrix({ baseUrl }) {
  const manifest = await validateCapabilityManifest();
  const primary = { passed: 0, dispatched: 0, rejectedLocally: 0 };
  for (const entry of manifest.primaryEndpoints) {
    const fixture = await loadJson(entry.fixture);
    const before = JSON.stringify(fixture);
    const validation = validatePrimaryFixture(entry, fixture);
    if (!entry.expected.upstreamDispatch) {
      assert.equal(validation.valid, false, `${entry.id} must reject locally`);
      primary.rejectedLocally += 1;
      primary.passed += 1;
      continue;
    }
    assert.equal(validation.valid, true, `${entry.id}: ${validation.issues.join(", ")}`);
    const outbound = clone(fixture);
    outbound.stream = entry.stream;
    const { response, text } = await send(baseUrl, entry, outbound);
    assert.equal(response.status, 200, entry.id);
    if (entry.stream) assertStream(entry.endpoint, text);
    else assertJson(entry.endpoint, JSON.parse(text));
    assert.equal(JSON.stringify(fixture), before, `${entry.id} mutated source fixture`);
    primary.dispatched += 1;
    primary.passed += 1;
  }

  const sample = manifest.primaryEndpoints.find((entry) => entry.endpoint === "/v1/chat/completions" && entry.scenario === "text" && !entry.stream);
  const body = await loadJson(sample.fixture);
  const success = await send(baseUrl, sample, { ...body, stream: false }, "success");
  assert.equal(success.response.status, 200);
  const providerError = await send(baseUrl, sample, { ...body, stream: false }, "provider-error");
  assert.equal(providerError.response.status, 529);
  assert.equal(JSON.parse(providerError.text).error.type, "provider_error");
  await assert.rejects(send(baseUrl, sample, { ...body, stream: false }, "transport-abrupt"));
  return { primary, outcomes: { success: 1, providerError: 1, transportAbrupt: 1 } };
}

async function main() {
  const baseArg = process.argv.find((value) => value.startsWith("--base-url="));
  if (baseArg) {
    const report = await runCapabilityMatrix({ baseUrl: baseArg.slice("--base-url=".length) });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  const stub = await startProviderStub({ port: 20210 });
  try {
    const report = await runCapabilityMatrix({ baseUrl: stub.baseUrl });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    await stub.close();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
