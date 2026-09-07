import { beforeEach, describe, expect, it } from 'vitest';
import { GET, PATCH } from '../../src/app/api/settings/route.js';
import { exportSettings, getSettings, mergeWithDefaults, updateSettings } from '../../src/lib/db/repos/settingsRepo.js';
const request = body => new Request('http://localhost/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
beforeEach(async () => { await updateSettings({ statsRetentionMode: 'preserve', statsRetentionDays: 45, stickyRoundRobinLimit: 3 }); });
describe('history retention settings', () => {
  it('defaults old settings to preservation without migrating or changing legacy keys', () => {
    const legacy = { stickyRoundRobinLimit: 7 };
    expect(mergeWithDefaults(legacy)).toMatchObject({ statsRetentionMode: 'preserve', statsRetentionDays: 45, stickyRoundRobinLimit: 7 });
    expect(legacy).toEqual({ stickyRoundRobinLimit: 7 });
  });
  it.each([1,45,365])('persists an explicit %i-day window through PATCH and fresh GET, then preservation', async days => {
    expect((await PATCH(request({ statsRetentionMode: 'window', statsRetentionDays: days }))).status).toBe(200);
    expect(await (await GET()).json()).toMatchObject({ statsRetentionMode: 'window', statsRetentionDays: days });
    expect(await exportSettings()).toMatchObject({ statsRetentionMode: 'window', statsRetentionDays: days });
    expect((await PATCH(request({ statsRetentionMode: 'preserve' }))).status).toBe(200);
    expect(await getSettings()).toMatchObject({ statsRetentionMode: 'preserve', statsRetentionDays: days });
  });
  it.each([{statsRetentionMode:'delete'}, {statsRetentionMode:null}, {statsRetentionMode:true}, {statsRetentionMode:[]}, ...[0,366,-1,1.5,'45',null,true,{}].map(statsRetentionDays=>({statsRetentionDays}))])('rejects invalid policy atomically with unrelated settings %j', async invalid => {
    const before = await exportSettings();
    const response = await PATCH(request({ stickyRoundRobinLimit: 9, ...invalid }));
    expect(response.status).toBe(400);
    expect(await exportSettings()).toEqual(before);
  });
  it('rejects invalid days even when changing to preservation', async () => {
    const before = await exportSettings();
    expect((await PATCH(request({ statsRetentionMode: 'preserve', statsRetentionDays: 0 }))).status).toBe(400);
    expect(await exportSettings()).toEqual(before);
  });
});
