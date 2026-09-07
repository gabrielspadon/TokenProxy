import { createHash } from 'node:crypto';
import { normalizeProfileDefaults } from './profileDefaults.js';
import { UNAVAILABLE_CONTROLS } from './runtimeSupport.js';
export { UNAVAILABLE_CONTROLS } from './runtimeSupport.js';

export class ShapingError extends Error {
  constructor(code, status = 400, details = {}) { super(code); this.code = code; this.status = status; this.details = details; }
}
const flags = ['rtkEnabled', 'rtkAllowLossy', 'schemaDistillEnabled', 'schemaAllowLossy', 'thinkingStripEnabled', 'queryAwareCompressionEnabled', 'pairDropEnabled', 'embedReorderEnabled', 'midPrefixInjectEnabled', 'epochMicroEnabled', 'epochAutoEnabled', 'dietEnabled', 'linguaEnabled', 'adaptiveCacheTtlEnabled', 'privacyFilterEnabled', 'headroomEnabled', 'headroomAllowLossy', 'headroomCompressUserMessages', 'headroomLossless', 'cavemanEnabled', 'ponytailEnabled', 'pxpipeEnabled', 'pxpipeAllowLossy', 'memoryToolPruningEnabled', 'memoryMediaPruningEnabled', 'memoryCompactionEnabled', 'memoryHandoffEnabled', 'toolDisclosureEnabled', 'toolDisclosureFilterEnabled'];
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
export const PLAN_CONTROL_KEYS = ['enabled', 'rtk', 'schema', 'headroom', 'caveman', 'ponytail', 'pxpipe', 'thinking', 'qac', 'pairs', 'reorder', 'midinject', 'epochMicro', 'epochAuto', 'diet', 'lingua'];
export const RUNTIME_KEYS = ['headroomUrl', 'embedReorderUrl', 'embedReorderModel', 'pxpipeAutoInstall', 'contextStructureEnabled'];
export const runtimeSettingsHash = settings => createHash('sha256').update(JSON.stringify(RUNTIME_KEYS.map(key => [key, settings[key] ?? null]))).digest('hex');
export function projectRuntimeSettings(settings) {
  const redactedFields = [], values = Object.fromEntries(RUNTIME_KEYS.map(key => [key, settings[key] ?? null]));
  for (const key of ['headroomUrl', 'embedReorderUrl']) {
    try {
      const parsed = new URL(values[key]);
      if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = ''; values[key] = parsed.toString(); redactedFields.push(key);
      }
    } catch { values[key] = ''; redactedFields.push(key); }
  }
  return { settings: values, redactedFields };
}
export function validateRuntimePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length || Object.keys(patch).some(key => !RUNTIME_KEYS.includes(key))) throw new ShapingError('invalid_runtime_fields');
  for (const [key, value] of Object.entries(patch)) {
    if (['pxpipeAutoInstall', 'contextStructureEnabled'].includes(key)) { if (typeof value !== 'boolean') throw new ShapingError('invalid_runtime_setting', 400, { key }); }
    else if (key === 'embedReorderModel') { if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f]/.test(value)) throw new ShapingError('invalid_runtime_setting', 400, { key }); }
    else {
      let parsed; try { parsed = new URL(value); } catch { throw new ShapingError('invalid_runtime_url', 400, { key }); }
      if (typeof value !== 'string' || value.length > 2048 || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new ShapingError('invalid_runtime_url', 400, { key });
    }
  }
}
export const planControlHash = (name, value) => createHash('sha256').update(JSON.stringify([name, value ?? null])).digest('hex');
export function projectPlanControls(value) {
  if (typeof value === 'boolean') return { enabled: value };
  return Object.fromEntries(PLAN_CONTROL_KEYS.filter(key => typeof value?.[key] === 'boolean').map(key => [key, value[key]]));
}
export function validatePlanControlPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length || Object.entries(patch).some(([key, value]) => !PLAN_CONTROL_KEYS.includes(key) || (value !== null && typeof value !== 'boolean'))) throw new ShapingError('invalid_plan_control_fields');
}
export const settingsDiff = (before, after) => PROFILE_KEYS.filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key])).map(key => ({ key, before: before[key], after: after[key] }));
export function validateProfile(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || Object.keys(settings).some(key => !PROFILE_KEYS.includes(key))) throw new ShapingError('invalid_profile_fields');
  const normalized = normalizeProfileDefaults(settings);
  for (const key of flags) if (typeof normalized[key] !== 'boolean') throw new ShapingError('invalid_profile_setting', 400, { key });
  for (const [key, [min, max]] of Object.entries(integers)) if (!Number.isSafeInteger(normalized[key]) || normalized[key] < min || normalized[key] > max) throw new ShapingError('invalid_profile_setting', 400, { key });
  for (const key of lists) if (!Array.isArray(normalized[key]) || normalized[key].length > 100 || normalized[key].some(value => typeof value !== 'string' || value.length > 500)) throw new ShapingError('invalid_profile_setting', 400, { key });
  for (const key of ['cavemanLevel', 'ponytailLevel']) if (!['lite', 'full', 'ultra'].includes(normalized[key])) throw new ShapingError('invalid_profile_setting', 400, { key });
  if (normalized.headroomTimeoutMs !== null && (!Number.isInteger(normalized.headroomTimeoutMs) || normalized.headroomTimeoutMs < 1 || normalized.headroomTimeoutMs >= 600000)) throw new ShapingError('invalid_profile_setting', 400, { key: 'headroomTimeoutMs' });
  return structuredClone(normalized);
}
export function consentRequired(settings) {
  const keys = ['thinkingStripEnabled', 'queryAwareCompressionEnabled', 'pairDropEnabled', 'embedReorderEnabled', 'midPrefixInjectEnabled', 'epochMicroEnabled', 'epochAutoEnabled', 'dietEnabled', 'linguaEnabled', 'privacyFilterEnabled', 'memoryToolPruningEnabled', 'memoryMediaPruningEnabled', 'memoryCompactionEnabled', 'memoryHandoffEnabled', 'toolDisclosureEnabled', 'toolDisclosureFilterEnabled', 'cavemanEnabled', 'ponytailEnabled'];
  for (const [enabled, lossy] of [['rtkEnabled', 'rtkAllowLossy'], ['schemaDistillEnabled', 'schemaAllowLossy'], ['headroomEnabled', 'headroomAllowLossy'], ['pxpipeEnabled', 'pxpipeAllowLossy']]) if (settings[enabled] && settings[lossy]) keys.push(lossy);
  return keys.filter(key => settings[key]).sort();
}
export function validateConsent(settings, consent) {
  const required = consentRequired(settings);
  if (!Array.isArray(consent) || consent.some(key => typeof key !== 'string' || !PROFILE_KEYS.includes(key)) || required.some(key => !consent.includes(key))) throw new ShapingError('content_change_consent_required', 422, { required });
  return required;
}

export function validateControlPatch(before, patch, consent) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length || Object.keys(patch).some(key => !PROFILE_KEYS.includes(key))) throw new ShapingError('invalid_control_fields');
  for (const key of Object.keys(UNAVAILABLE_CONTROLS)) {
    if (Object.hasOwn(patch, key) && patch[key] !== before[key]) throw new ShapingError('control_runtime_unavailable', 422, { key, reason: UNAVAILABLE_CONTROLS[key] });
  }
  const after = validateProfile({ ...before, ...patch });
  return { after, acknowledged: validateConsent(after, consent) };
}
