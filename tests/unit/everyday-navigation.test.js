import { describe, expect, it } from 'vitest';
import { NAV, NAV_GROUPS, navigationGroups } from '../../src/shared/nav';

describe('workspace navigation', () => {
  it('exposes every retained destination in one grouping without duplicate or obsolete entries', () => {
    const paths = navigationGroups().flatMap(group => group.paths);
    expect(new Set(paths).size).toBe(paths.length);
    expect(new Set(paths)).toEqual(new Set(NAV.map(item => item.href)));
    expect(paths).not.toContain('/dashboard/remote');
    expect(paths).not.toContain('/dashboard/translation');
    expect(navigationGroups()).toBe(NAV_GROUPS);
  });

  it('exposes the same destinations on a specialist page, a deep link and an unknown path', () => {
    for (const pathname of ['/dashboard/sessions', '/dashboard/connections/account-1', '/missing']) {
      expect(navigationGroups(pathname)).toBe(NAV_GROUPS);
    }
  });
});
