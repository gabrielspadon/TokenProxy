// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  editPlan,
  removePlan,
  setPlanOverride,
  scopeModel,
} from '../../src/shared/models-policy/policyModel';

const state = vi.hoisted(() => ({ workspace: null, analysisActions: null }));
vi.mock('@/shared/workspace/WorkspaceProvider', () => ({ useWorkspace: () => state.workspace }));
vi.mock('@/shared/workspace/ScopeBar', () => ({
  ScopeBar: (props) => {
    state.analysisActions = props.analysisActions;
    return <div aria-label="Shared scope fixture" />;
  },
}));
const { ModelsPolicy } = await import('../../src/shared/models-policy/ModelsPolicy');
let container, root, current, draft, calls, handler;
const id = '00000000-0000-4000-8000-000000000001';
const hash = 'a'.repeat(64),
  nextHash = 'b'.repeat(64);
const valid = { valid: true, errors: [], warnings: [{ code: 'upstream_support_unverified' }] };
const documentFixture = () => ({
  combos: [{ id: 'fast', name: 'fast', kind: 'llm', models: ['claude/model-a', 'claude/model-b'] }],
  aliases: { shortcut: 'claude/model-a' },
  settings: {
    comboStrategy: 'fallback',
    comboStrategies: {
      fast: { memberConnections: { 'claude/model-a': 'account-a' }, judgeModel: 'claude/judge' },
    },
  },
});
const response = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function render() {
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <ModelsPolicy />
      </MantineProvider>
    )
  );
  await flush();
}
function button(name) {
  return [...document.querySelectorAll('button')].find((item) => item.textContent === name);
}
async function click(name) {
  const item = button(name);
  expect(item, name).toBeTruthy();
  await act(async () => item.click());
  await flush();
}
async function input(selector, value) {
  const node = document.querySelector(selector);
  expect(node).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })),
  });
  state.workspace = {
    scope: { provider: 'claude', model: 'model-a', connectionId: null },
    accounts: [{ connectionId: 'account-a', displayName: 'Synthetic account' }],
    models: {
      data: { models: [{ provider: 'claude', model: 'model-a', fullModel: 'claude/model-a' }] },
    },
    observeSnapshot: vi.fn(),
  };
  current = { document: documentFixture(), currentHash: hash, validation: valid };
  draft = null;
  calls = [];
  handler = async (url, method, body) => {
    if (url === '/api/admin/configuration') return response(current);
    if (url === '/api/admin/configuration/drafts' && method === 'POST') {
      draft = { id, revision: 1, baseHash: hash, version: { id: 2, document: body.document } };
      return response(draft, 201);
    }
    if (url === `/api/admin/configuration/drafts/${id}` && method === 'PATCH') {
      draft = {
        ...draft,
        revision: draft.revision + 1,
        version: { ...draft.version, document: body.document },
      };
      return response(draft);
    }
    if (url === `/api/admin/configuration/drafts/${id}`)
      return response({
        ...draft,
        diff: [
          {
            path: '/combos',
            before: current.document.combos,
            after: draft.version.document.combos,
            operation: 'replace',
          },
        ],
      });
    if (url.endsWith('/validate'))
      return response({ ...valid, currentHash: hash, draftId: id, revision: draft?.revision });
    if (url.includes('/drafts?')) return response({ drafts: draft ? [draft] : [] });
    if (url.includes('/versions?'))
      return response({
        versions: [
          { id: 1, kind: 'snapshot', contentHash: hash, createdAt: '2026-09-06T15:00:00Z' },
        ],
      });
    if (url === '/api/admin/configuration/versions/1')
      return response({ id: 1, kind: 'snapshot', document: documentFixture() });
    if (url.includes('/receipts?')) return response({ receipts: [] });
    return response({ error: 'Unexpected fixture operation', code: 'unexpected_fixture' }, 500);
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options = {}) => {
      const method = options.method || 'GET',
        body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ url: String(url), method, body });
      return handler(String(url), method, body);
    })
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Covered policy editor transformations', () => {
  it('renames a plan and preserves its exact override and member bindings without mutating the source', () => {
    const source = documentFixture(),
      next = editPlan(source, 'fast', { name: 'renamed' });
    expect(next.settings.comboStrategies.renamed).toEqual(source.settings.comboStrategies.fast);
    expect(next.settings.comboStrategies.fast).toBeUndefined();
    expect(source.combos[0].name).toBe('fast');
  });
  it('refuses duplicate plan names before replacing another plan override', () => {
    const source = documentFixture();
    source.combos.push({ id: 'other', name: 'other', models: [] });
    expect(() => editPlan(source, 'fast', { name: 'other' })).toThrow(/already/);
  });
  it('removes only the selected plan and its own override', () => {
    const source = documentFixture(),
      next = removePlan(source, 'fast');
    expect(next.combos).toEqual([]);
    expect(next.settings.comboStrategies.fast).toBeUndefined();
    expect(next.aliases).toEqual(source.aliases);
    expect(next.settings.comboStrategy).toBe('fallback');
  });
  it('clears one covered override without losing unrelated bindings', () => {
    const source = documentFixture(),
      next = setPlanOverride(source, 'fast', 'judgeModel', undefined);
    expect(next.settings.comboStrategies.fast.memberConnections).toEqual(
      source.settings.comboStrategies.fast.memberConnections
    );
    expect(next.settings.comboStrategies.fast.judgeModel).toBeUndefined();
    expect(scopeModel(state.workspace.scope, state.workspace.models.data.models)).toBe(
      'claude/model-a'
    );
  });
});

describe('Policy workbench controls', () => {
  it('starts read-only and omits unrelated analytical export actions', async () => {
    await render();
    expect(state.analysisActions).toBe(false);
    expect(document.querySelector('[aria-label="Member 1 model"]').disabled).toBe(true);
    expect(calls.some((call) => call.method !== 'GET')).toBe(false);
  });
  it('stores ordered edits with the exact expected draft revision, then validates that stored revision', async () => {
    await render();
    await click('New draft from active');
    await input('[aria-label="Member 1 model"]', 'claude/replacement');
    expect(button('Validate locally').disabled).toBe(true);
    await click('Save draft revision');
    expect(calls.find((call) => call.method === 'PATCH').body).toMatchObject({
      expectedRevision: 1,
      document: { combos: [{ models: ['claude/replacement', 'claude/model-b'] }] },
    });
    await click('Validate locally');
    expect(calls.find((call) => call.url.endsWith('/validate')).body.expectedRevision).toBe(2);
    expect(button('Review activation').disabled).toBe(false);
  });
  it('retains edits after a409 and requires explicit discard before loading the newer revision', async () => {
    const normal = handler;
    handler = async (url, method, body) =>
      method === 'PATCH'
        ? response({ error: 'Stored revision advanced', code: 'revision_conflict' }, 409)
        : normal(url, method, body);
    await render();
    await click('New draft from active');
    await input('[aria-label="Member 1 model"]', 'claude/local-edit');
    await click('Save draft revision');
    expect(document.querySelector('[aria-label="Member 1 model"]').value).toBe('claude/local-edit');
    await click('Reload stored revision');
    expect(document.body.textContent).toContain('Replace local draft edits?');
    await click('Keep editing');
    expect(document.querySelector('[aria-label="Member 1 model"]').value).toBe('claude/local-edit');
    await click('Reload stored revision');
    await click('Reload and discard local edits');
    expect(document.querySelector('[aria-label="Member 1 model"]').value).toBe('claude/model-a');
  });
  it('reviews fresh active state and reports207 partial completion without automatic replay', async () => {
    const normal = handler;
    handler = async (url, method, body) =>
      url.endsWith('/activate')
        ? response(
            {
              outcome: 'partial',
              version: { id: 3 },
              currentHash: nextHash,
              receipt: { id: 8, outcome: 'partial' },
              completion: { databaseCommitted: true, runtimeRefresh: 'failed' },
            },
            207
          )
        : normal(url, method, body);
    await render();
    await click('New draft from active');
    await click('Validate locally');
    current.currentHash = nextHash;
    await click('Review activation');
    expect(document.querySelector('[aria-label="Covered configuration changes"]')).toBeTruthy();
    await click('Activate revision 1');
    expect(calls.find((call) => call.url.endsWith('/activate')).body).toEqual({
      expectedRevision: 1,
      expectedCurrent: nextHash,
    });
    expect(document.body.textContent).toContain('Partial completion');
    expect(document.body.textContent).toContain('Receipt 8');
    expect(calls.filter((call) => call.url.endsWith('/activate')).length).toBe(1);
  });
  it('keeps an activation conflict visible inside its open confirmation dialog', async () => {
    const normal = handler;
    handler = async (url, method, body) =>
      url.endsWith('/activate')
        ? response(
            {
              error: 'Active hash changed',
              code: 'current_conflict',
              receipt: { id: 9, outcome: 'conflict' },
            },
            409
          )
        : normal(url, method, body);
    await render();
    await click('New draft from active');
    await click('Validate locally');
    await click('Review activation');
    await click('Activate revision 1');
    expect(document.querySelector('[role="dialog"]').textContent).toContain('Active hash changed');
    expect(document.querySelector('[role="dialog"]').textContent).toContain('receipt 9');
  });
  it('restores a prior version only after an explicit fresh review', async () => {
    const normal = handler;
    handler = async (url, method, body) =>
      url.endsWith('/rollback')
        ? response({
            outcome: 'applied',
            version: { id: 4 },
            currentHash: nextHash,
            receipt: { id: 10, outcome: 'applied' },
          })
        : normal(url, method, body);
    await render();
    await click('History and receipts');
    await click('Immutable versions');
    await click('Review restoration');
    expect(calls.some((call) => call.url.endsWith('/rollback'))).toBe(false);
    await click('Restore version 1');
    expect(calls.find((call) => call.url.endsWith('/rollback')).body).toEqual({
      expectedCurrent: hash,
    });
    expect(document.body.textContent).toContain('Configuration version 4 applied');
  });
  it('retains the exact captured packet through replay and states readiness and affinity uncertainty', async () => {
    const capture = {
      version: 1,
      captureId: hash,
      capturedAt: '2026-09-06T15:45:00Z',
      scope: { requestedModel: 'claude/model-a', provider: 'claude', model: 'model-a' },
      configuration: { currentHash: hash },
    };
    const normal = handler;
    handler = async (url, method, body) => {
      if (url.endsWith('/capture')) return response({ capture, input: body.input });
      if (url.endsWith('/simulate'))
        return response({
          receipt: { captureId: hash, sideEffects: false },
          served: null,
          readiness: 'unknown',
          localSelection: {
            status: 'candidate',
            connectionId: 'account-a',
            model: 'model-a',
            reason: 'first-pin',
          },
          affinity: { source: 'assumed-new-session', action: 'pin', reason: 'first-pin' },
          candidates: [
            {
              order: 1,
              connectionId: 'account-a',
              capacity: { gated: true, limit: 80 },
              activeLoad: { inFlight: 0 },
              quotaEvidence: 'unknown',
            },
          ],
          exclusions: [],
          ranking: [],
          capabilityFit: {
            contextFitsDeclaredWindow: null,
            outputFitsDeclaredLimit: null,
            missingOrUnknown: ['reasoning'],
          },
          unknownEvidence: ['provider-acceptance', 'actual-session-affinity'],
        });
      return normal(url, method, body);
    };
    await render();
    await click('Offline account decision');
    await click('Capture current inputs');
    await click('Simulate captured decision');
    expect(calls.find((call) => call.url.endsWith('/simulate')).body.capture).toEqual(capture);
    expect(calls.find((call) => call.url.endsWith('/capture')).body).not.toHaveProperty(
      'sessionHash'
    );
    expect(document.body.textContent).toContain('Upstream readinessUnknown');
    expect(document.body.textContent).toContain('assumed new session');
    expect(
      document.querySelector('[aria-label="Captured candidate ordering"]').textContent
    ).toContain('Synthetic account');
    await click('History and receipts');
    await click('Offline account decision');
    expect(button('Simulate captured decision').disabled).toBe(false);
    expect(calls.some((call) => call.url.includes('/v1/'))).toBe(false);
  });
  it('shows a refused capture without inventing candidates or served evidence', async () => {
    const normal = handler;
    handler = async (url, method, body) =>
      url.endsWith('/capture')
        ? response(
            { error: 'Virtual model capture is unsupported', code: 'unsupported_capture' },
            422
          )
        : normal(url, method, body);
    await render();
    await click('Offline account decision');
    await click('Capture current inputs');
    expect(document.body.textContent).toContain('Virtual model capture is unsupported');
    expect(document.querySelector('[aria-label="Captured candidate ordering"]')).toBeNull();
    expect(button('Simulate captured decision').disabled).toBe(true);
  });
});
