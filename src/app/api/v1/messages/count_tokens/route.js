import { encodingForModel, localTokenizer } from '../../../../../../open-sse/utils/localTokenizer.js';
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*"
};

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, { headers: CORS_HEADERS });
}

// Media content uses an explicit heuristic; provider-specific image/document
// processing and message framing cannot be verified by a text tokenizer.
const MEDIA_TOKENS = 1600;
const CHARS_PER_TOKEN = 4;
const MEDIA_CHARS = MEDIA_TOKENS * CHARS_PER_TOKEN;

function isMediaBlock(block) {
  if (!block || typeof block !== "object") return false;
  const t = block.type;
  return (
    t === "image"
    || t === "image_url"
    || t === "input_image"
    || t === "input_audio"
    || t === "audio"
    || t === "input_video"
    || t === "video"
    || t === "document"
    || t === "file"
    || Boolean(block.source?.data)
    || Boolean(block.source?.url)
    || Boolean(block.inlineData?.mimeType)
    || Boolean(block.fileData?.mimeType)
  );
}

function countValueChars(value, state, depth = 0) {
  if (++state.nodes > 8192 || depth > 32) throw new RangeError("Content structure exceeds counting limits");
  if (value == null) return 0;
  if (typeof value === "string") { state.texts.push(value); return value.length; }
  if (typeof value === "number" || typeof value === "boolean") {
    state.texts.push(String(value)); return String(value).length;
  }
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countValueChars(item, state, depth + 1), 0);
  }
  if (typeof value === "object") {
    // Checked before the recursion, so a media block nested inside a
    // tool_result is charged flat rather than walked down to its base64.
    if (isMediaBlock(value)) { state.media++; return MEDIA_CHARS; }
    return Object.entries(value).reduce((total, [key, item]) => {
      state.texts.push(key); return total + key.length + countValueChars(item, state, depth + 1);
    }, 0);
  }
  return 0;
}

function countContentBlockChars(block, state) {
  if (++state.nodes > 8192) throw new RangeError('Content structure exceeds counting limits');
  if (block == null) return 0;
  if (typeof block === "string") return countValueChars(block, state);
  if (typeof block !== "object") return countValueChars(block, state);
  if (isMediaBlock(block)) { state.media++; return MEDIA_CHARS; }

  switch (block.type) {
    case "text":
      return countValueChars(block.text, state);
    case "tool_use":
      return countValueChars(block.name, state) + countValueChars(block.input, state);
    case "tool_result":
      return countValueChars(block.content, state);
    case "thinking":
      return countValueChars(block.thinking, state);
    default:
      return countValueChars(block, state);
  }
}

function countMessageChars(message, state) {
  if (++state.nodes > 8192) throw new RangeError('Content structure exceeds counting limits');
  if (!message || typeof message !== "object") return 0;
  const content = message.content;

  if (typeof content === "string") return countValueChars(content, state);
  if (Array.isArray(content)) {
    return content.reduce((total, block) => total + countContentBlockChars(block, state), 0);
  }
  return countValueChars(content, state);
}

function collectInput(body = {}) {
  const state = { texts: [], media: 0, nodes: 0 };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let totalChars = countValueChars(body.system, state) + countValueChars(body.tools, state);

  for (const msg of messages) {
    totalChars += countMessageChars(msg, state);
  }

  return { ...state, estimate: Math.ceil(totalChars / CHARS_PER_TOKEN) };
}

export function estimateAnthropicInputTokens(body = {}) { return collectInput(body).estimate; }

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const STAGE_BYTES = 64 * 1024;
let readers = 0;
const response = (body, status = 200) => Response.json(body, { status, headers: CORS_HEADERS });

async function readBody(request) {
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) throw Object.assign(new Error('Body exceeds 4 MiB'), { status: 413 });
  const reader = request.body?.getReader();
  if (!reader) throw new Error('JSON body is required');
  // Chunks are staged into fixed 64 KiB blocks. A client that trickles one
  // byte per chunk would otherwise hold up to four million small Buffers for
  // a body that is within the byte limit; staging bounds the object count at
  // MAX_BODY_BYTES / STAGE_BYTES regardless of how the body arrives.
  const blocks = []; let stage = null, staged = 0, size = 0;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10000)]);
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) throw Object.assign(new Error('Counting cancelled'), { status: 408 });
    while (true) {
      const { value, done } = await reader.read();
      if (signal.aborted) throw Object.assign(new Error('Counting cancelled'), { status: 408 });
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Body exceeds 4 MiB'), { status: 413 });
      for (let offset = 0; offset < value.byteLength;) {
        if (!stage) { stage = Buffer.allocUnsafe(STAGE_BYTES); staged = 0; }
        const copied = Math.min(STAGE_BYTES - staged, value.byteLength - offset);
        stage.set(value.subarray(offset, offset + copied), staged);
        staged += copied; offset += copied;
        if (staged === STAGE_BYTES) { blocks.push(stage); stage = null; }
      }
    }
    if (stage) blocks.push(stage.subarray(0, staged));
    return JSON.parse(Buffer.concat(blocks, size).toString('utf8'));
  } finally { signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function POST(request) {
  if (readers >= 16) return response({ error: 'Token counting capacity exhausted' }, 503);
  readers++;
  try {
    const body = await readBody(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return response({ error: 'JSON object is required' }, 400);
    const input = collectInput(body);
    const encoding = encodingForModel(body.model);
    const counted = encoding ? await localTokenizer.count(input.texts, { encoding, signal: request.signal }) : null;
    return response({ input_tokens: counted ? counted.tokens + input.media * MEDIA_TOKENS : input.estimate,
      estimated: true,
      estimation: { method: counted ? 'local_bpe_text_with_unverified_framing' : 'character_heuristic',
        encoding, tokenizer: counted?.tokenizer || null, text_tokens: counted?.tokens ?? null,
        media_blocks: input.media, media_tokens_per_block: input.media ? MEDIA_TOKENS : null,
        limitations: ['Provider message and tool framing are unverified',
          ...(!encoding ? ['Model encoding is unverified; text uses 4 characters per token'] : []),
          ...(input.media ? ['Media processing is unverified; 1600 tokens per block is a heuristic without an error bound'] : [])],
        scope: 'input_estimate_only', provider_calls: 0 } });
  } catch (error) {
    const status = error.status || ({ input_too_large: 413, overloaded: 503, timeout: 408, aborted: 408,
      tokenizer_failed: 503, tokenizer_closed: 503 }[error.code]) || 400;
    return response({ error: status === 400 ? 'Invalid JSON body or content structure' : error.message }, status);
  } finally { readers--; }
}
