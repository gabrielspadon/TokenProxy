// Build a base64 data URI from mime + base64 payload
export function encodeDataUri(mimeType, base64) {
  return `data:${mimeType};base64,${base64}`;
}

// Parse a base64 data URI → { mimeType, base64 }, or null if not a data URI.
// [\s\S] tolerates newlines inside the base64 payload.
const DATA_URI_RE = /^data:([^;]+);base64,([\s\S]+)$/;
export function parseDataUri(url) {
  if (typeof url !== "string") return null;
  const m = url.match(DATA_URI_RE);
  return m ? { mimeType: m[1], base64: m[2] } : null;
}

// The Vercel AI SDK sends multimodal image parts as
// { type: "image", image: "data:...;base64,..." } (or a plain http(s) URL),
// distinct from OpenAI's { type: "image_url", image_url: { url } } and from the
// Claude-shaped passthrough block { type: "image", source: { type: "base64", ... } }
// some clients already send under the same "image" type. Every OpenAI-input
// translator that only read image_url.url silently dropped this shape, so an
// image an OpenAI-compatible client sent never reached a vision-capable
// provider (#1330). Returns the raw url/data-uri string, or null if `part`
// isn't this shape.
export function extractAiSdkImageUrl(part) {
  if (part?.type !== "image" || part.source) return null;
  return typeof part.image === "string" && part.image ? part.image : null;
}

// Kiro's tool result carries text and nothing else: its content is [{ text }].
// A tool that returns an image (an MCP read_media_file, a screenshot tool) had
// its image parts mapped to "" by every Kiro translator, so the model answered
// about a picture it was never shown, and in the Claude translator an
// image-only result fell through to JSON.stringify and shipped the whole base64
// payload as tool text — costing the tokens without delivering the image (#2521).
//
// Kiro does have a vision channel, userInputMessage.images, which the direct
// attachment path already fills. Split a tool result into the text Kiro can
// carry and the images to hoist into that channel, leaving a marker behind so
// the turn still reads as having produced something.
export function splitToolResultMedia(content) {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) {
    return { text: content ? JSON.stringify(content) : "", images: [] };
  }

  const textParts = [];
  const images = [];
  for (const part of content) {
    // Claude shape: { type: "image", source: { type: "base64", media_type, data } }
    if (part?.type === "image" && part.source?.type === "base64" && part.source?.data) {
      const mediaType = part.source.media_type || "image/png";
      images.push({ format: mediaType.split("/")[1] || mediaType, source: { bytes: part.source.data } });
      textParts.push("[Image returned by tool]");
      continue;
    }
    // OpenAI shape: { type: "image_url", image_url: { url: "data:...;base64,..." } }
    if (part?.type === "image_url") {
      const parsed = parseDataUri(part.image_url?.url || "");
      if (parsed) {
        images.push({
          format: parsed.mimeType.split("/")[1] || parsed.mimeType,
          source: { bytes: parsed.base64 },
        });
        textParts.push("[Image returned by tool]");
      } else if (typeof part.image_url?.url === "string" && part.image_url.url) {
        // Kiro takes base64 only, so a remote URL stays as text rather than
        // being fetched here: that would be an outbound request on a translation
        // path, and image.js already gates those behind an SSRF check elsewhere.
        textParts.push(`[Image: ${part.image_url.url}]`);
      }
      continue;
    }
    if (typeof part?.text === "string") {
      textParts.push(part.text);
      continue;
    }
    // Anything else keeps its old behaviour of being serialised, EXCEPT that a
    // part carrying base64 image data is never stringified into the text.
    if (part !== undefined && part !== null) textParts.push(JSON.stringify(part));
  }

  return { text: textParts.join("\n"), images };
}

import { lookup } from "node:dns/promises";
import { Agent } from "undici";
import { MAX_IMAGE_BYTES, FETCH_TIMEOUT_MS, IMAGE_SIGNATURES, BLOCKED_HOSTS } from "../../config/mediaConfig.js";
import { preparationSignal, waitForPreparation } from "../../utils/preparationAbort.js";

// True if an IPv4/IPv6 address is private/reserved (SSRF target).
function isPrivateIp(ip) {
  if (!ip) return true;
  // IPv6 loopback / unique-local / link-local
  if (ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80")) return true;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) -> extract tail
  const v4 = ip.includes(".") ? ip.split(":").pop() : ip;
  const parts = v4.split(".").map((n) => Number.parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return ip.includes(":") ? false : true;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

// Resolve host once and return only public IPs (SSRF guard).
// Rejects if any resolved record is private/reserved (defeats multi-A tricks).
async function resolvePinnedIps(hostname) {
  if (!hostname || BLOCKED_HOSTS.has(hostname.toLowerCase())) return null;
  try {
    const records = await lookup(hostname, { all: true });
    if (!records.length || records.some((r) => isPrivateIp(r.address))) return null;
    return records;
  } catch {
    return null;
  }
}

// Verify buffer magic bytes match a known image signature; return its mime or null.
function detectImageMime(buf) {
  for (const { sig, offset, mime, verifyWebp } of IMAGE_SIGNATURES) {
    if (buf.length < offset + sig.length) continue;
    let match = true;
    for (let i = 0; i < sig.length; i++) {
      if (buf[offset + i] !== sig[i]) { match = false; break; }
    }
    if (!match) continue;
    // WEBP: RIFF....WEBP — bytes 8..11 must be "WEBP".
    if (verifyWebp && !(buf.length >= 12 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50)) continue;
    return mime;
  }
  return null;
}

/**
 * Fetch a remote image URL and return it as a base64 data URI.
 * Hardened against SSRF (private/metadata IPs), memory DoS (size cap),
 * and disguised non-image payloads (magic-byte verification).
 * Returns null on fetch/validation failure; caller cancellation propagates.
 *
 * @param {string} imageUrl - HTTP(S) URL of the image
 * @param {object} options - { signal, timeoutMs, maxBytes, consumeBytes }
 * @returns {Promise<{url: string, mimeType: string, byteLength: number}|null>}
 */
export async function fetchImageAsBase64(imageUrl, options = {}) {
  const { signal, timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_IMAGE_BYTES, consumeBytes } = options;
  signal?.throwIfAborted();
  if (!imageUrl || (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://"))) {
    return null;
  }

  let url;
  try { url = new URL(imageUrl); } catch { return null; }
  const fetchSignal = preparationSignal(signal, timeoutMs);
  let dispatcher, reader, response, complete = false;
  try {
    const pinnedIps = await waitForPreparation(resolvePinnedIps(url.hostname), fetchSignal);
    fetchSignal.throwIfAborted();
    if (!pinnedIps) return null;
    // Pin connect to the validated IP so no second DNS resolution can rebind.
    dispatcher = new Agent({
      connect: { lookup: (_h, _o, cb) => cb(null, [{ address: pinnedIps[0].address, family: pinnedIps[0].family }]) },
    });
    // redirect:"manual" prevents a public URL redirecting to a private one (SSRF bypass).
    response = await waitForPreparation(fetch(imageUrl, { signal: fetchSignal, redirect: "manual", dispatcher }), fetchSignal,
      late => late.body?.cancel());
    if (!response.ok || !response.body) return null;

    // Stream-read with a hard byte cap to avoid loading huge payloads into memory.
    reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await waitForPreparation(reader.read(), fetchSignal);
      fetchSignal.throwIfAborted();
      if (done) { complete = true; break; }
      total += value.length;
      if (total > Math.min(maxBytes, MAX_IMAGE_BYTES)) return null;
      consumeBytes?.(value.length);
      chunks.push(value);
    }

    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const mimeType = detectImageMime(buf);
    if (!mimeType) return null; // not a recognized image — reject disguised payloads

    return { url: `data:${mimeType};base64,${buf.toString("base64")}`, mimeType, byteLength: total };
  } catch {
    signal?.throwIfAborted();
    return null;
  } finally {
    if (!complete) {
      try { await (reader ? reader.cancel() : response?.body?.cancel()); } catch { /* transport already aborted */ }
    }
    try { reader?.releaseLock?.(); } catch { /* no owned lock remains */ }
    if (dispatcher) {
      try { await (complete ? dispatcher.close() : dispatcher.destroy()); } catch { /* already closed */ }
    }
  }
}
