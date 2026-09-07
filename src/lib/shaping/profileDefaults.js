const laterFlags = ['epochMicroEnabled', 'epochAutoEnabled', 'dietEnabled', 'linguaEnabled', 'adaptiveCacheTtlEnabled'];

// A legacy saved version keeps its original content and hash. Its later-added
// controls take the same default-off values in editing, review and activation.
export function normalizeProfileDefaults(settings) {
  const normalized = { ...settings };
  for (const key of laterFlags) if (!Object.hasOwn(normalized, key)) normalized[key] = false;
  return normalized;
}
