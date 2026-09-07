#!/usr/bin/env node
/**
 * Reference sidecar for the `lingua` token-saver stage
 * (open-sse/utils/linguaCompress.js).
 *
 * Contract (the stage POSTs exactly this):
 *   POST /compress
 *   request:  { "text": string, "ratio": number }   // ratio in (0, 1]
 *   response: 200 { "text": string }                 // compressed text
 *
 * Failure shapes (the stage treats ANY non-200 as "does not apply" and
 * leaves the request body untouched):
 *   501 { "error": string }  the optional `llmlingua-2` package is not
 *                            importable (or exposes no usable compress fn)
 *   400 { "error": string }  unparsable JSON body, or missing/invalid fields
 *   404                      any other path or method
 *
 * llmlingua-2 is optional. When importable next to this script, its
 * compress(text, ratio) export (string or Promise<string>) is used; the
 * import is attempted once at startup, so installing or removing the
 * package requires a sidecar restart.
 *
 * Loopback only: binds 127.0.0.1 — prompt text never leaves the machine.
 *
 * Usage:
 *   node scripts/lingua-sidecar.mjs [port]     (default: env
 *     LINGUA_SIDECAR_PORT or 4891; port 0 = ephemeral, for tests)
 */
import http from "node:http";
import { pathToFileURL } from "node:url";

let compressFn = null;
let compressAttempted = false;

async function loadCompress() {
  if (compressAttempted) return compressFn;
  compressAttempted = true;
  try {
    const mod = await import("llmlingua-2");
    const fn =
      (typeof mod?.compress === "function" && mod.compress) ||
      (typeof mod?.default?.compress === "function" && mod.default.compress) ||
      (typeof mod?.default === "function" && mod.default) ||
      null;
    compressFn = fn;
  } catch {
    compressFn = null;
  }
  return compressFn;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

export async function createLinguaSidecar() {
  await loadCompress();
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/compress") {
      return sendJson(res, 404, { error: "not found: POST /compress only" });
    }
    let raw = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) {
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on("error", () => sendJson(res, 400, { error: "request error" }));
    req.on("end", async () => {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return sendJson(res, 400, { error: "invalid JSON body" });
      }
      if (typeof parsed?.text !== "string" || parsed.text.length === 0) {
        return sendJson(res, 400, { error: 'body must be { text: string, ratio: number }' });
      }
      if (
        typeof parsed.ratio !== "number" ||
        !Number.isFinite(parsed.ratio) ||
        parsed.ratio <= 0 ||
        parsed.ratio > 1
      ) {
        return sendJson(res, 400, { error: "ratio must be a number in (0, 1]" });
      }
      if (!compressFn) {
        return sendJson(res, 501, { error: "llmlingua-2 not available" });
      }
      try {
        const out = await compressFn(parsed.text, parsed.ratio);
        if (typeof out !== "string") {
          return sendJson(res, 501, { error: "llmlingua-2 returned a non-string" });
        }
        return sendJson(res, 200, { text: out });
      } catch {
        return sendJson(res, 500, { error: "compression failed" });
      }
    });
  });
  return server;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const port = Number(process.argv[2] ?? process.env.LINGUA_SIDECAR_PORT ?? 4891);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`lingua-sidecar: invalid port ${process.argv[2]}`);
    process.exit(2);
  }
  createLinguaSidecar().then((server) =>
    server.listen(port, "127.0.0.1", () => {
      console.log(
        `lingua-sidecar on 127.0.0.1:${server.address().port} (llmlingua-2: ${compressFn ? "loaded" : "absent — 501"})`,
      );
    }),
  );
}
