import { getAdapter } from '../db/driver.js';
import { AUTOMATION_LIMITS, executeAction } from './remediation.mjs';

export async function drainAuthorizedActions({ signal, adapter } = {}) {
  if (signal?.aborted) return { processed:0,aborted:true };
  const db = adapter || await getAdapter();
  // sql.js must persist the authorization intent before applying a recovered
  // action. Native SQLite commits already establish this boundary.
  db.flush?.();
  const ids = db.all("SELECT id FROM notificationActions WHERE state='queued' ORDER BY createdAt,id LIMIT ?",[AUTOMATION_LIMITS.batch]);
  const outcomes = [];
  for (const { id } of ids) {
    if (signal?.aborted) break;
    try {
      const result = executeAction(db,id);
      try { db.flush?.(); outcomes.push({ ...result,persistence:'confirmed' }); }
      catch { outcomes.push({ ...result,persistence:'unconfirmed' }); break; }
    } catch { outcomes.push({ id,state:'unavailable',changed:'unknown' }); break; }
    await new Promise(resolve => setImmediate(resolve));
  }
  return { processed:outcomes.length,outcomes,aborted:Boolean(signal?.aborted) };
}
