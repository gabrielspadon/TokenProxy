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

function assertSingleTerminal(records, predicate, label) {
  assert.equal(records.filter(predicate).length, 1, `${label} terminal cardinality`);
}

function assertStream(endpoint, text) {
  const records = parseSse(text);
  assert.ok(records.length > 0, "stream must contain events");
  if (endpoint === "/v1/messages") {
    assert.equal(records[0].event, "message_start");
    assertSingleTerminal(records, ({ event }) => event === "message_stop", "Claude");
    assert.equal(records.at(-1).event, "message_stop");
    const delta = records.find(({ event }) => event === "content_block_delta");
    const terminalDelta = records.find(({ event }) => event === "message_delta");
    assert.equal(delta?.data?.type, "content_block_delta");
    assert.equal(terminalDelta?.data?.delta?.stop_reason, "end_turn");
    assert.equal(typeof terminalDelta?.data?.usage?.output_tokens, "number");
    assert.ok(records.indexOf(delta) < records.indexOf(terminalDelta));
  } else if (endpoint === "/v1/responses") {
    assert.equal(records[0].event, "response.created");
    assertSingleTerminal(records, ({ event }) => event === "response.completed", "Responses");
    const textDelta = records.find(({ event }) => event === "response.output_text.delta");
    const terminal = records.at(-1);
    assert.equal(terminal.event, "response.completed");
    assert.equal(terminal.data?.response?.status, "completed");
    assert.equal(typeof terminal.data?.response?.usage?.total_tokens, "number");
    assert.ok(records.indexOf(textDelta) > 0 && records.indexOf(textDelta) < records.length - 1);
  } else {
    assertSingleTerminal(records, ({ data }) => data === "[DONE]", "Chat Completions");
    assert.equal(records.at(-1).data, "[DONE]");
    const terminalChunk = records.find(({ data }) => data !== "[DONE]" && data?.choices?.some((choice) => choice.finish_reason));
    assert.equal(terminalChunk?.data?.choices?.[0]?.finish_reason, "stop");
    assert.equal(typeof terminalChunk?.data?.usage?.total_tokens, "number");
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

async function send(baseUrl, entry, body, requestHeaders) {
  const response = await fetch(`${baseUrl}${entry.endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...requestHeaders },
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

export async function runCapabilityMatrix({ baseUrl, controlUrl = null, requestHeaders = {}, model = null }) {
  const manifest = await validateCapabilityManifest();
  const primary = { passed: 0, dispatched: 0, rejectedBeforeUpstream: 0 };
  for (const entry of manifest.primaryEndpoints) {
    const fixture = await loadJson(entry.fixture);
    const before = JSON.stringify(fixture);
    const validation = validatePrimaryFixture(entry, fixture);
    const upstreamBefore = controlUrl ? (await readControl(controlUrl)).requestCount : null;
    if (!entry.expected.upstreamDispatch) {
      assert.equal(validation.valid, false, `${entry.id} must reject locally`);
      const outbound = clone(fixture);
      outbound.stream = entry.stream;
      if (model) outbound.model = model;
      const { response } = await send(baseUrl, entry, outbound, requestHeaders);
      assert.ok(response.status >= 400 && response.status < 500, `${entry.id} must return client 4xx`);
      if (controlUrl) assert.equal((await readControl(controlUrl)).requestCount, upstreamBefore, `${entry.id} reached provider`);
      assert.equal(JSON.stringify(fixture), before, `${entry.id} mutated source fixture`);
      primary.rejectedBeforeUpstream += 1;
      primary.passed += 1;
      continue;
    }
    assert.equal(validation.valid, true, `${entry.id}: ${validation.issues.join(", ")}`);
    const outbound = clone(fixture);
    outbound.stream = entry.stream;
    if (model) outbound.model = model;
    await setStubOutcome(controlUrl, "success", entry.id);
    const { response, text } = await send(baseUrl, entry, outbound, requestHeaders);
    assert.equal(response.status, 200, entry.id);
    if (entry.stream) assertStream(entry.endpoint, text);
    else assertJson(entry.endpoint, JSON.parse(text));
    assert.equal(JSON.stringify(fixture), before, `${entry.id} mutated source fixture`);
    primary.dispatched += 1;
    primary.passed += 1;
  }

  const sample = manifest.primaryEndpoints.find((entry) => entry.endpoint === "/v1/chat/completions" && entry.scenario === "text" && !entry.stream);
  const body = await loadJson(sample.fixture);
  const outcomeBody = { ...body, ...(model ? { model } : {}), stream: false };
  await setStubOutcome(controlUrl, "success", "outcome-success");
  const success = await send(baseUrl, sample, outcomeBody, requestHeaders);
  assert.equal(success.response.status, 200);
  await setStubOutcome(controlUrl, "provider-error", "outcome-provider-error");
  const providerError = await send(baseUrl, sample, outcomeBody, requestHeaders);
  assert.equal(providerError.response.status, 529);
  assert.equal(JSON.parse(providerError.text).error.type, "provider_error");
  await setStubOutcome(controlUrl, "transport-abrupt", "outcome-transport-abrupt");
  let transportAbrupt;
  try {
    const abrupt = await send(baseUrl, sample, outcomeBody, requestHeaders);
    assert.ok(abrupt.response.status >= 500, "abrupt transport must not succeed");
    transportAbrupt = { responseStatus: abrupt.response.status };
  } catch {
    transportAbrupt = { fetchRejected: true };
  }
  return { primary, outcomes: { success: 1, providerError: 1, transportAbrupt } };
}

async function main() {
  const baseArg = process.argv.find((value) => value.startsWith("--base-url="));
  const controlArg = process.argv.find((value) => value.startsWith("--control-url="));
  const modelArg = process.argv.find((value) => value.startsWith("--model="));
  const authorizationArg = process.argv.find((value) => value.startsWith("--authorization="));
  if (baseArg) {
    const report = await runCapabilityMatrix({
      baseUrl: baseArg.slice("--base-url=".length),
      controlUrl: controlArg?.slice("--control-url=".length) || null,
      model: modelArg?.slice("--model=".length) || null,
      requestHeaders: authorizationArg ? { authorization: authorizationArg.slice("--authorization=".length) } : {},
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  const stub = await startProviderStub({ port: 20210 });
  try {
    const report = await runCapabilityMatrix({ baseUrl: stub.baseUrl, controlUrl: stub.controlUrl });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    await stub.close();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
