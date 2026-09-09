export const BUDGET_DIMENSIONS = [
  ['promptTokens', 'maxPromptTokens', 'PromptTokens', 'unknownPromptRows'],
  ['completionTokens', 'maxCompletionTokens', 'CompletionTokens', 'unknownCompletionRows'],
  ['costUsd', 'maxCostUsd', 'CostUsd', 'unknownCostRows'],
];
export const BUDGET_POLICY_EXPLANATIONS = Object.freeze({
  strict: 'Refuses generation unless every capped quantity has a verified upper bound. Recorded application costs are estimates, not confirmed provider charges.',
  'reserve-remaining': 'Best-effort protection. An unknown-bound request reserves the remaining allowance and blocks overlapping exposure. Its actual usage or charge may exceed that allowance; this is not a hard cap or invoice guarantee.',
});
export const budgetAmount = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
export const budgetCapped = policy => BUDGET_DIMENSIONS.some(([, limit]) => policy?.[limit] != null);
export const effectiveBudgetPolicy = policy => policy?.budgetPolicy ?? 'reserve-remaining';
export function validateBudgetPolicy(value) {
  if (value !== null && !Object.hasOwn(BUDGET_POLICY_EXPLANATIONS, value)) throw new TypeError('budgetPolicy must be strict or reserve-remaining');
  return value;
}

// API-key and project admission use this same arithmetic in one transaction.
// Bounds come exclusively from the gateway's verified wire-contract resolver.
export function reservationAmounts({ policy, account, held, bounds, refuse, exceededCode = 'api_key_budget_exceeded' }) {
  const mode = effectiveBudgetPolicy(policy);
  validateBudgetPolicy(mode);
  const values = {};
  for (const [dimension, limit, column, unknown] of BUDGET_DIMENSIONS) {
    const bound = budgetAmount(bounds[dimension]);
    values[dimension] = policy[limit] == null ? null : bound;
    if (policy[limit] == null) continue;
    const remaining = policy[limit] - account[`recorded${column}`] - held[dimension];
    if (policy.budgetMode === 'alert') { values[dimension] = bound; continue; }
    if (held[unknown] > 0) refuse('budget-unresolved-exposure', `Outstanding ${dimension} exposure has no verified bound.`);
    if (mode === 'strict' && (bound === null || account[unknown] > 0)) {
      refuse('budget-bound-unavailable', `Strict ${dimension} protection requires a verified bound and complete recorded usage.`);
    }
    if (remaining <= 0 || (bound !== null && bound > remaining)) refuse(exceededCode, `${dimension} allowance is exhausted or already reserved.`);
    values[dimension] = bound ?? remaining;
  }
  return values;
}
