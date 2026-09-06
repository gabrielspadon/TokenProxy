import { createHash } from 'node:crypto';

export class ShapingError extends Error {
  constructor(code, status = 400, details = {}) { super(code); this.code = code; this.status = status; this.details = details; }
}
const flags = ['rtkEnabled', 'rtkAllowLossy', 'schemaDistillEnabled', 'schemaAllowLossy', 'thinkingStripEnabled', 'queryAwareCompressionEnabled', 'pairDropEnabled', 'embedReorderEnabled', 'midPrefixInjectEnabled', 'privacyFilterEnabled', 'headroomEnabled', 'headroomAllowLossy', 'headroomCompressUserMessages', 'headroomLossless', 'cavemanEnabled', 'ponytailEnabled', 'pxpipeEnabled', 'pxpipeAllowLossy', 'memoryToolPruningEnabled', 'memoryMediaPruningEnabled', 'memoryCompactionEnabled', 'memoryHandoffEnabled', 'toolDisclosureEnabled', 'toolDisclosureFilterEnabled'];
const integers = {
  pxpipeMinChars: [1, 10000000], pxpipeTimeoutMs: [1, 599999], memoryMaxToolTurnsKeepFull: [0, 1000],
  memoryMaxHistoricalToolChars: [1, 10000000], memoryCompactionThresholdTokens: [1, 10000000],
  memoryRecentTurnsToKeep: [1, 1000], toolDisclosureMaxTools: [1, 10000],
};
const lists = ['privacyFilterTerms', 'toolDisclosureExcludeServers', 'toolDisclosureExcludeTools'];
export const PROFILE_KEYS = [...flags, ...Object.keys(integers), ...lists, 'cavemanLevel', 'ponytailLevel', 'headroomTimeoutMs'];
export const PROFILE_COVERAGE = {
  scope: 'global shaping settings', takesEffect: 'New requests, unless a routing plan overrides these settings. In-flight requests retain their own settings.',
  excluded: ['Per-plan tokenSaver overrides', 'Service endpoints and installation', 'Routing policy', 'Context-window overrides', 'Session calibration and memo history'],
};
export function projectSettings(settings) {
  return Object.fromEntries(PROFILE_KEYS.map(key => [key, structuredClone(settings[key] ?? (flags.includes(key) ? false : key === 'headroomTimeoutMs' ? null : lists.includes(key) ? [] : null))]));
}
export const settingsHash = settings => createHash('sha256').update(JSON.stringify(Object.fromEntries(PROFILE_KEYS.map(key => [key, settings[key]])))).digest('hex');
export const settingsDiff = (before, after) => PROFILE_KEYS.filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key])).map(key => ({ key, before: before[key], after: after[key] }));
export function validateProfile(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || Object.keys(settings).some(key => !PROFILE_KEYS.includes(key))) throw new ShapingError('invalid_profile_fields');
  for (const key of flags) if (typeof settings[key] !== 'boolean') throw new ShapingError('invalid_profile_setting', 400, { key });
  for (const [key, [min, max]] of Object.entries(integers)) if (!Number.isSafeInteger(settings[key]) || settings[key] < min || settings[key] > max) throw new ShapingError('invalid_profile_setting', 400, { key });
  for (const key of lists) if (!Array.isArray(settings[key]) || settings[key].length > 100 || settings[key].some(value => typeof value !== 'string' || value.length > 500)) throw new ShapingError('invalid_profile_setting', 400, { key });
  for (const key of ['cavemanLevel', 'ponytailLevel']) if (!['lite', 'full', 'ultra'].includes(settings[key])) throw new ShapingError('invalid_profile_setting', 400, { key });
  if (settings.headroomTimeoutMs !== null && (!Number.isInteger(settings.headroomTimeoutMs) || settings.headroomTimeoutMs < 1 || settings.headroomTimeoutMs >= 600000)) throw new ShapingError('invalid_profile_setting', 400, { key: 'headroomTimeoutMs' });
  return structuredClone(settings);
}
export function consentRequired(settings) {
  const keys = ['thinkingStripEnabled', 'queryAwareCompressionEnabled', 'pairDropEnabled', 'embedReorderEnabled', 'midPrefixInjectEnabled', 'privacyFilterEnabled', 'memoryToolPruningEnabled', 'memoryMediaPruningEnabled', 'memoryCompactionEnabled', 'memoryHandoffEnabled', 'toolDisclosureEnabled', 'toolDisclosureFilterEnabled', 'cavemanEnabled', 'ponytailEnabled'];
  for (const [enabled, lossy] of [['rtkEnabled', 'rtkAllowLossy'], ['schemaDistillEnabled', 'schemaAllowLossy'], ['headroomEnabled', 'headroomAllowLossy'], ['pxpipeEnabled', 'pxpipeAllowLossy']]) if (settings[enabled] && settings[lossy]) keys.push(lossy);
  return keys.filter(key => settings[key]).sort();
}
export function validateConsent(settings, consent) {
  const required = consentRequired(settings);
  if (!Array.isArray(consent) || consent.some(key => typeof key !== 'string' || !PROFILE_KEYS.includes(key)) || required.some(key => !consent.includes(key))) throw new ShapingError('content_change_consent_required', 422, { required });
  return required;
}
