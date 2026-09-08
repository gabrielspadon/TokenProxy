import { describe, expect, it } from 'vitest';
import { EVERYDAY_GROUPS, NAV, NAV_GROUPS, navigationGroups } from '../../src/shared/nav';

describe('everyday navigation', () => {
  it('keeps current specialist destinations reachable without changing the selected page', () => {
    const groups = navigationGroups('everyday', '/dashboard/sessions');
    expect(groups.at(-1)).toEqual({ label: 'Current page', paths: ['/dashboard/sessions'] });
    expect(navigationGroups('everyday', '/dashboard/connections/account-1')).toBe(EVERYDAY_GROUPS);
    expect(navigationGroups('everyday', '/dashboard/model-context').at(-1).paths).toEqual(['/dashboard/model-context']);
  });

  it('exposes every retained destination in advanced without duplicate or obsolete entries', () => {
    const paths = navigationGroups('advanced', '/dashboard').flatMap(group => group.paths);
    expect(new Set(paths).size).toBe(paths.length);
    expect(new Set(paths)).toEqual(new Set(NAV.map(item => item.href)));
    expect(paths).not.toContain('/dashboard/remote');
    expect(paths).not.toContain('/dashboard/translation');
    expect(navigationGroups('advanced', '/dashboard')).toBe(NAV_GROUPS);
  });

  it('falls back to daily work for unknown preferences and paths', () => {
    expect(navigationGroups('corrupted', '/missing')).toBe(EVERYDAY_GROUPS);
  });
});
