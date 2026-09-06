import { createHash } from 'node:crypto';

/**
 * A digest of the request's CACHED PREFIX — never the prompt text itself.
 *
 * WHY THIS EXISTS. The affinity key was sha256(providerId : sessionId), and
 * Claude Code hands every subagent its parent's session uuid
 * (open-sse/utils/sessionManager.js reads `x-claude-code-session-id` and the
 * `_session_<uuid>` in metadata.user_id, both inherited). One session with
 * thirty concurrent agents therefore produced ONE pin per model, so thirty
 * agents queued on one account while the rest of the pool sat idle. Measured on
 * production 2026-09-06 over the last 4000 successful requests: sel=pin-hit
 * 3975 against sel=win 25, meaning 99.4% of requests never reached the ranker,
 * spread across five connections with the top one absorbing 1702.
 *
 * WHAT IT KEYS ON INSTEAD. The provider bills the prompt prefix, so the unit
 * that actually wants to stay on one account is the CACHE PREFIX, not the
 * session. Two agents of one session carry different system blocks and
 * different tool sets, so they get different keys and rank independently; five
 * turns of ONE agent carry the same ones, so they keep the same pin and the
 * provider-side cache survives.
 *
 * REGIONS WALKED, AND WHY IN THIS ORDER. `system` then `tools`. Both are fixed
 * for the life of an agent, but `system` has to come first: measured on the
 * isolated instance 2026-09-06, walking `tools` first made two subagents of one
 * session digest IDENTICALLY, because Claude Code anchors its last tool and
 * hands every subagent the same tool list, so the walk stopped inside `tools`
 * and never reached the block that tells the agents apart. `messages` is
 * deliberately NOT walked at all: Claude Code
 * also stamps a breakpoint on the last message of every turn, and hashing that
 * would give each turn its own key — a pin that never hits, one affinity row
 * per request, and the prompt-cache locality destroyed rather than protected.
 * A body whose only breakpoint is in `messages` therefore digests to '' and
 * routes exactly as it did before this function existed.
 *
 * RULE 8 HOLDS BY CONSTRUCTION. Only a digest leaves this function. Raw block
 * text is fed to the hash and never returned, logged or stored, the same
 * discipline resolveRoutingSessionHash documents.
 *
 * @param {unknown} body - the parsed client request body, whatever format.
 * @returns {string} 32 hex chars, or '' when the body carries no breakpoint in
 *   a stable region (every OpenAI-format body, every non-caching client).
 */
export function cachePrefixDigest(body) {
  if (!body || typeof body !== 'object') return '';
  const hash = createHash('sha256');
  let found = false;
  for (const region of [body.system, body.tools]) {
    if (!Array.isArray(region)) continue;
    for (const block of region) {
      // JSON.stringify preserves insertion order, and one client's parsed body
      // reproduces that order turn after turn, so no canonicalizer is needed
      // for the stability this key depends on.
      try {
        hash.update(JSON.stringify(block) ?? 'undefined');
      } catch {
        // A body we cannot serialize (a cycle) is a body we cannot key on.
        // Falling back to '' routes it the way it routed yesterday.
        return '';
      }
      if (block?.cache_control?.type === 'ephemeral') {
        found = true;
        break;
      }
    }
    if (found) break;
  }
  return found ? hash.digest('hex').slice(0, 32) : '';
}
