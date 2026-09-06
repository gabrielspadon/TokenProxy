import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { afterAll, expect, it } from 'vitest';
import { getAdapter } from '@/lib/db/driver.js';
import { createProviderConnection } from '@/lib/db/repos/connectionsRepo.js';
import { captureQuotaUsage, recordQuotaCheckEvent } from '@/lib/db/repos/quotaHistoryRepo.js';
import { putWindows } from '@/lib/db/repos/quotaWindowsRepo.js';
import { getQuotaWorkbench } from '@/lib/db/repos/quotaWorkbenchRepo.js';
import { _resetSecretKeyCacheForTests } from '@/lib/db/helpers/secretCol.js';

let db;
afterAll(async () => {
  await globalThis._contextAnalytics?.client.close();
  db?.close();
});
it.skipIf(!process.env.QUOTA_WORKBENCH_PREVIEW_OUT)(
  'retains synthetic quota observations and scheduler outcomes for visual qualification',
  async () => {
    expect(process.env.DATA_DIR).toContain('tokenproxy-test-file-');
    const output = process.env.QUOTA_WORKBENCH_PREVIEW_OUT;
    expect(output).toBe(
      '/Users/gabrielspadon/Documents/ChatGPT/Token Router/implementation-evidence/capacity-history/synthetic'
    );
    const auth = JSON.parse(await readFile(`${output}/preview-auth.json`, 'utf8'));
    process.env.DB_ENCRYPTION_KEY = auth.dbEncryptionKey;
    _resetSecretKeyCacheForTests();
    db = await getAdapter();
    expect(db.driver).toBe('better-sqlite3');
    const end = '2026-09-06T15:45:01.749Z';
    const accounts = [];
    for (const [index, provider] of ['claude', 'codex', 'gemini'].entries()) {
      const connection = await createProviderConnection({
        provider,
        name: ['Synthetic research', 'Synthetic personal', 'Synthetic batch'][index],
        authType: 'apikey',
        isActive: true,
        testStatus: 'active',
        lastTested: end,
      });
      accounts.push(connection.id);
      for (let i = 0; i < 20; i++) {
        const observedAt = new Date(Date.parse(end) - (20 - i) * 300_000).toISOString();
        const remaining = 1000 - i * (index === 1 ? 10 : 24);
        const usage = {
          quotaObservation: { id: `synthetic-${index}-${i}`, observedAt },
          quotas: {
            weekly: {
              unit: 'requests',
              resourceType: 'request-limit',
              remaining,
              total: 1000,
              remainingPercentage: remaining / 10,
              windowType: 'fixed',
              windowDurationMs: 604800000,
              resetAt: '2026-09-06T18:00:00Z',
            },
            'five-hour': {
              remainingPercentage: index === 0 && i >= 12 ? 95 - (i - 12) : 90 - i * 2,
              windowType: 'fixed',
              windowDurationMs: 18000000,
              resetAt: '2026-09-06T17:00:00Z',
            },
          },
        };
        await captureQuotaUsage(connection, usage, {
          capturedAt: new Date(Date.parse(observedAt) + 1000).toISOString(),
        });
        if (i === 19)
          await putWindows(
            connection.id,
            Object.entries(usage.quotas).map(([scope, q]) => ({
              scope,
              remaining: q.remaining ?? q.remainingPercentage,
              limit: q.total ?? 100,
              observedAt,
              confidence: 'fresh',
              resetAt: q.resetAt,
              windowDurationMs: q.windowDurationMs,
              windowType: q.windowType,
            }))
          );
      }
      for (let i = 0; i < 13; i++) {
        await recordQuotaCheckEvent({
          connectionId: connection.id,
          provider,
          scope: 'weekly',
          checkId: `synthetic-check-${index}-${i}`,
          eventType: i % 3 === 0 ? 'scheduled' : i % 3 === 1 ? 'started' : 'failed',
          code: i % 3 === 0 ? 'reset-not-before' : i % 3 === 1 ? null : 'usage_unreadable',
          scheduledFor: '2026-09-06T18:00:00Z',
          resetAt: '2026-09-06T18:00:00Z',
          capturedAt: new Date(Date.parse(end) - (14 - i) * 600_000).toISOString(),
        });
      }
    }
    const result = await getQuotaWorkbench(new URLSearchParams({ connectionId: accounts[0], end }));
    expect(result.total).toBe(40);
    expect(result.series).toHaveLength(2);
    expect(result.series.every((series) => series.analysis.state === 'available')).toBe(true);
    await mkdir(`${output}/runtime/db`, { recursive: true, mode: 0o700 });
    await db.raw.backup(`${output}/runtime/db/data.sqlite`);
    await writeFile(
      `${output}/fixture-receipt.json`,
      JSON.stringify(
        {
          source: 'Actual quota retention and scheduler-record repositories with synthetic inputs',
          accounts,
          capturedAt: end,
          observations: db.get('SELECT COUNT(*) AS count FROM quotaObservations').count,
          checkEvents: db.get('SELECT COUNT(*) AS count FROM quotaCheckEvents').count,
          providerCalls: 0,
        },
        null,
        2
      ),
      { mode: 0o600 }
    );
  }
);
