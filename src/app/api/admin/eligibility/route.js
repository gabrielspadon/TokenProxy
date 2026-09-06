import { getProviderConnections } from "@/lib/db/repos/connectionsRepo.js";
import { getAllWindows } from "@/lib/db/repos/quotaWindowsRepo.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { getDisabledModels } from "@/lib/db/repos/disabledModelsRepo.js";
import { getProviderNodes } from "@/lib/db/repos/nodesRepo.js";
import { readAllDrainDocs, readAllQualifications } from "@/lib/admin/state.js";
import { requireAdmin } from "@/lib/admin/guard.js";
import { adminError, adminJson } from "@/lib/admin/policy.js";
import { projectEligibility } from "@/lib/admin/eligibility.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const provider = params.get("provider")?.trim();
  const model = params.get("model")?.trim();
  if (!provider || !model || provider.length > 128 || model.length > 512 || /[\x00-\x1f\x7f]/.test(provider + model)) {
    return adminError(400, "invalid_query", "Provide a provider and a model identifier.");
  }
  try {
    const [connections, windowsByConnection, drains, qualifications, settings, disabledModels, providerNodes] = await Promise.all([
      getProviderConnections(), getAllWindows(), readAllDrainDocs(), readAllQualifications(), getSettings(), getDisabledModels(), getProviderNodes(),
    ]);
    return adminJson(projectEligibility({ connections, windowsByConnection, drains, qualifications, settings, disabledModels, providerNodes, provider, model }));
  } catch {
    return adminError(500, "state_unavailable", "Account eligibility state could not be read.");
  }
}
