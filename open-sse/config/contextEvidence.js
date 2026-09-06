import { CLAUDE_BLOCK, GEMINI_ROLE, OPENAI_BLOCK, RESPONSES_ITEM, ROLE } from "../translator/schema/index.js";

export { CONTEXT_BOUNDARIES, CONTEXT_ROLES } from "../../src/lib/db/analytics/contextStructure.mjs";
export const CONTEXT_INSTRUCTION_FIELDS = ["system", "instructions", "systemInstruction", "system_instruction"];
export const CONTEXT_MESSAGE_FIELDS = ["messages", "input", "contents"];
export const CONTEXT_TOOL_FIELDS = ["tools", "functions"];
export const CONTEXT_CAPTURE_LIMITS = { bytes: 8 * 1024 * 1024, nodes: 100000, depth: 64 };
export const CONTEXT_CALL_TYPES = new Set([CLAUDE_BLOCK.TOOL_USE, RESPONSES_ITEM.FUNCTION_CALL, RESPONSES_ITEM.CUSTOM_TOOL_CALL]);
export const CONTEXT_RESULT_TYPES = new Set([CLAUDE_BLOCK.TOOL_RESULT, RESPONSES_ITEM.FUNCTION_CALL_OUTPUT, RESPONSES_ITEM.CUSTOM_TOOL_CALL_OUTPUT]);
export const CONTEXT_ATTACHMENT_TYPES = new Set([CLAUDE_BLOCK.IMAGE, CLAUDE_BLOCK.DOCUMENT, OPENAI_BLOCK.IMAGE_URL, OPENAI_BLOCK.INPUT_AUDIO, OPENAI_BLOCK.AUDIO_URL, OPENAI_BLOCK.FILE, RESPONSES_ITEM.INPUT_IMAGE]);
export const CONTEXT_IDENTITY_HEADERS = {
  clientRef: "x-tokenproxy-client-id",
  clientSessionRef: "x-tokenproxy-session-id",
  taskRef: "x-tokenproxy-task-id",
  projectRef: "x-tokenproxy-project-id",
};
export const CONTEXT_EVENT_TYPES = ["compaction", "handoff", "task_start", "task_outcome"];
export const CONTEXT_EVENT_OUTCOMES = ["success", "failure", "cancelled", "unknown"];
export const CONTEXT_TOKEN_METHODS = ["client-tokenizer", "client-estimate", "unknown"];

export function contextRole(item) {
  if (typeof item === "string") return ROLE.USER;
  if (item?.role === GEMINI_ROLE.MODEL) return ROLE.ASSISTANT;
  if (Object.values(ROLE).includes(item?.role)) return item.role;
  if (CONTEXT_CALL_TYPES.has(item?.type)) return ROLE.ASSISTANT;
  if (CONTEXT_RESULT_TYPES.has(item?.type)) return ROLE.TOOL;
  return "other";
}
