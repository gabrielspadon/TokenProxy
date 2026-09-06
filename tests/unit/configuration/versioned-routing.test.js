import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createNodeSqliteAdapter } from '../../../src/lib/db/adapters/nodeSqliteAdapter.js';
import { TABLES, buildCreateTableSql } from '../../../src/lib/db/schema.js';
import { CONFIG_VERSION_TABLES } from '../../../src/lib/db/configVersionSchema.js';
import { createCombo } from '../../../src/lib/db/repos/combosRepo.js';
import { setModelAlias } from '../../../src/lib/db/repos/aliasRepo.js';

const fixture = vi.hoisted(() => ({ db: null }));
vi.mock('../../../src/lib/db/driver.js', () => ({ getAdapter: async () => fixture.db }));
beforeEach(async () => {
  fixture.db = await createNodeSqliteAdapter(':memory:');
  for (const [name, def] of Object.entries({ ...TABLES, ...CONFIG_VERSION_TABLES })) {
    fixture.db.exec(buildCreateTableSql(name, def));
    for (const sql of def.indexes || []) fixture.db.exec(sql);
  }
});
afterEach(() => fixture.db.close());

describe('versioned existing routing writes', () => {
  it('records effective combo and alias changes without copying unrelated credentials', async () => {
    fixture.db.run('INSERT INTO settings(id, data) VALUES(1, ?)', [JSON.stringify({ oidcClientSecret: 'must-not-be-in-history' })]);
    const combo = await createCombo({ name: 'work', models: ['openai/gpt-4o', 'claude/claude-sonnet-4'] });
    await setModelAlias('brief', 'openai/gpt-4o');
    const versions = fixture.db.all('SELECT document FROM configVersions ORDER BY id');
    expect(versions.length).toBeGreaterThan(0);
    const latest = JSON.parse(versions.at(-1).document);
    expect(latest.combos).toEqual([{ id: combo.id, name: 'work', kind: null, models: ['openai/gpt-4o', 'claude/claude-sonnet-4'] }]);
    expect(latest.aliases.brief).toBe('openai/gpt-4o');
    expect(JSON.stringify(versions)).not.toContain('must-not-be-in-history');
  });
});

import { updateCombo, deleteCombo, getCombos } from '../../../src/lib/db/repos/combosRepo.js';
import { getModelAliases, deleteModelAlias } from '../../../src/lib/db/repos/aliasRepo.js';
import { getSettings, updateSettings, updateProviderStrategy } from '../../../src/lib/db/repos/settingsRepo.js';
import { getCurrentConfiguration, createConfigurationDraft, reviseConfigurationDraft, getConfigurationDraft, getConfigurationVersion, listConfigurationVersions, validateConfigurationDraft, activateConfigurationDraft, rollbackConfigurationVersion, listConfigurationReceipts } from '../../../src/lib/db/repos/configVersionsRepo.js';
import { resetComboRotation, getRotatedModels } from '../../../open-sse/services/combo.js';
import { configHash } from '../../../src/lib/db/helpers/configHistory.js';
vi.mock('../../../open-sse/services/combo.js', async importOriginal => ({ ...await importOriginal(), resetComboRotation: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.mocked(resetComboRotation).mockReset(); });
async function plan() {
  const c = await createCombo({ name: 'work', models: ['openai/gpt-4o', 'claude/claude-sonnet-4'] });
  await setModelAlias('brief', 'openai/gpt-4o');
  return { c, current: await getCurrentConfiguration() };
}
function reversed(current) {
  const document = structuredClone(current.document);
  document.combos[0].models.reverse();
  document.aliases.brief = 'claude/claude-sonnet-4';
  document.settings.comboStrategy = 'round-robin';
  return document;
}

describe('real stored draft lifecycle', () => {
  it('saves, diffs, validates, activates, reads gateway stores and rolls back as a new version', async () => {
    const { current } = await plan();
    const draft = await createConfigurationDraft({ document: reversed(current), expectedCurrent: current.currentHash });
    expect((await getCurrentConfiguration()).currentHash).toBe(current.currentHash);
    expect(draft.diff.some(d => d.path === '/combos' && d.before[0].models[0] === 'openai/gpt-4o')).toBe(true);
    const checked = await validateConfigurationDraft(draft.id, { expectedRevision: 1 });
    expect(checked.valid).toBe(true);
    expect(checked.effectivePlans[0].strategy).toBe('round-robin');
    const activated = await activateConfigurationDraft(draft.id, { expectedRevision: 1, expectedCurrent: current.currentHash });
    expect(activated.outcome).toBe('applied');
    expect((await getCombos())[0].models).toEqual(['claude/claude-sonnet-4', 'openai/gpt-4o']);
    expect((await getModelAliases()).brief).toBe('claude/claude-sonnet-4');
    expect((await getSettings()).comboStrategy).toBe('round-robin');
    expect(getRotatedModels((await getCombos())[0].models, 'unique-test', (await getSettings()).comboStrategy)[0]).toBe('claude/claude-sonnet-4');
    expect((await getCurrentConfiguration()).currentHash).toBe(activated.currentHash);
    const rollback = await rollbackConfigurationVersion(current.versionId, { expectedCurrent: activated.currentHash });
    expect(rollback.version.id).toBeGreaterThan(activated.version.id);
    expect(rollback.version.kind).toBe('rollback');
    expect((await getCurrentConfiguration()).currentHash).toBe(current.currentHash);
    expect((await getCombos())[0].models[0]).toBe('openai/gpt-4o');
    const receipts = await listConfigurationReceipts();
    expect(receipts[0]).toMatchObject({ action: 'rollback', outcome: 'applied', details: { databaseCommitted: true, runtimeRefresh: 'applied' } });
    expect(receipts.some(r => r.action === 'activate' && r.outcome === 'staged')).toBe(true);
  });
  it('appends immutable revisions and refuses stale concurrent draft editors', async () => {
    const { current } = await plan();
    const draft = await createConfigurationDraft({ document: current.document, expectedCurrent: current.currentHash });
    const attempts = await Promise.allSettled([1, 2].map(() => reviseConfigurationDraft(draft.id, { document: reversed(current), expectedRevision: 1 })));
    expect(attempts.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.find(x => x.status === 'rejected').reason.code).toBe('draft_revision_conflict');
    expect((await getConfigurationVersion(draft.version.id)).document).toEqual(current.document);
    expect((await getConfigurationDraft(draft.id)).revision).toBe(2);
    expect((await getCurrentConfiguration()).currentHash).toBe(current.currentHash);
    await expect(activateConfigurationDraft(draft.id, { expectedRevision: 1, expectedCurrent: current.currentHash })).rejects.toMatchObject({ code: 'draft_revision_conflict' });
  });
  it('rejects a stale activation after an existing writer changes one covered setting', async () => {
    const { current } = await plan();
    const draft = await createConfigurationDraft({ document: reversed(current), expectedCurrent: current.currentHash });
    await updateSettings({ exposeComboOnly: true });
    const changed = await getCurrentConfiguration();
    await expect(activateConfigurationDraft(draft.id, { expectedRevision: 1, expectedCurrent: current.currentHash })).rejects.toMatchObject({ code: 'configuration_conflict', details: { currentHash: changed.currentHash } });
    expect((await getCurrentConfiguration()).currentHash).toBe(changed.currentHash);
    expect((await listConfigurationReceipts())[0].outcome).toBe('conflict');
  });
  it('permits only one of two concurrent activations from the same prior hash', async () => {
    const { current } = await plan();
    const a = await createConfigurationDraft({ document: reversed(current), expectedCurrent: current.currentHash });
    const other = reversed(current); other.settings.exposeComboOnly = true;
    const b = await createConfigurationDraft({ document: other, expectedCurrent: current.currentHash });
    const result = await Promise.allSettled([a, b].map(d => activateConfigurationDraft(d.id, { expectedRevision: 1, expectedCurrent: current.currentHash })));
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(result.find(r => r.status === 'rejected').reason.code).toBe('configuration_conflict');
    expect(fixture.db.get("SELECT COUNT(*) n FROM configVersions WHERE kind = 'activation'").n).toBe(1);
  });
  it('keeps unrelated settings, secrets and excluded shaping overrides through activation and rollback', async () => {
    await updateSettings({ oidcClientSecret: 'never-version-this', providerStrategies: { claude: { maxConcurrent: 7 } }, comboStrategies: { work: { tokenSaver: { privateEndpoint: 'https://secret.invalid' }, fallbackStrategy: 'fallback' } } });
    const { current } = await plan();
    const draft = await createConfigurationDraft({ document: reversed(current), expectedCurrent: current.currentHash });
    const result = await activateConfigurationDraft(draft.id, { expectedRevision: 1, expectedCurrent: current.currentHash });
    await rollbackConfigurationVersion(current.versionId, { expectedCurrent: result.currentHash });
    const s = await getSettings();
    expect(s.oidcClientSecret).toBe('never-version-this');
    expect(s.providerStrategies.claude.maxConcurrent).toBe(7);
    expect(s.comboStrategies.work.tokenSaver.privateEndpoint).toBe('https://secret.invalid');
    const all = JSON.stringify(fixture.db.all('SELECT document, provenance FROM configVersions')) + JSON.stringify(await listConfigurationReceipts());
    expect(all).not.toContain('never-version-this');
    expect(all).not.toContain('secret.invalid');
  });
  it('uses actual defaults when a covered property is omitted and preserves exclusions on a removed plan', async () => {
    const { current } = await plan();
    await updateSettings({ comboStrategy: 'round-robin', comboStrategies: { work: { tokenSaver: { rtkEnabled: false }, fallbackStrategy: 'round-robin' } } });
    const active = await getCurrentConfiguration();
    const doc = { combos: [], aliases: current.document.aliases, settings: {} };
    const draft = await createConfigurationDraft({ document: doc, expectedCurrent: active.currentHash });
    await activateConfigurationDraft(draft.id, { expectedRevision: 1, expectedCurrent: active.currentHash });
    expect(await getCombos()).toEqual([]);
    const settings = await getSettings();
    expect(settings.comboStrategy).toBe('fallback');
    expect(settings.comboStrategies.work).toEqual({ tokenSaver: { rtkEnabled: false } });
  });
  it('rolls back all store writes when a later write fails and records a generic failure', async () => {
    const { current } = await plan();
    const draft = await createConfigurationDraft({ document: reversed(current), expectedCurrent: current.currentHash });
    const run = fixture.db.run.bind(fixture.db);
    vi.spyOn(fixture.db, 'run').mockImplementation((sql, args) => {
      if (sql.startsWith('INSERT INTO settings')) throw new Error('raw-password-or-sql-must-not-leak');
      return run(sql, args);
    });
    await expect(activateConfigurationDraft(draft.id, { expectedRevision: 1, expectedCurrent: current.currentHash })).rejects.toMatchObject({ code: 'configuration_write_failed' });
    expect((await getCurrentConfiguration()).currentHash).toBe(current.currentHash);
    expect((await getCombos())[0].models).toEqual(current.document.combos[0].models);
    expect(fixture.db.get("SELECT COUNT(*) n FROM configVersions WHERE kind = 'activation'").n).toBe(0);
    expect((await listConfigurationReceipts())[0]).toMatchObject({ outcome: 'failed', details: { databaseCommitted: false } });
    expect(JSON.stringify(await listConfigurationReceipts())).not.toContain('raw-password');
  });
  it('reports partial after committed config if rotation invalidation fails, without replay', async () => {
    const { current } = await plan();
    const draft = await createConfigurationDraft({ document: reversed(current), expectedCurrent: current.currentHash });
    vi.mocked(resetComboRotation).mockImplementationOnce(() => { throw new Error('failure-secret'); });
    const result = await activateConfigurationDraft(draft.id, { expectedRevision: 1, expectedCurrent: current.currentHash });
    expect(result).toMatchObject({ outcome: 'partial', receipt: { details: { databaseCommitted: true, runtimeRefresh: 'failed' } } });
    expect((await getCurrentConfiguration()).currentHash).toBe(result.currentHash);
    expect(resetComboRotation).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('failure-secret');
  });
  it('fails the original direct write if its audit insert cannot commit', async () => {
    const { current, c } = await plan();
    const run = fixture.db.run.bind(fixture.db);
    vi.spyOn(fixture.db, 'run').mockImplementation((sql, args) => {
      if (sql.startsWith('INSERT INTO configReceipts')) throw new Error('disk full');
      return run(sql, args);
    });
    await expect(updateCombo(c.id, { models: ['openai/gpt-4o'] })).rejects.toThrow('disk full');
    expect((await getCurrentConfiguration()).currentHash).toBe(current.currentHash);
  });
  it('records delete operations and excludes provider-only changes from hash and history', async () => {
    const { current, c } = await plan();
    const count = (await listConfigurationVersions()).length;
    await updateProviderStrategy('claude', { maxConcurrent: 8 });
    await updateProviderStrategy('claude', { maxConcurrent: null });
    expect((await getSettings()).providerStrategies.claude).toBeUndefined();
    expect((await listConfigurationVersions()).length).toBe(count);
    expect((await getCurrentConfiguration()).currentHash).toBe(current.currentHash);
    await deleteModelAlias('brief');
    await deleteCombo(c.id);
    expect((await getCurrentConfiguration()).document).toMatchObject({ combos: [], aliases: {} });
    expect((await listConfigurationReceipts())[0].provenance).toEqual({ source: 'repo.combos.delete', actorClass: 'unverified', actorId: null });
  });
});

describe('independent validation and redaction boundaries', () => {
  it.each([
    ['top-level secret', d => { d.password = 'secret'; }],
    ['nested alias credential', d => { d.aliases.brief = { provider: 'openai', model: 'gpt-4o', apiKey: 'secret' }; }],
    ['member endpoint', d => { d.combos[0].models = ['https://user:secret@provider.invalid']; }],
    ['excluded strategy credential', d => { d.settings.comboStrategies = { work: { tokenSaver: { password: 'secret' } } }; }],
    ['prototype key', d => { d.aliases = JSON.parse('{"__proto__":"openai/gpt-4o"}'); }],
  ])('refuses %s before retaining a draft', async (_label, mutate) => {
    const { current } = await plan(), doc = structuredClone(current.document);
    mutate(doc);
    const count = fixture.db.get('SELECT COUNT(*) n FROM configVersions').n;
    await expect(createConfigurationDraft({ document: doc, expectedCurrent: current.currentHash })).rejects.toMatchObject({ code: 'invalid_document' });
    expect(fixture.db.get('SELECT COUNT(*) n FROM configVersions').n).toBe(count);
  });
  it.each([
    ['cycle through qualified combo basename', d => { d.combos.push({ id: 'other', name: 'other', kind: null, models: ['work'] }); d.combos[0].models = ['openai/other']; }, 'combo_cycle'],
    ['missing member', d => { d.combos[0].models = ['unregistered-bare-member']; }, 'unresolved_member'],
    ['alias cycle', d => { d.aliases = { a: 'b', b: 'a' }; }, 'alias_requires_direct_target'],
    ['empty combo', d => { d.combos[0].models = []; }, 'empty_combo'],
    ['missing connection', d => { d.settings.comboStrategies = { work: { memberConnections: { 'openai/gpt-4o': 'missing' } } }; }, 'missing_connection'],
  ])('stores an editable %s draft but refuses activation', async (_label, mutate, code) => {
    const { current } = await plan(), doc = structuredClone(current.document); mutate(doc);
    const draft = await createConfigurationDraft({ document: doc, expectedCurrent: current.currentHash });
    const result = await validateConfigurationDraft(draft.id, { expectedRevision: 1 });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === code)).toBe(true);
    await expect(activateConfigurationDraft(draft.id, { expectedRevision: 1, expectedCurrent: current.currentHash })).rejects.toMatchObject({ code: 'configuration_invalid' });
    expect((await getCurrentConfiguration()).currentHash).toBe(current.currentHash);
  });
  it('hashes semantic object order canonically but preserves member ordering', async () => {
    const { current } = await plan();
    expect(configHash({ settings: current.document.settings, aliases: current.document.aliases, combos: current.document.combos })).toBe(current.currentHash);
    const changed = structuredClone(current.document); changed.combos[0].models.reverse();
    expect(configHash(changed)).not.toBe(current.currentHash);
  });
  it('refuses missing optimistic tokens and unpublished rollback sources', async () => {
    const { current } = await plan();
    await expect(createConfigurationDraft({ document: current.document })).rejects.toMatchObject({ code: 'expected_current_required' });
    const draft = await createConfigurationDraft({ document: current.document, expectedCurrent: current.currentHash });
    await expect(activateConfigurationDraft(draft.id, { expectedCurrent: current.currentHash })).rejects.toMatchObject({ code: 'expected_revision_required' });
    await expect(rollbackConfigurationVersion(draft.version.id, { expectedCurrent: current.currentHash })).rejects.toMatchObject({ code: 'published_version_required' });
  });
});

it('reports committed state when final audit persistence fails instead of inviting replay', async () => {
  const { current } = await plan();
  const draft = await createConfigurationDraft({ document: reversed(current), expectedCurrent: current.currentHash });
  const run = fixture.db.run.bind(fixture.db);
  vi.spyOn(fixture.db, 'run').mockImplementation((sql, args) => {
    if (sql.startsWith('INSERT INTO configReceipts') && JSON.parse(args[9]).runtimeRefresh === 'applied') throw new Error('audit-full-secret');
    return run(sql, args);
  });
  const result = await activateConfigurationDraft(draft.id, { expectedRevision: 1, expectedCurrent: current.currentHash });
  expect(result).toMatchObject({ outcome: 'partial', completion: { databaseCommitted: true, auditFinalization: 'failed' }, receipt: { details: { databaseCommitted: true, runtimeRefresh: 'pending' } } });
  expect((await getCurrentConfiguration()).currentHash).toBe(result.currentHash);
  expect(JSON.stringify(result)).not.toContain('audit-full-secret');
});
it('refuses corrupted settings before overwriting outside-scope state', async () => {
  fixture.db.run('INSERT INTO settings(id, data) VALUES(1, ?)', ['{bad json']);
  await expect(getCurrentConfiguration()).rejects.toThrow('Settings are unreadable');
  await expect(createCombo({ name: 'test', models: ['openai/gpt-4o'] })).rejects.toThrow('Settings are unreadable');
  expect(fixture.db.get('SELECT data FROM settings WHERE id = 1').data).toBe('{bad json');
  expect(await getCombos()).toEqual([]);
});
it('redacts malformed legacy URLs in keys and values, and refuses to activate their projection', async () => {
  await setModelAlias('https://user:password@invalid.example', 'openai/gpt-4o');
  await setModelAlias('broken', { provider: 'openai', model: 'gpt-4o', apiKey: 'another-secret' });
  const state = await getCurrentConfiguration();
  expect(state.validation.valid).toBe(false);
  expect(JSON.stringify(await listConfigurationVersions())).not.toContain('password');
  const rows = JSON.stringify(fixture.db.all('SELECT document FROM configVersions'));
  expect(rows).not.toContain('password');
  expect(rows).not.toContain('another-secret');
  await expect(createConfigurationDraft({ document: state.document, expectedCurrent: state.currentHash })).rejects.toMatchObject({ code: 'invalid_document' });
});
it('validates nested membership and rejects an account from a different provider', async () => {
  const { current } = await plan();
  fixture.db.run('INSERT INTO providerConnections(id, provider, authType, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)', ['account-a', 'claude', 'oauth', '{}', '2026-01-01', '2026-01-01']);
  const doc = reversed(current);
  doc.settings.comboStrategies = { work: { memberConnections: { 'openai/gpt-4o': 'account-a', 'openai/not-a-member': 'account-a' } } };
  const draft = await createConfigurationDraft({ document: doc, expectedCurrent: current.currentHash });
  const result = await validateConfigurationDraft(draft.id, { expectedRevision: 1 });
  expect(result.errors.some(e => e.code === 'connection_provider_mismatch')).toBe(true);
  expect(result.errors.some(e => e.code === 'connection_target_not_member')).toBe(true);
});
