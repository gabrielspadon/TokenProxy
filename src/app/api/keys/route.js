import { NextResponse } from "next/server";
import { getApiKeys, createApiKey, updateApiKey } from "@/lib/localDb";
import { deleteApiKeys, getApiKeyUsageTotals, pickLimits } from "@/lib/db/repos/apiKeysRepo.js";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { getApiKeyDeviceCount } from "@/sse/services/apiKeyDevices.js";
import { requireAdmin } from "@/lib/admin/guard.js";
import { publicApiKey } from "@/lib/admin/publicApiKey.js";
import { validateBudgetPolicy } from "@/lib/db/repos/budgetRepo.js";

export const dynamic = "force-dynamic";

// GET /api/keys - List API keys
export async function GET(request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    const keys = await getApiKeys();
    // Each key carries its ceilings; without what it has already spent, a
    // ceiling is a number with nothing to compare it to (#3371). One grouped
    // query, not one per key.
    const totals = await getApiKeyUsageTotals();
    const zero = { promptTokens: 0, completionTokens: 0, costUsd: 0, requests: 0 };
    return NextResponse.json({
      // How many distinct clients are on the key right now, beside what it has
      // spent: a shared or leaked key shows up here before it shows up in the
      // bill (#930). A live in-memory window, so an absent key is 0 rather than
      // unknown.
      keys: keys.map((k) => ({
        ...publicApiKey(k),
        usage: totals[k.key] || zero,
        deviceCount: getApiKeyDeviceCount(k.key),
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.log("Error fetching keys:", error);
    return NextResponse.json({ error: "Failed to fetch keys" }, { status: 500 });
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
      try { validateBudgetPolicy(body.budgetPolicy); }
      catch (error) { return NextResponse.json({ error: error.message }, { status: 400 }); }
    }

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    // Always get machineId from server
    const machineId = await getConsistentMachineId();
    const apiKey = await createApiKey(name, machineId, expiresAt);

    // maxPromptTokens / maxCompletionTokens / maxCostUsd are optional too, and
    // absent means no ceiling, so a caller that predates them creates exactly
    // the key it always did (#3371). allowedModels is optional in the same way
    // and absent means every model (#1154).
    const limits = pickLimits(body);
    const stored = Object.keys(limits).length
      ? await updateApiKey(apiKey.id, limits)
      : apiKey;

    return NextResponse.json({
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
    }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.log("Error creating key:", error);
    return NextResponse.json({ error: "Failed to create key" }, { status: 500 });
  }
}

// DELETE /api/keys?id=a&id=b — revoke several keys at once (#2120). The
// single-key route stays as it is; this is the same operation over a set, so a
// leaked batch is revoked in one action rather than one dialog per key.
export async function DELETE(request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    const ids = new URL(request.url).searchParams.getAll("id").filter(Boolean);
    if (!ids.length) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }
    const deleted = await deleteApiKeys(ids);
    // Reporting requested and deleted separately, because a batch containing an
    // id that was already gone is a partial success, not a failure: answering
    // "failed" would send the caller looking for a problem that is not there.
    return NextResponse.json({ requested: ids.length, deleted });
  } catch (error) {
    console.log("Error deleting keys:", error);
    return NextResponse.json({ error: "Failed to delete keys" }, { status: 500 });
  }
}
