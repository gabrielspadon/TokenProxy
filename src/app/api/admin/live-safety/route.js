import { requireAdmin } from '@/lib/admin/guard.js';
import { adminJson } from '@/lib/admin/policy.js';
import { DATA_FILE } from '@/lib/db/paths.js';
import { getCriticalAcknowledgmentRuntime } from '@/lib/db/adapters/criticalAckJournal.js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  const snapshot = globalThis.__tokenproxyLiveSafety?.snapshot();
  if (snapshot) snapshot.criticalAcknowledgments = getCriticalAcknowledgmentRuntime({databaseFile:DATA_FILE});
  return adminJson(snapshot || { schemaVersion:1,kind:'live-secret-snapshot',
    unobservable:[{reason:'runtime-observer-not-installed',count:1}] });
}
