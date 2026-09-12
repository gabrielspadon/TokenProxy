import { FORMATS } from "../formats.js";
import { CLAUDE_BLOCK, OPENAI_BLOCK, RESPONSES_ITEM } from "../schema/index.js";

// Messages contain only protocol paths and fixed explanations, never user payloads.
export class TranslationInputError extends Error {
  constructor(path, targetFormat, reason) {
    super(`Cannot translate ${path} to ${targetFormat}: ${reason}`);
    this.name = "TranslationInputError";
    this.code = "unsupported_translation";
    this.status = 400;
    this.path = path;
    this.targetFormat = targetFormat;
  }
}

// A selected wire format must have a complete direct or OpenAI-pivot route.
// This error is intentionally payload-free so callers can expose it as a stable
// local 400 without leaking any part of the request or upstream response.
export class TranslationRouteError extends Error {
  constructor(kind, sourceFormat, targetFormat, missing = []) {
    super(`Cannot translate ${kind} from ${sourceFormat} to ${targetFormat}: required conversion edge is unavailable`);
    this.name = "TranslationRouteError";
    this.code = "translation_route_unavailable";
    this.status = 400;
    this.kind = kind;
    this.sourceFormat = sourceFormat;
    this.targetFormat = targetFormat;
    this.missing = missing.map(({ from, to }) => ({ from, to }));
  }
}

// Check before normalization can discard a block or repair a tool transaction.
// These are limitations of the implemented transport, not model capability claims.
export function assertTranslationContent(sourceFormat, targetFormat, body) {
  if (sourceFormat === targetFormat) return;
  const reject = (path, reason) => { throw new TranslationInputError(path, targetFormat, reason); };

  if (sourceFormat === FORMATS.OPENAI_RESPONSES && Array.isArray(body.input)) {
    body.input.forEach((item, i) => {
      if (!item) return;
      if ([RESPONSES_ITEM.FUNCTION_CALL, RESPONSES_ITEM.CUSTOM_TOOL_CALL].includes(item.type)
          && (typeof item.name !== "string" || !item.name.trim())) {
        reject(`input[${i}].name`, "a tool call requires a non-empty name");
      }
      if (Array.isArray(item.content)) item.content.forEach((part, j) => {
        if (part?.type === RESPONSES_ITEM.INPUT_IMAGE && part.file_id != null) {
          reject(`input[${i}].content[${j}].file_id`, "an uploaded image reference cannot be converted to an image URL; use an image URL or inline image data");
        }
      });
    });
  }

  const claudeBridge = sourceFormat === FORMATS.CLAUDE && targetFormat !== FORMATS.KIRO;
  const visit = (content, path) => {
    if (!Array.isArray(content)) return;
    content.forEach((part, i) => {
      if (!part || typeof part !== "object") return;
      const at = `${path}[${i}]`;
      if (claudeBridge && part.type === CLAUDE_BLOCK.REDACTED_THINKING) {
        reject(at, "opaque redacted thinking requires a Claude-compatible route");
      }
      if (claudeBridge && part.type === CLAUDE_BLOCK.TOOL_RESULT) {
        if (part.is_error === true) {
          reject(`${at}.is_error`, "the Chat Completions bridge has no tool-result error flag; use a Claude-compatible route");
        }
        if (Array.isArray(part.content)) part.content.forEach((block, j) => {
          if (block?.type === CLAUDE_BLOCK.IMAGE) {
            reject(`${at}.content[${j}]`, "the Chat Completions bridge accepts only text in tool replies; use a Claude-compatible route");
          }
        });
      }
      if (targetFormat === FORMATS.CLAUDE && part.type === OPENAI_BLOCK.INPUT_AUDIO) {
        reject(at, "this Messages transport cannot represent input audio; use an audio-capable route");
      }
      if (targetFormat === FORMATS.CURSOR && [OPENAI_BLOCK.IMAGE_URL, CLAUDE_BLOCK.IMAGE, RESPONSES_ITEM.INPUT_IMAGE, OPENAI_BLOCK.INPUT_AUDIO].includes(part.type)) {
        reject(at, "this Cursor transport accepts text only; use a media-capable route");
      }
      if (targetFormat === FORMATS.KIRO) {
        const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
        const image = url ?? part.source?.url ?? (typeof part.image === "string" ? part.image : null);
        if (typeof image === "string" && /^https?:\/\//i.test(image)) {
          reject(at, "this Kiro transport requires inline image data and cannot resolve remote image URLs");
        }
      }
      if (Array.isArray(part.content)) visit(part.content, `${at}.content`);
    });
  };
  if (Array.isArray(body.input)) body.input.forEach((item, i) => visit(item?.content, `input[${i}].content`));
  for (const [i, msg] of (body.messages || []).entries()) {
    visit(msg?.content, `messages[${i}].content`);
    if (targetFormat === FORMATS.COMMANDCODE && Array.isArray(msg?.tool_calls)) {
      msg.tool_calls.forEach((call, j) => {
        const args = call?.function?.arguments;
        if (typeof args !== "string") return;
        try { JSON.parse(args); } catch {
          reject(`messages[${i}].tool_calls[${j}].function.arguments`, "tool arguments must be valid JSON and cannot be replaced with an empty object");
        }
      });
    }
  }
}
