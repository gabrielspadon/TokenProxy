// seenModelsRepo contracts against the real SQLite adapter in this file's
// isolated DATA_DIR: first-scan seeding, new/unseen classification,
// acknowledgement, and seed idempotency.
import { describe, it, expect, beforeAll } from 'vitest';

const { DATA_FILE } = await import('../../src/lib/db/paths.js');
const { getAdapter } = await import('../../src/lib/db/driver.js');
const {
  getSeenModels,
  getSeenModelsCount,
  reconcileSeenModels,
  acknowledgeModels,
  countUnseenModels,
  getUnseenModels,
  seedSeenModels,
} = await import('../../src/lib/db/repos/seenModelsRepo.js');

const m = (providerAlias, modelId, isFree = false) => ({ providerAlias, modelId, isFree });

beforeAll(async () => {
  // Hard gate: an unusable DATA_DIR silently falls back to ~/.tokenproxy.
  expect(DATA_FILE.startsWith(process.env.DATA_DIR)).toBe(true);
  await getAdapter();
});

describe('empty table', () => {
  it('reports zero models everywhere', async () => {
    expect(await getSeenModelsCount()).toBe(0);
    expect((await getSeenModels()).size).toBe(0);
    expect(await countUnseenModels()).toBe(0);
    expect(await getUnseenModels()).toEqual([]);
  });

  it('reconcile with nothing observed neither seeds nor reports', async () => {
    const r = await reconcileSeenModels([]);
    expect(r).toEqual({ new: [], unseen: [], seeded: false });
    expect(await getSeenModelsCount()).toBe(0);
  });
});

describe('first scan seeds acknowledged', () => {
  it('inserts every observed model as acknowledged and reports none as new', async () => {
    const r = await reconcileSeenModels([m('prov-a', 'model-1', true), m('prov-a', 'model-2')]);
    expect(r.seeded).toBe(true);
    expect(r.new).toEqual([]);
    expect(r.unseen).toEqual([]);
    expect(await getSeenModelsCount()).toBe(2);
    expect(await countUnseenModels()).toBe(0);

    const map = await getSeenModels();
    const one = map.get('prov-a::model-1');
    expect(one).toMatchObject({
      providerAlias: 'prov-a',
      modelId: 'model-1',
      isFree: true,
      acknowledged: true,
    });
    expect(typeof one.firstSeenAt).toBe('string');
    // isFree is coerced to a real boolean, not the stored 0/1.
    expect(map.get('prov-a::model-2').isFree).toBe(false);
  });
});

describe('later scans classify new vs unseen', () => {
  it('a model appearing after the seed is genuinely new (acknowledged=0)', async () => {
    const r = await reconcileSeenModels([m('prov-a', 'model-1', true), m('prov-b', 'model-3')]);
    expect(r.seeded).toBe(false);
    expect(r.new).toHaveLength(1);
    expect(r.new[0]).toMatchObject({
      providerAlias: 'prov-b',
      modelId: 'model-3',
      acknowledged: false,
    });
    expect(r.unseen).toEqual([]);
    expect(await countUnseenModels()).toBe(1);
  });

  it('a still-unacknowledged model re-observed lands in unseen, not new', async () => {
    const r = await reconcileSeenModels([m('prov-b', 'model-3', true)]);
    expect(r.new).toEqual([]);
    expect(r.unseen).toHaveLength(1);
    // Stored state wins over the observed flag for previously-seen models.
    expect(r.unseen[0]).toMatchObject({
      providerAlias: 'prov-b',
      modelId: 'model-3',
      isFree: false,
      acknowledged: false,
    });
    // getUnseenModels lists it regardless of the live scan.
    const unseen = await getUnseenModels();
    expect(unseen.map((u) => `${u.providerAlias}::${u.modelId}`)).toEqual(['prov-b::model-3']);
    expect(unseen[0].acknowledged).toBe(false);
  });
});

describe('acknowledgement', () => {
  it('acknowledges named models only', async () => {
    await reconcileSeenModels([m('prov-c', 'model-4'), m('prov-c', 'model-5')]);
    expect(await countUnseenModels()).toBe(3);
    await acknowledgeModels([{ providerAlias: 'prov-c', modelId: 'model-4' }]);
    expect(await countUnseenModels()).toBe(2);
    const left = await getUnseenModels();
    expect(left.find((u) => u.modelId === 'model-4')).toBeUndefined();
  });

  it('acknowledges everything when called with no items', async () => {
    await acknowledgeModels(null);
    expect(await countUnseenModels()).toBe(0);
    expect(await getUnseenModels()).toEqual([]);
  });
});

describe('seedSeenModels', () => {
  it('is idempotent on existing ids and inserts new ids as acknowledged', async () => {
    const before = await getSeenModelsCount();
    await seedSeenModels([m('prov-a', 'model-1'), m('prov-d', 'model-6', true)]);
    expect(await getSeenModelsCount()).toBe(before + 1);
    // Seeded rows never show as unseen.
    expect(await countUnseenModels()).toBe(0);
    // INSERT OR IGNORE: the existing row keeps its original state.
    expect((await getSeenModels()).get('prov-a::model-1').isFree).toBe(true);
  });
});
