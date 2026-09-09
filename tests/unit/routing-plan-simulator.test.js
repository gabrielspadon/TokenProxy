import { assertRoutingDocument } from '@/lib/configuration/routingConfig.js';
import { describe, expect, it } from 'vitest';
import {
  createRoutePlanCapture,
  simulateRoutePlan,
  ROUTE_CAPTURE_TTL_MS,
} from '@/lib/routingPlanSimulation.js';
import { createRoutingCapture } from '@/lib/routingSimulation.js';
import { configHash, CONFIG_SCOPE } from '@/lib/db/helpers/configHistory.js';
import { getCapabilitiesForModel } from 'open-sse/providers/capabilities.js';
import {
  handleComboChat,
  getRotatedModels,
  resetComboRotation,
  snapshotComboRotation,
  orderComboEntries,
} from 'open-sse/services/combo.js';
import { selectAutoModelFromCatalog } from '@/sse/services/autoRouter.js';

const capturedAt = '2026-09-08T16:00:00.000Z';
const alpha = 'claude/claude-sonnet-4',
  beta = 'openai/gpt-4o';
function fixture({
  document = {
    combos: [{ id: 'plan', name: 'plan', models: [alpha, beta] }],
    aliases: {},
    settings: {},
  },
  draft = null,
  pin = false,
  disabled = false,
  runtime,
  auto,
} = {}) {
  document = assertRoutingDocument(document);
  if (draft) draft = assertRoutingDocument(draft);
  const configuration = { scope: CONFIG_SCOPE, currentHash: configHash(document), document };
  const routes = Object.fromEntries(
    [alpha, beta].map((route, i) => {
      const [provider, ...tail] = route.split('/'),
        model = tail.join('/');
      const accounts = [{ id: `account-${i}`, provider, isActive: true, authType: 'apikey' }];
      return [
        route,
        createRoutingCapture({
          capturedAt,
          scope: { requestedModel: route, provider, model },
          accounts,
          disabledModels: disabled && i === 0 ? { [provider]: [model] } : {},
          providerNodes: [],
          settings: { disabledProviders: {}, providerStrategies: {} },
          drains: {},
          activeLoad: { [`account-${i}`]: { pins: pin && i === 0 ? 1 : 0, inFlight: 0 } },
          pin: null,
          affinitySource: 'assumed-new-session',
          capabilities: getCapabilitiesForModel(provider, model),
          configuration,
        }),
      ];
    })
  );
  return createRoutePlanCapture({
    capturedAt,
    expiresAt: new Date(Date.parse(capturedAt) + ROUTE_CAPTURE_TTL_MS).toISOString(),
    scope: { requestedModel: runtime?.requestedModel || 'plan' },
    configuration,
    draft: draft
      ? {
          draftId: 'draft',
          revision: 1,
          versionId: 2,
          expectedCurrent: configuration.currentHash,
          document: draft,
          documentHash: configHash(draft),
        }
      : null,
    routes,
    resolutions: { [alpha]: alpha, [beta]: beta },
    rotations: { plan: snapshotComboRotation('plan') },
    sessions: pin
      ? [
          {
            sessionId: 'a'.repeat(64),
            route: alpha,
            connectionId: 'account-0',
            pinnedAt: capturedAt,
            expiresAt: null,
          },
        ]
      : [],
    sessionCoverage: 'complete-for-captured-physical-models',
    ...(runtime ? { runtime } : {}),
    ...(auto ? { auto } : {}),
  });
}
const request = { model: 'plan', modality: 'chat' };
const draftPacket = (capture) => ({
  version: 1,
  draftId: capture.draft.draftId,
  revision: capture.draft.revision,
  expectedCurrent: capture.configuration.currentHash,
  document: capture.draft.document,
});

describe('offline route, draft and session plans', () => {
  it('matches real controlled fallback dispatcher order and never reports a served model', async () => {
    resetComboRotation();
    const capture = fixture(),
      before = JSON.stringify(capture),
      calls = [];
    await handleComboChat({
      body: { messages: [{ role: 'user', content: 'hello' }] },
      models: [alpha, beta],
      comboName: 'plan',
      comboStrategy: 'fallback',
      log: { info() {}, warn() {} },
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        return new Response(JSON.stringify({ error: { message: 'model_not_found' } }), {
          status: 404,
          headers: { 'content-type': 'application/json', 'x-tokenproxy-replay-safe': 'true' },
        });
      },
    });
    const result = simulateRoutePlan({ capture, input: request });
    expect(result.after.attempts.map((a) => a.requestedModel)).toEqual(calls);
    expect(result.after.selectedModel).toBe(alpha);
    expect(result.after.servedModel).toBeNull();
    expect(result.served).toBeNull();
    expect(result.receipt).toMatchObject({ sideEffects: false, providerCalls: 0 });
    expect(JSON.stringify(capture)).toBe(before);
    expect(simulateRoutePlan({ capture, input: request })).toEqual(result);
  });
  it('preserves captured round-robin and resets draft activation cursor without mutating runtime cursor', () => {
    resetComboRotation();
    getRotatedModels([alpha, beta], 'plan', 'round-robin');
    const document = {
      combos: [{ id: 'plan', name: 'plan', models: [alpha, beta] }],
      aliases: {},
      settings: { comboStrategy: 'round-robin' },
    };
    const capture = fixture({ document, draft: document });
    const cursor = snapshotComboRotation('plan');
    const result = simulateRoutePlan({ capture, input: request, draft: draftPacket(capture) });
    expect(result.before.selectedModel).toBe(beta);
    expect(result.after.selectedModel).toBe(alpha);
    expect(result.after.plans[0].cursorSource).toBe('activation-resets-rotation');
    expect(snapshotComboRotation('plan')).toEqual(cursor);
    resetComboRotation();
  });
  it('applies alias target revisions and exact configuration diffs to session consequences', () => {
    const document = { combos: [], aliases: { plan: alpha }, settings: {} };
    const draft = { ...document, aliases: { plan: beta } };
    const capture = fixture({ document, draft, pin: true });
    const result = simulateRoutePlan({ capture, input: request, draft: draftPacket(capture) });
    expect(result.before.selectedModel).toBe(alpha);
    expect(result.after.selectedModel).toBe(beta);
    expect(result.receipt).toMatchObject({
      draftId: 'draft',
      draftRevision: 1,
      draftVersionId: 2,
      draftHash: configHash(draft),
    });
    expect(result.sessionPreview.affectedCount).toBe(1);
    expect(result.sessionPreview.sessions[0]).toMatchObject({
      reason: 'requested-route-selects-another-model',
      cacheContinuity: 'binding-changed-cache-reuse-not-guaranteed',
      after: { model: beta },
    });
    expect(result.diff.length).toBeGreaterThan(0);
  });
  it('shares capability/context ordering and excludes disabled members with ordered skip evidence', () => {
    const capture = fixture({ disabled: true });
    const result = simulateRoutePlan({
      capture,
      input: { ...request, requiredCapabilities: ['vision', 'reasoning'], contextTokens: 160000 },
    });
    expect(result.after.selectedModel).toBe(beta);
    expect(result.after.plans[0].disabled).toMatchObject([
      { route: alpha, reason: 'model-disabled-for-every-active-account', originalIndex: 0 },
    ]);
    const intact = fixture();
    const expected = orderComboEntries(
      [alpha, beta].map((modelStr) => ({ modelStr })),
      { contextTokens: 160000, required: new Set(['vision']) }
    );
    expect(
      simulateRoutePlan({
        capture: intact,
        input: { ...request, requiredCapabilities: ['vision'], contextTokens: 160000 },
      }).after.attempts.map((a) => a.requestedModel)
    ).toEqual(expected.map((e) => e.modelStr));
  });
  it('supports clear/expiry at the next request boundary without implying a forced account change', () => {
    const capture = fixture({ pin: true });
    for (const action of ['clear', 'expire']) {
      const result = simulateRoutePlan({
        capture,
        input: request,
        sessionPolicy: { action, at: capturedAt, connectionIds: ['account-0'] },
      });
      expect(result.sessionPreview.affectedCount).toBe(1);
      expect(result.sessionPreview.sessions[0]).toMatchObject({
        before: { connectionId: 'account-0' },
        after: { connectionId: 'account-0', reason: 'first-pin' },
        boundary: 'next-request-only-in-flight-requests-unchanged',
      });
    }
  });
  it('refuses stale revisions, mutated captures, unsupported session policies and cycles', () => {
    const capture = fixture({ draft: { combos: [], aliases: { plan: beta }, settings: {} } });
    expect(() =>
      simulateRoutePlan({
        capture,
        input: request,
        draft: { ...draftPacket(capture), revision: 2 },
      })
    ).toThrow('draft_capture_mismatch');
    expect(() =>
      simulateRoutePlan({ capture: { ...capture, captureId: 'b'.repeat(64) }, input: request })
    ).toThrow('capture_integrity_mismatch');
    expect(() =>
      simulateRoutePlan({
        capture,
        input: request,
        sessionPolicy: { action: 'migrate-stream', at: capturedAt, connectionIds: [] },
      })
    ).toThrow('unsupported_session_policy');
    expect(() => simulateRoutePlan({ capture, input: { model: 'another' } })).toThrow(
      'capture_model_mismatch'
    );
  });
  it('plans a fusion panel explicitly without fabricating a completed judge selection', () => {
    const document = {
      combos: [{ id: 'plan', name: 'plan', models: [alpha, beta] }],
      aliases: {},
      settings: { comboStrategy: 'fusion' },
    };
    const result = simulateRoutePlan({ capture: fixture({ document }), input: request });
    expect(result.after.plans[0]).toMatchObject({
      strategy: 'fusion',
      judgeModel: alpha,
      selectionBoundary: 'parallel-panel-then-judge',
    });
    expect(result.after.unknownEvidence).toContain('fusion-panel-outcomes-and-judge-dispatch');
    expect(result.served).toBeNull();
  });
  it('uses the runtime automatic selection contract against a captured catalog', () => {
    const auto = {
      models: [
        { id: alpha, owned_by: 'claude' },
        { id: beta, owned_by: 'openai' },
      ],
      rules: { coding: beta },
      blockedModels: [],
      blockedProviders: [],
    };
    const runtime = {
      requestedModel: 'auto-router',
      capacityAdapter: {},
      agentRoles: {},
      reachableProviders: [],
    };
    const capture = fixture({ runtime, auto });
    const result = simulateRoutePlan({
      capture,
      input: { model: 'auto-router', taskClass: 'coding' },
    });
    expect(result.after.automatic).toEqual(
      selectAutoModelFromCatalog('coding', auto.models, undefined, {
        autoRouter: { rules: auto.rules },
      })
    );
    expect(result.after.selectedModel).toBe(beta);
    expect(result.after.unknownEvidence).toContain('live-entitlement-catalog-differences');
  });
});

it('shows both cascade stages when raw request/session facts are unknown and applies explicit hypothetical facts', () => {
  const runtime = {
    requestedModel: alpha,
    capacityAdapter: {},
    agentRoles: {},
    reachableProviders: [],
    cascadePairs: [{ strong: alpha, cheap: beta }],
  };
  const capture = fixture({ runtime });
  const unknown = simulateRoutePlan({ capture, input: { model: alpha } });
  expect(unknown.after.status).toBe('unknown');
  expect(unknown.after.selectedModel).toBeNull();
  expect(unknown.after.attempts.map((a) => a.resolvedModel)).toEqual([beta, alpha]);
  expect(
    simulateRoutePlan({ capture, input: { model: alpha, cascadeMode: 'exploration' } }).after
      .selectedModel
  ).toBe(beta);
  expect(
    simulateRoutePlan({ capture, input: { model: alpha, cascadeMode: 'escalated' } }).after
      .selectedModel
  ).toBe(alpha);
});

it('applies captured agent role groups without reordering their intersection', () => {
  const runtime = {
    requestedModel: 'plan',
    capacityAdapter: {},
    agentRoles: { sub: [beta] },
    reachableProviders: [],
  };
  const capture = fixture({ runtime });
  expect(
    simulateRoutePlan({ capture, input: { ...request, agentRole: 'sub' } }).after.attempts.map(
      (a) => a.resolvedModel
    )
  ).toEqual([beta]);
  expect(
    simulateRoutePlan({ capture, input: { ...request, agentRole: 'unknown' } }).after.attempts.map(
      (a) => a.resolvedModel
    )
  ).toEqual([alpha, beta]);
});
