import { beforeEach, describe, expect, it } from 'vitest';
import { getAdapter } from '../../src/lib/db/driver.js';
import { exportDb, importDb } from '../../src/lib/db/index.js';

const db = await getAdapter();
beforeEach(async () => {
  await importDb({ settings: { requireLogin: true }, apiKeys: [{ id: 'retained-key', key: 'fixture-retained-key' }] });
});

describe('configuration import identity conflicts', () => {
  it.each([
    ['connection ID', { providerConnections: [{ id: 'same', provider: 'codex' }, { id: 'same', provider: 'claude' }] }],
    ['node ID', { providerNodes: [{ id: 'same' }, { id: 'same' }] }],
    ['proxy pool ID', { proxyPools: [{ id: 'same' }, { id: 'same' }] }],
    ['key ID', { apiKeys: [{ id: 'same', key: 'fixture-key-one' }, { id: 'same', key: 'fixture-key-two' }] }],
    ['key material', { apiKeys: [{ id: 'one', key: 'fixture-same-key' }, { id: 'two', key: 'fixture-same-key' }] }],
    ['combo ID', { combos: [{ id: 'same', name: 'one' }, { id: 'same', name: 'two' }] }],
    ['combo name', { combos: [{ id: 'one', name: 'same' }, { id: 'two', name: 'same' }] }],
    ['custom model identity', { customModels: [{ providerAlias: 'codex', id: 'same' }, { providerAlias: 'codex', id: 'same' }] }],
  ])('rejects duplicate %s and preserves the complete previous configuration', async (_label, payload) => {
    const before = await exportDb();
    await expect(importDb(payload)).rejects.toThrow(/UNIQUE constraint/);
    expect(await exportDb()).toEqual(before);
    expect(db.get('SELECT key FROM apiKeys WHERE id=?', ['retained-key']).key).toBe('fixture-retained-key');
  });

  it('imports distinct stable keys and models with the same display labels', async () => {
    await importDb({ apiKeys: [{ id: 'one', key: 'fixture-key-one', name: 'shared' }, { id: 'two', key: 'fixture-key-two', name: 'shared' }],
      customModels: [{ providerAlias: 'codex', id: 'same' }, { providerAlias: 'claude', id: 'same' }] });
    expect(db.get('SELECT count(*) AS n FROM apiKeys').n).toBe(2);
    expect(db.get("SELECT count(*) AS n FROM kv WHERE scope='customModels'").n).toBe(2);
  });
});
