import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { adjustMaxTokens } from "../formats/maxTokens.js";
import { encodeDataUri } from "../concerns/image.js";
import { ROLE, OPENAI_BLOCK, CLAUDE_BLOCK } from "../schema/index.js";
import { collapseTextParts } from "../concerns/message.js";

function stripAnthropicBillingHeader(text) {
  if (typeof text !== "string") return "";
  return text.replace(/^x-anthropic-billing-header:[^\n]*(?:\r?\n)?/i, "");
}

// Convert Claude request to OpenAI format
/**
 * Give a tool schema the shape OpenAI-compatible providers require.
 *
 * The absent case was already handled, but a PRESENT-yet-malformed input_schema
 * was forwarded verbatim — a schema with no `type`, or an object schema with no
 * `properties`, reaches the provider and comes back as "Invalid tool
 * parameters", which reads to the user as a broken edit rather than a schema
 * problem (#2875). Same normalisation openai-responses.js applies on its own
 * tool path.
 */
function normalizeToolSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  const out = { ...schema };
  if (typeof out.type !== "string") out.type = "object";
  if (out.type === "object" && (!out.properties || typeof out.properties !== "object")) {
    out.properties = {};
  }
  return out;
}

// Fields that identify the route and the upstream prompt cache. They are
// forwarded verbatim across the Claude to OpenAI request translation.
export const PASSTHROUGH_REQUEST_FIELDS = ["provider", "session_id", "prompt_cache_key"];

export function claudeToOpenAIRequest(model, body, stream) {
  const result = {
    model: model,
    messages: [],
    stream: stream
  };

  // Max tokens
  if (body.max_tokens) {
    result.max_tokens = adjustMaxTokens(body);
  }

  // Temperature
  if (body.temperature !== undefined) {
    result.temperature = body.temperature;
  }

  // System message
  if (body.system) {
    // A Claude system prompt is usually the largest cacheable chunk, and its
    // cache_control markers live on the individual blocks. Joining the blocks
    // into one string discarded them here, before the provider quirk that would
    // have preserved them ever ran, so a provider that honours cache_control
    // (DashScope/alicode) never saw a marker on the system prompt at all.
    //
    // Keep the block shape ONLY when a marker is actually present. Without one
    // the joined string is emitted exactly as before, so the common path is
    // byte-identical; filterToOpenAIFormat then strips or keeps the markers
    // according to the provider's quirk, and collapses the array back to a
    // string when nothing survived.
    const systemBlocks = Array.isArray(body.system) ? body.system : null;
    const hasCacheControl = systemBlocks?.some(s => s && s.cache_control);

    if (hasCacheControl) {
      const blocks = systemBlocks
        .map(s => {
          const text = stripAnthropicBillingHeader(s.text || "");
          if (!text) return null;
          return s.cache_control
            ? { type: OPENAI_BLOCK.TEXT, text, cache_control: s.cache_control }
            : { type: OPENAI_BLOCK.TEXT, text };
        })
        .filter(Boolean);
      if (blocks.length) result.messages.push({ role: ROLE.SYSTEM, content: blocks });
    } else {
      const systemContent = systemBlocks
        ? systemBlocks.map(s => stripAnthropicBillingHeader(s.text || "")).filter(Boolean).join("\n")
        : stripAnthropicBillingHeader(body.system);

      if (systemContent) {
        result.messages.push({
          role: ROLE.SYSTEM,
          content: systemContent
        });
      }
    }
  }

  // Convert messages
  if (body.messages && Array.isArray(body.messages)) {
    for (let i = 0; i < body.messages.length; i++) {
      const msg = body.messages[i];
      const converted = convertClaudeMessage(msg);
      if (converted) {
        // Handle array of messages (multiple tool results)
        if (Array.isArray(converted)) {
          result.messages.push(...converted);
        } else {
          result.messages.push(converted);
        }
      }
    }
  }

  // Fix missing tool responses - OpenAI requires every tool_call to have a response.
  // Local variant: scans contiguous tool replies + inserts "[No response received]"
  // (distinct from the global immediate-next check in concerns/toolCall, runs on the openai leg).
  fixMissingToolResponsesOpenAI(result.messages);

  // Tools
  if (body.tools && Array.isArray(body.tools)) {
    result.tools = body.tools.map(tool => ({
      type: OPENAI_BLOCK.FUNCTION,
      function: {
        name: tool.name,
        description: String(tool.description || ""),
        parameters: normalizeToolSchema(tool.input_schema)
      }
    }));
  }

  // Tool choice
  if (body.tool_choice) {
    result.tool_choice = convertToolChoice(body.tool_choice);
  }

  if (body.reasoning_effort !== undefined) {
    result.reasoning_effort = body.reasoning_effort;
  } else if (body.reasoning?.effort !== undefined) {
    result.reasoning_effort = body.reasoning.effort;
  }

  if (body.reasoning !== undefined) {
    result.reasoning = body.reasoning;
  }

  // Routing and cache identity are the caller's, not ours to invent or drop.
  // `provider` pins the upstream route; `session_id` and `prompt_cache_key`
  // are the keys an upstream hashes to hit its own prompt cache. Losing any of
  // them still returns a valid completion, so the only visible symptom is a
  // cache miss on every turn.
  for (const key of PASSTHROUGH_REQUEST_FIELDS) {
    if (body[key] !== undefined) result[key] = body[key];
  }

  return result;
}

// Fix missing tool responses - add empty responses for tool_calls without responses
function fixMissingToolResponsesOpenAI(messages) {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === ROLE.ASSISTANT && msg.tool_calls && msg.tool_calls.length > 0) {
      const toolCallIds = msg.tool_calls.map(tc => tc.id);
      
      // Collect all tool response IDs that IMMEDIATELY follow this assistant message
      const respondedIds = new Set();
      let insertPosition = i + 1;
      for (let j = i + 1; j < messages.length; j++) {
        const nextMsg = messages[j];
        if (nextMsg.role === ROLE.TOOL && nextMsg.tool_call_id) {
          respondedIds.add(nextMsg.tool_call_id);
          insertPosition = j + 1;
        } else {
          break;
        }
      }
      
      // Find missing responses and insert them
      const missingIds = toolCallIds.filter(id => !respondedIds.has(id));
      
      if (missingIds.length > 0) {
        const missingResponses = missingIds.map(id => ({
          role: ROLE.TOOL,
          tool_call_id: id,
          content: "[No response received]"
        }));
        messages.splice(insertPosition, 0, ...missingResponses);
        i = insertPosition + missingResponses.length - 1;
      }
    }
  }
}

// Wrap mid-conversation system text so it ends as a user turn (avoids Anthropic prefill 400).
// Uses <instructions> tags that Claude models treat as authoritative directives.
function systemReminderText(content) {
  const parts = Array.isArray(content)
    ? content.filter(c => c?.type === CLAUDE_BLOCK.TEXT).map(c => c.text || "")
    : [typeof content === "string" ? content : ""];
  const text = parts.filter(Boolean).join("\n");
  if (!text.trim()) return "";
  return `<instructions>\n${text}\n</instructions>`;
}

// Convert single Claude message - returns single message or array of messages
function convertClaudeMessage(msg) {
  // Mid-conversation system message -> user (per Anthropic placement rules)
  if (msg.role === ROLE.SYSTEM) {
    const text = systemReminderText(msg.content);
    return text ? { role: ROLE.USER, content: text } : null;
  }

  const role = msg.role === ROLE.USER || msg.role === ROLE.TOOL ? ROLE.USER : ROLE.ASSISTANT;
  
  // Simple string content
  if (typeof msg.content === "string") {
    return { role, content: msg.content };
  }

  // Array content
  if (Array.isArray(msg.content)) {
    const parts = [];
    const toolCalls = [];
    const toolResults = [];
    const reasoning = [];

    for (const block of msg.content) {
      switch (block.type) {
        case CLAUDE_BLOCK.TEXT:
          parts.push({ type: OPENAI_BLOCK.TEXT, text: block.text });
          break;

        // Assistant thinking has no OpenAI content-block equivalent; it rides on
        // the message as reasoning_content. Without this case the block falls
        // through the switch and the turn's reasoning is lost (#2400).
        case CLAUDE_BLOCK.THINKING:
          if (typeof block.thinking === "string" && block.thinking) reasoning.push(block.thinking);
          break;

        case CLAUDE_BLOCK.IMAGE:
          if (block.source?.type === "base64") {
            parts.push({
              type: OPENAI_BLOCK.IMAGE_URL,
              image_url: {
                url: encodeDataUri(block.source.media_type, block.source.data)
              }
            });
          } else if (block.source?.type === "url") {
            parts.push({ type: OPENAI_BLOCK.IMAGE_URL, image_url: { url: block.source.url } });
          }
          break;

        case CLAUDE_BLOCK.TOOL_USE:
          toolCalls.push({
            id: block.id,
            type: OPENAI_BLOCK.FUNCTION,
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {})
            }
          });
          break;

        case CLAUDE_BLOCK.TOOL_RESULT:
          let resultContent = "";
          if (typeof block.content === "string") {
            resultContent = block.content;
          } else if (Array.isArray(block.content)) {
            // Keep text in the tool message; lift any images out as a following user
            // turn (OpenAI `tool` messages can't carry images). Without this, an
            // image-only tool_result is JSON.stringify'd -> base64 as text -> Codex
            // "input exceeds the context window".
            const textParts = [];
            let hasImage = false;
            for (const c of block.content) {
              if (c.type === CLAUDE_BLOCK.TEXT) {
                textParts.push(c.text);
              } else if (c.type === CLAUDE_BLOCK.IMAGE && c.source?.type === "base64") {
                parts.push({
                  type: OPENAI_BLOCK.IMAGE_URL,
                  image_url: { url: encodeDataUri(c.source.media_type, c.source.data) }
                });
                hasImage = true;
              }
            }
            resultContent = textParts.join("\n")
              || (hasImage ? "[tool returned an image; see attached]" : JSON.stringify(block.content));
          } else if (block.content) {
            resultContent = JSON.stringify(block.content);
          }
          
          toolResults.push({
            role: ROLE.TOOL,
            tool_call_id: block.tool_use_id,
            content: resultContent
          });
          break;
      }
    }

    // If has tool results, return array of tool messages
    if (toolResults.length > 0) {
      if (parts.length > 0) {
        return [...toolResults, { role: ROLE.USER, content: collapseTextParts(parts) }];
      }
      return toolResults;
    }

    // If has tool calls, return assistant message with tool_calls
    if (toolCalls.length > 0) {
      const result = { role: ROLE.ASSISTANT };
      if (parts.length > 0) {
        result.content = collapseTextParts(parts);
      }
      // Always carry the field on a tool-call turn, empty when the assistant
      // produced no thinking. Kimi with thinking enabled rejects the message
      // outright — "thinking is enabled but reasoning_content is missing in
      // assistant tool call message at index N" — and the other families that
      // read this field (GLM, Qwen, DeepSeek, Step, Hunyuan) treat an empty
      // string as the absence it describes (#1480). A provider that dislikes
      // the field names it in its rejection, which the adaptive stripper then
      // removes on retry, so this is recoverable rather than fatal.
      result.reasoning_content = reasoning.length > 0 ? reasoning.join("") : "";
      result.tool_calls = toolCalls;
      return result;
    }

    // Return content
    if (parts.length > 0) {
      const result = { role, content: collapseTextParts(parts) };
      if (reasoning.length > 0 && role === ROLE.ASSISTANT) {
        result.reasoning_content = reasoning.join("");
      }
      return result;
    }

    // A turn that was nothing but thinking still carries the reasoning forward.
    if (reasoning.length > 0 && role === ROLE.ASSISTANT) {
      return { role, content: "", reasoning_content: reasoning.join("") };
    }
    
    // Empty content array
    if (msg.content.length === 0) {
      return { role, content: "" };
    }
  }

  return null;
}

// Convert tool choice
function convertToolChoice(choice) {
  if (!choice) return "auto";
  if (typeof choice === "string") return choice;
  
  switch (choice.type) {
    case "auto": return "auto";
    case "none": return "none";
    case "any": return "required";
    case "tool": return { type: OPENAI_BLOCK.FUNCTION, function: { name: choice.name } };
    default: return "auto";
  }
}

// Register
register(FORMATS.CLAUDE, FORMATS.OPENAI, claudeToOpenAIRequest, null);
