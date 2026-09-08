import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTROLS, configurationPatch, configuredState, stageEvidence, thresholdPatch } from '../../src/app/dashboard/shaping/controlCatalog.js';
import { PROFILE_KEYS } from '../../src/lib/shaping/profile.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
describe('optimization control evidence', () => {
  it('distinguishes a measured zero from an event with no byte measurement', () => {
    const map = {
      epochMicro: { requests: 1, applied: 0, bytesSaved: 0, measuredRequests: 1 },
      epochAuto: { requests: 1, applied: 0, bytesSaved: 0, measuredRequests: 0 },
    };
    expect(stageEvidence(map, 'epochMicro')).toMatchObject({ measured: true, delta: 0, measuredRecords: 1 });
    expect(stageEvidence(map, 'epochAuto')).toMatchObject({ measured: false, measuredRecords: 0 });
  });
  it('keeps signed growth and the measured-record denominator', () => {
    const reduced = stageEvidence({ rtk: { requests: 2, applied: 2, bytesSaved: -2048, measuredRequests: 1 } }, 'rtk');
    const grew = stageEvidence({ inject: { requests: 1, applied: 1, bytesSaved: 384, measuredRequests: 1 } }, 'inject');
    expect(reduced).toMatchObject({ delta: -2048, measuredRecords: 1, records: 2 });
    expect(grew).toMatchObject({ delta: 384, measured: true });
  });
  it('does not infer coverage from a legacy nonzero aggregate or missing stage', () => {
    expect(stageEvidence({ rtk: { bytesSaved: -10, requests: 1 } }, 'rtk')).toMatchObject({ delta: -10, measured: false, measuredRecords: null });
    expect(stageEvidence({}, 'lingua')).toMatchObject({ delta: null, measured: false, records: null });
    expect(stageEvidence({}, null)).toMatchObject({ delta: null, measured: false });
  });
  it('keeps historical execution independent of present configuration', () => {
    const control = CONTROLS.find(item => item.key === 'dietEnabled');
    expect(configuredState({ dietEnabled: false }, control)).toBe('Off');
    expect(stageEvidence({ diet: { requests: 2, applied: 1, bytesSaved: -8192, measuredRequests: 2 } }, control.stage).applied).toBe(1);
    expect(configuredState(null, control)).toBe('Unknown');
  });
  it('retains the default-off permission when its setting has never been persisted', () => {
    const permission = CONTROLS.find(item => item.key === 'rtkAllowLossy');
    expect(configuredState({}, permission)).toBe('Off');
    expect(configuredState(null, permission)).toBe('Unknown');
    expect(configuredState({ rtkAllowLossy: 'false' }, permission)).toBe('Unknown');
  });
});

describe('optimization settings boundary', () => {
  it('requires usable integer values before submitting a threshold patch', () => {
    expect(thresholdPatch({ pxpipeTimeoutMs: '' })).toBeNull();
    expect(thresholdPatch({ pxpipeTimeoutMs: '1.5' })).toBeNull();
    expect(thresholdPatch({ pxpipeTimeoutMs: '600000' })).toBeNull();
    expect(thresholdPatch({ memoryRecentTurnsToKeep: '0' })).toBeNull();
    expect(thresholdPatch({ memoryMaxToolTurnsKeepFull: '0', pxpipeTimeoutMs: '599999' })).toEqual({ memoryMaxToolTurnsKeepFull: 0, pxpipeTimeoutMs: 599999 });
  });
  it('keeps an inherited service timeout distinct from numeric zero', () => {
    expect(thresholdPatch({ headroomTimeoutMs: '' })).toEqual({ headroomTimeoutMs: null });
    expect(thresholdPatch({ headroomTimeoutMs: null })).toEqual({ headroomTimeoutMs: null });
    expect(thresholdPatch({ headroomTimeoutMs: '0' })).toBeNull();
    expect(thresholdPatch({ headroomTimeoutMs: '600000' })).toBeNull();
  });
  it('validates direct response levels and exact lists against the saved controls contract', () => {
    expect(configurationPatch({ cavemanLevel: 'full', toolDisclosureExcludeTools: ['tool_one', ' tool two '] })).toEqual({ cavemanLevel: 'full', toolDisclosureExcludeTools: ['tool_one', ' tool two '] });
    expect(configurationPatch({ ponytailLevel: 'invalid' })).toBeNull();
    expect(configurationPatch({ privacyFilterTerms: ['x'.repeat(501)] })).toBeNull();
    expect(configurationPatch({ privacyFilterTerms: Array(101).fill('x') })).toBeNull();
    expect(configurationPatch({ privacyFilterTerms: 'not an array' })).toBeNull();
    expect(configurationPatch({ missing: 1 })).toBeNull();
    expect(configurationPatch({})).toBeNull();
  });
  it('exposes persisted profile controls with existing source owners', () => {
    for (const control of CONTROLS) {
      expect(PROFILE_KEYS, control.key).toContain(control.key);
      expect(existsSync(path.join(root, control.source)), control.source).toBe(true);
    }
    expect(new Set(CONTROLS.map(control => control.key)).size).toBe(CONTROLS.length);
  });
  it('keeps adaptive lifetime global and each new context stage default-off', () => {
    for (const key of ['epochMicroEnabled', 'epochAutoEnabled', 'dietEnabled', 'linguaEnabled', 'adaptiveCacheTtlEnabled']) {
      const control = CONTROLS.find(item => item.key === key);
      expect(control.defaultOn).not.toBe(true);
      expect(control.threshold.length).toBeGreaterThan(0);
      expect(control.failure.length).toBeGreaterThan(0);
    }
    const ttl = CONTROLS.find(control => control.key === 'adaptiveCacheTtlEnabled');
    expect(ttl.override).toBeUndefined();
    expect(ttl.stage).toBeNull();
  });
});
