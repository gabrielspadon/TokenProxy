// Helpers for OpenAI Responses API streaming termination + event framing
import { FORMATS } from "../translator/formats.js";
import { formatSSE } from "./streamHelpers.js";
import { filterUsageForFormat } from "./usageTracking.js";

// Responses API events that signal the stream has reached a terminal state
const OPENAI_RESPONSES_TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.done",
  "response.failed",
  "error"
]);

export function getOpenAIResponsesEventName(eventName, chunk) {
  if (eventName) return eventName;
  if (chunk && typeof chunk.type === "string") return chunk.type;
  return null;
}

export function isOpenAIResponsesTerminalEvent(eventName, chunk) {
  const type = getOpenAIResponsesEventName(eventName, chunk);
  if (OPENAI_RESPONSES_TERMINAL_EVENTS.has(type)) return true;
  const status = chunk?.response?.status;
  return status === "completed" || status === "failed";
}

const sharedEncoder = new TextEncoder();

// Encoded response.failed + [DONE] payload for aborted/stalled Responses passthrough streams
export function buildAbortedResponsesTerminalBytes(usage = null) {
  return sharedEncoder.encode(`${formatIncompleteOpenAIResponsesStreamFailure(usage)}data: [DONE]\n\n`);
}

// The early Responses bridge has already committed a 200 SSE response when
// routing fails. Keep its terminal generic so provider error bodies never leak.
export function buildEarlyResponsesFailureTerminalBytes() {
  return sharedEncoder.encode(`${formatSSE({
    event: "response.failed",
    data: {
      type: "response.failed",
      response: {
        id: `resp_${Date.now()}`,
        status: "failed",
        error: {
          type: "upstream_error",
          code: "upstream_error",
          message: "request failed before stream started"
        }
      }
    }
  }, FORMATS.OPENAI_RESPONSES)}data: [DONE]\n\n`);
}

// Synthesize a response.failed event for streams that close without a terminal event
export function formatIncompleteOpenAIResponsesStreamFailure(usage = null) {
  return formatSSE({
    event: "response.failed",
    data: {
      type: "response.failed",
      response: {
        id: `resp_${Date.now()}`,
        status: "failed",
        error: {
          type: "stream_error",
          code: "stream_disconnected",
          message: "stream closed before response.completed"
        },
        ...(usage ? { usage: filterUsageForFormat(usage, FORMATS.OPENAI_RESPONSES) } : {})
      }
    }
  }, FORMATS.OPENAI_RESPONSES);
}
