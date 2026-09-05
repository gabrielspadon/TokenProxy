import { createHash } from "node:crypto";
import { decide } from "../../../src/shared/observability/decide.js";

const REFRESH_RESULT_TTL_MS = 10_000;
const refreshDedupCache = new Map();

/** How long a connection stays listed as a chain peer after it last
 *  refreshed with that token. */
const CHAIN_MEMBER_TTL_MS = 6 * 60 * 60 * 1000;
const CHAIN_MAX = 512;
const CHAIN_CONN_MAX = 16;

/** First 8 hex of sha256 — the line carries the fingerprint, never the
 *  token (docs/logging-design.md §3.3). */
export function tokenFingerprint(token) {
  if (!token) return null;
  return createHash("sha256").update(String(token)).digest("hex").slice(0, 8);
}

// Token fingerprint -> Map(conn 8-char prefix -> last seen ms). Feeds
// CRED.chain-diverged peers=; bounded so the registry cannot become the leak.
const chainMembers = new Map();

function noteChainMember(fp, conn) {
  if (!fp || !conn) return;
  let members = chainMembers.get(fp);
  if (!members) {
    if (chainMembers.size >= CHAIN_MAX) {
      const oldest = chainMembers.keys().next().value;
      if (oldest !== undefined) chainMembers.delete(oldest);
    }
    members = new Map();
    chainMembers.set(fp, members);
  }
  members.set(conn, Date.now());
  if (members.size > CHAIN_CONN_MAX) members.delete(members.keys().next().value);
}

/** The other connections known to hold this token, newest first. */
export function chainPeers(fp, excludeConn) {
  const members = chainMembers.get(fp);
  if (!members) return [];
  const now = Date.now();
  const peers = [];
  for (const [conn, at] of members) {
    if (conn === excludeConn) continue;
    if (now - at > CHAIN_MEMBER_TTL_MS) continue;
    peers.push(conn);
  }
  return peers;
}

/** Comma list capped at 3 with a +N tail, per the chain-diverged field rule. */
export function connsLabel(conns) {
  if (!conns || !conns.length) return null;
  const shown = conns.slice(0, 3).join(",");
  return conns.length > 3 ? `${shown}+${conns.length - 3}` : shown;
}

/** Same-connection reuse is the dedup working as designed. Only a second
 *  connection joining the same chain speaks — once per joining connection. */
function reportChainReuse(chain, entry, conn) {
  if (!conn || !entry.conn || entry.conn === conn) return;
  if (entry.reusers.has(conn)) return;
  entry.reusers.add(conn);
  decide("CRED", "dedup-reuse", {
    chain,
    conns: connsLabel(chainPeers(chain, null)),
  });
}

export async function dedupRefresh(provider, oldToken, fn, log, conn = null) {
  if (!oldToken) return fn();
  const key = `${provider}:${oldToken}`;
  const chain = tokenFingerprint(oldToken);
  noteChainMember(chain, conn);
  const hit = refreshDedupCache.get(key);
  if (hit) {
    if (hit.promise) {
      log?.info?.("TOKEN_REFRESH", `Reusing in-flight refresh for ${provider}`);
      reportChainReuse(chain, hit, conn);
      return hit.promise;
    }
    if (hit.expiresAt > Date.now()) {
      log?.info?.("TOKEN_REFRESH", `Reusing recent refresh result for ${provider}`);
      reportChainReuse(chain, hit, conn);
      return hit.result;
    }
  }
  const entry = { conn, reusers: new Set() };
  entry.promise = (async () => {
    try {
      const result = await fn();
      delete entry.promise;
      entry.result = result;
      entry.expiresAt = Date.now() + REFRESH_RESULT_TTL_MS;
      return result;
    } catch (err) {
      refreshDedupCache.delete(key);
      throw err;
    } finally {
      // The success result stays cached for its TTL, then the entry is
      // removed so the map cannot grow one entry per distinct token forever.
      if (entry.expiresAt) {
        const t = setTimeout(() => {
          if (refreshDedupCache.get(key) === entry) refreshDedupCache.delete(key);
        }, REFRESH_RESULT_TTL_MS);
        t.unref?.();
      }
    }
  })();
  refreshDedupCache.set(key, entry);
  return entry.promise;
}
