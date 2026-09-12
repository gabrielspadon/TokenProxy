#!/usr/bin/env node
import http from "node:http";
import { pathToFileURL } from "node:url";
import { semanticReceipt } from "./provider-semantic.mjs";

const ALLOWED_PORTS = new Set(Array.from({ length: 10 }, (_, index) => 20210 + index));
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const ENDPOINTS = new Set(["/v1/chat/completions", "/v1/messages", "/v1/responses"]);
const OUTCOMES = new Set(["success", "provider-error", "transport-abrupt"]);
const CONTROL_PATH = "/__tokenproxy_fixture/control";

function readJson(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reject(Object.assign(new Error("request too large"), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("invalid JSON"), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function writeJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function isMalformedClientRequest(pathname, body) {
  if (pathname === "/v1/responses") {
    if (!Array.isArray(body?.input)) return true;
    return body.input.some((item) => item?.type === "function_call" && (!item.name || !item.call_id));
  }
  return !Array.isArray(body?.messages);
}

function sse(response, events) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "close",
  });
  for (const event of events) {
    if (event.event) response.write(`event: ${event.event}\n`);
    response.write(`data: ${typeof event.data === "string" ? event.data : JSON.stringify(event.data)}\n\n`);
  }
  response.end();
}

function streamEvents(pathname) {
  if (pathname === "/v1/messages") {
    return [
      { event: "message_start", data: { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", content: [], model: "fixture-model", stop_reason: null, usage: { input_tokens: 7, output_tokens: 0 } } } },
      { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fixture-ok" } } },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } } },
      { event: "message_stop", data: { type: "message_stop" } },
    ];
  }
  if (pathname === "/v1/responses") {
    const response = { id: "resp_fixture", object: "response", status: "in_progress", model: "fixture-model", output: [] };
    const item = { id: "msg_fixture", type: "message", role: "assistant", status: "in_progress", content: [] };
    return [
      { event: "response.created", data: { type: "response.created", sequence_number: 0, response } },
      { event: "response.output_item.added", data: { type: "response.output_item.added", sequence_number: 1, output_index: 0, item } },
      { event: "response.content_part.added", data: { type: "response.content_part.added", sequence_number: 2, item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } } },
      { event: "response.output_text.delta", data: { type: "response.output_text.delta", sequence_number: 3, item_id: item.id, output_index: 0, content_index: 0, delta: "fixture-ok" } },
      { event: "response.output_text.done", data: { type: "response.output_text.done", sequence_number: 4, item_id: item.id, output_index: 0, content_index: 0, text: "fixture-ok" } },
      { event: "response.content_part.done", data: { type: "response.content_part.done", sequence_number: 5, item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "fixture-ok", annotations: [] } } },
      { event: "response.output_item.done", data: { type: "response.output_item.done", sequence_number: 6, output_index: 0, item: { ...item, status: "completed", content: [{ type: "output_text", text: "fixture-ok", annotations: [] }] } } },
      { event: "response.completed", data: { type: "response.completed", sequence_number: 7, response: { ...response, status: "completed", output: [{ ...item, status: "completed", content: [{ type: "output_text", text: "fixture-ok", annotations: [] }] }], usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 } } } },
    ];
  }
  return [
    { data: { id: "chatcmpl_fixture", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] } },
    { data: { id: "chatcmpl_fixture", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0, delta: { content: "fixture-ok" }, finish_reason: null }] } },
    { data: { id: "chatcmpl_fixture", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } } },
    { data: "[DONE]" },
  ];
}

function completion(pathname) {
  if (pathname === "/v1/messages") {
    return { id: "msg_fixture", type: "message", role: "assistant", model: "fixture-model", content: [{ type: "text", text: "fixture-ok" }], stop_reason: "end_turn", usage: { input_tokens: 7, output_tokens: 2 } };
  }
  if (pathname === "/v1/responses") {
    return { id: "resp_fixture", object: "response", status: "completed", model: "fixture-model", output: [{ id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "fixture-ok", annotations: [] }] }], usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 } };
  }
  return { id: "chatcmpl_fixture", object: "chat.completion", model: "fixture-model", choices: [{ index: 0, message: { role: "assistant", content: "fixture-ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } };
}

export async function startProviderStub({ host = "127.0.0.1", port = 20210, maxRequestBytes = MAX_REQUEST_BYTES } = {}) {
  if (!ALLOWED_PORTS.has(port)) throw new Error(`provider stub port must be in 20210-20219, got ${port}`);
  const ingress = [];
  const requests = [];
  let next = { outcome: "success", label: "unspecified" };
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, `http://${host}`).pathname;
    if (pathname === CONTROL_PATH) {
      if (request.method === "GET") {
        writeJson(response, 200, {
          ingressCount: ingress.length,
          providerDispatchCount: requests.length,
          // Retained for existing consumers. New contracts must name the
          // provider-dispatch counter so a malformed ingress is not mistaken
          // for an upstream call.
          requestCount: requests.length,
          semanticReceipts: requests.map(({ label, semantic }) => ({ label, semantic })),
          next,
        });
        return;
      }
      if (request.method === "POST") {
        try {
          const command = await readJson(request, 4096);
          if (!OUTCOMES.has(command?.outcome)) {
            writeJson(response, 400, { error: { type: "invalid_control" } });
            return;
          }
          next = {
            outcome: command.outcome,
            label: typeof command.label === "string" ? command.label.slice(0, 80) : "unspecified",
          };
          writeJson(response, 200, { accepted: true });
        } catch (error) {
          writeJson(response, error?.status || 400, { error: { type: "invalid_control" } });
        }
        return;
      }
    }
    if (request.method !== "POST" || !ENDPOINTS.has(pathname)) {
      writeJson(response, 404, { error: { type: "not_found" } });
      return;
    }
    try {
      // This receipt is intentionally before body parsing. A malformed body
      // reached this server even though it must never become a provider
      // dispatch, so one counter cannot prove both facts.
      ingress.push({
        pathname,
        bytes: Number(request.headers["content-length"] || 0),
        hasAuthorization: typeof request.headers.authorization === "string",
      });
      const body = await readJson(request, maxRequestBytes);
      if (isMalformedClientRequest(pathname, body)) {
        writeJson(response, 400, { error: { type: "invalid_request" } });
        return;
      }
      const { outcome, label } = next;
      next = { outcome: "success", label: "unspecified" };
      requests.push({
        pathname,
        label,
        model: typeof body?.model === "string" ? body.model : null,
        stream: body?.stream === true,
        outcome,
        bytes: Number(request.headers["content-length"] || 0),
        semantic: semanticReceipt(body),
      });
      if (outcome === "transport-abrupt") {
        response.socket?.destroy();
        return;
      }
      if (outcome === "provider-error") {
        writeJson(response, 529, { error: { type: "provider_error", code: "fixture_overloaded", message: "deterministic fixture failure" } });
        return;
      }
      if (body?.stream === true) sse(response, streamEvents(pathname));
      else writeJson(response, 200, completion(pathname));
    } catch (error) {
      if (!response.headersSent && !response.destroyed) writeJson(response, error?.status || 400, { error: { type: "invalid_request" } });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return {
    baseUrl: `http://${host}:${port}`,
    controlUrl: `http://${host}:${port}${CONTROL_PATH}`,
    ingress,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function main() {
  const arg = process.argv.find((value) => value.startsWith("--port="));
  const port = arg ? Number(arg.slice("--port=".length)) : 20210;
  const stub = await startProviderStub({ port });
  process.stdout.write(`${JSON.stringify({ ready: true, baseUrl: stub.baseUrl })}\n`);
  const close = async () => {
    await stub.close();
    process.exit(0);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
