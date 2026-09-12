import { beforeEach, describe, expect, it } from 'vitest';
import { getAdapter } from '../../src/lib/db/driver.js';
import { saveUsageStats, extractUsageFromResponse } from '../../open-sse/handlers/chatCore/requestDetail.js';
import { extractUsage } from '../../open-sse/utils/usageTracking.js';
import { readActivityAnalytics } from '../../src/lib/db/analytics/activityQueries.mjs';

// End to end on the completion ledger: real extraction (stream and non-stream)
// through saveUsageStats into SQLite, then out through the economics read. What
// is under test is that a reported cache write of 0 stays a reported 0 while an
// ABSENT one reads back as Unknown, since both store the same 0 column.
const db = await getAdapter();
beforeEach(() => { db.run('DELETE FROM usageHistory'); });

const read = () => readActivityAnalytics(db, { operation: 'activity', view: 'economics', provider: 'codex' });
async function persist(tokens) {
  await saveUsageStats({ provider: 'codex', model: 'cache-presence-fixture', tokens, silent: true });
  const row = db.get('SELECT id,tokens FROM usageHistory WHERE model=?', ['cache-presence-fixture']);
  expect(row).toBeDefined();
  // Deliberately expose this owned fixture to the public analytics filter.
  db.run("UPDATE usageHistory SET dataOrigin='unknown' WHERE id=?", [row.id]);
  return JSON.parse(row.tokens);
}

describe.each(['stream', 'json'])('cache presence through %s extraction and completion persistence', transport => {
  it.each([6000, 0, undefined])('retains the reported cache write state %s', async write => {
    const usage = { input_tokens: 20000, output_tokens: 500,
      input_tokens_details: { cached_tokens: 12000, ...(write === undefined ? {} : { cache_write_tokens: write }) } };
    const tokens = transport === 'stream'
      ? extractUsage({ type: 'response.completed', response: { usage } })
      : extractUsageFromResponse({ usage });
    const stored = await persist(tokens);
    expect(stored).toMatchObject({ prompt_tokens: 20000, cached_tokens: 12000,
      cache_read_tokens_present: true, cache_write_tokens_present: write !== undefined });
    // Reported 0 stays 0 and still counts as a sample; absent reads back null
    // with no sample. The read fraction is unaffected either way.
    const result = read();
    expect(result.summary).toMatchObject({ inputTokens: 20000, cacheReadTokens: 12000, cacheReadFraction: 0.6,
      cacheWriteTokens: write ?? null, cacheWriteSamples: write === undefined ? 0 : 1,
      uncachedInputTokens: write === undefined ? null : 8000 - write });
    const current = db.get("SELECT value FROM _meta WHERE key='economicsProjectionVersion'").value;
    try {
      db.run("UPDATE _meta SET value='0' WHERE key='economicsProjectionVersion'");
      expect(read()).toEqual(result);
    } finally { db.run("UPDATE _meta SET value=? WHERE key='economicsProjectionVersion'", [current]); }
  });
});

it('does not turn estimated cache quantities into provider observations', async () => {
  const stored = await persist({ prompt_tokens: 20000, completion_tokens: 500,
    cached_tokens: 12000, cache_creation_input_tokens: 6000, estimated: true });
  expect(stored).toMatchObject({ cache_read_tokens_present: false, cache_write_tokens_present: false });
  expect(read().summary).toMatchObject({ cacheReadTokens: null, cacheWriteTokens: null,
    cacheReadFraction: null, cacheWriteSamples: 0 });
});
