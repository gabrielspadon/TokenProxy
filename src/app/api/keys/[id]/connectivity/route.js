import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin/guard.js';
import { getApiKeyById, matchesAllowedModel } from '@/lib/db/repos/apiKeysRepo.js';
import { recordOperationTerminal } from '@/lib/db/repos/operationEventsRepo.js';
import {
  CHECK_TIERS,
  RUNNABLE_TIERS,
  checkConfiguration,
  clientEndpoints,
} from '@/lib/clientSetup/connectivity.js';

export const dynamic = 'force-dynamic';

const store = (body, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

// One request, one short deadline. A connectivity check that hangs is worse
// than one that fails, because an operator cannot tell it apart from a gateway
// that is down.
const AUTH_TIMEOUT_MS = 3000;

/**
 * GET — the generated client configuration for this key. No probe, no network.
 *
 * The key material is NOT included: the configuration names the key by id and
 * preview, and an operator who needs the secret itself uses the explicit
 * reveal endpoint, which writes its own audit row.
 */
export async function GET(request, { params }) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) return store({ error: 'Key not found' }, 404);
    const origin = new URL(request.url).origin;
    return store({
      keyId: key.id,
      keyPreview: key.key ? `••••${key.key.slice(-4)}` : '••••',
      endpoints: clientEndpoints(origin),
      allowedModels: key.allowedModels,
      expiresAt: key.expiresAt,
      tiers: CHECK_TIERS,
      runnableTiers: RUNNABLE_TIERS,
    });
  } catch (error) {
    console.log('Error building client configuration:', error);
    return store({ error: 'Failed to build client configuration' }, 500);
  }
}

/**
 * POST — run a bounded check at an explicitly named tier.
 *
 * `inference` is REFUSED rather than downgraded. A paid request against a real
 * provider is a separate operator decision and nothing here initiates one.
 */
export async function POST(request, { params }) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const tier = body?.tier;
    if (tier === 'inference') {
      return store(
        {
          error:
            'An inference check sends a billable request to a provider and is not run from here.',
          code: 'tier_not_runnable',
          tier: 'inference',
          tiers: CHECK_TIERS,
        },
        400
      );
    }
    if (!RUNNABLE_TIERS.includes(tier)) {
      return store(
        { error: `tier must be one of: ${RUNNABLE_TIERS.join(', ')}`, code: 'invalid_tier' },
        400
      );
    }

    const key = await getApiKeyById(id);
    const origin = new URL(request.url).origin;
    const endpoints = clientEndpoints(body?.baseUrl || origin);
    const configuration = checkConfiguration(
      { baseUrl: endpoints.baseUrl, model: body?.model },
      key,
      matchesAllowedModel
    );
    if (tier === 'configuration') return store({ ...configuration, endpoints });

    // Tier 2 runs only on a configuration that already holds. Probing with a
    // key we know is expired teaches nothing and spends a round trip saying so.
    if (!configuration.ok) {
      return store({
        tier: 'authentication',
        ok: false,
        reached: 'nothing',
        skipped: true,
        code: 'configuration_failed',
        configuration,
        endpoints,
      });
    }

    const started = Date.now();
    let outcome;
    try {
      const response = await fetch(endpoints.modelsUrl, {
        headers: { authorization: `Bearer ${key.key}` },
        signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
      });
      outcome = {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText || null,
        elapsedMs: Date.now() - started,
        timedOut: false,
      };
    } catch (error) {
      // A timeout and a refused connection are different answers and are kept
      // apart: one says the gateway is slow, the other that nothing is there.
      outcome = {
        ok: false,
        status: null,
        statusText: null,
        elapsedMs: Date.now() - started,
        timedOut: error?.name === 'TimeoutError',
      };
    }

    await recordOperationTerminal(
      {
        operationId: randomUUID(),
        phase: 'reachability',
        source: 'client-setup-check',
        actorClass: 'operator',
        subjectKind: 'apiKey',
        subjectId: id,
      },
      {
        state: outcome.ok ? 'succeeded' : 'failed',
        code: outcome.ok ? null : outcome.timedOut ? 'probe_timeout' : 'probe_failed',
        details: {
          kind: 'authenticated-endpoint-check',
          status: outcome.status,
          statusText: outcome.statusText,
          elapsedMs: outcome.elapsedMs,
          timedOut: outcome.timedOut,
        },
      }
    );

    return store({
      tier: 'authentication',
      ...outcome,
      // Said explicitly in the payload so a green result is never read as proof
      // that a provider answered.
      reached: 'this gateway',
      provedNothingAbout: 'upstream provider availability or billing',
      configuration,
      endpoints,
    });
  } catch (error) {
    console.log('Error running connectivity check:', error);
    return store({ error: 'Failed to run connectivity check' }, 500);
  }
}
