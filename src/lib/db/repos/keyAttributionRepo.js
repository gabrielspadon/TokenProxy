import { getAdapter } from '../driver.js';

/**
 * Which client last used each key, from retained request statistics.
 *
 * THE COLUMNS ARE REAL, THE VALUES OFTEN ARE NOT. requestStats.clientKeyId is
 * set only when a caller sent the context-identity headers against a valid key
 * (contextEvidenceRepo), and clientTool only when the request went down the
 * context-telemetry path. Both are nullable and historical rows keep their
 * NULLs by design, so this returns null for a key it cannot attribute and the
 * UI renders "Unknown" rather than inventing a client.
 *
 * Attribution is NOT identity. clientTool is a self-reported label from the
 * caller's own headers: it says which tool claims to be using the key, which is
 * useful for spotting a key in two places at once and worthless as proof of
 * who. The device count on the keys list is the live counterpart; this is the
 * retained one.
 *
 * @returns {Promise<Record<string, {clientTool: string|null,
 *   lastSeenAt: string|null, requests: number, distinctClients: number,
 *   attribution: 'observed'|'unattributed'}>>}
 */
export async function getKeyAttribution() {
  const db = await getAdapter();
  const out = {};
  // One pass per key over an index that already exists (idx_rs_client_key on
  // clientKeyId, timestamp, id), so this stays cheap on a table nothing prunes.
  for (const row of db.all(
    `SELECT clientKeyId,
            COUNT(*) AS requests,
            COUNT(DISTINCT clientTool) AS distinctClients,
            MAX(timestamp) AS lastSeenAt
       FROM requestStats
      WHERE clientKeyId IS NOT NULL
      GROUP BY clientKeyId`
  )) {
    // The label belongs to the MOST RECENT request, not to the most frequent
    // one: "what is on this key now" is the question an operator is asking when
    // they rotate or revoke it.
    const latest = db.get(
      `SELECT clientTool, timestamp FROM requestStats
        WHERE clientKeyId = ? AND clientTool IS NOT NULL
        ORDER BY timestamp DESC, id DESC LIMIT 1`,
      [row.clientKeyId]
    );
    out[row.clientKeyId] = {
      clientTool: latest?.clientTool ?? null,
      lastSeenAt: latest?.timestamp ?? row.lastSeenAt ?? null,
      requests: row.requests,
      distinctClients: row.distinctClients,
      // Requests were attributed to the key, but none of them named a client.
      // Distinguished from a key with no attributed requests at all, which is
      // simply absent from this map.
      attribution: latest?.clientTool ? 'observed' : 'unattributed',
    };
  }
  return out;
}
