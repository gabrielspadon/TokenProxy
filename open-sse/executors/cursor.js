import { BaseExecutor } from "./base.js";
import { Buffer } from "node:buffer";
import { PROVIDERS, PROVIDER_OAUTH } from "../config/providers.js";
import { FETCH_CONNECT_TIMEOUT_MS, HTTP_STATUS } from "../config/runtimeConfig.js";
import {
  generateCursorBody,
  encodeField,
  encodeMcpTools,
  wrapConnectRPCFrame,
  decodeMessage,
  parseConnectRPCFrame,
  extractTextFromResponse
} from "../utils/cursorProtobuf.js";
import { buildCursorHeaders } from "../utils/cursorChecksum.js";
import { estimateUsage } from "../utils/usageTracking.js";
import { SSE_DONE, SSE_HEADERS } from "../utils/sseConstants.js";
import { chatChunkSse, sseChunk } from "../utils/sse.js";
import { FORMATS } from "../translator/formats.js";
import { proxyAwareFetch, resolveEffectiveProxyRoute } from "../utils/proxyFetch.js";
import { connectHttp2 as defaultConnectHttp2 } from "../utils/http2Connect.js";
import {
  createExecutorResponseHeaderTimeout,
  isConnectTimeoutError,
} from "../utils/responseHeaderTimeout.js";
import zlib from "zlib";
import crypto from "crypto";
import * as http2 from "node:http2";

// Detect cloud environment. No longer gates the http2 load (see below); kept
// because it is the only place this file states what a non-Node target looks
// like, and removing it would delete that knowledge rather than any behaviour.
const isCloudEnv = () => {
  if (typeof caches !== "undefined" && typeof caches === "object") return true;
  if (typeof EdgeRuntime !== "undefined") return true;
  return false;
};

// http2 is imported statically. The lazy form existed to keep node:http2 out of
// a cloud/edge bundle, but line 19 already pulls in ../utils/http2Connect.js,
// which imports node:http2 statically itself — so the guard has not kept it out
// of the graph for as long as that import has existed.
//
// It was briefly loaded through createRequire to avoid the top-level await that
// `await import()` needs when this ESM module is transpiled to CJS. A STATIC
// import needs no await either, and http2Connect.js has been doing exactly that
// all along, so the interop goal is met without the require: a createRequire
// resolution happens outside the test runner's module registry, which silently
// bypassed the suite's http2 mock and left 10 assertions in
// cursor-connect-timeout.test.js unable to observe anything.

const COMPRESS_FLAG = {
  NONE: 0x00,
  GZIP: 0x01,
  TRAILER: 0x02,
  GZIP_TRAILER: 0x03
};

const AGENT_RUN_PATH = "/agent.v1.AgentService/Run";
const PROTOBUF_LEN = 2;

function agentConnectionClosedError() {
  return Object.assign(new Error("Cursor AgentService closed before response headers"), {
    code: "http2_connection_closed",
  });
}

function concatBuffers(...parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

const agentString = (field, value) => encodeField(field, PROTOBUF_LEN, value);
const agentMessage = (field, value) => encodeField(field, PROTOBUF_LEN, value);

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function isAgentTextRequest(body) {
  // Many compatible clients always attach their built-in tool schemas, even
  // for a normal text turn. Cursor's retired ChatService rejects those
  // requests; AgentService can still answer the text turn, so ignore schemas
  // here. A real tool-call/result conversation is kept on the legacy path
  // until its AgentService tool protocol is implemented.
  return Array.isArray(body?.messages) && body.messages.every((message) => {
    if (message?.tool_calls?.length || message?.role === "tool") return false;
    return typeof message?.content === "string"
      || Array.isArray(message?.content) && message.content.every((part) => part?.type === "text");
  });
}

function encodeHistoryMessage(message) {
  let content = textFromContent(message?.content);
  // A tool-call turn carries no text; represent the call and its result as
  // text history so AgentService sees the full conversation rather than a gap.
  if (!content && message?.tool_calls?.length) {
    content = message.tool_calls
      .map((call) => `[tool_call ${call?.function?.name || ""} ${call?.function?.arguments || "{}"}]`)
      .join("\n");
  }
  if (content && message?.role === "tool") {
    content = `[tool_result ${message.tool_call_id || ""}] ${content}`;
  }
  if (!content) return null;

  // ConversationHistoryMessage.user / .assistant -> repeated content -> text.
  const text = agentString(1, content);
  if (message.role === "assistant") {
    return agentMessage(2, agentMessage(1, agentMessage(1, text)));
  }
  return agentMessage(1, agentMessage(1, agentMessage(1, text)));
}

export function isAgentCapableRequest(body) {
  // Wider than isAgentTextRequest: tool declarations and tool-call history are
  // representable in the AgentService frame; only non-text content is not.
  if (!Array.isArray(body?.messages) || body.messages.length === 0) return false;
  return body.messages.every((message) => {
    if (message?.role === "tool" || message?.tool_calls?.length) return true;
    if (message?.content == null) return false;
    return typeof message.content === "string"
      || Array.isArray(message.content) && message.content.every((part) => part?.type === "text");
  });
}

export function resolveCursorAgentModel(model) {
  const value = String(model || "");
  return /^claude-fable-/i.test(value) && value.endsWith("-fast")
    ? value.slice(0, -"-fast".length)
    : value;
}

export function buildAgentRunFrame(messages, model, tools = []) {
  const system = messages
    .filter((message) => message?.role === "system")
    .map((message) => textFromContent(message.content))
    .filter(Boolean)
    .join("\n\n");
  const chatMessages = messages.filter((message) => message?.role !== "system");
  const currentIndex = [...chatMessages].map((message) => message?.role).lastIndexOf("user");
  const current = currentIndex >= 0 ? chatMessages[currentIndex] : chatMessages.at(-1);
  const history = chatMessages
    .slice(0, currentIndex >= 0 ? currentIndex : -1)
    .map(encodeHistoryMessage)
    .filter(Boolean);
  const userText = textFromContent(current?.content) || "Continue.";

  // agent.v1.UserMessageAction.user_message and its optional history.
  const userMessage = concatBuffers(
    agentString(1, userText),
    agentString(2, crypto.randomUUID()),
  );
  const conversationHistory = history.length
    ? concatBuffers(...history.map((entry) => agentMessage(1, entry)))
    : null;
  const userAction = concatBuffers(
    agentMessage(1, userMessage),
    ...(conversationHistory ? [agentMessage(7, conversationHistory)] : []),
  );
  const conversationAction = agentMessage(1, userAction);
  const requestedModel = agentMessage(1, agentString(1, resolveCursorAgentModel(model)));
  const mcpTools = encodeMcpTools(tools);
  const runRequest = concatBuffers(
    // An empty ConversationStateStructure starts a fresh local agent session.
    agentMessage(1, new Uint8Array()),
    agentMessage(2, conversationAction),
    ...(mcpTools.length ? [agentMessage(4, mcpTools)] : []),
    ...(system ? [agentString(8, system)] : []),
    agentMessage(9, requestedModel),
  );

  // agent.v1.AgentClientMessage.run_request.
  return wrapConnectRPCFrame(agentMessage(1, runRequest));
}

function extractAgentString(message, field) {
  const value = message?.get(field)?.[0]?.value;
  return value ? Buffer.from(value).toString("utf8") : "";
}

function decodeAgentFrames(buffer, onFrame) {
  let pending = Buffer.from(buffer || []);
  while (pending.length >= 5) {
    const flags = pending[0];
    const length = pending.readUInt32BE(1);
    if (pending.length < 5 + length) break;
    let payload = pending.subarray(5, 5 + length);
    pending = pending.subarray(5 + length);
    if (flags & COMPRESS_FLAG.GZIP) {
      payload = zlib.gunzipSync(payload);
    }
    if (!(flags & COMPRESS_FLAG.TRAILER)) onFrame(payload);
  }
  return pending;
}

function createRequestContextResponse() {
  // AgentService asks every run for client context. tokenproxy has no IDE file
  // context, so acknowledge with an empty RequestContext.
  const requestContextSuccess = agentMessage(1, new Uint8Array());
  const requestContextResult = agentMessage(1, requestContextSuccess);
  const execClientMessage = agentMessage(10, requestContextResult);
  return wrapConnectRPCFrame(agentMessage(2, execClientMessage));
}

const CURSOR_STREAM_DEBUG = process.env.CURSOR_STREAM_DEBUG === "1";
const debugLog = (...args) => {
  if (CURSOR_STREAM_DEBUG) console.log(...args);
};

// Composer sends its visible answer inside the thinking field, after a
// </think> marker, instead of as text. Cursor's "default" entry is Auto
// (Server Picks) and the server routinely picks Composer for it, so keying the
// decode on the requested NAME alone dropped the whole reply and the client saw
// an empty response (#1077). Including "default" is fail-closed: a pick that is
// not Composer sends no </think>, so nothing extra is ever surfaced.
function isComposerModel(model) {
  const modelId = String(model || "").split("/").pop();
  return /^composer(?:-|$)/i.test(modelId) || modelId === "default";
}

// Composer prefixes its visible answer with a `<｜final｜>` sentinel, so the
// </think> split alone handed the raw token to the client ahead of every
// Composer answer (#1316).
const COMPOSER_FINAL_SENTINEL = "<｜final｜>";

function visibleComposerContentFromThinking(thinking) {
  if (!thinking) return "";
  const endTag = "</think>";
  const endIdx = thinking.lastIndexOf(endTag);
  if (endIdx < 0) return "";
  const visible = thinking.slice(endIdx + endTag.length).trimStart();
  return visible.startsWith(COMPOSER_FINAL_SENTINEL)
    ? visible.slice(COMPOSER_FINAL_SENTINEL.length).trimStart()
    : visible;
}

// Frames split the sentinel mid-token, so a tail that could still complete it
// has to wait for the next frame. Buffering on a bare "<" would stall every
// comparison and tag an answer contains, so only a tail that is itself a
// sentinel prefix is held; the caller flushes it once the stream ends (#1316).
function emittableComposerContent(visible) {
  const maxHold = Math.min(visible.length, COMPOSER_FINAL_SENTINEL.length - 1);
  for (let n = maxHold; n > 0; n--) {
    if (COMPOSER_FINAL_SENTINEL.startsWith(visible.slice(-n))) return visible.slice(0, -n);
  }
  return visible;
}

function decompressPayload(payload, flags) {
  // Check if payload is JSON error (starts with {"error")
  if (payload.length > 10 && payload[0] === 0x7b && payload[1] === 0x22) {
    try {
      const text = payload.toString("utf-8");
      if (text.startsWith('{"error"')) {
        debugLog(`[DECOMPRESS] Detected JSON error, skipping decompression`);
        return payload;
      }
    } catch {}
  }

  if (
    flags === COMPRESS_FLAG.GZIP ||
    flags === COMPRESS_FLAG.TRAILER ||
    flags === COMPRESS_FLAG.GZIP_TRAILER
  ) {
    // Primary: try gzip decompression (standard gzip header 0x1f 0x8b)
    try {
      return zlib.gunzipSync(payload);
    } catch (gzipErr) {
      // Fallback: TRAILER and GZIP_TRAILER frames sometimes use raw zlib deflate format
      try {
        return zlib.inflateSync(payload);
      } catch (deflateErr) {
        // Last resort: try raw deflate (no zlib header)
        try {
          return zlib.inflateRawSync(payload);
        } catch (rawErr) {
          debugLog(
            `[DECOMPRESS ERROR] flags=${flags}, payloadSize=${payload.length}, gzip=${gzipErr.message}, deflate=${deflateErr.message}, raw=${rawErr.message}`
          );
          debugLog(
            `[DECOMPRESS ERROR] First 50 bytes (hex):`,
            payload.slice(0, 50).toString("hex")
          );
          return payload;
        }
      }
    }
  }
  return payload;
}

// Read one cursor protobuf frame: header + bounds + decompress. Returns status + payload + new offset.
function readCursorFrame(buffer, offset, frameNum, tag) {
  if (offset + 5 > buffer.length) {
    debugLog(`[CURSOR BUFFER${tag}] Reached end, offset=${offset}, remaining=${buffer.length - offset}`);
    return { status: "done" };
  }

  const flags = buffer[offset];
  const length = buffer.readUInt32BE(offset + 1);
  debugLog(`[CURSOR BUFFER${tag}] Frame ${frameNum + 1}: flags=0x${flags.toString(16).padStart(2, "0")}, length=${length}`);

  if (offset + 5 + length > buffer.length) {
    debugLog(`[CURSOR BUFFER${tag}] Incomplete frame, offset=${offset}, length=${length}, buffer.length=${buffer.length}`);
    return { status: "done" };
  }

  let payload = buffer.slice(offset + 5, offset + 5 + length);
  const newOffset = offset + 5 + length;
  payload = decompressPayload(payload, flags);
  if (!payload) {
    debugLog(`[CURSOR BUFFER${tag}] Frame ${frameNum + 1}: decompression failed, skipping`);
    return { status: "skip", offset: newOffset };
  }
  return { status: "ok", payload, offset: newOffset };
}

function createErrorResponse(jsonError) {
  const errorMsg = jsonError?.error?.details?.[0]?.debug?.details?.title
    || jsonError?.error?.details?.[0]?.debug?.details?.detail
    || jsonError?.error?.message
    || "API Error";
  
  const isRateLimit = jsonError?.error?.code === "resource_exhausted";
  
  return new Response(JSON.stringify({
    error: {
      message: errorMsg,
      type: isRateLimit ? "rate_limit_error" : "api_error",
      code: jsonError?.error?.details?.[0]?.debug?.error || "unknown"
    }
  }), {
    status: isRateLimit ? HTTP_STATUS.RATE_LIMITED : HTTP_STATUS.BAD_REQUEST,
    headers: { "Content-Type": "application/json" }
  });
}

export class CursorExecutor extends BaseExecutor {
  constructor({ connectHttp2 = defaultConnectHttp2 } = {}) {
    super("cursor", PROVIDERS.cursor);
    this.connectHttp2 = connectHttp2;
  }

  buildUrl() {
    return `${this.config.baseUrl}${this.config.chatPath}`;
  }

  buildHeaders(credentials) {
    const accessToken = credentials.accessToken;
    const machineId = credentials.providerSpecificData?.machineId;
    const ghostMode = credentials.providerSpecificData?.ghostMode !== false;

    if (!machineId) {
      throw new Error("Machine ID is required for Cursor API");
    }

    return buildCursorHeaders(accessToken, machineId, ghostMode);
  }

  transformRequest(model, body, stream, credentials) {
    // Messages are already translated by chatCore (claude→openai→cursor)
    // Do NOT call openaiToCursorRequest again — double-translation drops tool_results
    const messages = body.messages || [];
    const tools = body.tools || [];
    const reasoningEffort = body.reasoning_effort || null;
    // Force Agent mode, or Cursor answers "Switch to Agent mode to apply all
    // changes" and the flow stops.
    //
    // This was a Claude Code user-agent allowlist (issue #643), which meant every
    // other agentic client hit the same wall and needed its own UA added —
    // opencode reported exactly that (#1008). The client's NAME was only ever a
    // proxy for the real signal: a request carrying tools is agentic by
    // definition. Both are checked, so this can only widen and no client that
    // worked before stops working.
    const ua = credentials?.rawHeaders?.["user-agent"] || "";
    const agenticUA = ua.includes("claude-cli") || ua.includes("claude-code") || ua.includes("Claude Code");
    const forceAgentMode = agenticUA || tools.length > 0;
    return generateCursorBody(messages, model, tools, reasoningEffort, forceAgentMode);
  }

  async makeFetchRequest(url, headers, body, signal, proxyOptions = null, connectTimeout = null) {
    const deadline = createExecutorResponseHeaderTimeout({
      connectTimeout,
      registryTimeout: this.config?.timeoutMs,
      envTimeout: FETCH_CONNECT_TIMEOUT_MS,
      signal,
    });
    let response;
    try {
      response = await proxyAwareFetch(url, {
        method: "POST",
        headers,
        body,
        signal: deadline.signal,
      }, proxyOptions);
    } catch (error) {
      throw deadline.classify(error);
    } finally {
      deadline.clear();
    }

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: Buffer.from(await response.arrayBuffer())
    };
  }

  makeHttp2Request(url, headers, body, signal, connectTimeout = null) {
    if (!http2) {
      throw new Error("http2 module not available");
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason || new DOMException("Request aborted", "AbortError"));
    }

    const HTTP2_TIMEOUT_MS = 60000; // 60s max — prevent hung sessions

    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const deadline = createExecutorResponseHeaderTimeout({
        connectTimeout,
        registryTimeout: this.config?.timeoutMs,
        envTimeout: FETCH_CONNECT_TIMEOUT_MS,
        signal,
      });
      const chunks = [];
      let responseHeaders = {};
      let settled = false;
      let client;
      let req;
      let hangTimeout;

      const onHeaderAbort = () => finish(reject)(deadline.classify(deadline.signal.reason));
      const onCallerAbort = () => finish(reject)(signal.reason || new DOMException("Request aborted", "AbortError"));

      // Ensure client is always closed on settle
      const finish = (fn) => (...args) => {
        if (settled) return;
        settled = true;
        deadline.clear();
        clearTimeout(hangTimeout);
        deadline.signal.removeEventListener("abort", onHeaderAbort);
        signal?.removeEventListener("abort", onCallerAbort);
        try { req?.destroy(); } catch {}
        try { client?.close(); } catch {}
        fn(...args);
      };

      try {
        client = http2.connect(`https://${urlObj.host}`);

        // Hard timeout: close session if server never responds
        hangTimeout = setTimeout(finish(() => {
          reject(new Error("HTTP/2 request timed out"));
        }), HTTP2_TIMEOUT_MS);

        client.on("error", finish(reject));

        req = client.request({
          ":method": "POST",
          ":path": urlObj.pathname,
          ":authority": urlObj.host,
          ":scheme": "https",
          ...headers
        });

        deadline.signal.addEventListener("abort", onHeaderAbort, { once: true });
        signal?.addEventListener("abort", onCallerAbort, { once: true });

        req.on("response", (hdrs) => {
          responseHeaders = hdrs;
          deadline.clear();
          deadline.signal.removeEventListener("abort", onHeaderAbort);
        });
        req.on("data", (chunk) => { chunks.push(chunk); });
        req.on("end", finish(() => {
          resolve({
            status: responseHeaders[":status"],
            headers: responseHeaders,
            body: Buffer.concat(chunks)
          });
        }));
        req.on("error", finish(reject));

        req.write(body);
        req.end();
      } catch (error) {
        finish(reject)(error);
      }
    });
  }

  /**
   * AgentService (agent.api5.cursor.sh) is HTTP/2-only. Node's fetch/undici speaks
   * HTTP/1.1 and fails with HTTPParserError on the h2 preface — use http2 duplex.
   */
  async openAgentHttp2Stream(url, headers, signal, proxyOptions = null, connectTimeout = null) {
    if (signal?.aborted) {
      throw signal.reason || new DOMException("Request aborted", "AbortError");
    }

    const urlObj = new URL(url);
    const deadline = createExecutorResponseHeaderTimeout({
      connectTimeout,
      registryTimeout: this.config?.timeoutMs,
      envTimeout: FETCH_CONNECT_TIMEOUT_MS,
      signal,
    });
    const route = resolveEffectiveProxyRoute(url, proxyOptions || {});
    const chunkQueue = [];
    let waiting = null;
    let ended = false;
    let streamError = null;
    let lease = null;
    let client = null;
    let req = null;
    let closed = false;
    let headersSettled = false;
    let resolveHeaders;
    let rejectHeaders;
    let onHeaderAbort;
    let onCallerAbort;

    const wake = (result) => {
      if (!waiting) return;
      const resolve = waiting;
      waiting = null;
      resolve(result);
    };

    const close = () => {
      if (closed) return;
      closed = true;
      deadline.clear();
      if (onHeaderAbort) deadline.signal.removeEventListener("abort", onHeaderAbort);
      if (onCallerAbort) signal?.removeEventListener("abort", onCallerAbort);
      try { req?.destroy(); } catch {}
      try { lease?.close(); } catch {}
    };

    const fail = (error) => {
      if (streamError) return;
      streamError = error;
      ended = true;
      if (!headersSettled) {
        headersSettled = true;
        rejectHeaders(error);
      }
      wake(null);
      close();
    };

    onHeaderAbort = () => fail(deadline.classify(deadline.signal.reason));
    onCallerAbort = () => fail(signal.reason || new DOMException("Request aborted", "AbortError"));

    const responseHeaders = new Promise((resolve, reject) => {
      resolveHeaders = resolve;
      rejectHeaders = reject;
    });

    try {
      lease = await this.connectHttp2(url, { route, signal: deadline.signal });
      if (!lease?.session || typeof lease.close !== "function") {
        throw new Error("Cursor AgentService adapter did not return a SessionLease");
      }
      if (deadline.signal.aborted) {
        throw deadline.classify(deadline.signal.reason);
      }
      client = lease.session;
      client.on("error", fail);

      req = client.request({
        ":method": "POST",
        ":path": urlObj.pathname,
        ":authority": urlObj.host,
        ":scheme": "https",
        ...headers,
      });

      req.on("error", fail);
      req.on("response", (hdrs) => {
        if (headersSettled) return;
        headersSettled = true;
        deadline.clear();
        deadline.signal.removeEventListener("abort", onHeaderAbort);
        resolveHeaders(hdrs);
      });
      req.on("data", (chunk) => {
        if (waiting) wake({ value: chunk, done: false });
        else chunkQueue.push(chunk);
      });
      req.on("end", () => {
        if (closed || ended) return;
        if (!headersSettled) {
          fail(agentConnectionClosedError());
          return;
        }
        ended = true;
        wake({ value: undefined, done: true });
        close();
      });
      req.once("close", () => {
        if (!closed && !ended) fail(agentConnectionClosedError());
      });

      deadline.signal.addEventListener("abort", onHeaderAbort, { once: true });
      signal?.addEventListener("abort", onCallerAbort, { once: true });
    } catch (error) {
      close();
      throw deadline.classify(error);
    }

    return {
      responseHeaders,
      write(frame) {
        if (req && !req.destroyed) req.write(Buffer.from(frame));
      },
      end() {
        try { if (req && !req.destroyed) req.end(); } catch {}
      },
      close,
      async read() {
        if (chunkQueue.length) return { value: chunkQueue.shift(), done: false };
        if (ended) {
          if (streamError) throw streamError;
          return { value: undefined, done: true };
        }
        const result = await new Promise((resolve) => { waiting = resolve; });
        if (streamError) throw streamError;
        return result || { value: undefined, done: true };
      },
    };
  }

  async executeAgent({ model, body, stream, credentials, signal, proxyOptions = null, connectTimeout = null }) {
    const agentEndpoint = PROVIDER_OAUTH.cursor?.agentEndpoint;
    if (!agentEndpoint) throw new Error("Cursor AgentService endpoint is not configured");

    const url = `${agentEndpoint}${AGENT_RUN_PATH}`;
    const headers = this.buildHeaders(credentials);
    const requestController = new AbortController();
    const onParentAbort = () => requestController.abort(signal.reason);
    let parentAbortAttached = false;
    const removeParentAbort = () => {
      if (!parentAbortAttached) return;
      parentAbortAttached = false;
      signal.removeEventListener("abort", onParentAbort);
    };
    if (signal?.aborted) {
      requestController.abort(signal.reason);
    } else if (signal?.addEventListener) {
      parentAbortAttached = true;
      signal.addEventListener("abort", onParentAbort, { once: true });
    }

    let session;
    try {
      session = await this.openAgentHttp2Stream(
        url,
        headers,
        requestController.signal,
        proxyOptions,
        connectTimeout,
      );
      const closeSession = session.close.bind(session);
      session.close = () => {
        removeParentAbort();
        closeSession();
      };
      session.write(buildAgentRunFrame(body.messages || [], model));
    } catch (error) {
      session?.close();
      removeParentAbort();
      if (error?.name === "AbortError" || isConnectTimeoutError(error)) throw error;
      throw new Error(`Cursor AgentService request failed: ${error.message}`);
    }

    let responseHeaders;
    try {
      responseHeaders = await session.responseHeaders;
    } catch (error) {
      session.close();
      if (error?.name === "AbortError" || isConnectTimeoutError(error)) throw error;
      throw new Error(`Cursor AgentService request failed: ${error.message}`);
    }

    const status = Number(responseHeaders[":status"] || 0);
    if (status !== 200) {
      let errorText = "";
      try {
        while (true) {
          const { done, value } = await session.read();
          if (done) break;
          errorText += Buffer.from(value).toString("utf8");
        }
      } catch (error) {
        session.close();
        if (error?.name === "AbortError" || isConnectTimeoutError(error)) throw error;
      }
      session.close();
      return {
        response: new Response(JSON.stringify({
          error: { message: `Cursor AgentService ${status}: ${errorText || "request failed"}`, type: "api_error" },
        }), { status: status || HTTP_STATUS.SERVER_ERROR, headers: { "Content-Type": "application/json" } }),
        url,
        headers,
        transformedBody: body,
        responseFormat: FORMATS.OPENAI,
      };
    }

    // The Claude SSE translator derives Anthropic's message ID by stripping
    // `chatcmpl-`. Keep the remaining ID in Anthropic's required `msg_` form
    // so strict clients such as Claude Code accept the completed stream.
    const responseId = `chatcmpl-msg_${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    let pending = Buffer.alloc(0);
    let finished = false;

    const consume = async (onEvent) => {
      try {
        while (!finished) {
          const { done, value } = await session.read();
          if (done) break;
          pending = Buffer.concat([pending, Buffer.from(value)]);
          pending = decodeAgentFrames(pending, (payload) => {
            // A single read can carry several frames; once the turn is over the
            // rest of the batch must not reach the already-closed controller.
            if (finished) return;
            const serverMessage = decodeMessage(payload);

            // agent.v1.AgentServerMessage.interaction_update
            if (serverMessage.has(1)) {
              const update = decodeMessage(serverMessage.get(1)[0].value);
              if (update.has(1)) {
                const textDelta = extractAgentString(decodeMessage(update.get(1)[0].value), 1);
                if (textDelta) onEvent({ type: "text", value: textDelta });
              }
              // Cursor's AgentService emits internal reasoning without the
              // cryptographic signature required by Anthropic thinking blocks.
              // Forwarding it makes strict Anthropic clients (Claude Code)
              // discard or wait on an otherwise complete response. Keep the
              // reasoning upstream-only and emit the normal answer text.
              if (update.has(14)) {
                finished = true;
                onEvent({ type: "done" });
              }
            }

            // AgentService requests IDE context before producing a response.
            // Return an empty context; tokenproxy is not coupled to an editor.
            if (serverMessage.has(2)) {
              const execRequest = decodeMessage(serverMessage.get(2)[0].value);
              if (execRequest.has(10)) {
                session.write(createRequestContextResponse());
              } else {
                // Every other ExecServerMessage variant is an editor-backed tool
                // (shell, read, write, …) that tokenproxy cannot service. Fail the
                // turn rather than narrating protocol state as assistant text.
                debugLog(`[CURSOR AGENT] Unsupported exec request fields: ${[...execRequest.keys()].join(",")}`);
                finished = true;
                onEvent({ type: "error", value: "Cursor AgentService requested an unsupported IDE tool" });
              }
            }
          });
        }
      } finally {
        try { session.end(); } catch {}
        try { session.close(); } catch {}
        if (!finished) onEvent({ type: "done" });
      }
    };

    if (stream === false) {
      let content = "";
      let agentError = null;
      await consume((event) => {
        if (event.type === "text") content += event.value;
        else if (event.type === "error") agentError = event.value;
      });
      if (agentError) {
        return {
          response: new Response(JSON.stringify({ error: { message: agentError, type: "api_error" } }), {
            status: HTTP_STATUS.BAD_REQUEST,
            headers: { "Content-Type": "application/json" },
          }),
          url,
          headers,
          transformedBody: body,
          responseFormat: FORMATS.OPENAI,
        };
      }
      return {
        response: new Response(JSON.stringify({
          id: responseId,
          object: "chat.completion",
          created,
          model,
          choices: [{ index: 0, message: { role: "assistant", content: content || null }, finish_reason: "stop" }],
          usage: estimateUsage(body, content.length, FORMATS.OPENAI),
        }), { headers: { "Content-Type": "application/json" } }),
        url,
        headers,
        transformedBody: body,
        responseFormat: FORMATS.OPENAI,
      };
    }

    const encoder = new TextEncoder();
    const responseStream = new ReadableStream({
      start(controller) {
        consume((event) => {
          if (event.type === "text") {
            controller.enqueue(encoder.encode(chatChunkSse({ id: responseId, created, model, delta: { content: event.value } })));
          } else if (event.type === "error") {
            // An SSE error frame, not a content delta: a protocol failure must not
            // be rendered to the user as the assistant's reply, and downstream
            // usage tracking must not record the turn as a success.
            controller.enqueue(encoder.encode(sseChunk({ error: { message: event.value, type: "api_error" } })));
            controller.enqueue(encoder.encode(SSE_DONE));
            controller.close();
          } else if (event.type === "done") {
            controller.enqueue(encoder.encode(chatChunkSse({ id: responseId, created, model, delta: {}, finishReason: "stop" })));
            controller.enqueue(encoder.encode(SSE_DONE));
            controller.close();
          }
        }).catch((error) => controller.error(error));
      },
      cancel() {
        requestController.abort();
      },
    });

    return {
      response: new Response(responseStream, { headers: SSE_HEADERS }),
      url,
      headers,
      transformedBody: body,
      responseFormat: FORMATS.OPENAI,
    };
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null, connectTimeout = null }) {
    if (isAgentTextRequest(body)) {
      try {
        return await this.executeAgent({ model, body, stream, credentials, signal, proxyOptions, connectTimeout });
      } catch (error) {
        if (error?.name === "AbortError" || isConnectTimeoutError(error)) throw error;
        return {
          response: new Response(JSON.stringify({
            error: { message: error.message, type: "connection_error", code: "" },
          }), { status: HTTP_STATUS.SERVER_ERROR, headers: { "Content-Type": "application/json" } }),
          url: `${PROVIDER_OAUTH.cursor?.agentEndpoint || ""}${AGENT_RUN_PATH}`,
          headers: {},
          transformedBody: body,
        };
      }
    }

    const url = this.buildUrl();
    const headers = this.buildHeaders(credentials);
    const transformedBody = this.transformRequest(model, body, stream, credentials);

    try {
      const shouldForceFetch = proxyOptions?.enabled === true || proxyOptions?.connectionProxyEnabled === true || !!proxyOptions?.vercelRelayUrl;
      const response = (http2 && !shouldForceFetch)
        ? await this.makeHttp2Request(url, headers, transformedBody, signal, connectTimeout)
        : await this.makeFetchRequest(url, headers, transformedBody, signal, proxyOptions, connectTimeout);

      if (response.status !== 200) {
        const errorText = response.body?.toString() || "Unknown error";
        const errorResponse = new Response(JSON.stringify({
          error: {
            message: `[${response.status}]: ${errorText}`,
            type: "invalid_request_error",
            code: ""
          }
        }), {
          status: response.status,
          headers: { "Content-Type": "application/json" }
        });
        return { response: errorResponse, url, headers, transformedBody: body };
      }

      if (!response.body || response.body.length === 0) {
        const errorResponse = new Response(JSON.stringify({
          error: {
            message: "Cursor returned an empty response body",
            type: "upstream_error",
            code: "missing_response_body",
          },
        }), {
          status: HTTP_STATUS.BAD_GATEWAY,
          headers: { "Content-Type": "application/json" },
        });
        return { response: errorResponse, url, headers, transformedBody: body };
      }

      const transformedResponse = stream !== false
        ? this.transformProtobufToSSE(response.body, model, body)
        : this.transformProtobufToJSON(response.body, model, body);

      return { response: transformedResponse, url, headers, transformedBody: body };
    } catch (error) {
      if (error?.name === "AbortError" || isConnectTimeoutError(error)) throw error;
      const errorResponse = new Response(JSON.stringify({
        error: {
          message: error.message,
          type: "connection_error",
          code: ""
        }
      }), {
        status: HTTP_STATUS.SERVER_ERROR,
        headers: { "Content-Type": "application/json" }
      });
      return { response: errorResponse, url, headers, transformedBody: body };
    }
  }

  transformProtobufToJSON(buffer, model, body) {
    const responseId = `chatcmpl-cursor-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    let offset = 0;
    let totalContent = "";
    let totalThinking = "";
    const toolCalls = [];
    const toolCallsMap = new Map(); // Track streaming tool calls by ID
    const finalizedIds = new Set();
    let frameCount = 0;

    debugLog(`[CURSOR BUFFER] Total length: ${buffer.length} bytes`);

    while (offset < buffer.length) {
      const frame = readCursorFrame(buffer, offset, frameCount, "");
      if (frame.status === "done") break;
      offset = frame.offset;
      frameCount++;
      if (frame.status === "skip") continue;
      const payload = frame.payload;

      // Check for JSON error frames (byte guard: skip toString on non-JSON frames)
      if (payload.length > 0 && payload[0] === 0x7b) {
        try {
          const text = payload.toString("utf-8");
          if (text.includes('"error"')) {
            const hasContent = totalContent || toolCallsMap.size > 0;
            debugLog(
              `[CURSOR BUFFER] Error frame (hasContent=${hasContent}): ${text.slice(0, 500)}`
            );
            if (hasContent) {
              break;
            }
            return createErrorResponse(JSON.parse(text));
          }
        } catch {}
      }

      const result = extractTextFromResponse(new Uint8Array(payload));
      debugLog(`[CURSOR DECODED] Frame ${frameCount}:`, result);

      if (result.error) {
        const hasContent = totalContent || toolCallsMap.size > 0;
        debugLog(`[CURSOR BUFFER] Decoded error (hasContent=${hasContent}): ${result.error}`);
        if (hasContent) {
          break;
        }
        return new Response(
          JSON.stringify({
            error: {
              message: result.error,
              type: "rate_limit_error",
              code: "rate_limited"
            }
          }),
          {
            status: HTTP_STATUS.RATE_LIMITED,
            headers: { "Content-Type": "application/json" }
          }
        );
      }

      if (result.toolCall) {
        const tc = result.toolCall;

        if (toolCallsMap.has(tc.id)) {
          // Accumulate arguments for existing tool call
          const existing = toolCallsMap.get(tc.id);
          existing.function.arguments += tc.function.arguments;
          existing.isLast = tc.isLast;
        } else {
          // New tool call
          toolCallsMap.set(tc.id, { ...tc });
        }

        // Push to final array when isLast is true
        if (tc.isLast) {
          const finalToolCall = toolCallsMap.get(tc.id);
          finalizedIds.add(tc.id);
          toolCalls.push({
            id: finalToolCall.id,
            type: finalToolCall.type,
            function: {
              name: finalToolCall.function.name,
              arguments: finalToolCall.function.arguments
            }
          });
        }
      }

      if (result.text) totalContent += result.text;
      if (result.thinking) totalThinking += result.thinking;
    }

    const visibleComposerContent = isComposerModel(model)
      ? visibleComposerContentFromThinking(totalThinking)
      : "";
    const finalContent = totalContent || visibleComposerContent;

    debugLog(
      `[CURSOR BUFFER] Parsed ${frameCount} frames, toolCallsMap size: ${toolCallsMap.size}, finalized toolCalls: ${toolCalls.length}`
    );

    // Finalize all remaining tool calls in map (in case stream ended without isLast=true)
    for (const [id, tc] of toolCallsMap.entries()) {
      // Check if already in final array
      if (!finalizedIds.has(id)) {
        debugLog(`[CURSOR BUFFER] Finalizing incomplete tool call: ${id}, isLast=${tc.isLast}`);
        toolCalls.push({
          id: tc.id,
          type: tc.type,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments
          }
        });
      }
    }

    debugLog(`[CURSOR BUFFER] Final toolCalls count: ${toolCalls.length}`);


    const message = {
      role: "assistant",
      content: finalContent || null
    };

    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }

    const usage = estimateUsage(body, finalContent.length, FORMATS.OPENAI);

    const completion = {
      id: responseId,
      object: "chat.completion",
      created,
      model,
      choices: [{
        index: 0,
        message,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop"
      }],
      usage
    };

    return new Response(JSON.stringify(completion), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  transformProtobufToSSE(buffer, model, body) {
    const responseId = `chatcmpl-cursor-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    const chunks = [];
    let offset = 0;
    let totalContent = "";
    let totalThinking = "";
    let emittedComposerThinkingContentLength = 0;
    const toolCalls = [];
    const toolCallsMap = new Map(); // Track streaming tool calls by ID
    const finalizedIds = new Set();
    const emittedToolCallIds = new Set();
    let frameCount = 0;
    const emitComposerContent = (visible) => {
      if (visible.length <= emittedComposerThinkingContentLength) return;
      const deltaContent = visible.slice(emittedComposerThinkingContentLength);
      emittedComposerThinkingContentLength = visible.length;
      totalContent += deltaContent;
      chunks.push(chatChunkSse({
        id: responseId, created, model,
        delta:
          chunks.length === 0 && toolCalls.length === 0
            ? { role: "assistant", content: deltaContent }
            : { content: deltaContent }
      }));
    };

    debugLog(`[CURSOR BUFFER SSE] Total length: ${buffer.length} bytes`);

    while (offset < buffer.length) {
      const frame = readCursorFrame(buffer, offset, frameCount, " SSE");
      if (frame.status === "done") break;
      offset = frame.offset;
      frameCount++;
      if (frame.status === "skip") continue;
      const payload = frame.payload;

      // Check for JSON error frames (byte-guard: only decode if starts with '{')
      if (payload[0] === 0x7b) {
        try {
          const text = payload.toString("utf-8");
          if (text.includes('"error"')) {
            const hasContent = chunks.length > 0 || totalContent || toolCallsMap.size > 0;
            debugLog(
              `[CURSOR BUFFER SSE] Error frame (hasContent=${hasContent}): ${text.slice(0, 500)}`
            );
            if (hasContent) {
              break;
            }
            return createErrorResponse(JSON.parse(text));
          }
        } catch {}
      }

      const result = extractTextFromResponse(new Uint8Array(payload));
      debugLog(`[CURSOR DECODED SSE] Frame ${frameCount}:`, result);

      if (result.error) {
        const hasContent = chunks.length > 0 || totalContent || toolCallsMap.size > 0;
        debugLog(`[CURSOR BUFFER SSE] Decoded error (hasContent=${hasContent}): ${result.error}`);
        if (hasContent) {
          break;
        }
        return new Response(
          JSON.stringify({
            error: {
              message: result.error,
              type: "rate_limit_error",
              code: "rate_limited"
            }
          }),
          {
            status: HTTP_STATUS.RATE_LIMITED,
            headers: { "Content-Type": "application/json" }
          }
        );
      }

      if (result.toolCall) {
        const tc = result.toolCall;

        if (chunks.length === 0) {
          chunks.push(chatChunkSse({ id: responseId, created, model, delta: { role: "assistant", content: "" } }));
        }

        if (toolCallsMap.has(tc.id)) {
          // Accumulate arguments for existing tool call
          const existing = toolCallsMap.get(tc.id);
          const oldArgsLen = existing.function.arguments.length;
          existing.function.arguments += tc.function.arguments;
          existing.isLast = tc.isLast;

          // Stream the delta arguments
          if (tc.function.arguments) {
            emittedToolCallIds.add(tc.id);
            chunks.push(chatChunkSse({
              id: responseId, created, model,
              delta: {
                tool_calls: [
                  {
                    index: existing.index,
                    id: tc.id,
                    type: "function",
                    function: {
                      name: tc.function.name,
                      arguments: tc.function.arguments
                    }
                  }
                ]
              }
            }));
          }
        } else {
          // New tool call - assign index and add to map
          const toolCallIndex = toolCalls.length;
          finalizedIds.add(tc.id);
          toolCalls.push({ ...tc, index: toolCallIndex });
          toolCallsMap.set(tc.id, { ...tc, index: toolCallIndex });

          // Stream initial tool call with name
          emittedToolCallIds.add(tc.id);
          chunks.push(chatChunkSse({
            id: responseId, created, model,
            delta: {
              tool_calls: [
                {
                  index: toolCallIndex,
                  id: tc.id,
                  type: "function",
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments
                  }
                }
              ]
            }
          }));
        }
      }

      if (result.text) {
        totalContent += result.text;
        chunks.push(chatChunkSse({
          id: responseId, created, model,
          delta:
            chunks.length === 0 && toolCalls.length === 0
              ? { role: "assistant", content: result.text }
              : { content: result.text }
        }));
      }

      if (isComposerModel(model) && result.thinking) {
        totalThinking += result.thinking;
        emitComposerContent(
          emittableComposerContent(visibleComposerContentFromThinking(totalThinking))
        );
      }
    }

    debugLog(
      `[CURSOR BUFFER SSE] Parsed ${frameCount} frames, toolCallsMap size: ${toolCallsMap.size}, toolCalls array: ${toolCalls.length}`
    );

    // Finalize all remaining tool calls in map (stream may have ended without isLast=true)
    for (const [id, tc] of toolCallsMap.entries()) {
      if (!finalizedIds.has(id)) {
        debugLog(`[CURSOR BUFFER SSE] Finalizing incomplete tool call: ${id}, isLast=${tc.isLast}`);
        const toolCallIndex = toolCalls.length;
        toolCalls.push({
          id: tc.id,
          type: tc.type,
          index: toolCallIndex,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments
          }
        });

        // Emit SSE chunk for the finalized tool call if not already emitted
        if (!emittedToolCallIds.has(tc.id)) {
          chunks.push(chatChunkSse({
            id: responseId, created, model,
            delta: {
              tool_calls: [
                {
                  index: toolCallIndex,
                  id: tc.id,
                  type: "function",
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments
                  }
                }
              ]
            }
          }));
        }
      }
    }

    // A tail held back as a possible sentinel prefix is ordinary content once
    // the stream is over, so flush it rather than swallowing it (#1316).
    if (isComposerModel(model)) {
      emitComposerContent(visibleComposerContentFromThinking(totalThinking));
    }

    if (chunks.length === 0 && toolCalls.length === 0) {
      chunks.push(chatChunkSse({ id: responseId, created, model, delta: { role: "assistant", content: "" } }));
    }

    const usage = estimateUsage(body, totalContent.length, FORMATS.OPENAI);

    chunks.push(
      `data: ${JSON.stringify({
        id: responseId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop"
          }
        ],
        usage
      })}\n\n`
    );
    chunks.push(SSE_DONE);

    return new Response(chunks.join(""), {
      status: 200,
      headers: { ...SSE_HEADERS }
    });
  }

  async refreshCredentials() {
    return null;
  }
}

export default CursorExecutor;
