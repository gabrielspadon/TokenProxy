import "../qa/gateway-performance/aliases.mjs";
import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NextRequest } from "next/server.js";

const port = Number(process.env.CAPABILITY_GATEWAY_PORT);
const providerBaseUrl = process.env.CAPABILITY_PROVIDER_BASE_URL;
const authFile = process.env.CAPABILITY_AUTH_FILE;
if (!Number.isInteger(port) || port < 20210 || port > 20219) {
  throw new Error("CAPABILITY_GATEWAY_PORT must be in 20210-20219");
}
if (!providerBaseUrl || !authFile) throw new Error("Capability gateway fixture requires provider and auth paths");

const { createProviderNode } = await import("../../src/lib/db/repos/nodesRepo.js");
const { createProviderConnection } = await import("../../src/lib/db/repos/connectionsRepo.js");
const { createApiKey } = await import("../../src/lib/db/repos/apiKeysRepo.js");
const { updateSettings } = await import("../../src/lib/db/repos/settingsRepo.js");

const nodeId = "capability-fixture-openai";
await createProviderNode({
  id: nodeId,
  type: "openai-compatible",
  prefix: "fixture",
  name: "Capability fixture upstream",
  apiType: "chat",
  baseUrl: providerBaseUrl,
});
await createProviderConnection({
  provider: nodeId,
  authType: "apikey",
  name: "Capability fixture account",
  apiKey: "fixture-upstream-key",
  isActive: true,
  testStatus: "active",
  providerSpecificData: { baseUrl: providerBaseUrl },
});
await updateSettings({
  requireApiKey: true,
  requireLogin: false,
  rtkEnabled: false,
  headroomEnabled: false,
  pxpipeEnabled: false,
  contextStructureEnabled: false,
  storeRequestDetails: false,
  backgroundTokenRefreshEnabled: false,
});
const fixtureKey = await createApiKey("capability-gateway", "controlled-loopback");
await writeFile(authFile, `Bearer ${fixtureKey.key}\n`, { mode: 0o600 });

const [{ POST: chatPost }, { POST: messagesPost }, { POST: responsesPost }] = await Promise.all([
  import("../../src/app/api/v1/chat/completions/route.js"),
  import("../../src/app/api/v1/messages/route.js"),
  import("../../src/app/api/v1/responses/route.js"),
]);

const GATEWAY_CONTROL_PATH = "/__tokenproxy_fixture/gateway-control";
const ingress = [];
const handlerFor = (pathname) => ({
  "/v1/chat/completions": chatPost,
  "/v1/messages": messagesPost,
  "/v1/responses": responsesPost,
}[pathname]);

const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, `http://127.0.0.1:${port}`).pathname;
  if (pathname === "/__ready") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ready: true }));
    return;
  }
  if (pathname === GATEWAY_CONTROL_PATH) {
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ gatewayIngressCount: ingress.length }));
    return;
  }

  const post = handlerFor(pathname);
  if (request.method !== "POST" || !post) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { type: "not_found" } }));
    return;
  }

  // This is the product ingress receipt. It is recorded before NextRequest
  // consumes/parses the body, so malformed client requests have evidence that
  // they reached the real TokenProxy route while provider dispatch remains 0.
  ingress.push({ pathname, bytes: Number(request.headers["content-length"] || 0) });
  const abort = new AbortController();
  response.on("close", () => {
    if (!response.writableFinished) abort.abort(new DOMException("client disconnected", "AbortError"));
  });
  try {
    const nextRequest = new NextRequest(`http://127.0.0.1:${port}${request.url}`, {
      method: request.method,
      headers: request.headers,
      signal: abort.signal,
      body: Readable.toWeb(request),
      duplex: "half",
    });
    const result = await post(nextRequest);
    response.writeHead(result.status, Object.fromEntries(result.headers));
    if (result.body) await pipeline(Readable.fromWeb(result.body), response);
    else response.end();
  } catch (error) {
    if (abort.signal.aborted) return;
    if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { type: "gateway_fixture_failure", message: String(error?.message || error) } }));
  }
});

server.listen(port, "127.0.0.1");
const close = () => server.close(() => process.exit(0));
process.once("SIGTERM", close);
process.once("SIGINT", close);
