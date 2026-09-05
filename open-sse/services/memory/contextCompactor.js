/**
 * Sliding Window Context Compactor (Memory Optimization)
 *
 * Inspired by ai-memory's session distillation and compaction:
 * When conversations span 30-100+ turns, passing the entire raw message history
 * can exhaust provider context limits, cause latency spikes, and generate massive costs.
 *
 * This module monitors total message payload size/token estimate. When the threshold is
 * crossed, it preserves the system instruction and the most recent `recentTurnsToKeep` turns,
 * while consolidating older turns into a structured summary block.
 */

import { ELIDE_MARKER_RE } from '../../rtk/filters/elide.js';

const DEFAULT_THRESHOLD_TOKENS = 32000;
const DEFAULT_RECENT_TURNS = 8;
const CHARS_PER_TOKEN_ESTIMATE = 3.8;

// Claude-target bodies cannot carry role:"system" inside messages[]: the one
// claude normalizer that folds system messages runs BEFORE the memory stage,
// so a system-role summary ships an API-rejected shape. The midPrefixInject
// convention labels synthetic user notes "[tokenproxy context note] "; the
// compactor's claude summary uses the same label so the model (and every
// reader) can tell it from a real user turn.
const CLAUDE_USER_NOTE_PREFIX = '[tokenproxy context note] ';

/**
 * Fast conservative token estimation
 * @param {Array} items
 * @returns {number}
 */
export function estimateTokenCount(items) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  try {
    const rawLength = JSON.stringify(items).length;
    return Math.ceil(rawLength / CHARS_PER_TOKEN_ESTIMATE);
  } catch {
    return 0;
  }
}

/**
 * Extract concise text summary from a message item
 * @param {Object} msg
 * @returns {string}
 */
function summarizeMessage(msg) {
  if (!msg) return '';
  const role = msg.role || (msg.type === 'function_call_output' ? 'tool' : 'user');
  let contentText = '';

  if (typeof msg.content === 'string') {
    contentText = msg.content;
  } else if (Array.isArray(msg.content)) {
    contentText = msg.content
      .map((c) => {
        if (c?.type === 'text') return c.text;
        if (c?.type === 'tool_use') return `[called tool: ${c.name}]`;
        if (c?.type === 'tool_result') {
          // An elided result keeps its integrity marker verbatim (R-F5
          // discipline): the summary names it as preserved and carries the
          // marker text itself, never the fabricated word "output".
          if (typeof c.content === 'string' && ELIDE_MARKER_RE.test(c.content)) {
            const marker = c.content.match(ELIDE_MARKER_RE)[0];
            return `[elided tool result preserved verbatim, ${c.content.length} chars] ${marker}`;
          }
          return `[tool result: ${typeof c.content === 'string' ? c.content.slice(0, 100) : 'output'}]`;
        }
        return '';
      })
      .filter(Boolean)
      .join(' ');
  } else if (typeof msg.output === 'string') {
    contentText = msg.output;
  } else if (Array.isArray(msg.parts)) {
    contentText = msg.parts
      .map(
        (p) =>
          p.text ||
          (p.functionCall
            ? `[call: ${p.functionCall.name}]`
            : p.functionResponse
              ? `[result: ${p.functionResponse.name}]`
              : '')
      )
      .filter(Boolean)
      .join(' ');
  }

  // Bound the per-message summary to max 300 chars for the summary block
  const cleaned = contentText.replace(/\s+/g, ' ').trim();
  const truncated = cleaned.length > 250 ? `${cleaned.slice(0, 250)}...` : cleaned;
  return truncated ? `- **${role.toUpperCase()}**: ${truncated}` : '';
}

/**
 * Compact older conversation history into a structured summary
 * @param {Object} body - Request body
 * @param {Object} options
 * @param {boolean} options.enabled - Whether compaction is enabled
 * @param {number} [options.thresholdTokens=32000] - Token threshold to trigger compaction
 * @param {number} [options.recentTurnsToKeep=8] - Number of recent turns to keep intact
 * @returns {{ body: Object, compacted: boolean, originalTokens: number, newTokens: number }}
 */
export function compactContextWindow(body, options = {}) {
  const { enabled = false } = options;
  // Coerce with Number.isFinite fallbacks: NaN or a non-numeric threshold made
  // the size gate fire spuriously (every comparison against NaN is false, so
  // the "below threshold" early return never matched), and a recentTurnsToKeep
  // of 0 or less replaced the WHOLE conversation including the current query.
  const thresholdTokens =
    Number.isFinite(Number(options.thresholdTokens)) && Number(options.thresholdTokens) > 0
      ? Math.floor(Number(options.thresholdTokens))
      : DEFAULT_THRESHOLD_TOKENS;
  const recentTurnsToKeep = Math.max(
    1,
    Number.isFinite(Number(options.recentTurnsToKeep)) && Number(options.recentTurnsToKeep) >= 1
      ? Math.floor(Number(options.recentTurnsToKeep))
      : DEFAULT_RECENT_TURNS
  );

  if (!enabled || !body || typeof body !== 'object') {
    return { body, compacted: false, originalTokens: 0, newTokens: 0 };
  }

  const items = Array.isArray(body.messages)
    ? body.messages
    : Array.isArray(body.input)
      ? body.input
      : null;

  if (!items || items.length <= recentTurnsToKeep + 2) {
    return { body, compacted: false, originalTokens: 0, newTokens: 0 };
  }

  const originalTokens = estimateTokenCount(items);
  if (originalTokens < thresholdTokens) {
    return { body, compacted: false, originalTokens, newTokens: originalTokens };
  }

  // Preserve leading system messages at the start. System messages that
  // appear LATER in the conversation used to fall into the compacted region,
  // where the per-message 250-char summary cap silently dropped their content;
  // they are now preserved verbatim right after the summary blocks instead.
  const systemMessages = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i]?.role !== 'system') break;
    systemMessages.push(items[i]);
  }
  const conversationStartIndex = systemMessages.length;

  // System messages past the head used to fall into the compacted region,
  // where the per-message summary cap silently dropped their content. They
  // are pulled out verbatim and re-spliced after the summary blocks; they are
  // also excluded from the summary input's turn accounting below.
  const midSystemMessages = [];
  for (let i = conversationStartIndex; i < items.length; i++) {
    if (items[i]?.role === 'system') midSystemMessages.push(items[i]);
  }

  const conversationalItems = items
    .slice(conversationStartIndex)
    .filter((m) => m?.role !== 'system');
  if (conversationalItems.length <= recentTurnsToKeep) {
    return { body, compacted: false, originalTokens, newTokens: originalTokens };
  }

  const splitIndex = conversationalItems.length - recentTurnsToKeep;
  const olderItems = conversationalItems.slice(0, splitIndex);
  const recentItems = conversationalItems.slice(splitIndex);

  const SUMMARY_MARKER = '[Historical Context Summary by tokenproxy Memory Optimizer]';
  const SECTION_FALLBACK = 'none recorded';
  const FILE_PATH_RE = /(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,10}/g;
  const DECISION_RE =
    /\b(decided|decision|agreed|chosen|chose|settled|will use|going with|opted)\b/i;
  const ERROR_RE =
    /\b(error|errors|failed|failure|exception|broken|crash(?:ed)?|stack trace|fix(?:ed|es)?|bug|regression|workaround|panic)\b/i;
  const PENDING_RE =
    /\b(todo|pending|follow[- ]?up|remaining|blocked|next step|not yet|fixme|still needs?|open item)\b/i;

  function textOf(msg) {
    if (!msg) return '';
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join(' ');
    }
    return '';
  }

  // Structured checklist summary (deterministic extraction, no model call):
  // Intent, Decisions, Files, Errors and fixes, Pending, Next as compact labeled
  // lines. Sections without keyword matches fall back to raw per-message lines so
  // representative content is kept even when the history names nothing explicitly.
  function buildSummary(olderItems) {
    const highlights = olderItems.map(summarizeMessage).filter(Boolean).slice(-20);

    const convo = olderItems.filter((m) => m.role === 'user' || m.role === 'assistant');
    const firstUser = convo.find((m) => m.role === 'user');
    const lastUser = convo.length > 0 ? convo[convo.length - 1] : null;
    const clip = (t) => {
      const flat = t.replace(/\s+/g, ' ').trim();
      return flat.length > 200 ? flat.slice(0, 200) + '…' : flat;
    };
    const intent = firstUser ? clip(textOf(firstUser)) : SECTION_FALLBACK;
    const next = lastUser ? clip(textOf(lastUser)) : SECTION_FALLBACK;

    const decisionHits = highlights.filter((h) => DECISION_RE.test(h));
    const errorHits = highlights.filter((h) => ERROR_RE.test(h));
    const picked = new Set([...decisionHits, ...errorHits]);
    const rest = highlights.filter((h) => !picked.has(h));
    // Fallback keeps EVERY unmatched highlight (split across the two sections)
    // so the pre-checklist guarantee, all of the last 20 per-message lines, holds.
    const decisionLines =
      decisionHits.length > 0
        ? decisionHits.slice(0, 3)
        : rest.slice(0, Math.ceil(rest.length / 2));
    const errorLines =
      errorHits.length > 0 ? errorHits.slice(0, 4) : rest.slice(Math.ceil(rest.length / 2));

    const seenPaths = new Set();
    const files = [];
    for (const item of olderItems) {
      // FILE_PATH_RE backtracks O(n^2) on long slash-free runs (no "/" means
      // [\w.-]+ greedily eats to the end then backtracks per start position).
      // Only the first few file paths per message are ever surfaced, so bound
      // the scanned text rather than let one oversized message dominate a pass
      // over the whole history.
      for (const m of textOf(item).slice(0, 4000).matchAll(FILE_PATH_RE)) {
        if (!seenPaths.has(m[0])) {
          seenPaths.add(m[0]);
          files.push(m[0]);
          if (files.length >= 10) break;
        }
      }
      if (files.length >= 10) break;
    }

    const pendingHits = highlights.filter((h) => PENDING_RE.test(h)).slice(0, 3);

    return [
      SUMMARY_MARKER,
      `Notice: Earlier conversation turns (${olderItems.length} messages) have been compacted to conserve context window.`,
      `Intent: ${intent || SECTION_FALLBACK}`,
      `Decisions: ${decisionLines.length > 0 ? decisionLines.join('; ') : SECTION_FALLBACK}`,
      `Files: ${files.length > 0 ? files.join(', ') : SECTION_FALLBACK}`,
      `Errors and fixes: ${errorLines.length > 0 ? errorLines.join('; ') : SECTION_FALLBACK}`,
      `Pending: ${pendingHits.length > 0 ? pendingHits.join('; ') : SECTION_FALLBACK}`,
      `Next: ${next || SECTION_FALLBACK}`,
    ].join('\n');
  }

  const summaryContent = buildSummary(olderItems);

  // #2187: the summary never rides a fabricated user/assistant dialogue. For
  // non-claude targets both blocks carry role "system" (system-scoped notices).
  // Claude targets cannot: role:"system" inside messages[] is rejected by the
  // API once the one system-folding normalizer has already run, so there the
  // summary+notice ship as ONE user-role note under the midPrefixInject
  // "[tokenproxy context note]" label, which marks it as proxy-written.
  const compactionNoticeText =
    'The summary above replaces the compacted turns above it; continue the conversation using it as context.';
  const claudeTarget = options.format === 'claude';

  const summaryMessage = claudeTarget
    ? {
        role: 'user',
        content: `${CLAUDE_USER_NOTE_PREFIX}${summaryContent}\n\n${compactionNoticeText}`,
      }
    : {
        role: 'system',
        content: summaryContent,
      };

  const compactionNotice = claudeTarget
    ? null
    : {
        role: 'system',
        content: compactionNoticeText,
      };

  const compactedMessages = [
    ...systemMessages,
    summaryMessage,
    ...(compactionNotice ? [compactionNotice] : []),
    ...midSystemMessages,
    ...recentItems,
  ];

  if (Array.isArray(body.messages)) {
    body.messages = compactedMessages;
  } else if (Array.isArray(body.input)) {
    body.input = compactedMessages;
  }

  const newTokens = estimateTokenCount(compactedMessages);

  return {
    body,
    compacted: true,
    originalTokens,
    newTokens,
    savedTokens: Math.max(0, originalTokens - newTokens),
  };
}
