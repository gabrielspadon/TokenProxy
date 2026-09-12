import { beforeEach, expect, it } from 'vitest';
import { getAdapter } from '../../src/lib/db/driver.js';
import { saveRequestStats } from '../../src/lib/db/repos/requestStatsRepo.js';

const db = await getAdapter();
beforeEach(() => {
  db.run('DELETE FROM usageHistory');
  db.run('DELETE FROM requestStats');
});

it('persists completion after linked usage has already created its projection', async () => {
  const detail = { id: 'projection-upsert', provider: 'codex', model: 'fixture', status: 'pending',
    timestamp: new Date().toISOString(), tokens: {} };
  await saveRequestStats(detail);
  // Give only this owned row a visible import origin for the request join.
  db.run("UPDATE requestStats SET dataOrigin='import' WHERE id=?", [detail.id]);
  db.run('INSERT INTO usageHistory(timestamp,provider,model,requestId,promptTokens,completionTokens,tokens) VALUES(?,?,?,?,?,?,?)',
    [detail.timestamp, detail.provider, detail.model, detail.id, 20000, 500,
      JSON.stringify({ cached_tokens: 12000, cache_creation_input_tokens: 6000 })]);
  const usage = db.get('SELECT id FROM usageHistory WHERE requestId=?', [detail.id]);
  expect(db.get('SELECT id,latencyMs FROM usageEconomicsProjection WHERE id=?', [usage.id]))
    .toEqual({ id: usage.id, latencyMs: null });

  await saveRequestStats({ ...detail, status: 'success', tokens: { prompt_tokens: 20000, completion_tokens: 500 },
    latency: { total: 120, ttft: 30 },
    terminalEvidence: { state: 'succeeded', reason: 'json-complete', source: 'provider-json' } });
  expect(db.get('SELECT status,promptTokens,terminalState FROM requestStats WHERE id=?', [detail.id]))
    .toEqual({ status: 'success', promptTokens: 20000, terminalState: 'succeeded' });
  expect(db.all('SELECT id,latencyMs,ttftMs FROM usageEconomicsProjection'))
    .toEqual([{ id: usage.id, latencyMs: 120, ttftMs: 30 }]);
});
