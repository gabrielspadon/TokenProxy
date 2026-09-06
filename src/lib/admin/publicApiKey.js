// Public key records are an allowlist. New private repository fields must not
// become HTTP response fields by default.
const FIELDS = ["id", "name", "machineId", "isActive", "isExpired", "createdAt", "expiresAt",
  "maxPromptTokens", "maxCompletionTokens", "maxCostUsd", "allowedModels",
  "budgetPolicy", "effectiveBudgetPolicy", "budgetPolicyExplanation"];

export function publicApiKey(key) {
  if (!key) return null;
  const result = Object.fromEntries(FIELDS.filter(field => Object.hasOwn(key, field)).map(field => [field, key[field]]));
  result.keyPreview = typeof key.key === "string" && key.key.length >= 12 ? `••••${key.key.slice(-4)}` : "••••";
  result.secretRedacted = true;
  return result;
}
