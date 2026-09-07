// Claude helper functions for translator
import { DEFAULT_THINKING_CLAUDE_SIGNATURE } from "../../config/defaultThinkingSignature.js";
import { ROLE, CLAUDE_BLOCK, TOOL_TYPE } from "../schema/index.js";
import { adjustMaxTokens } from "./maxTokens.js";
import { applyCloaking } from "../../utils/claudeCloaking.js";
import { resolveSessionId } from "../../utils/sessionManager.js";
import { isValidClaudeSignature } from "../../utils/claudeSignature.js";
import { PROVIDERS } from "../../providers/index.js";
import { resolveProviderAlias } from "../../services/model.js";
import { getCapabilitiesForModel } from "../../providers/capabilities.js";
import { DEFAULT_MAX_TOKENS } from "../../config/runtimeConfig.js";
import { applyAssistantPrefillPolicy } from "../concerns/assistantPrefillPolicy.js";

const CACHE_CONTROL_5M = { type: "ephemeral" };
const CACHE_CONTROL_1H = { type: "ephemeral", ttl: "1h" };

// Check if message has valid non-empty content
export function hasValidContent(msg) {
  if (typeof msg.content === "string" && msg.content.trim()) return true;
  if (Array.isArray(msg.content)) {
    return msg.content.some(block =>
      (block.type === CLAUDE_BLOCK.TEXT && block.text?.trim()) ||
      block.type === CLAUDE_BLOCK.TOOL_USE ||
      block.type === CLAUDE_BLOCK.TOOL_RESULT ||
      block.type === CLAUDE_BLOCK.IMAGE ||
      block.type === CLAUDE_BLOCK.DOCUMENT
    );
  }
  return false;
}

// Fix tool_use/tool_result ordering for Claude API
// 1. Assistant message with tool_use: remove text AFTER tool_use (Claude doesn't allow)
// 2. Merge consecutive same-role messages
export function fixToolUseOrdering(messages) {
  if (messages.length <= 1) return messages;

  // Pass 1: Fix assistant messages with tool_use - remove text after tool_use
  for (const msg of messages) {
    if (msg.role === ROLE.ASSISTANT && Array.isArray(msg.content)) {
      const hasToolUse = msg.content.some(b => b.type === CLAUDE_BLOCK.TOOL_USE);
      if (hasToolUse) {
        // Keep only: thinking blocks + tool_use blocks (remove text blocks after tool_use)
        const newContent = [];
        let foundToolUse = false;

        for (const block of msg.content) {
          if (block.type === CLAUDE_BLOCK.TOOL_USE) {
            foundToolUse = true;
            newContent.push(block);
          } else if (block.type === CLAUDE_BLOCK.THINKING || block.type === CLAUDE_BLOCK.REDACTED_THINKING) {
            newContent.push(block);
          } else if (!foundToolUse) {
            // Keep text blocks BEFORE tool_use
            newContent.push(block);
          }
          // Skip text blocks AFTER tool_use
        }

        msg.content = newContent;
      }
    }
  }

  // Pass 2: Merge consecutive same-role messages
  const merged = [];

  for (const msg of messages) {
    const last = merged[merged.length - 1];

    if (last && last.role === msg.role) {
      // Merge content arrays
      const lastContent = Array.isArray(last.content) ? last.content : [{ type: CLAUDE_BLOCK.TEXT, text: last.content }];
      const msgContent = Array.isArray(msg.content) ? msg.content : [{ type: CLAUDE_BLOCK.TEXT, text: msg.content }];

      // Put tool_result first, then other content
      const toolResults = [...lastContent.filter(b => b.type === CLAUDE_BLOCK.TOOL_RESULT), ...msgContent.filter(b => b.type === CLAUDE_BLOCK.TOOL_RESULT)];
      const otherContent = [...lastContent.filter(b => b.type !== CLAUDE_BLOCK.TOOL_RESULT), ...msgContent.filter(b => b.type !== CLAUDE_BLOCK.TOOL_RESULT)];

      last.content = [...toolResults, ...otherContent];
    } else {
      // Ensure content is array
      const content = Array.isArray(msg.content) ? msg.content : [{ type: CLAUDE_BLOCK.TEXT, text: msg.content }];
      merged.push({ role: msg.role, content: [...content] });
    }
  }

  return merged;
}

// Models that reject thinking.type "adaptive" + output_config.effort (Opus 4.5+/Sonnet 4.6+ only)
const ADAPTIVE_THINKING_UNSUPPORTED = /haiku/i;

function handlesThinkingBlocks(provider) {
  return provider === "claude" || provider === "anthropic" || provider?.startsWith("anthropic-compatible") || provider === "deepseek";
}

function buildThinkingPlaceholder(provider) {
  const block = {
    type: CLAUDE_BLOCK.THINKING,
    thinking: ".",
  };

  // DeepSeek's Anthropic-compatible endpoint requires a thinking block in
  // thinking mode, but it does not need Anthropic's signed-thinking fallback.
  if (provider !== "deepseek") {
    block.signature = DEFAULT_THINKING_CLAUDE_SIGNATURE;
  }

  return block;
}

function isBlankThinkingBlock(block) {
  if (block?.type !== CLAUDE_BLOCK.THINKING) return false;
  return block.thinking == null || (typeof block.thinking === "string" && !block.thinking.trim());
}

function dropEmptyContentMessages(messages) {
  const cleaned = messages.filter((message, index) =>
    index === messages.length - 1 || !Array.isArray(message?.content) || message.content.length > 0
  );
  if (cleaned.length === messages.length) return cleaned;

  const merged = [];
  for (const message of cleaned) {
    const last = merged[merged.length - 1];
    if (last?.role !== ROLE.USER || message.role !== ROLE.USER) {
      merged.push(message);
      continue;
    }
    const lastContent = Array.isArray(last.content)
      ? last.content
      : [{ type: CLAUDE_BLOCK.TEXT, text: last.content }];
    const messageContent = Array.isArray(message.content)
      ? message.content
      : [{ type: CLAUDE_BLOCK.TEXT, text: message.content }];
    last.content = [...lastContent, ...messageContent];
  }
  return merged;
}

function unpairedToolResultText(block) {
  const content = block?.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
        .map(part => typeof part === "string"
          ? part
          : part?.type === CLAUDE_BLOCK.TEXT && typeof part.text === "string"
            ? part.text
            : "")
        .filter(Boolean)
        .join("\n")
      : "";
  const id = typeof block?.tool_use_id === "string" && block.tool_use_id
    ? block.tool_use_id
    : "unknown";
  return {
    type: CLAUDE_BLOCK.TEXT,
    text: text ? `[Unpaired tool result ${id}]\n${text}` : `[Unpaired tool result ${id}]`,
  };
}

function cloneClaudeMessages(messages) {
  return messages.map(message => ({
    ...message,
    content: Array.isArray(message?.content)
      ? message.content.map(block => block && typeof block === "object" ? { ...block } : block)
      : message?.content,
  }));
}

function mergeAdjacentUserMessages(messages) {
  const merged = [];
  for (const message of messages) {
    const previous = merged[merged.length - 1];
    if (previous?.role !== ROLE.USER || message?.role !== ROLE.USER) {
      merged.push(message);
      continue;
    }
    const previousContent = Array.isArray(previous.content)
      ? previous.content
      : [{ type: CLAUDE_BLOCK.TEXT, text: previous.content }];
    const content = Array.isArray(message.content)
      ? message.content
      : [{ type: CLAUDE_BLOCK.TEXT, text: message.content }];
    merged[merged.length - 1] = { ...previous, content: [...previousContent, ...content] };
  }
  return merged;
}

// Native Claude passthrough bypasses translateRequest(), which already repairs
// tool results. Reconcile only against the immediately preceding assistant
// turn so stale results are never paired across a completed conversation turn.
function reconcileNativeClaudeToolResults(messages) {
  for (let index = 1; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role !== ROLE.USER || !Array.isArray(message.content)) continue;

    const previous = messages[index - 1];
    const toolUseIds = previous?.role === ROLE.ASSISTANT && Array.isArray(previous.content)
      ? previous.content
        .filter(block => block?.type === CLAUDE_BLOCK.TOOL_USE && typeof block.id === "string" && block.id)
        .map(block => block.id)
        .filter((id, position, ids) => ids.indexOf(id) === position)
      : [];
    const expectedIds = new Set(toolUseIds);
    const matched = new Map();
    const otherContent = [];
    let hasToolResult = false;

    for (const block of message.content) {
      if (block?.type !== CLAUDE_BLOCK.TOOL_RESULT) {
        otherContent.push(block);
      } else {
        hasToolResult = true;
        if (expectedIds.has(block.tool_use_id) && !matched.has(block.tool_use_id)) {
          matched.set(block.tool_use_id, block);
        } else {
          otherContent.push(unpairedToolResultText(block));
        }
      }
    }

    if (toolUseIds.length > 0 || hasToolResult) {
      message.content = [
        ...toolUseIds.map(id => matched.get(id) || {
          type: CLAUDE_BLOCK.TOOL_RESULT,
          tool_use_id: id,
          content: "",
        }),
        ...otherContent,
      ];
    }
  }
  return messages;
}

// Nested server-tool models use the same provider namespace as the top-level
// request model. Remove only prefixes owned by this router before forwarding
// to Anthropic, while copying every tool object so fallback attempts retain
// the caller's original payload.
function normalizeKnownProviderToolModels(tools) {
  if (!Array.isArray(tools)) return tools;

  return tools.map((tool) => {
    if (!tool || typeof tool !== "object") return tool;

    const normalized = { ...tool };
    if (typeof tool.model !== "string") return normalized;

    const slash = tool.model.indexOf("/");
    if (slash <= 0) return normalized;

    const prefix = tool.model.slice(0, slash);
    const resolvedProvider = resolveProviderAlias(prefix);
    if ((typeof resolvedProvider === "string" && resolvedProvider !== prefix) || Object.hasOwn(PROVIDERS, prefix)) {
      normalized.model = tool.model.slice(slash + 1);
    }
    return normalized;
  });
}

// Normalize a native Claude passthrough body to match Anthropic Messages API spec.
// Newer Cowork/Claude Code clients emit beta-only shapes that OAuth endpoints reject:
// 1. thinking.type "adaptive" → unsupported on Haiku
// 2. output_config.effort → unsupported on Haiku
// 3. role "system" messages (mid-conversation-system beta) → only top-level system is allowed
export function normalizeClaudePassthrough(body, model = "", rawHeaders = null) {
  if (!body || typeof body !== "object") return body;

  // 1. Downgrade adaptive thinking for models that don't support it
  if (body.thinking?.type === "adaptive" && ADAPTIVE_THINKING_UNSUPPORTED.test(model)) {
    body.thinking = { type: "enabled", budget_tokens: 10000 };
  }

  // 2. Strip effort param for models that don't support it (keep other output_config fields)
  if (ADAPTIVE_THINKING_UNSUPPORTED.test(model) && body.output_config?.effort != null) {
    body.output_config = { ...body.output_config };
    delete body.output_config.effort;
    if (Object.keys(body.output_config).length === 0) delete body.output_config;
  }

  if (Array.isArray(body.tools)) {
    body.tools = normalizeKnownProviderToolModels(body.tools);
  }

  // 2. Fold mid-conversation system messages into the neighbouring turn.
  // Hoisting them into body.system would insert volatile content (token counters,
  // reminders) ahead of the whole conversation and invalidate the prefix cache on
  // every request. Folding in place keeps the cached prefix stable.
  if (Array.isArray(body.messages)) {
    const messages = [];
    for (const msg of reconcileNativeClaudeToolResults(cloneClaudeMessages(body.messages))) {
      if (msg.role !== ROLE.SYSTEM) {
        messages.push(msg);
        continue;
      }
      const text = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map(b => (typeof b === "string" ? b : b?.text || "")).join("\n")
          : "";
      if (!text.trim()) continue;

      // Copy-on-write: the caller's body is reused across account-fallback
      // attempts, so folding must never mutate the original message.
      const block = { type: CLAUDE_BLOCK.TEXT, text };
      const prev = messages[messages.length - 1];
      if (prev?.role === ROLE.USER) {
        const content = typeof prev.content === "string"
          ? [{ type: CLAUDE_BLOCK.TEXT, text: prev.content }]
          : Array.isArray(prev.content) ? [...prev.content] : [];
        messages[messages.length - 1] = { ...prev, content: [...content, block] };
        continue;
      }
      messages.push({ role: ROLE.USER, content: [block] });
    }
    body.messages = mergeAdjacentUserMessages(messages);
  }

  // 3. Drop thinking blocks whose signature is not Claude's (combo mixes models,
  // so foreign signatures leak into history and Anthropic rejects them).
  const thinkingEnabled = body.thinking?.type === "enabled";
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg.role !== ROLE.ASSISTANT || !Array.isArray(msg.content)) continue;
      let hasToolUse = false;
      let hasKeptThinking = false;
      const kept = [];
      for (const block of msg.content) {
        if (isBlankThinkingBlock(block)) continue;
        if (block.type === CLAUDE_BLOCK.THINKING || block.type === CLAUDE_BLOCK.REDACTED_THINKING) {
          if (isValidClaudeSignature(block.signature)) {
            hasKeptThinking = true;
            kept.push(block);
          }
          continue;
        }
        if (block.type === CLAUDE_BLOCK.TOOL_USE) hasToolUse = true;
        kept.push(block);
      }
      msg.content = kept;
      if (thinkingEnabled && !hasKeptThinking && hasToolUse) {
        msg.content.unshift(buildThinkingPlaceholder("claude"));
      }
    }
    body.messages = dropEmptyContentMessages(body.messages);
  }

  applyAssistantPrefillPolicy(body, rawHeaders);
  return body;
}

// Put a breakpoint on the last cache-eligible block of a message (5m unless
// the caller passes the 1h control). thinking/redacted_thinking blocks do not
// accept cache_control.
function markLastCacheableBlock(msg, cacheControl = CACHE_CONTROL_5M) {
  if (!Array.isArray(msg?.content)) return false;
  for (let i = msg.content.length - 1; i >= 0; i--) {
    const block = msg.content[i];
    if (typeof block !== "object" || block === null) continue;
    if (block.type === CLAUDE_BLOCK.THINKING || block.type === CLAUDE_BLOCK.REDACTED_THINKING) continue;
    block.cache_control = { ...cacheControl };
    return true;
  }
  return false;
}

// Re-anchor cache breakpoints on a Claude passthrough body (same policy as
// prepareClaudeRequest): last tool + last system block at 1h, last assistant at 5m.
// The client's own markers point at pre-normalization offsets, so they are dropped.
// Must run LAST, after every step that can reshape system/tools/messages
// (normalize, tool dedupe, token savers) — otherwise the anchor drifts off the tail.
// Anthropic refuses a tool that both defers loading and carries a cache anchor:
// "Tool '...' cannot both defer_loading=true cache_control set. Tools
// defer_loading cannot use prompt caching." MCP tools set defer_loading by
// default, so anchoring the LAST tool unconditionally 400'd the whole request
// whenever the last one happened to be an MCP tool (#3567).
function canCacheTool(tool) {
  return !(tool && tool.defer_loading === true);
}

// The index to anchor on: the last tool that can actually carry the anchor, or
// -1 when every tool defers, in which case no tool is anchored at all.
function lastCacheableToolIndex(tools) {
  for (let i = tools.length - 1; i >= 0; i--) if (canCacheTool(tools[i])) return i;
  return -1;
}

// Client plans are kept verbatim only when complete and within Anthropic's
// 4-breakpoint limit: valid means every block carries {type:"ephemeral"} with
// ttl absent, "5m", or "1h". Otherwise returns null and the legacy
// strip-and-re-anchor policy applies. Preserving valid client breakpoints is
// what keeps the cache prefix stable per request; the fallback anchors alone
// collapse every multi-breakpoint plan into one 5m tail.
function clientCacheAnchors(body) {
  const anchored = new Set();
  let count = 0;
  let valid = true;

  const visit = (block) => {
    if (!block || typeof block !== "object") return;
    const cc = block.cache_control;
    if (cc == null) return;
    count += 1;
    // F2: thinking blocks never accept cache_control (:357), so a preserved
    // anchor on one is a deterministic 400 — force the legacy re-anchor.
    if (block.type === CLAUDE_BLOCK.THINKING || block.type === CLAUDE_BLOCK.REDACTED_THINKING) {
      valid = false;
      return;
    }
    // F3: Anthropic refuses defer_loading tools that also carry cache_control
    // (#3567) — a preserved anchor on one resurrects that 400.
    if (block.defer_loading === true) {
      valid = false;
      return;
    }
    if (cc.type !== "ephemeral" || (cc.ttl !== undefined && cc.ttl !== "5m" && cc.ttl !== "1h")) {
      valid = false;
    } else {
      anchored.add(block);
    }
  };

  if (Array.isArray(body.system)) body.system.forEach(visit);
  if (Array.isArray(body.tools)) body.tools.forEach(visit);
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (Array.isArray(msg.content)) msg.content.forEach(visit);
    }
  }

  if (!valid || count === 0 || count > 4) return null;

  // Backfilling the fallback tail anchors (system 1h, tool 1h, last assistant
  // 5m) on positions the client left unanchored must keep the total at or
  // under the 4-breakpoint ceiling, or the preserve is abandoned.
  let fallbackNeeded = 0;
  if (Array.isArray(body.system) && body.system.length > 0 && !anchored.has(body.system[body.system.length - 1])) fallbackNeeded += 1;
  if (Array.isArray(body.tools)) {
    const lastTool = lastCacheableToolIndex(body.tools);
    if (lastTool >= 0 && !anchored.has(body.tools[lastTool])) fallbackNeeded += 1;
  }
  if (Array.isArray(body.messages)) {
    // F1: count the fallback on the same position anchorClaudeCache anchors —
    // the last assistant with content, else the last message with content of
    // any role (first-turn fallback). Counting only the last assistant missed
    // the first-turn tail anchor and let a 4-anchor plan ship a 5th breakpoint.
    let target = null;
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const msg = body.messages[i];
      if (!Array.isArray(msg.content)) continue;
      if (msg.role === ROLE.ASSISTANT) { target = msg; break; }
      if (!target) target = msg;
    }
    if (target && !target.content.some(b => anchored.has(b))) fallbackNeeded += 1;
  }
  if (count + fallbackNeeded > 4) return null;

  return anchored;
}

/**
 * Count cache_control blocks across system/tools/messages(+content), the same
 * surface clientCacheAnchors walks. chatCore classifies XFORM.cache-keep vs
 * XFORM.cache-legacy by comparing this count before and after translation.
 */
export function countCacheAnchors(body) {
  if (!body || typeof body !== "object") return 0;
  let count = 0;
  const visit = (block) => {
    if (!block || typeof block !== "object") return;
    const cc = block.cache_control;
    if (cc?.type === "ephemeral" && (cc.ttl === undefined || cc.ttl === "5m" || cc.ttl === "1h")) count += 1;
  };
  if (Array.isArray(body.system)) body.system.forEach(visit);
  if (Array.isArray(body.tools)) body.tools.forEach(visit);
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (Array.isArray(msg.content)) msg.content.forEach(visit);
    }
  }
  return count;
}

export function anchorClaudeCache(body, { ttl } = {}) {
  if (!body || typeof body !== "object") return body;
  // ttl selects the breakpoint lifetime policy (context-tuning suite, task
  // 6): "1h" upgrades gateway-stamped ephemeral anchors on the final body for
  // sessions whose measured inter-request gaps outlive the 5m breakpoint;
  // anything else is the legacy policy byte for byte. Positions never move —
  // ttl is a lifetime property, not part of the cache key — so upgrading an
  // anchor is prefix-stable. A client-EXPLICIT ttl ("5m" or "1h") is the
  // client's ask: never lifted, never downgraded. Only anchors with no ttl at
  // ingress follow the gateway policy.
  const upgradeTo1h = ttl === "1h";
  const tailControl = upgradeTo1h ? CACHE_CONTROL_1H : CACHE_CONTROL_5M;
  // Valid client breakpoints are kept verbatim (per-request cache-prefix
  // stability); everything else gets the legacy single-anchor policy.
  const keep = clientCacheAnchors(body);

  if (Array.isArray(body.system)) {
    const last = body.system.length - 1;
    body.system.forEach((block, i) => {
      if (typeof block !== "object" || block === null) return;
      if (i === last) {
        if (!keep || !block.cache_control) block.cache_control = { ...CACHE_CONTROL_1H };
      } else if (!keep) delete block.cache_control;
    });
  }

  if (Array.isArray(body.tools)) {
    const last = lastCacheableToolIndex(body.tools);
    body.tools.forEach((tool, i) => {
      if (i === last) {
        if (!keep || !tool.cache_control) tool.cache_control = { ...CACHE_CONTROL_1H };
      } else if (!keep) delete tool.cache_control;
    });
  }

  if (Array.isArray(body.messages)) {
    let anchored = null;
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const msg = body.messages[i];
      if (!Array.isArray(msg.content)) continue;
      if (!keep) for (const block of msg.content) delete block.cache_control;

      // Prefer the last assistant turn: it ends a completed exchange, so the
      // prefix up to it stays byte-stable across the following requests.
      if (anchored || msg.role !== ROLE.ASSISTANT) continue;
      // Client already anchored this turn — never add a second breakpoint.
      if (keep && msg.content.some(b => keep.has(b))) { anchored = true; continue; }
      anchored = markLastCacheableBlock(msg, tailControl);
    }

    // First turn of a conversation has no assistant yet — anchor the final
    // message instead, so the opening prompt is cached rather than paid twice.
    if (!anchored) {
      for (let i = body.messages.length - 1; i >= 0 && !anchored; i--) {
        const msg = body.messages[i];
        if (keep && Array.isArray(msg.content) && msg.content.some(b => keep.has(b))) { anchored = true; continue; }
        anchored = markLastCacheableBlock(msg, tailControl);
      }
    }
  }

  if (upgradeTo1h) {
    // Kept plans may carry client-stamped anchors. Only an anchor whose ttl
    // was absent at ingress is the gateway's to lift (a bare ephemeral anchor
    // asks for caching but makes no lifetime choice); an explicit client ttl
    // ("5m" or "1h") is the client's ask and survives verbatim. Gateway-added
    // anchors already carry the 1h control, so the lift is a no-op on them.
    const clientExplicit = new Set();
    if (keep) {
      for (const block of keep) {
        if (block?.cache_control?.ttl !== undefined) clientExplicit.add(block);
      }
    }
    const lift = (block) => {
      const cc = block?.cache_control;
      if (cc?.type !== "ephemeral" || cc.ttl === "1h") return;
      if (clientExplicit.has(block)) return;
      block.cache_control = { ...CACHE_CONTROL_1H };
    };
    if (Array.isArray(body.system)) body.system.forEach(lift);
    if (Array.isArray(body.tools)) body.tools.forEach(lift);
    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (Array.isArray(msg?.content)) msg.content.forEach(lift);
      }
    }
  }

  return body;
}

// Prepare request for Claude format endpoints
// - Cleanup cache_control
// - Filter empty messages
// - Add thinking block for Anthropic endpoint (provider === "claude")
// - Fix tool_use/tool_result ordering
// - Apply cloaking (billing header + fake user ID) for OAuth tokens
export function prepareClaudeRequest(body, provider = null, apiKey = null, connectionId = null, rawHeaders = null, sessionId = null) {
  // quirk: MiniMax's Claude-compatible endpoint rejects Anthropic's output_config (400 invalid params)
  if (PROVIDERS[provider]?.quirks?.dropOutputConfig) {
    delete body.output_config;
  }
  // quirk: non-Anthropic endpoints reject Anthropic's context_management (400 invalid params)
  if (provider !== "claude" && provider !== "anthropic") {
    delete body.context_management;
  }

  // Clamp max_tokens to the model's real output ceiling. Models whose caps
  // declare a higher maxOutput (e.g. Opus 4.8 / Sonnet 4.6 = 128000) are allowed
  // up to it, so max-effort thinking gets full budget; others fall back to the
  // conservative 64000 default.
  if (body.max_tokens) {
    const ceiling = getCapabilitiesForModel(provider, body.model).maxOutput || DEFAULT_MAX_TOKENS;
    if (body.max_tokens > ceiling) body.max_tokens = ceiling;

    // Reconcile against thinking budget. applyThinking (thinkingUnified.js) runs
    // AFTER adjustMaxTokens capped max_tokens, and the claude-budget format maps
    // max effort → budget_tokens 128000 — larger than the clamped max_tokens.
    // Anthropic requires max_tokens strictly greater than budget_tokens (else 400).
    // Prefer raising max_tokens to preserve the requested thinking depth; if the
    // budget alone meets/exceeds the ceiling, cap output and shrink the budget so
    // some tokens remain for the answer.
    if (body.thinking?.type === "enabled" && body.thinking.budget_tokens && body.thinking.budget_tokens >= body.max_tokens) {
      body.max_tokens = Math.min(body.thinking.budget_tokens + 1024, ceiling);
      if (body.thinking.budget_tokens >= body.max_tokens) {
        body.thinking.budget_tokens = Math.max(1024, body.max_tokens - 1024);
      }
    }
  }

  // 1. System: drop empty text blocks, remove all cache_control, add only to
  // last surviving block with ttl 1h — UNLESS the client sent a complete,
  // within-limit breakpoint plan, which is preserved verbatim for per-request
  // cache-prefix stability.
  //
  // Messages are filtered by hasValidContent below; system blocks were not, so
  // an OpenAI client sending { role: "system", content: "" } produced a
  // { type: "text", text: "" } block — and, being last, it also collected the
  // cache anchor. Anthropic and its compatible endpoints reject an empty text
  // block outright, which fails the whole request rather than the one block
  // (#2047). Anchoring on an empty block is wrong regardless: it caches nothing
  // and displaces the anchor from the prompt that would benefit.
  if (Array.isArray(body.system)) {
    const blocks = body.system.filter(
      (block) => !(block?.type === CLAUDE_BLOCK.TEXT && !String(block.text ?? "").trim())
    );
    // Count after the empty-block filter: blocks that normalization drops must
    // not weigh on the plan's validity.
    const keepClientCache = blocks.length > 0 ? clientCacheAnchors({ ...body, system: blocks }) : null;
    if (blocks.length === 0) {
      delete body.system;
    } else if (keepClientCache) {
      body.system = blocks.map((block, i) => {
        if (i === blocks.length - 1 && !block.cache_control) {
          return { ...block, cache_control: { type: "ephemeral", ttl: "1h" } };
        }
        return block;
      });
    } else {
      body.system = blocks.map((block, i) => {
        const { cache_control, ...rest } = block;
        if (i === blocks.length - 1) {
          return { ...rest, cache_control: { type: "ephemeral", ttl: "1h" } };
        }
        return rest;
      });
    }
  }

  const keepClientCache = clientCacheAnchors(body);

  // 2. Messages: process in optimized passes
  if (body.messages && Array.isArray(body.messages)) {
    const len = body.messages.length;
    let filtered = [];

    // Pass 1: remove cache_control + filter empty messages
    for (let i = 0; i < len; i++) {
      const msg = body.messages[i];

      // Remove cache_control from content blocks (legacy path only; a valid
      // client plan survives verbatim)
      if (!keepClientCache && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          delete block.cache_control;
        }
      }

      // Keep final assistant even if empty, otherwise check valid content
      const isFinalAssistant = i === len - 1 && msg.role === ROLE.ASSISTANT;
      if (isFinalAssistant || hasValidContent(msg)) {
        filtered.push(msg);
      }
    }

    // Pass 1.5: Fix tool_use/tool_result ordering
    // Each tool_use must have tool_result in the NEXT message (not same message with other content)
    filtered = fixToolUseOrdering(filtered);

    body.messages = filtered;
    applyAssistantPrefillPolicy(body, rawHeaders);
    filtered = body.messages;

    // Check if thinking is enabled AND last message is from user
    const lastMessage = filtered[filtered.length - 1];
    const lastMessageIsUser = lastMessage?.role === ROLE.USER;
    const thinkingEnabled = body.thinking?.type === "enabled" && lastMessageIsUser;

    // Pass 2 (reverse): add cache_control to last assistant + handle thinking for Anthropic
    let lastAssistantProcessed = false;
    for (let i = filtered.length - 1; i >= 0; i--) {
      const msg = filtered[i];

      if (msg.role === ROLE.ASSISTANT && Array.isArray(msg.content)) {
        // Add cache_control to last non-thinking block of first (from end) assistant with content
        // thinking/redacted_thinking blocks do not support cache_control
        // In the client-preserve path, a turn the client already anchored is
        // left untouched — never stack a second breakpoint on it.
        if (!lastAssistantProcessed && msg.content.length > 0) {
          if (!(keepClientCache && msg.content.some(b => keepClientCache.has(b)))) {
            for (let j = msg.content.length - 1; j >= 0; j--) {
              const block = msg.content[j];
              if (block.type !== CLAUDE_BLOCK.THINKING && block.type !== CLAUDE_BLOCK.REDACTED_THINKING) {
                block.cache_control = { type: "ephemeral" };
                break;
              }
            }
          }
          lastAssistantProcessed = true;
        }

        // Handle thinking blocks for Anthropic-compatible endpoints.
        if (handlesThinkingBlocks(provider)) {
          let hasToolUse = false;
          let hasKeptThinking = false;

          // Claude native: preserve valid signatures, drop invalid blocks.
          // anthropic-compatible: replace with default (safe fallback for lenient upstreams).
          // DeepSeek: keep existing thinking as-is; add an unsigned placeholder only if missing.
          const isClaudeNative = provider === "claude" || provider === "anthropic";
          const isDeepSeek = provider === "deepseek";
          const kept = [];
          for (const block of msg.content) {
            if (isBlankThinkingBlock(block)) continue;
            const isThinking = block.type === CLAUDE_BLOCK.THINKING || block.type === CLAUDE_BLOCK.REDACTED_THINKING;
            if (isThinking) {
              if (isClaudeNative) {
                if (isValidClaudeSignature(block.signature)) {
                  hasKeptThinking = true;
                  kept.push(block);
                }
              } else if (isDeepSeek) {
                hasKeptThinking = true;
                kept.push(block);
              } else {
                // Only fill in a signature that is missing or unusable. An
                // anthropic-compatible upstream signs its own thinking blocks,
                // and stamping the placeholder over a real one is a
                // MODIFICATION: the next turn comes back with "`thinking` or
                // `redacted_thinking` blocks in the latest assistant message
                // cannot be modified", so single turns work and every
                // multi-turn conversation dies from the second turn on (#2693).
                // The fallback still applies where it was meant to, a block
                // that arrived unsigned from a lenient upstream.
                if (!isValidClaudeSignature(block.signature)) {
                  block.signature = DEFAULT_THINKING_CLAUDE_SIGNATURE;
                }
                hasKeptThinking = true;
                kept.push(block);
              }
              continue;
            }
            if (block.type === CLAUDE_BLOCK.TOOL_USE) hasToolUse = true;
            kept.push(block);
          }
          msg.content = kept;

          // Add thinking block if thinking enabled + has tool_use but no thinking.
          //
          // DeepSeek needs it on EVERY assistant turn, not only the ones that
          // call a tool. In a multi-turn tool conversation the shape is
          // assistant[thinking, tool_use] then user[tool_result] then
          // assistant[text] — that last turn carries no tool_use, so it used to
          // leave here with no thinking block and the endpoint rejected the
          // whole request with "The `content[].thinking` in the thinking mode
          // must be passed back to the API" (#2397, #1786). Widening it to the
          // other families would be wrong: Anthropic wants thinking to LEAD a
          // tool-use turn and rejects an unsigned block anywhere, which is why
          // the placeholder is unsigned for DeepSeek alone (buildThinkingPlaceholder).
          //
          // Still gated on the turn having survived with content: a message
          // emptied by the filter above is dropped by dropEmptyContentMessages,
          // and a placeholder would resurrect it as a turn the client never sent.
          //
          // NEVER for Claude native. Anthropic verifies the signature
          // cryptographically, so a placeholder carrying the default one is not
          // a lenient stand-in there, it is an invalid credential, and the
          // request comes back "messages.N.content.0: Invalid `signature` in
          // `thinking` block" (#2227). That is the same 400 the drop above
          // exists to prevent, re-introduced by the repair. A turn that reaches
          // Anthropic with no thinking block at all may still be refused, but
          // for a reason that names the real problem, which is that the history
          // no longer carries the block the model produced.
          const needsThinking = !isClaudeNative
            && (hasToolUse || (isDeepSeek && msg.content.length > 0));
          if (thinkingEnabled && !hasKeptThinking && needsThinking) {
            msg.content.unshift(buildThinkingPlaceholder(provider));
          }
        }
      }
    }

    // F4: first turn has no assistant — mirror anchorClaudeCache's tail
    // fallback (last message with content, any role) so prepareClaudeRequest
    // alone stamps the same 5m anchor the full pipeline would.
    if (!lastAssistantProcessed) {
      for (let i = filtered.length - 1; i >= 0; i--) {
        const msg = filtered[i];
        if (!Array.isArray(msg.content)) continue;
        if (keepClientCache && msg.content.some(b => keepClientCache.has(b))) break;
        let anchored = false;
        for (let j = msg.content.length - 1; j >= 0; j--) {
          const block = msg.content[j];
          if (block.type !== CLAUDE_BLOCK.THINKING && block.type !== CLAUDE_BLOCK.REDACTED_THINKING) {
            block.cache_control = { type: "ephemeral" };
            anchored = true;
            break;
          }
        }
        if (anchored) break;
      }
    }
    body.messages = dropEmptyContentMessages(body.messages);
  }

  // 3. Tools: filter built-in tools for non-Anthropic providers, then handle cache_control
  if (body.tools && Array.isArray(body.tools)) {
    // A tool can carry its own `model`. Claude Code writes the configured
    // ANTHROPIC_DEFAULT_*_MODEL values into the Task tool's schema, so a
    // TokenProxy-namespaced id like "cc/claude-opus-4-8" reached Anthropic and was
    // rejected outright: {"message":"tools.36.model: cc/claude-opus-4-8"} —
    // every subagent dispatch failing (#2642). body.model is de-prefixed on the
    // way through; a model sitting on a tool was not.
    //
    // Only a prefix that resolves to a KNOWN provider alias or id is stripped,
    // so a value that merely contains a slash, or names something this router
    // does not own, is left exactly as the client sent it.
    body.tools = normalizeKnownProviderToolModels(body.tools);
    // Strip server tools and normalize OpenAI functions for compatible providers,
    // while retaining Anthropic's native custom-tool discriminator and schema.
    if (provider !== "claude" && provider !== "anthropic") {
      // A built-in server tool is one only Anthropic executes, so it cannot be
      // forwarded to another provider and is dropped here. The drop was silent,
      // and the shape of that silence is a WebSearch call that returns HTTP 200
      // with nothing in it while WebFetch and POST /v1/search both work, which
      // reads as a broken search rather than an unsupported one (#3133).
      // TokenProxy does not execute these itself; say so once per request so the
      // empty result has a visible cause.
      // Anthropic's optional custom discriminator describes a client-executed
      // schema tool, not a provider-hosted server tool.
      const isClientTool = (tool) => !tool.type || tool.type === TOOL_TYPE.FUNCTION || tool.type === TOOL_TYPE.CUSTOM;
      const droppedServerTools = body.tools
        .filter((tool) => !isClientTool(tool))
        .map((tool) => tool.name || tool.type);
      if (droppedServerTools.length > 0) {
        console.warn(
          `[Translator] ${provider} cannot run Anthropic built-in server tools; `
          + `dropped ${droppedServerTools.join(", ")}. A client calling one gets an `
          + `empty result — only the Anthropic API executes these.`
        );
      }
      body.tools = body.tools
        .filter(isClientTool)
        .map(tool => {
          if (tool.type === TOOL_TYPE.CUSTOM) return tool;
          if (tool.function) {
            return {
              name: tool.function.name,
              description: tool.function.description,
              input_schema: tool.function.parameters,
            };
          }
          const { type, ...rest } = tool;
          return rest;
        });
    }

    const lastCacheable = lastCacheableToolIndex(body.tools);
    body.tools = body.tools.map((tool, i) => {
      // Client-preserve path: keep client anchors verbatim, backfill 1h only
      // on an unanchored last cacheable tool.
      if (keepClientCache) {
        if (i === lastCacheable && !tool.cache_control) {
          return { ...tool, cache_control: { type: "ephemeral", ttl: "1h" } };
        }
        return tool;
      }
      const { cache_control, ...rest } = tool;
      if (i === lastCacheable) {
        return { ...rest, cache_control: { type: "ephemeral", ttl: "1h" } };
      }
      return rest;
    });

    // Remove tools array and tool_choice if empty after filtering
    if (body.tools.length === 0) {
      delete body.tools;
      delete body.tool_choice;
    }
  }

  // Apply cloaking for OAuth tokens (billing header + fake user ID)
  // session_id in user_id must match X-Claude-Code-Session-Id for fingerprint consistency
  if ((provider === "claude" || provider?.startsWith("anthropic-compatible")) && apiKey) {
    const sid = sessionId || resolveSessionId({ headers: rawHeaders, body, connectionId, scope: "claude" });
    body = applyCloaking(body, apiKey, sid);
  }

  return body;
}
