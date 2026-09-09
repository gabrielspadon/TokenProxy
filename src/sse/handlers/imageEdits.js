import { withResourceAdmission } from '../services/resourceAdmission.js';
import { Buffer } from "node:buffer";
import { handleImageGeneration } from "./imageGeneration.js";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";

// OpenAI's images.edit accepts png/jpeg/webp; gif rides the same data-URL
// transport, so it is allowed too. Membership is decided by MAGIC BYTES, never
// by the client's Content-Type: sniffing both preserves the real type in the
// data URL and stops a mislabelled payload from reaching a provider.
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_IMAGES = 16;

// Everything else is dropped rather than forwarded, so a field no adapter can
// translate cannot reach an upstream as an unexpected key.
const PASSTHROUGH_FIELDS = [
  "size", "quality", "background", "output_format", "output_compression",
  "moderation", "image_detail", "n", "response_format", "style", "user",
];
const NUMERIC_FIELDS = new Set(["n", "output_compression"]);

function sniffMime(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 6 && bytes.toString("latin1", 0, 3) === "GIF") return "image/gif";
  return null;
}

function encodeImage(bytes, label) {
  if (!bytes?.length) return { error: `Empty image (${label})` };
  if (bytes.length > MAX_FILE_BYTES) {
    return { error: `Image ${label} is ${bytes.length} bytes, over the ${MAX_FILE_BYTES}-byte per-file limit` };
  }
  const mime = sniffMime(bytes);
  if (!ALLOWED_MIME.has(mime)) {
    return { error: `Unsupported image format (${label}); supported: ${[...ALLOWED_MIME].join(", ")}` };
  }
  return { dataUrl: `data:${mime};base64,${bytes.toString("base64")}`, bytes: bytes.length };
}

// A string source is a data URL or bare base64. A remote http(s) URL is
// REJECTED rather than fetched: several adapters resolve such a URL from this
// process (open-sse/handlers/imageProviders/cloudflareAi.js:46), so accepting
// one here would make /v1/images/edits an SSRF gadget against loopback.
function decodeStringSource(value, label) {
  const trimmed = String(value).trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return { error: `Remote image URLs are not accepted (${label}); upload the file or send a data: URL` };
  }
  const dataMatch = /^data:([^;,]+);base64,(.*)$/is.exec(trimmed);
  const b64 = dataMatch ? dataMatch[2] : trimmed;
  if (!b64) return { error: `Empty image (${label})` };
  // 4 base64 chars per 3 bytes — checked before decoding so an oversized
  // payload is refused without materialising it.
  if (b64.length / 4 * 3 > MAX_FILE_BYTES) {
    return { error: `Image ${label} is over the ${MAX_FILE_BYTES}-byte per-file limit` };
  }
  return encodeImage(Buffer.from(b64, "base64"), label);
}

function jsonSourceToString(entry, label) {
  if (typeof entry === "string") return { value: entry };
  if (!entry || typeof entry !== "object") return { error: `Unsupported image reference (${label})` };
  if (entry.file_id !== undefined) {
    return { error: `file_id references are not supported (${label}); send the image bytes instead` };
  }
  const url = typeof entry.image_url === "string" ? entry.image_url
    : typeof entry.image_url?.url === "string" ? entry.image_url.url
    : typeof entry.url === "string" ? entry.url
    : typeof entry.b64_json === "string" ? entry.b64_json
    : null;
  if (!url) return { error: `Unsupported image reference (${label}); expected a data URL string or { image_url }` };
  return { value: url };
}

async function collectMultipart(request) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return { status: HTTP_STATUS.BAD_REQUEST, error: "Invalid multipart/form-data body" };
  }

  const fields = {};
  for (const key of ["model", "prompt", ...PASSTHROUGH_FIELDS]) {
    const value = form.get(key);
    if (typeof value === "string" && value !== "") fields[key] = value;
  }

  // Both conventions OpenAI clients emit for a multi-image edit.
  const parts = [...form.getAll("image"), ...form.getAll("image[]")];
  const sources = [];
  for (const [index, part] of parts.entries()) {
    const label = `image[${index}]`;
    if (typeof part === "string") {
      sources.push({ raw: part, label });
      continue;
    }
    if (typeof part?.arrayBuffer !== "function") {
      return { status: HTTP_STATUS.BAD_REQUEST, error: `Unsupported image part (${label})` };
    }
    if (part.size > MAX_FILE_BYTES) {
      return { status: HTTP_STATUS.PAYLOAD_TOO_LARGE, error: `Image ${label} is ${part.size} bytes, over the ${MAX_FILE_BYTES}-byte per-file limit` };
    }
    sources.push({ bytes: Buffer.from(await part.arrayBuffer()), label });
  }

  return { fields, sources, hasMask: form.has("mask") };
}

async function collectJson(request) {
  let raw;
  try {
    raw = await request.json();
  } catch {
    return { status: HTTP_STATUS.BAD_REQUEST, error: "Invalid JSON body" };
  }
  if (!raw || typeof raw !== "object") {
    return { status: HTTP_STATUS.BAD_REQUEST, error: "Invalid JSON body" };
  }

  const fields = {};
  for (const key of ["model", "prompt", ...PASSTHROUGH_FIELDS]) {
    if (raw[key] !== undefined && raw[key] !== null && raw[key] !== "") fields[key] = raw[key];
  }

  const entries = [];
  if (Array.isArray(raw.images)) entries.push(...raw.images);
  if (raw.image !== undefined) entries.push(...(Array.isArray(raw.image) ? raw.image : [raw.image]));

  const sources = [];
  for (const [index, entry] of entries.entries()) {
    const label = `image[${index}]`;
    const resolved = jsonSourceToString(entry, label);
    if (resolved.error) return { status: HTTP_STATUS.BAD_REQUEST, error: resolved.error };
    sources.push({ raw: resolved.value, label });
  }

  return { fields, sources, hasMask: raw.mask !== undefined && raw.mask !== null };
}

/**
 * Parse an OpenAI-compatible images/edits request into the internal image body
 * this repo's adapters already consume (`image` + `images` data URLs), so edits
 * ride the existing generation pipeline instead of a second one.
 *
 * @param {Request} request
 * @returns {Promise<{ body: object } | { status: number, error: string }>}
 */
export async function buildImageEditBody(request) {
  const contentType = (request.headers.get("content-type") || "").toLowerCase();
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TOTAL_BYTES) {
    return { status: HTTP_STATUS.PAYLOAD_TOO_LARGE, error: `Request body exceeds the ${MAX_TOTAL_BYTES}-byte limit` };
  }

  let collected;
  if (contentType.startsWith("multipart/form-data")) {
    // ponytail: a chunked upload with no content-length is bounded only by the
    // per-file and total checks below, after formData() has buffered it. Swap
    // in a streaming multipart parser if a real client ever needs that.
    collected = await collectMultipart(request);
  } else if (contentType.includes("json") || contentType === "") {
    collected = await collectJson(request);
  } else {
    return { status: HTTP_STATUS.BAD_REQUEST, error: `Unsupported Content-Type '${contentType}'; use multipart/form-data or application/json` };
  }
  if (collected.error) return collected;

  const { fields, sources, hasMask } = collected;

  // No adapter in this tree translates a mask (nothing reads `body.mask`), so
  // accepting one would silently drop it and return an edit of the whole image.
  if (hasMask) {
    return { status: HTTP_STATUS.BAD_REQUEST, error: "mask is not supported by any provider routed here; omit it" };
  }
  if (!fields.model) return { status: HTTP_STATUS.BAD_REQUEST, error: "Missing model" };
  if (!fields.prompt) return { status: HTTP_STATUS.BAD_REQUEST, error: "Missing required field: prompt" };
  if (sources.length === 0) return { status: HTTP_STATUS.BAD_REQUEST, error: "Missing required field: image" };
  if (sources.length > MAX_IMAGES) {
    return { status: HTTP_STATUS.BAD_REQUEST, error: `At most ${MAX_IMAGES} source images per request` };
  }

  const dataUrls = [];
  let total = 0;
  for (const source of sources) {
    const encoded = source.bytes
      ? encodeImage(source.bytes, source.label)
      : decodeStringSource(source.raw, source.label);
    if (encoded.error) {
      const tooBig = encoded.error.includes("per-file limit");
      return { status: tooBig ? HTTP_STATUS.PAYLOAD_TOO_LARGE : HTTP_STATUS.BAD_REQUEST, error: encoded.error };
    }
    total += encoded.bytes;
    if (total > MAX_TOTAL_BYTES) {
      return { status: HTTP_STATUS.PAYLOAD_TOO_LARGE, error: `Source images total over the ${MAX_TOTAL_BYTES}-byte limit` };
    }
    dataUrls.push(encoded.dataUrl);
  }

  const body = { model: fields.model, prompt: fields.prompt };
  for (const key of PASSTHROUGH_FIELDS) {
    if (fields[key] === undefined) continue;
    if (NUMERIC_FIELDS.has(key)) {
      const n = Number(fields[key]);
      if (Number.isFinite(n)) body[key] = n;
      continue;
    }
    body[key] = fields[key];
  }

  // `image` carries the LAST source and `images` the rest, because the codex
  // adapter appends `image` after `images` (open-sse/handlers/imageProviders/
  // codex.js:166-168). This restores upload order there, keeps single-reference
  // adapters working off `image`, and never sends the same image twice.
  body.image = dataUrls[dataUrls.length - 1];
  if (dataUrls.length > 1) body.images = dataUrls.slice(0, -1);

  return { body };
}

/**
 * POST /v1/images/edits — OpenAI-compatible image edit.
 *
 * Normalizes multipart or JSON into the generation body shape and hands it to
 * the existing image path, so API-key auth, combo expansion, account selection,
 * token refresh and account fallback are shared rather than reimplemented.
 *
 * @param {Request} request
 */
export async function handleImageEdits(request) {
  return withResourceAdmission(request, () => handleImageEditsAdmitted(request));
}

async function handleImageEditsAdmitted(request) {
  const parsed = await buildImageEditBody(request);
  if (parsed.error) return errorResponse(parsed.status, parsed.error);

  // Uploads live only in the buffers above; nothing is written to disk, so a
  // success, an error and an abort all release them the same way.
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");

  return handleImageGeneration(new Request(request.url, {
    method: "POST",
    headers,
    body: JSON.stringify(parsed.body),
    signal: request.signal,
  }));
}
