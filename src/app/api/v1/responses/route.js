import { handleChat, validateClientRequestShape } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { errorResponse } from "open-sse/utils/error.js";
import { createDeferredResponsesResponse } from "open-sse/utils/responsesStreamBridge.js";

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * POST /v1/responses - OpenAI Responses API format
 * Now handled by translator pattern (openai-responses format auto-detected)
 */
export async function POST(request) {
  await ensureInitialized();
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const requestShapeError = validateClientRequestShape(new URL(request.url).pathname, body);
  if (requestShapeError) return errorResponse(HTTP_STATUS.BAD_REQUEST, requestShapeError);

  if (body?.stream !== true) return handleChat(request, null, { body });

  return createDeferredResponsesResponse(
    (signal) => handleChat(request, null, { body, signal }),
    { signal: request.signal },
  );
}
