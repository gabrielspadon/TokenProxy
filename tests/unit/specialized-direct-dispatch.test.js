import { beforeEach, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => fetchMock(...args) }));
import { BaseExecutor } from "../../open-sse/executors/base.js";
import { VertexExecutor } from "../../open-sse/executors/vertex.js";
import { GithubExecutor } from "../../open-sse/executors/github.js";
import { OllamaLocalExecutor } from "../../open-sse/executors/ollama-local.js";
import { MimoFreeExecutor, __test__ as mimo } from "../../open-sse/executors/mimo-free.js";

const body = () => ({ messages: [{ role: "user", content: "Keep 日本語 and 900719925474099312345" }] });
const credentials = { apiKey: "fixture", accessToken: "fixture", providerSpecificData: { projectId: "fixture" } };
const request = () => ({ model: "gpt-4.1", body: body(), stream: false, credentials });
const bootstrap = () => Response.json({ jwt: `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.fixture` });
beforeEach(() => { vi.restoreAllMocks(); fetchMock.mockReset(); mimo.resetJwtCache(); });

it.each(["vertex", "ollama", "github-messages", "github-responses"])("brackets the exact paid wire request for %s", async kind => {
  const executor = kind === "vertex" ? new VertexExecutor() : kind === "ollama" ? new OllamaLocalExecutor() : new GithubExecutor();
  const options = request();
  if (kind === "github-messages") options.model = "claude-sonnet-4.6";
  if (kind === "github-responses") executor.knownCodexModels.add(options.model);
  const events = [];
  let prepared;
  const response = new Response("fixture refusal", { status: 429 });
  const beforeDispatch = vi.fn(async event => { events.push("before"); prepared = event; });
  const afterDispatch = vi.fn(async event => { events.push("after"); expect(event.response).toBe(response); });
  fetchMock.mockImplementation(async (url, init) => {
    events.push("wire");
    expect(prepared.url).toBe(url);
    expect(prepared.serialized).toBe(init.body);
    expect(JSON.parse(init.body)).toEqual(prepared.body);
    return response;
  });
  const result = await executor.execute({ ...options, beforeDispatch, afterDispatch });
  expect(result.response).toBe(response);
  expect(executor.supportsBudgetDispatch).toBe(true);
  expect(events).toEqual(["before", "wire", "after"]);
  expect(await response.text()).toBe("fixture refusal");
});

it.each(["vertex", "github-messages", "github-responses"])("does not dispatch after a rejected reservation for %s", async kind => {
  const executor = kind === "vertex" ? new VertexExecutor() : new GithubExecutor();
  const options = request();
  if (kind === "github-messages") options.model = "claude-sonnet-4.6";
  if (kind === "github-responses") executor.knownCodexModels.add(options.model);
  const failure = new Error("budget denied");
  await expect(executor.execute({ ...options, beforeDispatch() { throw failure; } })).rejects.toBe(failure);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("forwards both hooks through the local Ollama override without inventing a dispatch", async () => {
  const beforeDispatch = vi.fn(), afterDispatch = vi.fn();
  const spy = vi.spyOn(BaseExecutor.prototype, "execute").mockResolvedValue({ url: "http://localhost/fixture" });
  const executor = new OllamaLocalExecutor();
  await executor.execute({ ...request(), beforeDispatch, afterDispatch });
  expect(spy.mock.calls[0][0]).toMatchObject({ beforeDispatch, afterDispatch });
  expect(executor.supportsBudgetDispatch).toBe(true);
  expect(beforeDispatch).not.toHaveBeenCalled();
  expect(afterDispatch).not.toHaveBeenCalled();
});

it("records MiMo auth replay as two paid dispatches and excludes bootstrap", async () => {
  const events = [], prepared = [];
  const refused = new Response("expired", { status: 401 });
  let calls = 0;
  fetchMock.mockImplementation(async (url, init) => {
    if (url === mimo.BOOTSTRAP_URL) { events.push("bootstrap"); return bootstrap(); }
    events.push("wire");
    expect(prepared.at(-1).serialized).toBe(init.body);
    return ++calls === 1 ? refused : Response.json({ choices: [] });
  });
  const executor = new MimoFreeExecutor();
  const result = await executor.execute({ ...request(),
    beforeDispatch(event) { events.push("before"); prepared.push(event); },
    afterDispatch({ response }) { events.push(`after-${response.status}`); },
  });
  expect(result.response.status).toBe(200);
  expect(events).toEqual(["bootstrap", "before", "wire", "after-401", "bootstrap", "before", "wire", "after-200"]);
  expect(prepared).toHaveLength(2);
  expect(refused.bodyUsed).toBe(true);
});

it("does not repeat a MiMo response marked unsafe to replay", async () => {
  const refused = new Response("uncertain", { status: 403, headers: { "x-tokenproxy-replay-safe": "false" } });
  fetchMock.mockResolvedValueOnce(bootstrap()).mockResolvedValueOnce(refused);
  const afterDispatch = vi.fn();
  const result = await new MimoFreeExecutor().execute({ ...request(), beforeDispatch: vi.fn(), afterDispatch });
  expect(result.response).toBe(refused);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(afterDispatch).toHaveBeenCalledOnce();
});

it("aborts a MiMo retry when the next reservation is refused", async () => {
  fetchMock.mockResolvedValueOnce(bootstrap()).mockResolvedValueOnce(new Response("expired", { status: 401 })).mockResolvedValueOnce(bootstrap());
  const beforeDispatch = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("second reservation denied"));
  await expect(new MimoFreeExecutor().execute({ ...request(), beforeDispatch, afterDispatch: vi.fn() })).rejects.toThrow("second reservation denied");
  expect(fetchMock.mock.calls.filter(([url]) => url === mimo.CHAT_URL)).toHaveLength(1);
});

it("never calls a paid endpoint when the caller was already cancelled", async () => {
  const controller = new AbortController(); controller.abort();
  for (const executor of [new MimoFreeExecutor(), new VertexExecutor()]) {
    await expect(executor.execute({ ...request(), signal: controller.signal, beforeDispatch: vi.fn() })).rejects.toThrow();
  }
  expect(fetchMock).not.toHaveBeenCalled();
});

it("marks only the recognized GitHub endpoint rejection as proven nonacceptance", async () => {
  const executor = new GithubExecutor();
  const refused = new Response("The requested model is not supported", { status: 400 });
  vi.spyOn(BaseExecutor.prototype, "execute").mockResolvedValue({ response: refused });
  const afterDispatch = vi.fn();
  const fallback = vi.spyOn(executor, "executeWithResponsesEndpoint").mockResolvedValue({ response: new Response("still refused", { status: 400 }) });
  await executor.execute({ ...request(), afterDispatch });
  expect(afterDispatch).toHaveBeenCalledWith({ response: refused, nonacceptance: "model-endpoint-unsupported" });
  expect(fallback).toHaveBeenCalledOnce();
  expect(refused.bodyUsed).toBe(true);
});

it("retains two distinct physical callbacks across actual GitHub endpoint fallback", async () => {
  const executor = new GithubExecutor(), events = [];
  const options = request();
  fetchMock.mockResolvedValueOnce(new Response("The requested model is not supported", { status: 400 }))
    .mockResolvedValueOnce(new Response("quota", { status: 429 }));
  const beforeDispatch = vi.fn(event => { events.push(["before", event.url]); });
  const afterDispatch = vi.fn(event => { events.push(["after", event.response.status, event.nonacceptance ?? null]); });
  const result = await executor.execute({ ...options, beforeDispatch, afterDispatch });
  expect(result.response.status).toBe(429);
  expect(beforeDispatch).toHaveBeenCalledTimes(2);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(events).toEqual([
    ["before", executor.config.baseUrl], ["after", 400, null],
    ["after", 400, "model-endpoint-unsupported"],
    ["before", executor.config.responsesUrl], ["after", 429, null],
  ]);
});

it("keeps replay-unsafe GitHub failures intact without trying another endpoint", async () => {
  const executor = new GithubExecutor();
  const response = new Response("The requested model is not supported", { status: 400, headers: { "x-tokenproxy-replay-safe": "false" } });
  vi.spyOn(BaseExecutor.prototype, "execute").mockResolvedValue({ response });
  const fallback = vi.spyOn(executor, "executeWithResponsesEndpoint");
  const result = await executor.execute(request());
  expect(result.response).toBe(response);
  expect(fallback).not.toHaveBeenCalled();
  expect(response.bodyUsed).toBe(false);
});

it("does not infer nonacceptance from an oversized GitHub diagnostic body", async () => {
  const executor = new GithubExecutor();
  const text = "The requested model is not supported" + "x".repeat(17000);
  const response = new Response(text, { status: 400 });
  vi.spyOn(BaseExecutor.prototype, "execute").mockResolvedValue({ response });
  const fallback = vi.spyOn(executor, "executeWithResponsesEndpoint"), afterDispatch = vi.fn();
  const result = await executor.execute({ ...request(), afterDispatch });
  expect(result.response).toBe(response);
  expect(fallback).not.toHaveBeenCalled();
  expect(afterDispatch).not.toHaveBeenCalled();
  expect(await result.response.text()).toBe(text);
});
