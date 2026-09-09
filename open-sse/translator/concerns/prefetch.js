// Pre-fetch remote image URLs into base64 BEFORE translation, for target
// formats whose upstream providers cannot fetch remote URLs themselves
// (they require inline base64). Runs on the source-format body.
import { FORMATS } from "../formats.js";
import { fetchImageAsBase64 } from "./image.js";
import { MAX_REMOTE_MEDIA_BYTES, REMOTE_MEDIA_CONCURRENCY } from "../../config/mediaConfig.js";

export class MediaAggregateLimitError extends Error {
  constructor() {
    super('Remote images exceed the per-request media byte limit.');
    this.name = 'MediaAggregateLimitError';
    this.code = 'media_aggregate_limit';
  }
}

// Targets that require inline base64 images (cannot accept remote URLs).
const TARGETS_NEED_BASE64 = new Set([
  FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.VERTEX,
  FORMATS.ANTIGRAVITY, FORMATS.OLLAMA, FORMATS.KIRO,
]);

function isRemoteUrl(url) {
  return typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"));
}

// Collect {get,set} accessors for every remote image URL in a source body.
function collectImageRefs(body, sourceFormat) {
  const refs = [];
  const pushOpenAI = (messages) => {
    for (const msg of messages || []) {
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block?.type === "image_url") {
          const url = typeof block.image_url === "string" ? block.image_url : block.image_url?.url;
          if (isRemoteUrl(url)) refs.push({ get: () => url, set: (v) => {
            if (typeof block.image_url === "string") block.image_url = v; else block.image_url.url = v;
          } });
        }
      }
    }
  };
  const pushGemini = (contents) => {
    for (const c of contents || []) {
      for (const p of c.parts || []) {
        const uri = p?.fileData?.fileUri;
        if (isRemoteUrl(uri)) refs.push({ get: () => uri, part: p });
      }
    }
  };

  switch (sourceFormat) {
    case FORMATS.OPENAI:
    case FORMATS.OLLAMA:
    case FORMATS.KIRO:
    case FORMATS.CURSOR:
    case FORMATS.COMMANDCODE:
      pushOpenAI(body.messages);
      break;
    case FORMATS.CLAUDE:
      for (const msg of body.messages || []) {
        if (!Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
          if (block?.type === "image" && block.source?.type === "url" && isRemoteUrl(block.source.url)) {
            refs.push({ get: () => block.source.url, claudeBlock: block });
          }
        }
      }
      break;
    case FORMATS.GEMINI:
    case FORMATS.GEMINI_CLI:
    case FORMATS.VERTEX:
      pushGemini(body.contents);
      break;
    case FORMATS.ANTIGRAVITY:
      pushGemini(body?.request?.contents);
      break;
    default:
      pushOpenAI(body.messages);
  }
  return refs;
}

/**
 * Replace remote image URLs with base64 data when the target needs inline data.
 * No-op when target accepts remote URLs (e.g. openai, claude) or body has none.
 * @returns {Promise<number>} count of images converted
 */
export async function prefetchRemoteImages(body, sourceFormat, targetFormat, options = {}) {
  options.signal?.throwIfAborted();
  if (!body || !TARGETS_NEED_BASE64.has(targetFormat)) return 0;
  const refs = collectImageRefs(body, sourceFormat);
  if (!refs.length) return 0;

  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const maxTotalBytes = Math.min(MAX_REMOTE_MEDIA_BYTES, options.maxTotalBytes ?? MAX_REMOTE_MEDIA_BYTES);
  const concurrency = Math.min(REMOTE_MEDIA_CONCURRENCY, options.concurrency ?? REMOTE_MEDIA_CONCURRENCY);
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1 || !Number.isSafeInteger(concurrency) || concurrency < 1) throw new RangeError('Invalid remote media limits');
  const occurrences = new Map();
  for (const ref of refs) occurrences.set(ref.get(), (occurrences.get(ref.get()) || 0) + 1);
  const urls = [...occurrences.keys()], results = new Map();
  let cursor = 0, totalBytes = 0;
  function consumeBytes(size, copies) {
    totalBytes += size * copies;
    if (totalBytes > maxTotalBytes) {
      const error = new MediaAggregateLimitError();
      controller.abort(error);
      throw error;
    }
  }
  async function worker() {
    while (cursor < urls.length) {
      signal.throwIfAborted();
      const url = urls[cursor++];
      const fetched = await fetchImageAsBase64(url, { ...options, signal,
        consumeBytes: size => consumeBytes(size, occurrences.get(url)) });
      signal.throwIfAborted();
      results.set(url, fetched);
    }
  }
  const settled = await Promise.allSettled(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  signal.throwIfAborted();
  const failure = settled.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  let converted = 0;
  // Commit only after the complete preparation succeeds; a failed/cancelled
  // sibling cannot leave a half-rewritten request or change reference order.
  for (const ref of refs) {
    const fetched = results.get(ref.get());
    if (!fetched) continue;
    if (ref.set) ref.set(fetched.url);
    else if (ref.part) { delete ref.part.fileData; ref.part.inlineData = { mimeType: fetched.mimeType, data: fetched.url.split(",")[1] }; }
    else if (ref.claudeBlock) ref.claudeBlock.source = { type: "base64", media_type: fetched.mimeType, data: fetched.url.split(",")[1] };
    converted++;
  }
  return converted;
}
