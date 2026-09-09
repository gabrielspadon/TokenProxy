import { stageErrorCode } from "./stageOutcome.js";
/**
 * LLMLingua-2 selective compression (context-tuning suite, task 4).
 *
 * Long agent sessions accumulate fat natural-language payloads: chatty tool
 * output, logs, prose. The model rarely re-reads them verbatim below the
 * recent tail, and LLMLingua-2-style compressors shrink such text while
 * keeping meaning. This stage sends qualifying blobs to an optional local
 * sidecar (env TOKENPROXY_LINGUA_ENDPOINT) and replaces the block text in
 * place. Messages are never dropped or reordered, and pair structure
 * (tool_use/tool_result ids, block order) is untouched.
 *
 * A blob is a CANDIDATE only when every gate passes:
 *   epoch        message index > epochCutIndex (never at or before the cut;
 *                cut 0 = stable/unknown epoch = skip the stage entirely)
 *   role         user text blocks, user tool_result payloads, and OpenAI
 *                role:"tool" string messages only; system messages and the
 *                latest assistant turn are never candidates
 *   live tail    nothing at or after the last user message is a candidate —
 *                the live instruction is never compressed (same tail
 *                protection as pairDropper keepRecentTurns 6, qac 2,
 *                epochCompact keepLastTurns 4, diet minAgeTurns)
 *   anchor       block carries no cache_control anchor
 *   size         payload >= minChars (default 5120)
 *   content      NOT code or structured data (skipCode): JSON (starts with
 *                { or [ and parses), code fences (```), diff hunks (@@ or
 *                diff --git), or the code heuristic (>= 30% of lines
 *                matching /^\s*(import|export|function|class|const|let|var|
 *                if|for|while|return|def|fn|public|private|#include)/)
 *
 * Ratio derivation: each blob is compressed toward <= LINGUA_TARGET_CHARS
 * (4096) chars out, ratio = min(0.5, 4096/chars): a 6 KB blob asks for half
 * its chars back, a 40 KB blob asks for 4096/40000 ≈ 0.1.
 *
 * Backend contract: POST {text, ratio} JSON -> 200 {text} JSON, 30 s timeout,
 * aborted when the request aborts. The endpoint MUST be loopback-only
 * (hostname localhost/127.0.0.1/::1, or a Unix socket path): prompt text is
 * never forwarded to a remote host, and a non-loopback endpoint refuses the
 * stage outright. Any failure (no endpoint, refused endpoint, network error,
 * non-200, schema mismatch, abort) reports applied:false, leaves the body
 * byte-identical, and puts the reason ONLY in this module's debug log —
 * saver events carry no free-text failure detail.
 */

import http from "node:http";
import { ROLE, CLAUDE_BLOCK } from "../translator/schema/index.js";

const DEFAULT_MIN_CHARS = 5120;
const LINGUA_TARGET_CHARS = 4096;
const LINGUA_MAX_RATIO = 0.5;
const LINGUA_TIMEOUT_MS = 30_000;
const ENV_ENDPOINT = "TOKENPROXY_LINGUA_ENDPOINT";
const DIFF_HUNK_RE = /^(?:@@|diff --git)/m;
const CODE_LINE_RE =
  /^\s*(?:import|export|function|class|const|let|var|if|for|while|return|def|fn|public|private|#include)/;
const CODE_LINE_FRACTION = 0.3;
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function unchanged(messages, skip) {
  const out = { applied: false, messages, compressedBlocks: 0, savedChars: 0 };
  if (skip) { out.skip = skip; out.outcome = "skipped"; out.errorCode = null; }
  return out;
}

// Endpoint env read at REQUEST time (never at import): operators point it at
// a sidecar without a restart, and tests redirect it per request.
export function resolveLinguaEndpoint() {
  const raw = process.env[ENV_ENDPOINT];
  return typeof raw === "string" ? raw.trim() : "";
}

// Loopback/Unix-host gate: prompt text must never leave the machine. HTTP
// endpoints must name localhost/127.0.0.1/::1; anything else (a remote host,
// an IP literal that is not loopback) refuses the stage. A bare absolute
// path is a Unix socket.
export function classifyEndpoint(endpoint) {
  if (!endpoint) return { kind: "none" };
  if (endpoint.startsWith("/")) return { kind: "unix", socketPath: endpoint };
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    return { kind: "refused", reason: "unparseable" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { kind: "refused", reason: `protocol ${parsed.protocol}` };
  }
  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
    return { kind: "refused", reason: `host ${parsed.hostname}` };
  }
  return { kind: "http", url: parsed };
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    if (typeof part === "string") text += part;
    else if (typeof part?.text === "string") text += part.text;
  }
  return text;
}

// Content classifier: JSON blobs, fenced code, diff hunks, and keyword-heavy
// text are structured/code, not natural language, and are never compressed.
export function looksLikeCodeOrData(text, { skipCode = true } = {}) {
  if (!skipCode) return false;
  if (typeof text !== "string") return true;
  if (text.includes("```")) return true;
  if (DIFF_HUNK_RE.test(text)) return true;
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(text);
      return true;
    } catch {
      // Unparsable JSON-shaped text falls through to the line heuristic.
    }
  }
  const lines = text.split("\n");
  if (lines.length === 0) return false;
  let codeLines = 0;
  for (const line of lines) {
    if (CODE_LINE_RE.test(line)) codeLines += 1;
  }
  return codeLines / lines.length >= CODE_LINE_FRACTION;
}

function ratioFor(chars) {
  return Math.min(LINGUA_MAX_RATIO, LINGUA_TARGET_CHARS / chars);
}

function composeSignal(signal) {
  const timeout = AbortSignal.timeout(LINGUA_TIMEOUT_MS);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);
  return timeout;
}

async function readJsonBody(res, cap = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  const stream = res.body ?? res;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > cap) throw new Error("response too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function callHttpEndpoint(url, payload, { signal, fetchImpl }) {
  // The endpoint names the sidecar host; the contract path is /compress.
  const postUrl = url.pathname && url.pathname !== "/" ? url : new URL("/compress", url);
  const res = await fetchImpl(postUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: composeSignal(signal),
  });
  if (!res.ok) { await res.body?.cancel(); throw Object.assign(new Error("sidecar HTTP error"), { code: "service_http_error" }); }
  const parsed = await readJsonBody(res);
  if (!parsed || typeof parsed.text !== "string") throw new Error("schema mismatch");
  return parsed.text;
}

async function callUnixSocket(socketPath, payload, { signal }) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: "/compress",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        signal: composeSignal(signal),
      },
      async (res) => {
        try {
          if (res.statusCode !== 200) throw new Error(`status ${res.statusCode}`);
          const parsed = await readJsonBody(res);
          if (!parsed || typeof parsed.text !== "string") throw new Error("schema mismatch");
          resolve(parsed.text);
        } catch (err) {
          reject(err);
        }
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/**
 * Compress natural-language-ish user/tool_result blobs via the loopback
 * sidecar. Fail-closed: ANY backend failure (or a schema mismatch on ANY
 * response) reports applied:false and leaves the input byte-identical — a
 * partially compressed body would both lie about the epoch boundary and
 * split the cache prefix mid-stage.
 *
 * Options:
 *   epochCutIndex  number  REQUIRED-ish; messages at or before this index are
 *                          never mutated. 0 (default) skips the stage.
 *   endpoint       string  sidecar URL or Unix socket path (default read from
 *                          TOKENPROXY_LINGUA_ENDPOINT by the caller); empty =
 *                          inert, skip "no_backend".
 *   minChars       number  default 5120; shorter blobs survive.
 *   skipCode       boolean default true; the content classifier gate.
 *   signal         AbortSignal  caller abort propagates to the backend call.
 *   log            debug-log sink; failure reasons land here, never in events.
 *   fetchImpl      fetch override (tests); defaults to global fetch.
 *
 * Returns { applied, messages, compressedBlocks, savedChars, skip? }.
 * messages is the input reference when nothing was compressed.
 */
export async function compressBlobs(body, options = {}) {
  options.signal?.throwIfAborted();
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return unchanged(messages, "invalid_input");
  }
  const cut = Math.max(0, Math.floor(Number(options.epochCutIndex) || 0));
  if (cut === 0) return unchanged(messages, "epoch_boundary");
  const endpoint = typeof options.endpoint === "string" ? options.endpoint.trim() : "";
  if (!endpoint) return unchanged(messages, "no_backend");
  const minChars = Math.max(1, Math.floor(Number(options.minChars) || DEFAULT_MIN_CHARS));
  const skipCode = options.skipCode !== false;
  const log = options.log;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const target = classifyEndpoint(endpoint);
  if (target.kind === "refused" || target.kind === "none") {
    log?.debug?.("LINGUA", `endpoint refused: ${target.reason || "empty"}`);
    return { ...unchanged(messages, "endpoint_refused"), outcome: "failed", errorCode: "invalid_configuration" };
  }
  if (target.kind === "http" && typeof fetchImpl !== "function") {
    log?.debug?.("LINGUA", "no fetch implementation available");
    return { ...unchanged(messages, "backend_error"), outcome: "failed", errorCode: "invalid_response" };
  }

  // Candidate collection: {i, blockIndex|null, text, chars, field}; blockIndex
  // null = whole-message (OpenAI role:"tool" string). field is the payload key
  // the compressed text replaces ("text" for text blocks, "content" for
  // tool_result payloads and OpenAI tool messages). Mirrors diet's shapes.
  // The live tail is protected exactly like the sibling stages (pairDropper
  // keepRecentTurns 6, qac 2, epochCompact keepLastTurns 4, diet minAgeTurns
  // + reference scan): nothing at or after the last user message is ever a
  // candidate, so the live instruction is never compressed.
  const lastUserIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === ROLE.USER) return i;
    }
    return messages.length;
  })();
  const candidates = [];
  messages.forEach((msg, i) => {
    if (i <= cut || i >= lastUserIndex || !msg || typeof msg !== "object") return;
    if (msg.role === ROLE.TOOL && typeof msg.content === "string") {
      candidates.push({ i, blockIndex: null, text: msg.content, chars: msg.content.length, field: "content" });
      return;
    }
    if (msg.role !== ROLE.USER || !Array.isArray(msg.content)) return;
    msg.content.forEach((block, blockIndex) => {
      if (!block || typeof block !== "object") return;
      if (block.cache_control) return;
      if (block.type === CLAUDE_BLOCK.TEXT && typeof block.text === "string") {
        candidates.push({ i, blockIndex, text: block.text, chars: block.text.length, field: "text" });
        return;
      }
      if (block.type !== CLAUDE_BLOCK.TOOL_RESULT) return;
      const text = extractText(block.content);
      candidates.push({ i, blockIndex, text, chars: text.length, field: "content" });
    });
  });

  const eligible = candidates.filter(
    (c) => c.chars >= minChars && !looksLikeCodeOrData(c.text, { skipCode }),
  );
  if (eligible.length === 0) return unchanged(messages);

  const call = (text, ratio) =>
    target.kind === "unix"
      ? callUnixSocket(target.socketPath, { text, ratio }, { signal: options.signal })
      : callHttpEndpoint(target.url, { text, ratio }, { signal: options.signal, fetchImpl });

  let compressed;
  try {
    compressed = await Promise.all(
      eligible.map((c) => call(c.text, ratioFor(c.chars))),
    );
  } catch (err) {
    options.signal?.throwIfAborted();
    log?.debug?.("LINGUA", "backend failure");
    return { ...unchanged(messages, "backend_error"), outcome: "failed", errorCode: stageErrorCode(err) };
  }

  options.signal?.throwIfAborted();
  const replacementByKey = new Map();
  const charsByKey = new Map();
  let any = false;
  for (let k = 0; k < eligible.length; k++) {
    const text = compressed[k];
    if (typeof text !== "string") {
      log?.debug?.("LINGUA", "backend failure: schema mismatch");
      return { ...unchanged(messages, "backend_error"), outcome: "failed", errorCode: "invalid_response" };
    }
    if (text.length === 0 || text === eligible[k].text) continue;
    const key = `${eligible[k].i}:${eligible[k].blockIndex ?? -1}`;
    replacementByKey.set(key, { text, field: eligible[k].field });
    charsByKey.set(key, eligible[k].chars);
    any = true;
  }
  if (!any) return unchanged(messages);

  // Apply: replace the block payload in place. Message count, block count,
  // order, ids, and untouched entries are preserved by reference.
  let compressedBlocks = 0;
  let savedChars = 0;
  const out = messages.map((msg, i) => {
    if (i <= cut || !msg || typeof msg !== "object") return msg;
    if (msg.role === ROLE.TOOL && typeof msg.content === "string") {
      const replacement = replacementByKey.get(`${i}:-1`);
      if (!replacement) return msg;
      compressedBlocks += 1;
      savedChars += charsByKey.get(`${i}:-1`) - replacement.text.length;
      return { ...msg, content: replacement.text };
    }
    if (msg.role !== ROLE.USER || !Array.isArray(msg.content)) return msg;
    let changed = false;
    const blocks = msg.content.map((block, blockIndex) => {
      const key = `${i}:${blockIndex}`;
      const replacement = replacementByKey.get(key);
      if (!replacement || !block || typeof block !== "object") return block;
      changed = true;
      compressedBlocks += 1;
      savedChars += charsByKey.get(key) - replacement.text.length;
      return { ...block, [replacement.field]: replacement.text };
    });
    return changed ? { ...msg, content: blocks } : msg;
  });
  return { applied: true, messages: out, compressedBlocks, savedChars };
}
