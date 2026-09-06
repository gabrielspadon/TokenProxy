import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getProxyPoolById } from '@/models';
import { testProxyUrl, testRelayUrl } from '@/lib/network/proxyTest';
import {
  recordOperationStarted,
  recordOperationTerminal,
} from '@/lib/db/repos/operationEventsRepo.js';

const RELAY_TYPES = new Set(['vercel', 'cloudflare']);

// POST /api/proxy-pools/[id]/test - Test proxy pool entry
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const proxyPool = await getProxyPoolById(id);

    if (!proxyPool) {
      return NextResponse.json({ error: 'Proxy pool not found' }, { status: 404 });
    }

    const operationId = randomUUID();
    const isRelay = RELAY_TYPES.has(proxyPool.type);
    const eventBase = {
      operationId,
      phase: 'reachability',
      source: 'proxy-pool-test',
      actorClass: 'operator',
      subjectKind: 'proxyPool',
      subjectId: id,
    };
    // The pool as it was when this probe was decided. A late result must not
    // apply against a pool the operator has since edited or deleted.
    const captured = { proxyUrl: proxyPool.proxyUrl, type: proxyPool.type };

    // Started row lands BEFORE any socket opens. If we die mid-probe the
    // operation reads as unresolved, never as success or as a resend request.
    await recordOperationStarted({
      ...eventBase,
      details: { kind: isRelay ? 'relay' : 'proxy', poolType: proxyPool.type },
    });

    const result = isRelay
      ? await testRelayUrl({ relayUrl: proxyPool.proxyUrl, signal: request.signal })
      : await testProxyUrl({ proxyUrl: proxyPool.proxyUrl, signal: request.signal });
    const now = new Date().toISOString();

    const outcome = await recordOperationTerminal(eventBase, (db) => {
      const details = {
        status: result.status,
        statusText: result.statusText,
        elapsedMs: result.elapsedMs,
        timedOut: result.timedOut === true,
        cancelled: result.cancelled === true,
        poolType: captured.type,
      };
      // A cancelled probe proved nothing about the pool. No bench, no enable.
      if (result.cancelled) return { state: 'cancelled', code: 'probe_cancelled', details };

      // Fresh read inside the transaction: the effect applies only if the
      // configuration this probe tested is still the configuration on disk.
      const row = db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]);
      const current = row ? JSON.parse(row.data || '{}') : null;
      if (!row || current.proxyUrl !== captured.proxyUrl || current.type !== captured.type) {
        return {
          state: 'conflict',
          code: row ? 'pool_configuration_changed' : 'pool_removed',
          details: { ...details, conflict: true },
        };
      }
      return {
        state: result.ok ? 'succeeded' : 'failed',
        code: result.ok ? null : result.timedOut ? 'probe_timeout' : 'probe_failed',
        details,
        effect: () => {
          db.run(
            `UPDATE proxyPools SET isActive = ?, testStatus = ?, data = ?, updatedAt = ? WHERE id = ?`,
            [
              result.ok ? 1 : 0,
              result.ok ? 'active' : 'error',
              JSON.stringify({
                ...current,
                lastTestedAt: now,
                lastError: result.ok
                  ? null
                  : result.error || `Proxy test failed with status ${result.status}`,
              }),
              now,
              id,
            ]
          );
        },
      };
    });

    return NextResponse.json(
      {
        ok: result.ok,
        status: result.status,
        statusText: result.statusText || null,
        error: result.error || null,
        elapsedMs: result.elapsedMs || 0,
        testedAt: now,
        operationId,
        outcome: outcome.state,
      },
      {
        // A rejected target is a caller error, not an upstream failure: surface it as
        // 4xx so the dashboard shows the reason rather than a generic test failure.
        status: !result.ok && result.status === 400 ? 400 : 200,
      }
    );
  } catch (error) {
    console.log('Error testing proxy pool:', error);
    return NextResponse.json({ error: 'Failed to test proxy pool' }, { status: 500 });
  }
}
