const MAX_STRING = 64;

function nonNegOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function signedOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boolOrNull(value) {
  return typeof value === "boolean" ? value : null;
}

function strOrNull(value) {
  if (typeof value !== "string") return null;
  return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value;
}

// volatileKeys arrives store-sanitized (<= 3 short structural key names); the
// route re-clamps rather than trusts, same as every other field.
function stringListOrNull(value) {
  if (!Array.isArray(value)) return null;
  return value
    .filter((v) => typeof v === "string")
    .slice(0, 8)
    .map((v) => (v.length > MAX_STRING ? v.slice(0, MAX_STRING) : v));
}

export function projectContextStatus(entry) {
  return {
      sid: strOrNull(entry?.sid),
      rid: strOrNull(entry?.rid),
      ctxTokens: nonNegOrNull(entry?.ctxTokens),
      ctxTokensActual: nonNegOrNull(entry?.ctxTokensActual),
      saveBytes: signedOrNull(entry?.saveBytes),
      ceBytes: nonNegOrNull(entry?.ceBytes),
      dollarsSaved: signedOrNull(entry?.dollarsSaved),
      epochHitRate: nonNegOrNull(entry?.epochHitRate),
      volatileKeys: stringListOrNull(entry?.volatileKeys),
      compactHint: boolOrNull(entry?.compactHint),
      updatedAt: strOrNull(entry?.updatedAt),
  };
}
