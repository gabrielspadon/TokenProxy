#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describeTranslationRoute } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { assertSemanticPreserved } from "./provider-semantic.mjs";
import { FIXTURE_MODEL_CAPABILITIES, FIXTURE_MODEL_ID } from "./capability-gateway-fixture.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const manifestPath = `${root}/tests/contracts/capabilities.json`;
const clone = (value) => JSON.parse(JSON.stringify(value));
// The endpoint a fixture is posted to determines its client format, which is
// what a declared provider transform is keyed on.
const ENDPOINT_SOURCE_FORMAT = Object.freeze({
  "/v1/chat/completions": "openai",
  "/v1/messages": "claude",
  "/v1/responses": "openai-responses",
});
const loadJson = async (path) => JSON.parse(await readFile(path.startsWith("/") ? path : `${root}/${path}`, "utf8"));
const CONTROLLED_USAGE = Object.freeze({
  chat: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
  messages: { input_tokens: 7, output_tokens: 2 },
  messagesStream: {
    initial: { input_tokens: 0, output_tokens: 0 },
    terminal: { input_tokens: 7, output_tokens: 2 },
  },
  responses: { input_tokens: 7, output_tokens: 2, total_tokens: 9 },
});

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
    if (record.data === "[DONE]") continue;
    assert.equal(typeof record.data, "object", `${endpoint} event data is an object`);
    assert.ok(record.data && !Array.isArray(record.data), `${endpoint} event data schema`);
  }
}

function assertChatUsage(usage, expected, label) {
  assert.equal(usage?.prompt_tokens, expected.prompt_tokens, `${label} Chat input usage`);
  assert.equal(usage?.completion_tokens, expected.completion_tokens, `${label} Chat output usage`);
  assert.equal(
    usage?.total_tokens ?? (usage?.prompt_tokens + usage?.completion_tokens),
    expected.total_tokens,
    `${label} Chat total usage`,
  );
}

function assertMessagesUsage(usage, expected, label) {
  assert.equal(usage?.input_tokens, expected.input_tokens, `${label} Messages input usage`);
  assert.equal(usage?.output_tokens, expected.output_tokens, `${label} Messages output usage`);
}

function assertResponsesUsage(usage, expected, label) {
  assert.deepEqual(usage, expected, `${label} Responses usage`);
}

export function assertStream(endpoint, text, label, usage = CONTROLLED_USAGE) {
  const records = parseSse(text);
  assert.ok(records.length > 0, "stream must contain events");
  assertEventSchema(records, endpoint);
  if (endpoint === "/v1/messages") {
    assert.equal(records[0].event, "message_start");
    assertSingleTerminal(records, ({ event }) => event === "message_stop", "Claude");
    assert.equal(records.at(-1).event, "message_stop");
    assert.deepEqual(records[0].data?.message?.usage, usage.messagesStream.initial, `${label} Messages initial usage`);
    const start = indexOfEvent(records, "content_block_start", "Claude content start");
    const delta = records[indexOfEvent(records, "content_block_delta", "Claude content delta")];
    const stop = indexOfEvent(records, "content_block_stop", "Claude content stop");
    const terminalIndex = indexOfEvent(records, "message_delta", "Claude terminal delta");
    const terminalDelta = records[terminalIndex];
    assert.equal(delta?.data?.type, "content_block_delta");
    assert.equal(terminalDelta?.data?.delta?.stop_reason, "end_turn");
    assert.deepEqual(terminalDelta?.data?.usage, usage.messagesStream.terminal, `${label} Messages terminal usage`);
    assert.ok(start < records.indexOf(delta) && records.indexOf(delta) < stop && stop < terminalIndex);
  } else if (endpoint === "/v1/responses") {
    assert.equal(records[0].event, "response.created");
    assertSingleTerminal(records, ({ event }) => event === "response.completed", "Responses");
    const itemAdded = indexOfEvent(records, "response.output_item.added", "Responses output item");
    const partAdded = indexOfEvent(records, "response.content_part.added", "Responses content part");
    const textDelta = indexOfEvent(records, "response.output_text.delta", "Responses text delta");
    const terminalIndex = indexOfEvent(records, "response.completed", "Responses terminal");
    const terminal = records[terminalIndex];
    assert.equal(terminal.event, "response.completed");
    assert.equal(terminal.data?.response?.status, "completed");
    assertResponsesUsage(terminal.data?.response?.usage, usage.responses, label);
    assert.ok(itemAdded < partAdded && partAdded < textDelta && textDelta < terminalIndex);
    assert.deepEqual(records.slice(terminalIndex + 1), [{ event: null, data: "[DONE]" }], `${label} permits only [DONE] framing after response.completed`);
  } else {
    assertSingleTerminal(records, ({ data }) => data === "[DONE]", "Chat Completions");
    assert.equal(records.at(-1).data, "[DONE]");
    const terminalChunk = records.find(({ data }) => data !== "[DONE]" && data?.choices?.some((choice) => choice.finish_reason));
    assert.equal(terminalChunk?.data?.choices?.[0]?.finish_reason, "stop");
    assertChatUsage(terminalChunk?.data?.usage, usage.chat, label);
    assert.ok(records.some(({ data }) => data !== "[DONE]" && data?.choices?.some((choice) => choice?.delta?.content)));
  }
  assert.match(text, /fixture-ok/);
}

export function assertJson(endpoint, body, usage = CONTROLLED_USAGE) {
  if (endpoint === "/v1/messages") {
    assert.equal(body.stop_reason, "end_turn");
    assertMessagesUsage(body.usage, usage.messages, "Messages JSON");
  } else if (endpoint === "/v1/responses") {
    assert.equal(body.status, "completed");
    assertResponsesUsage(body.usage, usage.responses, "Responses JSON");
  } else {
    assert.equal(body.choices[0].finish_reason, "stop");
    assertChatUsage(body.usage, usage.chat, "Chat JSON");
  }
  assert.match(JSON.stringify(body), /fixture-ok/);
}

export async function validateCapabilityManifest() {
  const manifest = await loadJson(manifestPath);
  assert.deepEqual(manifest.fixtureExpectations.usage, CONTROLLED_USAGE);
  assert.deepEqual(manifest.fixtureExpectations.outcomes, {
    "provider-error": { status: 529, error: { type: "server_error", code: "internal_server_error" } },
    "transport-abrupt": { status: 502, error: { type: "server_error", code: "bad_gateway" } },
  });
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

async function send(gatewayBaseUrl, entry, body, authorization, gatewayReceipt) {
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
  assert.match(
    response.headers.get("vary") || "",
    /next-router-state-tree/,
    `${entry.id} must receive a Next rewrite response`,
  );
  gatewayReceipt.responses += 1;
  const text = await response.text();
  return { response, text };
}

async function readControl(controlUrl) {
  const response = await fetch(controlUrl);
  assert.equal(response.status, 200, "provider stub control read");
  return response.json();
}

function assertDistinctOrigins(gatewayBaseUrl, providerControlUrl) {
  assert.notEqual(
    new URL(gatewayBaseUrl).origin,
    new URL(providerControlUrl).origin,
    "gateway and provider stub must use distinct origins",
  );
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

const declaredOutputBudget = (body) => body?.max_tokens ?? body?.max_output_tokens ?? null;

/**
 * Resolve the transforms the manifest declares for ONE cell. A transform is
 * matched on its exact source and target, so it licenses only the conversion
 * it names and never acts as a blanket exemption.
 */
export function cellTransforms(manifest, entry, target, modelCapabilities) {
  const source = ENDPOINT_SOURCE_FORMAT[entry.endpoint];
  return (manifest.providerTransforms || []).filter((transform) => {
    if (transform.kind !== "request" || transform.target !== target) return false;
    // A wildcard source is deliberate and is used only by a gate that is not
    // specific to a client format. Everything else matches exactly.
    if (transform.source !== "*" && transform.source !== source) return false;
    // A transform scoped to named scenarios applies ONLY to those, so the
    // Claude text cell never inherits the tool-cycle budget exemption.
    if (transform.appliesToScenarios && !transform.appliesToScenarios.includes(entry.scenario)) return false;
    return satisfiesCapabilityPredicate(transform, modelCapabilities);
  });
}

/**
 * A capability-conditional transform applies only where the target model's
 * DECLARED capabilities match its stated requirement. Absent or non-boolean
 * evidence grants nothing: a gate that cannot be shown to apply must not
 * license a missing control.
 */
function satisfiesCapabilityPredicate(transform, modelCapabilities) {
  const required = transform.requiresTargetCapability;
  if (!required) return true;
  for (const [capability, expected] of Object.entries(required)) {
    const declared = modelCapabilities?.[capability];
    if (typeof declared !== "boolean" || declared !== expected) return false;
  }
  return true;
}

function assertLatestSemanticReceipt(control, label, fixture, manifest, entry, target, modelCapabilities) {
  const receipt = control.semanticReceipts?.at(-1);
  assert.equal(receipt?.label, label, `${label} provider semantic receipt label`);
  const transforms = manifest ? cellTransforms(manifest, entry, target, modelCapabilities) : [];
  const budgetTransform = transforms.find(({ transform }) => transform === "output-budget-raised") || null;
  const sourceBudget = declaredOutputBudget(fixture);
  assertSemanticPreserved(fixture, receipt.semantic, label, {
    // Each declared control carries the exact value the transform predicts, so
    // a declaration cannot license an arbitrary new key.
    declaredControls: transforms.flatMap(({ expectsControls }) => expectsControls || []),
    // Only a transform whose capability predicate HELD contributes a gate.
    gatedControlKeys: transforms.flatMap(({ gatesControls }) => gatesControls || []),
    // A mapping waives its source control only when its exact replacement is
    // proven present, so a rename can never hide a silent drop.
    mappedControls: transforms.flatMap(({ mapsControl }) => mapsControl ? [mapsControl] : []),
    outputBudget: {
      source: sourceBudget,
      // No fallback. A receipt with no budget evidence must fail rather than
      // silently borrow the fixture's own value and compare equal.
      upstream: receipt.semantic?.shape?.outputBudget,
      declaredTransform: budgetTransform
        ? {
            id: budgetTransform.id,
            sourceBudget: budgetTransform.sourceBudget,
            expectedBudget: budgetTransform.expectedBudget,
          }
        : null,
    },
  });
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
  // The capability fixture upstream is an openai-compatible node, so every
  // cell lands on this target. A declared transform is matched against it, so
  // a transform for another target never licenses anything here.
  providerTargetFormat = "openai",
  // Evaluated against the SAME declaration that configures the started gateway,
  // never inferred from which controls happened to arrive.
  modelCapabilities = FIXTURE_MODEL_CAPABILITIES[FIXTURE_MODEL_ID],
}) {
  assert.equal(typeof gatewayBaseUrl, "string", "gatewayBaseUrl is required");
  assert.equal(typeof providerControlUrl, "string", "providerControlUrl is required");
  assert.ok(gatewayBaseUrl.length > 0, "gatewayBaseUrl is required");
  assert.ok(providerControlUrl.length > 0, "providerControlUrl is required");
  assertDistinctOrigins(gatewayBaseUrl, providerControlUrl);
  if (authorization != null) assert.equal(typeof authorization, "string", "authorization is a client credential string");
  if (model != null) assert.equal(typeof model, "string", "model override is a request model string");
  const manifest = await validateCapabilityManifest();
  const initialProvider = await readControl(providerControlUrl);
  const gatewayReceipt = { responses: 0 };
  const primary = { passed: 0, dispatched: 0, rejectedBeforeUpstream: 0 };
  for (const entry of manifest.primaryEndpoints) {
    const fixture = await loadJson(entry.fixture);
    const before = JSON.stringify(fixture);
    const validation = validatePrimaryFixture(entry, fixture);
    const providerBefore = await readControl(providerControlUrl);
    if (!entry.expected.upstreamDispatch) {
      assert.equal(validation.valid, false, `${entry.id} must reject locally`);
      const outbound = clone(fixture);
      outbound.stream = entry.stream;
      if (model) outbound.model = model;
      const { response } = await send(gatewayBaseUrl, entry, outbound, authorization, gatewayReceipt);
      assert.equal(response.status, entry.expected.status, `${entry.id} must return gateway ${entry.expected.status}`);
      const providerAfter = await readControl(providerControlUrl);
      assert.equal(providerAfter.providerDispatchCount, providerBefore.providerDispatchCount, `${entry.id} reached provider dispatch`);
      assert.equal(providerAfter.ingressCount, providerBefore.ingressCount, `${entry.id} reached provider ingress`);
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
    const { response, text } = await send(gatewayBaseUrl, entry, outbound, authorization, gatewayReceipt);
    assert.equal(response.status, 200, `${entry.id}: ${text.slice(0, 500)}`);
    if (entry.stream) assertStream(entry.endpoint, text, entry.id, manifest.fixtureExpectations.usage);
    else assertJson(entry.endpoint, JSON.parse(text), manifest.fixtureExpectations.usage);
    assert.equal(JSON.stringify(fixture), before, `${entry.id} mutated source fixture`);
    const providerAfter = await readControl(providerControlUrl);
    assert.equal(providerAfter.ingressCount, providerBefore.ingressCount + 1, `${entry.id} did not reach provider ingress exactly once`);
    assert.equal(providerAfter.providerDispatchCount, providerBefore.providerDispatchCount + 1, `${entry.id} did not reach provider exactly once`);
    assertLatestSemanticReceipt(providerAfter, entry.id, fixture, manifest, entry, providerTargetFormat, modelCapabilities);
    primary.dispatched += 1;
    primary.passed += 1;
  }

  const sample = manifest.primaryEndpoints.find((entry) => entry.endpoint === "/v1/chat/completions" && entry.scenario === "text" && !entry.stream);
  const body = await loadJson(sample.fixture);
  const outcomeBody = { ...body, ...(model ? { model } : {}), stream: false };
  await setStubOutcome(providerControlUrl, "success", "outcome-success");
  const success = await send(gatewayBaseUrl, sample, outcomeBody, authorization, gatewayReceipt);
  assert.equal(success.response.status, 200);
  assertLatestSemanticReceipt(await readControl(providerControlUrl), "outcome-success", body, manifest, sample, providerTargetFormat, modelCapabilities);
  await setStubOutcome(providerControlUrl, "provider-error", "outcome-provider-error");
  const providerError = await send(gatewayBaseUrl, sample, outcomeBody, authorization, gatewayReceipt);
  const providerErrorExpected = manifest.fixtureExpectations.outcomes["provider-error"];
  assert.equal(providerError.response.status, providerErrorExpected.status);
  const providerErrorBody = JSON.parse(providerError.text);
  assert.deepEqual(
    { type: providerErrorBody.error?.type, code: providerErrorBody.error?.code },
    providerErrorExpected.error,
    "provider error classification",
  );
  assertLatestSemanticReceipt(await readControl(providerControlUrl), "outcome-provider-error", body, manifest, sample, providerTargetFormat, modelCapabilities);
  await setStubOutcome(providerControlUrl, "transport-abrupt", "outcome-transport-abrupt");
  const abrupt = await send(gatewayBaseUrl, sample, outcomeBody, authorization, gatewayReceipt);
  const transportAbruptExpected = manifest.fixtureExpectations.outcomes["transport-abrupt"];
  assert.equal(abrupt.response.status, transportAbruptExpected.status, "abrupt transport status");
  const abruptBody = JSON.parse(abrupt.text);
  assert.deepEqual(
    { type: abruptBody.error?.type, code: abruptBody.error?.code },
    transportAbruptExpected.error,
    "abrupt transport classification",
  );
  assertLatestSemanticReceipt(await readControl(providerControlUrl), "outcome-transport-abrupt", body, manifest, sample, providerTargetFormat, modelCapabilities);
  const finalProvider = await readControl(providerControlUrl);
  const expectedSemanticLabels = [
    ...manifest.primaryEndpoints.filter((entry) => entry.expected.upstreamDispatch).map((entry) => entry.id),
    "outcome-success",
    "outcome-provider-error",
    "outcome-transport-abrupt",
  ].sort();
  const semanticReceipts = finalProvider.semanticReceipts || [];
  assert.deepEqual(
    semanticReceipts.map(({ label }) => label).sort(),
    expectedSemanticLabels,
    "provider recorded one redacted semantic receipt for every dispatch label",
  );
  const receipts = {
    nextGatewayResponses: gatewayReceipt.responses,
    providerIngress: {
      before: initialProvider.ingressCount,
      after: finalProvider.ingressCount,
      delta: finalProvider.ingressCount - initialProvider.ingressCount,
    },
    providerDispatch: {
      before: initialProvider.providerDispatchCount,
      after: finalProvider.providerDispatchCount,
      delta: finalProvider.providerDispatchCount - initialProvider.providerDispatchCount,
    },
    providerSemantic: Object.fromEntries(semanticReceipts.map(({ label, semantic }) => [label, semantic.digest])),
  };
  assert.equal(receipts.nextGatewayResponses, manifest.primaryEndpoints.length + 3, "all primary and outcome cases reached Next gateway");
  assert.equal(receipts.providerIngress.delta, primary.dispatched + 3, "only accepted primary and outcome cases reached provider ingress");
  assert.equal(receipts.providerDispatch.delta, primary.dispatched + 3, "only accepted primary and outcome cases dispatched provider");
  return {
    primary,
    outcomes: {
      success: 1,
      providerError: { status: providerError.response.status, ...providerErrorExpected.error },
      transportAbrupt: { status: abrupt.response.status, ...transportAbruptExpected.error },
    },
    receipts,
  };
}

export function resolveCliAuthorization(argv, env = process.env, read = readFileSync) {
  const authorizationEnvArg = argv.find((value) => value.startsWith("--authorization-env="));
  const authorizationFdArg = argv.find((value) => value.startsWith("--authorization-fd="));
  assert.equal(argv.some((value) => value.startsWith("--authorization=")), false, "authorization values must not be passed on argv");
  assert.ok(!(authorizationEnvArg && authorizationFdArg), "use one authorization source");
  let authorization = null;
  if (authorizationEnvArg) {
    const name = authorizationEnvArg.slice("--authorization-env=".length);
    assert.match(name, /^[A-Z][A-Z0-9_]*$/, "authorization environment variable name");
    authorization = env[name] || null;
  } else if (authorizationFdArg) {
    const fd = Number(authorizationFdArg.slice("--authorization-fd=".length));
    assert.ok(Number.isSafeInteger(fd) && fd >= 0, "authorization file descriptor");
    authorization = read(fd, "utf8");
  }
  return authorization == null ? null : authorization.trim() || null;
}

async function main() {
  const gatewayArg = process.argv.find((value) => value.startsWith("--gateway-base-url="));
  const controlArg = process.argv.find((value) => value.startsWith("--provider-control-url="));
  const modelArg = process.argv.find((value) => value.startsWith("--model="));
  assert.ok(gatewayArg, "pass --gateway-base-url for the started TokenProxy gateway");
  assert.ok(controlArg, "pass --provider-control-url for the started provider stub");
  const authorization = resolveCliAuthorization(process.argv);
  const report = await runCapabilityMatrix({
    gatewayBaseUrl: gatewayArg.slice("--gateway-base-url=".length),
    providerControlUrl: controlArg.slice("--provider-control-url=".length),
    model: modelArg?.slice("--model=".length) || null,
    authorization,
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
