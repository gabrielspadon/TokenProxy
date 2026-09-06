import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { DEFAULT_THINKING_AG_SIGNATURE, DEFAULT_THINKING_GEMINI_CLI_SIGNATURE } from "../../config/defaultThinkingSignature.js";
import { thoughtSignatureFor } from "../concerns/thoughtSignature.js";
import { openaiToClaudeRequestForAntigravity } from "./openai-to-claude.js";
function generateUUID() {
  return crypto.randomUUID();
}

import {
  DEFAULT_SAFETY_SETTINGS,
  convertOpenAIContentToParts,
  extractTextContent,
  tryParseJSON,
  generateRequestId,
  generateSessionId,
  generateProjectId,
  cleanJSONSchemaForAntigravity
} from "../formats/gemini.js";
import { deriveSessionId, toNumericSessionId } from "../../utils/sessionManager.js";
import { ROLE, GEMINI_ROLE, OPENAI_BLOCK, CLAUDE_BLOCK } from "../schema/index.js";

// Sanitizes system prompt text to prevent Google Cloud Code PA signature filter triggers
const HERMES_IDENTITY_RE = /You are Hermes Agent,\s*an intelligent AI assistant created by Nous Research\./gi;
const HERMES_IDENTITY_REPLACEMENT = "You are Hermes Agent. You are an intelligent AI assistant created by Nous Research.";

export function sanitizeAntigravitySystemPrompt(text) {
  if (!text || typeof text !== "string") return text;
  return text.replace(HERMES_IDENTITY_RE, HERMES_IDENTITY_REPLACEMENT);
}

// Sanitize function names for Gemini API.
// Gemini requires: starts with [a-zA-Z_], followed by [a-zA-Z0-9_.:\-], max 64 chars.
// Replace any invalid character with '_' and truncate to 64.
function sanitizeGeminiFunctionName(name, map = null) {
  if (!name) return "_unknown";
  // Replace any char not in [a-zA-Z0-9_.:\-] with '_'
  let sanitized = name.replace(/[^a-zA-Z0-9_.:\-]/g, "_");
  // First char must be letter or underscore
  if (!/^[a-zA-Z_]/.test(sanitized)) {
    sanitized = "_" + sanitized;
  }
  if (sanitized.length <= GEMINI_FUNCTION_NAME_MAX) {
    if (map && sanitized !== name) map.set(sanitized, name);
    return sanitized;
  }

  // Truncating alone collides. Two MCP tools sharing a long prefix become the
  // same declaration, and a call the model makes against it cannot be resolved
  // back to either one. Keep a prefix and append a tag derived from the WHOLE
  // original name, so names that differ only past the cut stay distinct and a
  // replayed history produces the identical name it was declared under.
  const tagged = `${sanitized.slice(0, GEMINI_FUNCTION_NAME_MAX - 9)}_${fnv1a(name)}`;
  if (map) map.set(tagged, name);
  return tagged;
}

const GEMINI_FUNCTION_NAME_MAX = 64;

// FNV-1a, 32 bit. Deterministic and dependency free: the same original name
// must yield the same tag on every request, or a tool declared on one turn and
// called on the next would not match.
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const carriesFunctionResponse = (parts) => parts.some((p) => p?.functionResponse);

function normalizeGeminiContents(contents) {
  const out = [];
  for (const c of contents || []) {
    if (!c?.role || !Array.isArray(c.parts) || c.parts.length === 0) continue;
    const last = out.at(-1);
    // A tool result reaches Gemini as a USER content of functionResponse parts,
    // which gives it the same role as the user's next text turn — that turn was
    // folded into it and the answer to a functionCall stopped being a turn of
    // its own (#3055). Consecutive turns of the same KIND still merge, so
    // ordinary text batching and parallel tool results are unchanged.
    const mergeable = last?.role === c.role
      && carriesFunctionResponse(last.parts) === carriesFunctionResponse(c.parts);
    if (mergeable) last.parts.push(...c.parts);
    else out.push({ ...c, parts: [...c.parts] });
  }
  return out;
}

// functionResponse.response is a google.protobuf.Struct — null, primitives and
// arrays must be wrapped in an object or Gemini rejects the payload (#3318).
function wrapFunctionResponsePayload(val) {
  return val !== null && typeof val === "object" && !Array.isArray(val) ? val : { result: val };
}

// Core: Convert OpenAI request to Gemini format (base for all variants)
function openaiToGeminiBase(model, body, stream, signature = DEFAULT_THINKING_AG_SIGNATURE, sanitizeSystem = false) {
  const toolNameMap = new Map();
  // Gemma 4 shares this translator with the Gemini family but rejects the
  // replay artifacts the rest of it depends on — a synthetic thought part, and
  // a thoughtSignature on a functionCall it never signed — with a bare 400
  // INVALID_ARGUMENT (#2480).
  const isGemma4 = typeof model === "string" && /gemma-4/i.test(model);
  const result = {
    model: model,
    contents: [],
    generationConfig: {},
    safetySettings: DEFAULT_SAFETY_SETTINGS
  };

  // Generation config
  if (body.temperature !== undefined) {
    result.generationConfig.temperature = body.temperature;
  }
  if (body.top_p !== undefined) {
    result.generationConfig.topP = body.top_p;
  }
  if (body.top_k !== undefined) {
    result.generationConfig.topK = body.top_k;
  }
  if (body.max_tokens !== undefined) {
    result.generationConfig.maxOutputTokens = body.max_tokens;
  }

  // OpenAI structured outputs. Gemini expresses the same thing through
  // generationConfig, and nothing mapped the two, so a client asking for a
  // json_schema got ordinary prose back and had to parse it (#2003).
  //
  // The schema is DEEP-COPIED before cleaning. cleanJSONSchemaForAntigravity
  // mutates what it is given, and a combo hands the SAME body to each member in
  // turn, so cleaning in place would give the next provider a Gemini-shaped
  // schema with its unsupported keywords already stripped.
  const responseFormat = body.response_format;
  if (responseFormat?.type === "json_schema" && responseFormat.json_schema?.schema) {
    result.generationConfig.responseMimeType = "application/json";
    result.generationConfig.responseSchema = cleanJSONSchemaForAntigravity(
      JSON.parse(JSON.stringify(responseFormat.json_schema.schema))
    );
  } else if (responseFormat?.type === "json_object") {
    // No schema to enforce, only the format.
    result.generationConfig.responseMimeType = "application/json";
  }

  // Build tool_call_id -> name map
  const tcID2Name = {};
  if (body.messages && Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg.role === ROLE.ASSISTANT && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.type === OPENAI_BLOCK.FUNCTION && tc.id && tc.function?.name) {
            tcID2Name[tc.id] = tc.function.name;
          }
        }
      }
    }
  }

  // Build tool responses cache
  const toolResponses = {};
  if (body.messages && Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg.role === ROLE.TOOL && msg.tool_call_id) {
        toolResponses[msg.tool_call_id] = msg.content;
      }
    }
  }

  // Convert messages
  if (body.messages && Array.isArray(body.messages)) {
    for (let i = 0; i < body.messages.length; i++) {
      const msg = body.messages[i];
      const role = msg.role === ROLE.DEVELOPER ? ROLE.SYSTEM : msg.role;
      const content = msg.content;

      if (role === ROLE.SYSTEM && body.messages.length > 1) {
        const rawText = typeof content === "string" ? content : extractTextContent(content);
        const sanitizedText = sanitizeSystem ? sanitizeAntigravitySystemPrompt(rawText) : rawText;
        result.systemInstruction ??= {
          role: GEMINI_ROLE.USER,
          parts: []
        };
        result.systemInstruction.parts.push({ text: sanitizedText });
      } else if (role === ROLE.USER || (role === ROLE.SYSTEM && body.messages.length === 1)) {
        const parts = convertOpenAIContentToParts(content);
        if (parts.length > 0) {
          if (role === ROLE.SYSTEM) {
            for (const part of parts) {
              if (part.text && sanitizeSystem) part.text = sanitizeAntigravitySystemPrompt(part.text);
            }
          }
          result.contents.push({ role: GEMINI_ROLE.USER, parts });
        }
      } else if (role === ROLE.ASSISTANT) {
        const parts = [];

        // Thinking/reasoning → thought part with signature
        if (msg.reasoning_content && !isGemma4) {
          parts.push({
            thought: true,
            text: msg.reasoning_content
          });
          parts.push({
            thoughtSignature: signature,
            text: ""
          });
        }

        if (content) {
          const text = typeof content === "string" ? content : extractTextContent(content);
          if (text) {
            parts.push({ text });
          }
        }

        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
          const toolCallIds = [];
          for (const tc of msg.tool_calls) {
            if (tc.type !== OPENAI_BLOCK.FUNCTION) continue;

            const args = tryParseJSON(tc.function?.arguments || "{}");
            const functionCallPart = {
              functionCall: {
                id: tc.id,
                name: sanitizeGeminiFunctionName(tc.function.name, toolNameMap),
                args: args
              }
            };
            // Gemini rejects a replayed call carrying someone else's
            // signature, so use the one it signed this call with and keep the
            // placeholder only for a call nothing here signed (#3646). Gemma 4
            // wants no signature at all, real or placeholder (#2480).
            if (!isGemma4) functionCallPart.thoughtSignature = thoughtSignatureFor(tc.id, signature);
            parts.push(functionCallPart);
            toolCallIds.push(tc.id);
          }

          if (parts.length > 0) {
            result.contents.push({ role: GEMINI_ROLE.MODEL, parts });
          }

          // Check if there are actual tool responses in the next messages
          // Presence, not truthiness: a tool that returns an empty string — a
          // command with no output, a successful write — otherwise looked like
          // no result at all and its functionResponse was dropped, leaving
          // Gemini a functionCall it never sees answered (#3055).
          const hasActualResponses = toolCallIds.some(fid => toolResponses[fid] !== undefined);

          if (hasActualResponses) {
            const toolParts = [];
            for (const fid of toolCallIds) {
              if (toolResponses[fid] === undefined) continue;

              let name = tcID2Name[fid];
              if (!name) {
                const idParts = fid.split("-");
                if (idParts.length > 2) {
                  name = idParts.slice(0, -2).join("-");
                } else {
                  name = fid;
                }
              }

              let resp = toolResponses[fid];
              let parsedResp = tryParseJSON(resp);
              if (parsedResp === null) {
                parsedResp = { result: resp };
              } else if (typeof parsedResp !== "object" || Array.isArray(parsedResp)) {
                // Gemini's functionResponse.response is a google.protobuf.Struct:
                // primitives and arrays must be wrapped, or the API rejects the
                // payload with INVALID_ARGUMENT (#3318).
                parsedResp = { result: parsedResp };
              }

              toolParts.push({
                functionResponse: {
                  id: fid,
                  name: sanitizeGeminiFunctionName(name, toolNameMap),
                  response: { result: parsedResp }
                }
              });
            }
            if (toolParts.length > 0) {
              result.contents.push({ role: GEMINI_ROLE.USER, parts: toolParts });
            }
          }
        } else if (parts.length > 0) {
          result.contents.push({ role: GEMINI_ROLE.MODEL, parts });
        }
      }
    }
  }

  // Convert tools
  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    const functionDeclarations = [];
    for (const t of body.tools) {
      // Check if already in Anthropic/Claude format (no type field, direct name/description/input_schema)
      if (t.name && t.input_schema) {
        const cleanedSchema = cleanJSONSchemaForAntigravity(structuredClone(t.input_schema || { type: "object", properties: {} }));
        functionDeclarations.push({
          name: sanitizeGeminiFunctionName(t.name, toolNameMap),
          description: t.description || "",
          parameters: cleanedSchema
        });
      }
      // OpenAI format
      else if (t.type === OPENAI_BLOCK.FUNCTION && t.function) {
        const fn = t.function;
        const cleanedSchema = cleanJSONSchemaForAntigravity(structuredClone(fn.parameters || { type: "object", properties: {} }));
        functionDeclarations.push({
          name: sanitizeGeminiFunctionName(fn.name, toolNameMap),
          description: fn.description || "",
          parameters: cleanedSchema
        });
      }
    }

    if (functionDeclarations.length > 0) {
      result.tools = [{ functionDeclarations }];
    }
  }

  result.contents = normalizeGeminiContents(result.contents);

  // chatCore lifts this off the translated body and hands it to the response
  // side, which maps a called name back to the one the client declared.
  if (toolNameMap.size > 0) result._toolNameMap = toolNameMap;

  return result;
}

// OpenAI -> Gemini (standard API)
export function openaiToGeminiRequest(model, body, stream) {
  return openaiToGeminiBase(model, body, stream);
}

// OpenAI -> Gemini CLI (Cloud Code Assist)
export function openaiToGeminiCLIRequest(model, body, stream) {
  const gemini = openaiToGeminiBase(model, body, stream, DEFAULT_THINKING_GEMINI_CLI_SIGNATURE, true);
  // Thinking is normalized centrally by applyThinking (thinkingUnified.js) after translation.

  // Clean schema for tools
  if (gemini.tools?.[0]?.functionDeclarations) {
    for (const fn of gemini.tools[0].functionDeclarations) {
      if (fn.parameters) {
        const cleanedSchema = cleanJSONSchemaForAntigravity(structuredClone(fn.parameters));
        fn.parameters = cleanedSchema;
        // if (isClaude) {
        //   fn.parameters = cleanedSchema;
        // } else {
        //   fn.parametersJsonSchema = cleanedSchema;
        //   delete fn.parameters;
        // }
      }
    }
  }

  return gemini;
}

// Wrap Gemini CLI format in Cloud Code wrapper
function wrapInCloudCodeEnvelope(model, geminiCLI, credentials = null, isAntigravity = false) {
  const projectId = credentials?.projectId || generateProjectId();

  const envelope = {
    project: projectId,
    model: model,
    userAgent: isAntigravity ? "antigravity" : "gemini-cli",
    requestId: isAntigravity ? `agent-${generateUUID()}` : generateRequestId(),
    request: {
      sessionId: toNumericSessionId(credentials?._clientSessionId) || (isAntigravity ? deriveSessionId(credentials?.email || credentials?.connectionId) : generateSessionId()),
      contents: geminiCLI.contents,
      systemInstruction: geminiCLI.systemInstruction,
      generationConfig: geminiCLI.generationConfig,
      tools: geminiCLI.tools,
    }
  };

  // Antigravity specific fields
  if (isAntigravity) {
    envelope.requestType = "agent";
  } else {
    // Keep safetySettings for Gemini CLI
    envelope.request.safetySettings = geminiCLI.safetySettings;
  }

  if (geminiCLI.tools?.length > 0) {
    envelope.request.toolConfig = {
      functionCallingConfig: { mode: "VALIDATED" }
    };
  }

  // The envelope is rebuilt field by field, so the map has to be carried up
  // explicitly or chatCore never sees it.
  if (geminiCLI._toolNameMap?.size > 0) envelope._toolNameMap = geminiCLI._toolNameMap;

  return envelope;
}

// Wrap Claude format in Cloud Code envelope for Antigravity
function wrapInCloudCodeEnvelopeForClaude(model, claudeRequest, credentials = null, signature = DEFAULT_THINKING_AG_SIGNATURE) {
  const toolNameMap = new Map();
  const projectId = credentials?.projectId || generateProjectId();

  const envelope = {
    project: projectId,
    model: model,
    userAgent: "antigravity",
    requestId: `agent-${generateUUID()}`,
    requestType: "agent",
    request: {
      sessionId: toNumericSessionId(credentials?._clientSessionId) || deriveSessionId(credentials?.email || credentials?.connectionId),
      contents: [],
      generationConfig: {
        temperature: claudeRequest.temperature || 1,
        maxOutputTokens: claudeRequest.max_tokens || 4096
      }
    }
  };

  // Build tool_use id -> name map so functionResponse can use the correct name
  const toolUseIdToName = {};
  if (claudeRequest.messages && Array.isArray(claudeRequest.messages)) {
    for (const msg of claudeRequest.messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === CLAUDE_BLOCK.TOOL_USE && block.id && block.name) {
            toolUseIdToName[block.id] = block.name;
          }
        }
      }
    }
  }

  // Convert Claude messages to Gemini contents
  if (claudeRequest.messages && Array.isArray(claudeRequest.messages)) {
    for (const msg of claudeRequest.messages) {
      const parts = [];

      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === CLAUDE_BLOCK.TEXT) {
            parts.push({ text: block.text });
          } else if (block.type === CLAUDE_BLOCK.TOOL_USE) {
            parts.push({
              thoughtSignature: thoughtSignatureFor(block.id, signature),
              functionCall: {
                id: block.id,
                name: sanitizeGeminiFunctionName(block.name, toolNameMap),
                args: block.input || {}
              }
            });
          } else if (block.type === CLAUDE_BLOCK.IMAGE) {
            // The loop handled text and tool blocks only, so an image was
            // silently dropped and the model answered as if none had been sent
            // — reported as Claude vision failing on Antigravity (#3148).
            // mime_type matches every other inlineData construction in the
            // translator; Gemini accepts the snake_case form.
            const src = block.source || {};
            if (src.type === "url" && src.url) {
              parts.push({ fileData: { fileUri: src.url, mimeType: src.media_type || "image/*" } });
            } else if (src.data) {
              parts.push({ inlineData: { mime_type: src.media_type || "image/png", data: src.data } });
            }
          } else if (block.type === CLAUDE_BLOCK.TOOL_RESULT) {
            let content = block.content;
            if (Array.isArray(content)) {
              content = content.map(c => c.type === CLAUDE_BLOCK.TEXT ? c.text : JSON.stringify(c)).join("\n");
            }
            // Resolve the original tool name from the id — Gemini requires it to match the functionCall name
            const resolvedName = toolUseIdToName[block.tool_use_id]
              ? sanitizeGeminiFunctionName(toolUseIdToName[block.tool_use_id], toolNameMap)
              : "tool";
            parts.push({
              functionResponse: {
                id: block.tool_use_id,
                name: resolvedName,
                response: { result: wrapFunctionResponsePayload(tryParseJSON(content) || content) }
              }
            });
          }
        }
      } else if (typeof msg.content === "string") {
        parts.push({ text: msg.content });
      }

      if (parts.length > 0) {
        envelope.request.contents.push({
          role: msg.role === ROLE.ASSISTANT ? GEMINI_ROLE.MODEL : GEMINI_ROLE.USER,
          parts
        });
      }
    }
  }

  // Convert Claude tools to Gemini functionDeclarations
  if (claudeRequest.tools && Array.isArray(claudeRequest.tools)) {
    const functionDeclarations = [];
    for (const tool of claudeRequest.tools) {
      if (tool.name && tool.input_schema) {
        const cleanedSchema = cleanJSONSchemaForAntigravity(structuredClone(tool.input_schema));
        functionDeclarations.push({
          name: sanitizeGeminiFunctionName(tool.name, toolNameMap),
          description: tool.description || "",
          parameters: cleanedSchema
        });
      }
    }
    if (functionDeclarations.length > 0) {
      envelope.request.tools = [{ functionDeclarations }];
      envelope.request.toolConfig = {
        functionCallingConfig: { mode: "VALIDATED" }
      };
    }
  }

  const systemParts = [];
  // Merge user system prompt from claudeRequest
  if (claudeRequest.system) {
    if (Array.isArray(claudeRequest.system)) {
      for (const block of claudeRequest.system) {
        if (block.text) systemParts.push({ text: sanitizeAntigravitySystemPrompt(block.text) });
      }
    } else if (typeof claudeRequest.system === "string") {
      systemParts.push({ text: sanitizeAntigravitySystemPrompt(claudeRequest.system) });
    }
  }

  if (systemParts.length > 0) {
    envelope.request.systemInstruction = { role: GEMINI_ROLE.USER, parts: systemParts };
  }

  envelope.request.contents = normalizeGeminiContents(envelope.request.contents);
  if (toolNameMap.size > 0) envelope._toolNameMap = toolNameMap;

  return envelope;
}

// Detect if model should use Claude backend in Antigravity
// Claude models have specific ID patterns — more reliable than caps at routing level
function isClaudeModel(model) {
  return model.toLowerCase().includes("claude");
}

// OpenAI -> Antigravity (Sandbox Cloud Code with wrapper)
export function openaiToAntigravityRequest(model, body, stream, credentials = null) {
  if (isClaudeModel(model)) {
    const claudeRequest = openaiToClaudeRequestForAntigravity(model, body, stream);
    return wrapInCloudCodeEnvelopeForClaude(model, claudeRequest, credentials);
  }

  const geminiCLI = openaiToGeminiCLIRequest(model, body, stream);
  return wrapInCloudCodeEnvelope(model, geminiCLI, credentials, true);
}

// Register
register(FORMATS.OPENAI, FORMATS.GEMINI, openaiToGeminiRequest, null);
register(FORMATS.OPENAI, FORMATS.GEMINI_CLI, (model, body, stream, credentials) => wrapInCloudCodeEnvelope(model, openaiToGeminiCLIRequest(model, body, stream), credentials), null);
register(FORMATS.OPENAI, FORMATS.ANTIGRAVITY, openaiToAntigravityRequest, null);
