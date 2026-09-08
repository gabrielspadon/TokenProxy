import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createNodeSqliteAdapter } from '../../../src/lib/db/adapters/nodeSqliteAdapter.js';
import { TABLES, buildCreateTableSql } from '../../../src/lib/db/schema.js';
import { encryptSecretJson, decryptSecretJson } from '../../../src/lib/db/helpers/secretCol.js';
import { configurationDomains as repo } from '../../../src/lib/db/repos/configurationDomainsRepo.js';
import {
  updateProviderConnection,
  getProviderConnectionById,
} from '../../../src/lib/db/repos/connectionsRepo.js';
import { updateSettings, updateProviderStrategy } from '../../../src/lib/db/repos/settingsRepo.js';
import { createProxyPool, updateProxyPool } from '../../../src/lib/db/repos/proxyPoolsRepo.js';
import {
  disableModels,
  enableModels,
  getDisabledModels,
} from '../../../src/lib/db/repos/disabledModelsRepo.js';
import {
  readConfigurationDomains,
  assertConfigurationDomains,
  DOMAIN_SCOPE,
} from '../../../src/lib/configuration/configurationDomains.js';
import { getCurrentConfiguration } from '../../../src/lib/db/repos/configVersionsRepo.js';
const fixture = vi.hoisted(() => ({ db: null }));
vi.mock('../../../src/lib/db/driver.js', () => ({ getAdapter: async () => fixture.db }));
beforeEach(async () => {
  fixture.db = await createNodeSqliteAdapter(':memory:');
  for (const [name, definition] of Object.entries(TABLES))
    fixture.db.exec(buildCreateTableSql(name, definition));
  fixture.db.run(
    "INSERT INTO providerConnections(id, provider, authType, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, '2026-09-08', '2026-09-08')",
    [
      'a',
      'openai',
      'apikey',
      1,
      1,
      encryptSecretJson({
        apiKey: 'SECRET-ACCOUNT',
        maxConcurrent: 2,
        quotaPauseThresholds: { weekly: 5 },
        providerSpecificData: {
          enabledModels: ['gpt-4o'],
          connectionProxyUrl: 'https://PRIVATE-ENDPOINT',
          privateHeader: 'SECRET-HEADER',
        },
      }),
    ]
  );
  fixture.db.run('INSERT INTO settings(id, data) VALUES(1, ?)', [
    JSON.stringify({
      oidcClientSecret: 'SECRET-SSO',
      outboundProxyUrl: 'https://SECRET-PROXY',
      privacyFilterTerms: ['PRIVATE-PERSON'],
      memoryToolPruningEnabled: false,
      memoryMediaPruningEnabled: false,
      comboStrategies: { work: { tokenSaver: { rtk: false, privateEndpoint: 'SECRET-SERVICE' } } },
    }),
  ]);
  fixture.db.run(
    "INSERT INTO combos(id,name,models,createdAt,updatedAt) VALUES(?,?,?,'2026-09-08','2026-09-08')",
    ['work', 'work', '["openai/gpt-4o"]']
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  fixture.db.close();
  delete global.__quotaAutoPing;
});
async function draft(change) {
  const current = await repo.getCurrentConfiguration();
  const document = structuredClone(current.document);
  change(document);
  return {
    current,
    draft: await repo.createConfigurationDraft({ document, expectedCurrent: current.currentHash }),
  };
}
it('allowlists all domains without serializing secret URLs, headers, account identity or private shaping text', async () => {
  await updateSettings({ rtkEnabled: false });
  await updateProviderConnection('a', { maxConcurrent: 4 });
  const current = await repo.getCurrentConfiguration();
  expect(current.document.accounts.a.maxConcurrent).toBe(4);
  expect(current.document.accounts.a.enabledModels).toEqual(['gpt-4o']);
  expect(current.references.accounts).toEqual(['a']);
  const history =
    JSON.stringify(fixture.db.all('SELECT * FROM configVersions')) + JSON.stringify(current);
  for (const secret of ['SECRET-', 'PRIVATE-']) expect(history).not.toContain(secret);
  const injected = structuredClone(current.document);
  injected.accounts.a.apiKey = 'DO-NOT-STORE';
  expect(() => assertConfigurationDomains(injected)).toThrow('invalid_domain_fields');
  injected.accounts.a = {
    ...current.document.accounts.a,
    defaultModel: { apiKey: 'DO-NOT-STORE' },
  };
  expect(() => assertConfigurationDomains(injected)).toThrow('invalid_domain_value');
});
it('ordinary account, provider, disabled-model, pool and saver writes share same-transaction history', async () => {
  await updateProviderConnection('a', { isActive: false });
  await updateProviderStrategy('openai', { maxConcurrent: 3 });
  await disableModels('openai', ['gpt-4o']);
  await enableModels('openai', [], 'a');
  await createProxyPool({
    id: 'pool',
    name: 'private-name',
    proxyUrl: 'https://SECRET-POOL',
    strictProxy: false,
  });
  await updateProxyPool('pool', { strictProxy: true });
  await updateSettings({ rtkEnabled: false });
  const versions = await repo.listConfigurationVersions({ limit: 100 });
  expect(versions.filter((row) => row.kind === 'direct')).toHaveLength(7);
  const current = await repo.getCurrentConfiguration();
  expect(current.document.disabledModels['openai::a']).toEqual([]);
  expect(current.document.network.pools.pool.strictProxy).toBe(true);
  expect((await repo.listConfigurationReceipts()).every((row) => row.scope === DOMAIN_SCOPE)).toBe(
    true
  );
  expect(JSON.stringify(versions)).not.toContain('private-name');
});
it('history insertion failure aborts the ordinary policy mutation and preserves the prior version', async () => {
  const before = readConfigurationDomains(fixture.db);
  const run = fixture.db.run.bind(fixture.db);
  vi.spyOn(fixture.db, 'run').mockImplementation((sql, args) => {
    if (sql.startsWith('INSERT INTO configVersions')) throw new Error('history-failed');
    return run(sql, args);
  });
  await expect(updateProviderConnection('a', { isActive: false })).rejects.toThrow(
    'history-failed'
  );
  expect(readConfigurationDomains(fixture.db)).toEqual(before);
  expect(fixture.db.all('SELECT id FROM configVersions')).toEqual([]);
});
it('selectively restores exact changed fields and leaves current credentials, URLs and unrelated policies intact', async () => {
  await updateProviderConnection('a', { maxConcurrent: 3 });
  const baseline = await repo.getCurrentConfiguration();
  const routing = await getCurrentConfiguration();
  await updateProviderConnection('a', {
    maxConcurrent: 8,
    globalPriority: 4,
    apiKey: 'ROTATED-SECRET',
  });
  await updateSettings({ rtkEnabled: false });
  const now = await repo.getCurrentConfiguration();
  const retained = await repo.restoreConfigurationSelection(baseline.versionId, {
    expectedCurrent: now.currentHash,
    paths: ['/accounts/a/maxConcurrent'],
  });
  expect(retained.diff.map((row) => row.path)).toEqual(['/accounts/a/maxConcurrent']);
  expect(retained.receipt.details.restoration).toEqual({
    sourceVersionId: baseline.versionId,
    paths: ['/accounts/a/maxConcurrent'],
  });
  const result = await repo.activateConfigurationDraft(retained.id, {
    expectedCurrent: now.currentHash,
    expectedRevision: 1,
  });
  expect(result.outcome).toBe('applied');
  const account = await getProviderConnectionById('a');
  expect(account).toMatchObject({ maxConcurrent: 3, globalPriority: 4, apiKey: 'ROTATED-SECRET' });
  expect((await getCurrentConfiguration()).currentHash).toBe(routing.currentHash);
  expect(
    JSON.parse(fixture.db.get('SELECT data FROM settings WHERE id=1').data).comboStrategies.work
      .tokenSaver.privateEndpoint
  ).toBe('SECRET-SERVICE');
});
it('invalid selection paths, prototype segments, missing entities and stale hashes are refused', async () => {
  await updateProviderConnection('a', { maxConcurrent: 3 });
  const baseline = await repo.getCurrentConfiguration();
  await updateProviderConnection('a', { maxConcurrent: 4 });
  const current = await repo.getCurrentConfiguration();
  for (const paths of [
    [],
    ['/accounts/a'],
    ['/accounts/__proto__/x'],
    ['/accounts/a/maxConcurrent', '/accounts/a/maxConcurrent'],
  ])
    await expect(
      repo.restoreConfigurationSelection(baseline.versionId, {
        expectedCurrent: current.currentHash,
        paths,
      })
    ).rejects.toMatchObject({ code: 'invalid_restore_paths' });
  await expect(
    repo.restoreConfigurationSelection(baseline.versionId, {
      expectedCurrent: baseline.currentHash,
      paths: ['/accounts/a/maxConcurrent'],
    })
  ).rejects.toMatchObject({ code: 'configuration_conflict' });
  const missing = await draft((doc) => {
    delete doc.accounts.a;
  });
  expect(
    (await repo.validateConfigurationDraft(missing.draft.id, { expectedRevision: 1 })).errors
  ).toContainEqual({ code: 'account_inventory_changed', path: '/accounts' });
});
it('disabled-model cache refresh and explicit empty account inheritance survive activation and rollback', async () => {
  await disableModels('openai', ['gpt-4o']);
  const baseline = await repo.getCurrentConfiguration();
  expect(await getDisabledModels()).toHaveProperty('openai');
  const d = await draft((doc) => {
    doc.disabledModels['openai::a'] = [];
  });
  const activated = await repo.activateConfigurationDraft(d.draft.id, {
    expectedCurrent: d.current.currentHash,
    expectedRevision: 1,
  });
  expect((await getDisabledModels())['openai::a']).toEqual([]);
  const restored = await repo.rollbackConfigurationVersion(baseline.versionId, {
    expectedCurrent: activated.currentHash,
  });
  expect(restored.version.kind).toBe('rollback');
  expect((await getDisabledModels())['openai::a']).toBeUndefined();
});
it('shaping restoration requires current explicit consent and preserves private configuration', async () => {
  const d = await draft((doc) => {
    doc.saver.settings.cavemanEnabled = true;
  });
  const checked = await repo.validateConfigurationDraft(d.draft.id, { expectedRevision: 1 });
  expect(checked.valid).toBe(true);
  expect(checked.requiredConsent).toContain('cavemanEnabled');
  await expect(
    repo.activateConfigurationDraft(d.draft.id, {
      expectedCurrent: d.current.currentHash,
      expectedRevision: 1,
    })
  ).rejects.toMatchObject({
    code: 'configuration_invalid',
    details: { validation: { valid: false } },
  });
  const result = await repo.activateConfigurationDraft(d.draft.id, {
    expectedCurrent: d.current.currentHash,
    expectedRevision: 1,
    consent: checked.requiredConsent,
  });
  expect(result.outcome).toBe('applied');
  const raw = JSON.parse(fixture.db.get('SELECT data FROM settings WHERE id=1').data);
  expect(raw.privacyFilterTerms).toEqual(['PRIVATE-PERSON']);
  expect(raw.comboStrategies.work.tokenSaver.privateEndpoint).toBe('SECRET-SERVICE');
});
it('pool restoration rotates bound credential revision while retaining current transport secrets', async () => {
  await createProxyPool({ id: 'pool', proxyUrl: 'https://SECRET-POOL', strictProxy: false });
  await updateProviderConnection('a', {
    providerSpecificData: { proxyPoolId: 'pool', strictProxy: false },
  });
  const previous = decryptSecretJson(
    fixture.db.get('SELECT data FROM providerConnections WHERE id=?', ['a']).data
  );
  const d = await draft((doc) => {
    doc.network.pools.pool.noProxy = 'localhost';
  });
  expect(
    (
      await repo.activateConfigurationDraft(d.draft.id, {
        expectedCurrent: d.current.currentHash,
        expectedRevision: 1,
      })
    ).outcome
  ).toBe('applied');
  const after = decryptSecretJson(
    fixture.db.get('SELECT data FROM providerConnections WHERE id=?', ['a']).data
  );
  expect(after.credentialRevisionId).not.toBe(previous.credentialRevisionId);
  expect(
    JSON.parse(fixture.db.get('SELECT data FROM proxyPools WHERE id=?', ['pool']).data).proxyUrl
  ).toBe('https://SECRET-POOL');
});
