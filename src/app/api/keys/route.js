import { NextResponse } from 'next/server';
import { getApiKeys, createApiKey, updateApiKey } from '@/lib/localDb';
import { deleteApiKeys, pickLimits } from '@/lib/db/repos/apiKeysRepo.js';
import { getKeyUsageSnapshot } from '@/lib/db/repos/keyUsageRepo.js';
import { getConsistentMachineId } from '@/shared/utils/machineId';
import { getApiKeyDeviceCount } from '@/sse/services/apiKeyDevices.js';
import { requireAdmin } from '@/lib/admin/guard.js';
import { publicApiKey } from '@/lib/admin/publicApiKey.js';
import { getApiKeyBudgetSummaries, validateBudgetPolicy } from '@/lib/db/repos/budgetRepo.js';
import { getAdapter } from '@/lib/db/driver.js';
import { profileComplianceFor } from '@/lib/db/repos/accessProfilesRepo.js';
import { getRotationSummaries } from '@/lib/db/repos/keyLifecycleRepo.js';
import { getKeyAttribution } from '@/lib/db/repos/keyAttributionRepo.js';

export const dynamic = 'force-dynamic';

// GET /api/keys - List API keys
export async function GET(request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    const keys = await getApiKeys();
    const budgets = await getApiKeyBudgetSummaries();
    const db = await getAdapter();
    const rotations = await getRotationSummaries();
    // Retained attribution, unlike the live device window below. A key absent
    // from this map has no attributed request at all, which the client renders
    // as unknown rather than as zero.
    let attribution = {};
    try {
      attribution = await getKeyAttribution();
    } catch {
      /* Attribution is evidence about the past, never a reason to withhold key controls. */
    }
    let history = null;
    try {
      const signals = [AbortSignal.timeout(250), ...(request.signal ? [request.signal] : [])];
      history = await getKeyUsageSnapshot({ signal: AbortSignal.any(signals) });
    } catch {
      /* Historical analytics cannot delay current key controls. */
    }
    return NextResponse.json(
      {
        usageState: history ? 'available' : 'unavailable',
        usageScope: history?.scope ?? 'retained-history-for-current-credential',
        usageFreshness: history?.freshness ?? null,
        // How many distinct clients are on the key right now, beside what it has
        // spent: a shared or leaked key shows up here before it shows up in the
        // bill (#930). A live in-memory window, so an absent key is 0 rather than
        // unknown.
        keys: keys.map((k) => ({
          ...publicApiKey(k),
          usage: history?.totals[k.id] ?? null,
          budget: budgets[k.id] ?? null,
          deviceCount: getApiKeyDeviceCount(k.key),
          // Which bundle the key follows, whether the bundle has moved on since
          // it adopted, and whether the key has been edited away from it. null
          // for a key nobody put on a profile.
          profile: profileComplianceFor(db, k),
          // Both sides of a rotation, so the superseded key can show its
          // deadline and the successor can point back at what it replaced.
          rotation: rotations[k.id] ?? null,
          // Absent means no attributed request was retained for this key. The
          // client renders that as unknown; it is never reported as zero use.
          attribution: attribution[k.id] ?? null,
        })),
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.log('Error fetching keys:', error);
    return NextResponse.json({ error: 'Failed to fetch keys' }, { status: 500 });
  }
}

// POST /api/keys - Create new API key
export async function POST(request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    const body = await request.json();
    // expiresAt is optional and absent means never expires, so a caller that
    // does not know about it keeps the behaviour it had (#2351). The repo
    // normalizes the shape and rejects at request-auth time.
    const { name, expiresAt = null } = body;
    if (body.budgetPolicy !== undefined) {
      try {
        validateBudgetPolicy(body.budgetPolicy);
      } catch (error) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }

    if (!name) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    }

    // Always get machineId from server
    const machineId = await getConsistentMachineId();
    const apiKey = await createApiKey(name, machineId, expiresAt);

    // maxPromptTokens / maxCompletionTokens / maxCostUsd are optional too, and
    // absent means no ceiling, so a caller that predates them creates exactly
    // the key it always did (#3371). allowedModels is optional in the same way
    // and absent means every model (#1154).
    const limits = pickLimits(body);
    const stored = Object.keys(limits).length ? await updateApiKey(apiKey.id, limits) : apiKey;
    globalThis.__tokenproxyLiveSafety?.authorizeDelivery('client-key-create', apiKey.key);

    return NextResponse.json(
      {
        key: apiKey.key,
        name: apiKey.name,
        id: apiKey.id,
        machineId: apiKey.machineId,
        expiresAt: apiKey.expiresAt,
        maxPromptTokens: stored.maxPromptTokens,
        maxCompletionTokens: stored.maxCompletionTokens,
        maxCostUsd: stored.maxCostUsd,
        budgetPolicy: stored.budgetPolicy,
        effectiveBudgetPolicy: stored.effectiveBudgetPolicy,
        budgetPolicyExplanation: stored.budgetPolicyExplanation,
        allowedModels: stored.allowedModels,
      },
      { status: 201, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.log('Error creating key:', error);
    return NextResponse.json({ error: 'Failed to create key' }, { status: 500 });
  }
}

// DELETE /api/keys?id=a&id=b — revoke several keys at once (#2120). The
// single-key route stays as it is; this is the same operation over a set, so a
// leaked batch is revoked in one action rather than one dialog per key.
export async function DELETE(request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    const ids = new URL(request.url).searchParams.getAll('id').filter(Boolean);
    if (!ids.length) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }
    const deleted = await deleteApiKeys(ids);
    // Reporting requested and deleted separately, because a batch containing an
    // id that was already gone is a partial success, not a failure: answering
    // "failed" would send the caller looking for a problem that is not there.
    return NextResponse.json({ requested: ids.length, deleted });
  } catch (error) {
    console.log('Error deleting keys:', error);
    return NextResponse.json({ error: 'Failed to delete keys' }, { status: 500 });
  }
}
