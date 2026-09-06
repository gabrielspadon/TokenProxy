import { getAdapter } from "../../lib/db/driver.js";
import { BudgetAdmissionError, budgetErrorResponse, reserveBudget, markBudgetDispatched, markBudgetUncertain } from "../../lib/db/repos/budgetRepo.js";

// OpenAI's native chat contract includes visible and reasoning tokens in this
// cap. Compatible endpoints and predicted/audio output have no verified bound
// here. Source https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
export function dispatchBudgetBounds({ url, body } = {}) {
  let destination;
  try { destination = new URL(url); } catch { return {}; }
  if (destination.origin !== "https://api.openai.com" || destination.pathname !== "/v1/chat/completions"
    || body?.prediction || body?.modalities?.includes?.("audio")) return {};
  const max = body?.max_completion_tokens;
  const n = body?.n ?? 1;
  if (!Number.isSafeInteger(max) || max <= 0 || !Number.isSafeInteger(n) || n <= 0 || n > 128
    || !Number.isSafeInteger(max * n)) return {};
  return { completionTokens: max * n,
    evidence: { source: "native-openai-chat-contract", field: "max_completion_tokens", includesReasoning: true, choices: n } };
}

export async function requireBudgetDispatchCoverage(apiKey, supported) {
  if (!apiKey || supported) return;
  const db = await getAdapter();
  const key = db.get("SELECT maxPromptTokens,maxCompletionTokens,maxCostUsd FROM apiKeys WHERE key=?", [apiKey]);
  if (key && [key.maxPromptTokens, key.maxCompletionTokens, key.maxCostUsd].some(v => v != null)) {
    throw new BudgetAdmissionError("budget-dispatch-coverage-unavailable", "This generation path does not yet support durable budget admission for every upstream attempt. No generation was dispatched.");
  }
}
export async function refuseUncoveredBudget(apiKey) {
  try { await requireBudgetDispatchCoverage(apiKey, false); return null; }
  catch (error) { if (error instanceof BudgetAdmissionError) return budgetErrorResponse(error); throw error; }
}
export function budgetErrorResult(error, rid) {
  return { success: false, status: error.status, error: error.message, response: budgetErrorResponse(error),
    failureMetadata: { safeToReplay: false, failurePhase: "admission" }, rid };
}
export async function beginBudgetDispatch(context, apiKey, wire) {
  const reservation = await reserveBudget({ apiKey, requestId: context.requestId, logicalRequestId: context.logicalRequestId,
    snapshot: context.pricingSnapshot, dispatchCoverage: "physical-dispatch", bounds: dispatchBudgetBounds(wire),
    onPrincipal: (id) => { context.apiKeyId = id; } });
  if (reservation) {
    context.budgetReservationId = reservation.requestId;
    await markBudgetDispatched(reservation.requestId);
  }
}
export async function observeBudgetResponse(context, { response, nonacceptance } = {}) {
  if (!context?.budgetReservationId) return;
  const rejected = [401, 403].includes(response?.status)
    || (response?.status === 400 && nonacceptance === "model-endpoint-unsupported");
  if (rejected && response.headers?.get?.("x-tokenproxy-replay-safe") !== "false") {
    const db = await getAdapter();
    db.run(`UPDATE apiKeyBudgetReservations SET state='released',updatedAt=?,resolutionEvidence=?
      WHERE requestId=? AND state IN ('dispatched','uncertain') AND usageRowId IS NULL`,
    [new Date().toISOString(), JSON.stringify({ source: "upstream-status", kind: "provider-nonacceptance", status: response.status,
      classification: nonacceptance ?? null }), context.budgetReservationId]);
  } else if (!response?.ok) {
    await markBudgetUncertain(context.budgetReservationId, "upstream-error-without-nonacceptance-proof");
  }
}
