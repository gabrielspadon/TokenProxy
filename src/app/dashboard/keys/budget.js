export const KEY_BUDGET_DIMENSIONS = [
  { used: 'promptTokens', limit: 'maxPromptTokens', unknownRecorded: 'unknownPromptRows', unknownHeld: 'unknownPromptBounds', label: 'Prompt tokens' },
  { used: 'completionTokens', limit: 'maxCompletionTokens', unknownRecorded: 'unknownCompletionRows', unknownHeld: 'unknownCompletionBounds', label: 'Completion tokens' },
  { used: 'costUsd', limit: 'maxCostUsd', unknownRecorded: 'unknownCostRows', unknownHeld: 'unknownCostBounds', label: 'Recorded cost estimate' },
];

const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

// This explains current accounting evidence. Eligibility still depends on the
// next request's verified bounds, model and executor capabilities.
export function keyBudgetState(key) {
  if (!key.isActive) return { state: 'off', label: 'Deactivated', tone: 'warn' };
  if (key.isExpired) return { state: 'expired', label: 'Expired', tone: 'warn' };
  const capped = KEY_BUDGET_DIMENSIONS.some(dimension => key[dimension.limit] != null);
  const budget = key.budget;
  if (capped && !budget) return { state: 'unknown', label: 'Budget evidence unavailable', tone: 'warn' };
  if (capped && budget.durableStorage === false) return { state: 'blocked', label: 'Durable storage required', tone: 'bad' };
  for (const dimension of KEY_BUDGET_DIMENSIONS) {
    const limit = amount(key[dimension.limit]);
    if (limit === null) continue;
    const recorded = amount((budget?.recorded ?? key.usage)?.[dimension.used]);
    if (recorded !== null && recorded >= limit) return { state: 'over', label: 'Ceiling reached', tone: 'bad' };
    const outstanding = budget?.outstanding;
    if (outstanding?.[dimension.unknownHeld] > 0) return { state: 'held', label: 'Unresolved exposure', tone: 'warn' };
    const held = amount(outstanding?.[dimension.used]);
    if (recorded !== null && held !== null && recorded + held >= limit) return { state: 'held', label: 'Allowance held', tone: 'warn' };
    if (budget?.policy === 'strict' && budget?.recorded?.[dimension.unknownRecorded] > 0) {
      return { state: 'blocked', label: 'Incomplete usage evidence', tone: 'warn' };
    }
  }
  return { state: 'on', label: 'Enabled', tone: 'ok' };
}

export function keyBudgetMeasurements(key) {
  const budget = key.budget;
  return KEY_BUDGET_DIMENSIONS.map(dimension => ({ ...dimension,
    ceiling: amount(key[dimension.limit]),
    recorded: amount((budget?.recorded ?? key.usage)?.[dimension.used]),
    held: amount(budget?.outstanding?.[dimension.used]),
    unknownRecorded: budget?.recorded ? amount(budget.recorded[dimension.unknownRecorded]) : null,
    unknownHeld: amount(budget?.outstanding?.[dimension.unknownHeld]),
    source: budget?.recorded ? 'Lifetime application ledger' : 'Retained usage history',
  }));
}
