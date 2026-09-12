#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describeTranslationRoute } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

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

function assertSingleTerminal(records, predicate, label) {
  assert.equal(records.filter(predicate).length, 1, `${label} terminal cardinality`);
}

function indexOfEvent(records, event, label) {
  const index = records.findIndex((record) => record.event === event);
  assert.ok(index >= 0, `${label} event is present`);
  return index;
}

function assertEventSchema(records, endpoint) {
  for (const record of records) {
    if (endpoint === "/v1/chat/completions" && record.data === "[DONE]") continue;
    assert.equal(typeof record.data, "object", `${endpoint} event data is an object`);
    assert.ok(record.data && !Array.isArray(record.data), `${endpoint} event data schema`);
  }
}

function assertStream(endpoint, text) {
  const records = parseSse(text);
  assert.ok(records.length > 0, "stream must contain events");
  assertEventSchema(records, endpoint);
  if (endpoint === "/v1/messages") {
    assert.equal(records[0].event, "message_start");
    assertSingleTerminal(records, ({ event }) => event === "message_stop", "Claude");
    assert.equal(records.at(-1).event, "message_stop");
    const start = indexOfEvent(records, "content_block_start", "Claude content start");
    const delta = records[indexOfEvent(records, "content_block_delta", "Claude content delta")];
    const stop = indexOfEvent(records, "content_block_stop", "Claude content stop");
    const terminalIndex = indexOfEvent(records, "message_delta", "Claude terminal delta");
    const terminalDelta = records[terminalIndex];
    assert.equal(delta?.data?.type, "content_block_delta");
    assert.equal(terminalDelta?.data?.delta?.stop_reason, "end_turn");
    assert.equal(typeof terminalDelta?.data?.usage?.output_tokens, "number");
    assert.ok(start < records.indexOf(delta) && records.indexOf(delta) < stop && stop < terminalIndex);
  } else if (endpoint === "/v1/responses") {
    assert.equal(records[0].event, "response.created");
    assertSingleTerminal(records, ({ event }) => event === "response.completed", "Responses");
    const itemAdded = indexOfEvent(records, "response.output_item.added", "Responses output item");
    const partAdded = indexOfEvent(records, "response.content_part.added", "Responses content part");
    const textDelta = indexOfEvent(records, "response.output_text.delta", "Responses text delta");
    const terminal = records.at(-1);
    assert.equal(terminal.event, "response.completed");
    assert.equal(terminal.data?.response?.status, "completed");
    assert.equal(typeof terminal.data?.response?.usage?.total_tokens, "number");
    assert.ok(itemAdded < partAdded && partAdded < textDelta && textDelta < records.length - 1);
  } else {
    assertSingleTerminal(records, ({ data }) => data === "[DONE]", "Chat Completions");
    assert.equal(records.at(-1).data, "[DONE]");
    const terminalChunk = records.find(({ data }) => data !== "[DONE]" && data?.choices?.some((choice) => choice.finish_reason));
    assert.equal(terminalChunk?.data?.choices?.[0]?.finish_reason, "stop");
    assert.equal(typeof terminalChunk?.data?.usage?.total_tokens, "number");
    assert.ok(records.some(({ data }) => data !== "[DONE]" && data?.choices?.some((choice) => choice?.delta?.content)));
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

async function send(gatewayBaseUrl, entry, body, authorization) {
  const response = await fetch(`${gatewayBaseUrl}${entry.endpoint}`, {
    method: "POST",
    // Client authorization is forwarded as an ordinary client credential. The
    // gateway must make its own authorization decision; no fixture header
    // selects a result or instructs an upstream stub how to behave.
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { response, text };
}

async function readControl(controlUrl) {
  const response = await fetch(controlUrl);
  assert.equal(response.status, 200, "provider stub control read");
  return response.json();
}

async function setStubOutcome(controlUrl, outcome, label) {
  if (!controlUrl) return;
  const response = await fetch(controlUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ outcome, label }),
  });
  assert.equal(response.status, 200, "provider stub control write");
}

/**
 * Exercise a started gateway against its separately controlled upstream stub.
 *
 * `gatewayBaseUrl` is deliberately separate from `providerControlUrl`: direct
 * calls to the stub prove only the fixture, while this contract is intended to
 * prove the product's endpoint parsing, authorization, routing and dispatch.
 */
export async function runCapabilityMatrix({
  gatewayBaseUrl,
  providerControlUrl,
  authorization = null,
  model = null,
}) {
  assert.equal(typeof gatewayBaseUrl, "string", "gatewayBaseUrl is required");
  assert.equal(typeof providerControlUrl, "string", "providerControlUrl is required");
  assert.ok(gatewayBaseUrl.length > 0, "gatewayBaseUrl is required");
  assert.ok(providerControlUrl.length > 0, "providerControlUrl is required");
  if (authorization != null) assert.equal(typeof authorization, "string", "authorization is a client credential string");
  if (model != null) assert.equal(typeof model, "string", "model override is a request model string");
  const manifest = await validateCapabilityManifest();
  const primary = { passed: 0, dispatched: 0, rejectedBeforeUpstream: 0 };
  for (const entry of manifest.primaryEndpoints) {
    const fixture = await loadJson(entry.fixture);
    const before = JSON.stringify(fixture);
    const validation = validatePrimaryFixture(entry, fixture);
    const upstreamBefore = (await readControl(providerControlUrl)).requestCount;
    if (!entry.expected.upstreamDispatch) {
      assert.equal(validation.valid, false, `${entry.id} must reject locally`);
      const outbound = clone(fixture);
      outbound.stream = entry.stream;
      if (model) outbound.model = model;
      const { response } = await send(gatewayBaseUrl, entry, outbound, authorization);
      assert.ok(response.status >= 400 && response.status < 500, `${entry.id} must return client 4xx`);
      assert.equal((await readControl(providerControlUrl)).requestCount, upstreamBefore, `${entry.id} reached provider`);
      assert.equal(JSON.stringify(fixture), before, `${entry.id} mutated source fixture`);
      primary.rejectedBeforeUpstream += 1;
      primary.passed += 1;
      continue;
    }
    assert.equal(validation.valid, true, `${entry.id}: ${validation.issues.join(", ")}`);
    const outbound = clone(fixture);
    outbound.stream = entry.stream;
    if (model) outbound.model = model;
    await setStubOutcome(providerControlUrl, "success", entry.id);
    const { response, text } = await send(gatewayBaseUrl, entry, outbound, authorization);
    assert.equal(response.status, 200, entry.id);
    if (entry.stream) assertStream(entry.endpoint, text);
    else assertJson(entry.endpoint, JSON.parse(text));
    assert.equal(JSON.stringify(fixture), before, `${entry.id} mutated source fixture`);
    assert.equal((await readControl(providerControlUrl)).requestCount, upstreamBefore + 1, `${entry.id} did not reach provider exactly once`);
    primary.dispatched += 1;
    primary.passed += 1;
  }

  const sample = manifest.primaryEndpoints.find((entry) => entry.endpoint === "/v1/chat/completions" && entry.scenario === "text" && !entry.stream);
  const body = await loadJson(sample.fixture);
  const outcomeBody = { ...body, ...(model ? { model } : {}), stream: false };
  await setStubOutcome(providerControlUrl, "success", "outcome-success");
  const success = await send(gatewayBaseUrl, sample, outcomeBody, authorization);
  assert.equal(success.response.status, 200);
  await setStubOutcome(providerControlUrl, "provider-error", "outcome-provider-error");
  const providerError = await send(gatewayBaseUrl, sample, outcomeBody, authorization);
  assert.equal(providerError.response.status, 529);
  assert.equal(JSON.parse(providerError.text).error.type, "provider_error");
  await setStubOutcome(providerControlUrl, "transport-abrupt", "outcome-transport-abrupt");
  let transportAbrupt;
  try {
    const abrupt = await send(gatewayBaseUrl, sample, outcomeBody, authorization);
    assert.ok(abrupt.response.status >= 500, "abrupt transport must not succeed");
    transportAbrupt = { responseStatus: abrupt.response.status };
  } catch {
    transportAbrupt = { fetchRejected: true };
  }
  return { primary, outcomes: { success: 1, providerError: 1, transportAbrupt } };
}

async function main() {
  const gatewayArg = process.argv.find((value) => value.startsWith("--gateway-base-url="));
  const controlArg = process.argv.find((value) => value.startsWith("--provider-control-url="));
  const modelArg = process.argv.find((value) => value.startsWith("--model="));
  const authorizationArg = process.argv.find((value) => value.startsWith("--authorization="));
  assert.ok(gatewayArg, "pass --gateway-base-url for the started TokenProxy gateway");
  assert.ok(controlArg, "pass --provider-control-url for the started provider stub");
  const report = await runCapabilityMatrix({
    gatewayBaseUrl: gatewayArg.slice("--gateway-base-url=".length),
    providerControlUrl: controlArg.slice("--provider-control-url=".length),
    model: modelArg?.slice("--model=".length) || null,
    authorization: authorizationArg?.slice("--authorization=".length) || null,
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
