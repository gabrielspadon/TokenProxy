import { createHash, randomBytes, randomUUID } from "crypto";
import { CLAUDE_TOOL_SUFFIX, CC_DEFAULT_TOOLS } from "../config/appConstants.js";

const CLAUDE_VERSION = "2.1.261";
const CC_ENTRYPOINT = "sdk-cli";

// Generate billing header matching real Claude Code 2.1.92+ format:
// x-anthropic-billing-header: cc_version=<ver>.<build>; cc_entrypoint=sdk-cli; cch=<hash>;
// buildHash/cch derive from (apiKey, sessionId) instead of the request body and
// fresh randomness: per-request variation defeats provider prompt-cache TTLs.
function generateBillingHeader(apiKey, sessionId) {
  // F5: an absent session id (sessionManager hands a fresh random id per
  // request when it has no connection) must fall back to a stable per-account
  // seed, never per-request variation that defeats the prompt-cache TTL.
  const cch = createHash("sha256").update(`cch:${apiKey}:${sessionId || `key:${apiKey}`}`).digest("hex").slice(0, 5);
  const buildHash = createHash("sha256").update(`cc-build:${apiKey}`).digest("hex").slice(0, 3);
  return `x-anthropic-billing-header: cc_version=${CLAUDE_VERSION}.${buildHash}; cc_entrypoint=${CC_ENTRYPOINT}; cch=${cch};`;
}

// Derive a deterministic UUID-v4-shaped string from a seed (stable per account)
function deriveUuid(seed) {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// Generate fake user ID in Claude Code 2.1.92+ JSON format:
// {"device_id":"<64hex>","account_uuid":"<uuid>","session_id":"<uuid>"}
// device_id/account_uuid derive from apiKey (stable per account), session_id per-conversation
function generateFakeUserID(sessionId, apiKey) {
  const deviceId = apiKey ? createHash("sha256").update(`device:${apiKey}`).digest("hex") : randomBytes(32).toString("hex");
  const accountUuid = apiKey ? deriveUuid(`account:${apiKey}`) : randomUUID();
  // F5: same stability requirement as the cch — a random session_id per
  // request would vary metadata.user_id and break the cached prefix too.
  const sessionUuid = sessionId || deriveUuid(`session:${apiKey}`);
  return `{"device_id":"${deviceId}","account_uuid":"${accountUuid}","session_id":"${sessionUuid}"}`;
}

/**
 * Cloak tools before sending to Claude provider (anti-ban):
 * - Rename non-CC client tools with _cc suffix in tools[] and messages[]
 * - Skip tools that are already CC default names (they become decoys as-is)
 * - Inject CC_DECOY_TOOLS after client tools
 * Returns { body, toolNameMap } where toolNameMap maps suffixed → original
 * @param {object} body - Claude API request body
 * @returns {{ body: object, toolNameMap: Map|null }}
 */
export function cloakClaudeTools(body) {
  const tools = body.tools;
  if (!tools || tools.length === 0) return { body, toolNameMap: null };

  const suffix = (name) => `${name}${CLAUDE_TOOL_SUFFIX}`;
  const toolNameMap = new Map();
  const clientToolNames = new Set();
  const clientDeclarations = [];

  // All client tools get renamed with suffix.
  // Built-in server tools (web_search_20250305, etc.) carry a `type` and require
  // an exact reserved `name` — never suffix those or Claude rejects the request.
  for (const tool of tools) {
    if (tool.type) { clientDeclarations.push(tool); continue; }
    const suffixed = suffix(tool.name);
    toolNameMap.set(suffixed, tool.name);
    clientToolNames.add(tool.name);
    clientDeclarations.push({ ...tool, name: suffixed });
  }

  // Client tools first, then CC decoy tools (no overlap: client tools all have _cc suffix)
  const allTools = [...clientDeclarations, ...CC_DECOY_TOOLS];

  // Rename tool_use in message history (all client tools get suffix)
  const renamedMessages = body.messages?.map(msg => {
    if (!Array.isArray(msg.content)) return msg;
    const renamedContent = msg.content.map(block =>
      block.type === "tool_use" ? { ...block, name: suffix(block.name) } : block
    );
    return { ...msg, content: renamedContent };
  });

  const cloakedBody = { ...body, tools: allTools, messages: renamedMessages || body.messages };

  // A forced tool_choice ({ type: "tool", name }) must point at the suffixed
  // tool name, otherwise Claude rejects it: "Tool '<name>' not found in provided tools".
  // Only rewrite when the choice targets one of the client tools we actually
  // renamed — never a decoy/built-in name (those are sent unsuffixed).
  if (
    body.tool_choice?.type === "tool" &&
    clientToolNames.has(body.tool_choice.name)
  ) {
    cloakedBody.tool_choice = { ...body.tool_choice, name: suffix(body.tool_choice.name) };
  }

  return {
    body: cloakedBody,
    toolNameMap: toolNameMap.size > 0 ? toolNameMap : null
  };
}

// Decloak tool_use names in non-streaming Claude response body (INPUT side)
export function decloakToolNames(body, toolNameMap) {
  if (!toolNameMap?.size || !body || typeof body !== "object") return body;
  const original = (name) => (toolNameMap.has(name) ? toolNameMap.get(name) : name);

  // Claude shape: content[] with tool_use blocks.
  if (Array.isArray(body.content)) {
    return {
      ...body,
      content: body.content.map((block) =>
        block?.type === "tool_use" && toolNameMap.has(block.name)
          ? { ...block, name: original(block.name) }
          : block),
    };
  }

  // OpenAI shape: choices[].message.tool_calls[].function.name. Reached from the
  // forced-SSE-to-JSON path, which parses the stream into this shape before any
  // translation, so the cloaked name was still on it when it went to the client
  // and a client that declared `exec` was handed `exec_ide` (#2693).
  if (Array.isArray(body.choices)) {
    return {
      ...body,
      choices: body.choices.map((choice) => {
        const calls = choice?.message?.tool_calls;
        if (!Array.isArray(calls)) return choice;
        return {
          ...choice,
          message: {
            ...choice.message,
            tool_calls: calls.map((tc) =>
              tc?.function?.name && toolNameMap.has(tc.function.name)
                ? { ...tc, function: { ...tc.function, name: original(tc.function.name) } }
                : tc),
          },
        };
      }),
    };
  }

  // Responses shape: output[] items carrying the name directly.
  if (Array.isArray(body.output)) {
    return {
      ...body,
      output: body.output.map((item) =>
        item?.name && toolNameMap.has(item.name)
          ? { ...item, name: original(item.name) }
          : item),
    };
  }

  return body;
}

// CC decoy tools — Claude Code native tool names, marked unavailable
const CC_DECOY_TOOLS = [
  { name: "Task", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "TaskOutput", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "TaskStop", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "TaskCreate", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "TaskGet", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "TaskUpdate", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "TaskList", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "Bash", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "Glob", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "Grep", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "Read", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "Edit", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "Write", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "NotebookEdit", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "WebFetch", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "WebSearch", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "AskUserQuestion", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "Skill", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "EnterPlanMode", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
  { name: "ExitPlanMode", description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } },
];

/**
 * Apply Claude cloaking to request body:
 * 1. Inject billing header as first system block
 * 2. Inject fake user ID into metadata (JSON format, session_id aligned with X-Claude-Code-Session-Id)
 * Only applies when using OAuth token (sk-ant-oat).
 * @param {object} body - Claude API request body
 * @param {string} apiKey - API key or OAuth token
 * @param {string} [sessionId] - Session ID to align with X-Claude-Code-Session-Id header
 * @returns {object} Modified body
 */
export function applyCloaking(body, apiKey, sessionId) {
  if (!apiKey || !apiKey.includes("sk-ant-oat")) return body;

  const result = { ...body };

  // Inject billing header as system[0], preserve existing system blocks
  const billingText = generateBillingHeader(apiKey, sessionId);
  const billingBlock = { type: "text", text: billingText };

  if (Array.isArray(result.system)) {
    // Skip if already injected
    if (!result.system[0]?.text?.startsWith("x-anthropic-billing-header:")) {
      result.system = [billingBlock, ...result.system];
    }
  } else if (typeof result.system === "string") {
    result.system = [billingBlock, { type: "text", text: result.system }];
  } else {
    result.system = [billingBlock];
  }

  // Inject fake user ID into metadata (session_id must match X-Claude-Code-Session-Id)
  const existingUserId = result.metadata?.user_id;
  if (!existingUserId) {
    result.metadata = { ...result.metadata, user_id: generateFakeUserID(sessionId, apiKey) };
  }

  return result;
}
