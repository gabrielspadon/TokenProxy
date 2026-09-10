// @vitest-environment jsdom
// The Token savings page: the sidebar level governs the board, turning a
// control on is reviewed in place with consent, turning one off and editing a
// threshold save from the field itself, and every save is read back.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  settings: {},
  calls: [],
  reads: [],
  conflict: false,
  mismatch: false,
  hash: 'a'.repeat(64),
}));
vi.mock('@/shared/hooks/usePoll', () => ({
  usePoll: (url) => {
    state.reads.push(url);
    return {
      loading: false,
      data:
        url === '/api/admin/shaping'
          ? { settings: state.settings, currentHash: state.hash }
          : url === '/api/settings'
            ? state.settings
            : { windows: { all: { stages: {} } } },
      goodAt: 1,
      refresh: vi.fn(),
    };
  },
}));
vi.mock('@/shared/api', () => ({
  call: async (url, options = {}) => {
    state.calls.push({ url, ...options });
    if (options.method === 'POST') {
      if (state.conflict) return { ok: false, status: 409, body: { code: 'settings_conflict' } };
      state.settings = { ...state.settings, ...options.body.patch };
      state.hash = 'b'.repeat(64);
      return { ok: true, status: 200, body: { afterHash: state.hash } };
    }
    return {
      ok: true,
      status: 200,
      body: { settings: state.settings, currentHash: state.mismatch ? 'c'.repeat(64) : state.hash },
    };
  },
}));
vi.mock('@/shared/workspace/ScopeBar', () => ({ ScopeBar: () => null }));
vi.mock('@/shared/workspace/WorkspaceProvider', () => ({
  useWorkspace: () => ({ scope: { period: 'all' } }),
  useOptionalWorkspace: () => null,
}));
vi.mock('@/app/dashboard/shaping/Workbench', () => ({ ShapingWorkbench: () => null }));
vi.mock('@/app/dashboard/shaping/PlanOverrides', () => ({ PlanOverrides: () => null }));
import ShapingPage from '@/app/dashboard/shaping/page';
import { CONFIGURATION_FIELDS, CONTROLS, THRESHOLDS } from '@/app/dashboard/shaping/controlCatalog';
import { PROFILE_KEYS } from '@/lib/shaping/profile';

let container, root;
const level = (mode) => localStorage.setItem('tokenproxy.navigation-mode', JSON.stringify(mode));
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
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  localStorage.clear();
  state.calls = [];
  state.reads = [];
  state.conflict = false;
  state.mismatch = false;
  state.hash = 'a'.repeat(64);
  state.settings = {
    ...Object.fromEntries(CONTROLS.map((control) => [control.key, false])),
    ...Object.fromEntries(
      THRESHOLDS.map((field) => [field.key, field.nullable ? null : field.min])
    ),
    ...Object.fromEntries(
      CONFIGURATION_FIELDS.map((field) => [field.key, field.list ? [] : 'full'])
    ),
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <ShapingPage />
      </MantineProvider>
    )
  );
}
const button = (text) =>
  [...container.querySelectorAll('button')].find((node) => node.textContent === text);
const control = (key) => container.querySelector(`[data-savings-control="${key}"]`);
const review = () => container.querySelector('[role="group"][aria-label^="Turn on"]');
async function change(name, value) {
  const input = container.querySelector(`[name="${name}"]`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, value);
    input.dispatchEvent(
      new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })
    );
  });
  if (input.tagName !== 'SELECT')
    await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
}

it('reads nothing but settings on open and keeps the level as the only switch', async () => {
  await render();
  expect(container.querySelector('h1').textContent).toBe('Token savings');
  expect(container.querySelectorAll('[role="tablist"]')).toHaveLength(0);
  expect(container.querySelector('[data-layout="cards"]')).not.toBeNull();
  expect(container.querySelector('dialog')).toBeNull();
  expect(state.reads.some((url) => /pxpipe|headroom|runtime/.test(url))).toBe(false);
  expect(state.calls).toEqual([]);
});

it('renders every threshold and level in place once the level is Advanced', async () => {
  level('advanced');
  await render();
  expect(container.querySelector('[data-layout="rows"]')).not.toBeNull();
  expect(
    new Set([...CONTROLS, ...THRESHOLDS, ...CONFIGURATION_FIELDS].map((field) => field.key))
  ).toEqual(new Set(PROFILE_KEYS));
  for (const field of [...THRESHOLDS, ...CONFIGURATION_FIELDS]) {
    const input = container.querySelector(`[name="${field.key}"]`);
    expect(input, field.key).not.toBeNull();
    expect(input.closest('details, [hidden], [data-hidden]'), field.key).toBeNull();
    expect(input.disabled, field.key).toBe(false);
    expect(container.querySelectorAll(`[name="${field.key}"]`)).toHaveLength(1);
  }
  expect(state.calls).toEqual([]);
});

it('reviews turning a control on in place and refuses to save without consent', async () => {
  level('advanced');
  await render();
  await act(async () => control('rtkEnabled').querySelector('input[type="checkbox"]').click());
  expect(review()).not.toBeNull();
  expect(container.querySelector('dialog')).toBeNull();
  expect(review().textContent).toContain('a request already in flight retains its settings');
  await act(async () => button('Turn on').click());
  expect(state.calls).toEqual([]);
  expect(review().textContent).toContain('Review and consent');
});

it('saves through the retained hash and consent boundary, then verifies the readback', async () => {
  level('advanced');
  await render();
  await act(async () => control('rtkEnabled').querySelector('input[type="checkbox"]').click());
  await act(async () => review().querySelector('input[type="checkbox"]').click());
  await act(async () => button('Turn on').click());
  expect(state.calls).toEqual([
    {
      url: '/api/admin/shaping/controls',
      method: 'POST',
      body: {
        patch: { rtkEnabled: true },
        expectedCurrent: 'a'.repeat(64),
        consent: ['rtkEnabled'],
      },
    },
    { url: '/api/admin/shaping' },
  ]);
  expect(review()).toBeNull();
  expect(control('rtkEnabled').querySelector('input[type="checkbox"]').checked).toBe(true);
});

it('keeps the refusal and the saved off state at the control after a settings conflict', async () => {
  state.conflict = true;
  level('advanced');
  await render();
  await act(async () => control('rtkEnabled').querySelector('input[type="checkbox"]').click());
  await act(async () => review().querySelector('input[type="checkbox"]').click());
  await act(async () => button('Turn on').click());
  expect(state.calls).toHaveLength(1);
  expect(review().textContent).toContain('Settings changed after this view was read');
  expect(control('rtkEnabled').querySelector('input[type="checkbox"]').checked).toBe(false);
});

it('turns a control off directly, because removing a transformation grants nothing', async () => {
  state.settings.rtkEnabled = true;
  level('advanced');
  await render();
  await act(async () => control('rtkEnabled').querySelector('input[type="checkbox"]').click());
  expect(review()).toBeNull();
  expect(state.calls[0].body.patch).toEqual({ rtkEnabled: false });
  expect(state.calls[1]).toEqual({ url: '/api/admin/shaping' });
});

it('saves a threshold, a level and a list from the field itself', async () => {
  level('advanced');
  await render();
  await change('pxpipeTimeoutMs', '12500');
  expect(state.calls[0].body.patch).toEqual({ pxpipeTimeoutMs: 12500 });
  await change('cavemanLevel', 'lite');
  expect(state.calls[2].body.patch).toEqual({ cavemanLevel: 'lite' });
  await change('privacyFilterTerms', 'private-one\nprivate-two');
  expect(state.calls[4].body.patch).toEqual({ privacyFilterTerms: ['private-one', 'private-two'] });
});

it('sends nothing for a value outside a field limit and keeps the runtime default blank', async () => {
  state.settings.headroomTimeoutMs = 15000;
  level('advanced');
  await render();
  await change('pxpipeTimeoutMs', '600000');
  expect(state.calls).toEqual([]);
  await change('headroomTimeoutMs', '');
  expect(state.calls[0].body.patch).toEqual({ headroomTimeoutMs: null });
});

it('keeps a task selection separate from the level and opens no dialog', async () => {
  await render();
  const tasks = container.querySelector('[role="radiogroup"][aria-label="Token savings task"]');
  expect([...tasks.querySelectorAll('label')].map((node) => node.textContent)).toEqual([
    'Controls',
    'Plans',
    'Profiles',
    'Services',
    'Evidence',
  ]);
  await act(async () => tasks.querySelector('input[value="evidence"]').click());
  expect(container.textContent).toContain('Recorded stage evidence');
  expect(container.querySelector('dialog')).toBeNull();
  expect(state.calls).toEqual([]);
});
