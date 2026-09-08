// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ settings: {}, calls: [], reads: [], conflict: false, mismatch: false, hash: 'a'.repeat(64) }));
vi.mock('@/shared/hooks/usePoll', () => ({ usePoll: url => {
  state.reads.push(url);
  return { loading: false, data: url === '/api/admin/shaping' ? { settings: state.settings, currentHash: state.hash } : url === '/api/settings' ? state.settings : { windows: { all: { stages: {} } } }, goodAt: 1, refresh: vi.fn() };
} }));
vi.mock('@/shared/api', () => ({ call: async (url, options = {}) => {
  state.calls.push({ url, ...options });
  if (options.method === 'POST') {
    if (state.conflict) return { ok: false, status: 409, body: { code: 'settings_conflict' } };
    state.settings = { ...state.settings, ...options.body.patch }; state.hash = 'b'.repeat(64);
    return { ok: true, status: 200, body: { afterHash: state.hash } };
  }
  return { ok: true, status: 200, body: { settings: state.settings, currentHash: state.mismatch ? 'c'.repeat(64) : state.hash } };
} }));
vi.mock('@/app/dashboard/shaping/Workbench', () => ({ ShapingWorkbench: () => null }));
vi.mock('@/app/dashboard/shaping/PlanOverrides', () => ({ PlanOverrides: () => null }));
import ShapingPage from '@/app/dashboard/shaping/page';
import { CONFIGURATION_FIELDS, CONTROLS, THRESHOLDS } from '@/app/dashboard/shaping/controlCatalog';
import { PROFILE_KEYS } from '@/lib/shaping/profile';
let container, root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  localStorage.clear(); state.calls = []; state.reads = []; state.conflict = false; state.mismatch = false; state.hash = 'a'.repeat(64);
  state.settings = { ...Object.fromEntries(CONTROLS.map(control => [control.key, false])), ...Object.fromEntries(THRESHOLDS.map(field => [field.key, field.nullable ? null : field.min])), ...Object.fromEntries(CONFIGURATION_FIELDS.map(field => [field.key, field.list ? [] : 'full'])) };
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function render() { await act(async () => root.render(<MantineProvider env="test"><ShapingPage /></MantineProvider>)); }
async function review() { await render(); await act(async () => container.querySelector('[data-savings-control="rtkEnabled"] input').click()); }
async function submit() { await act(async () => container.querySelector('dialog form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }
const button = text => [...container.querySelectorAll('button')].find(node => node.textContent === text);
async function change(name, value) {
  const input = container.querySelector(`[name="${name}"]`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, value);
    input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}

it('starts with four switches and keeps every field in one Advanced tab', async () => {
  await render();
  expect([...container.querySelectorAll('[role="tab"]')].map(node => node.textContent)).toEqual(['Everyday', 'Advanced', 'Plan overrides', 'Profiles and comparison', 'Services', 'Recorded evidence']);
  expect(container.querySelector('[role="tab"][aria-selected="true"]').textContent).toBe('Everyday');
  expect(container.querySelectorAll('[role="tablist"]')).toHaveLength(1);
  const everyday = container.querySelector('[aria-label="Everyday token savings"]');
  expect(everyday.querySelectorAll('input[type="checkbox"]')).toHaveLength(4);
  expect(everyday.querySelector('input[type="number"], textarea, select, details')).toBeNull();
  for (const field of [...THRESHOLDS, ...CONFIGURATION_FIELDS]) expect(container.querySelector(`[name="${field.key}"]`).closest('[role="tabpanel"]').style.display).toBe('none');
  await act(async () => button('Advanced').click());
  expect(new Set([...CONTROLS, ...THRESHOLDS, ...CONFIGURATION_FIELDS].map(field => field.key))).toEqual(new Set(PROFILE_KEYS));
  for (const field of [...THRESHOLDS, ...CONFIGURATION_FIELDS]) {
    const input = container.querySelector(`[name="${field.key}"]`);
    expect(input, field.key).not.toBeNull();
    expect(input.closest('details, [hidden], [data-hidden]'), field.key).toBeNull();
    expect(input.disabled, field.key).toBe(false);
    expect(container.querySelectorAll(`[name="${field.key}"]`)).toHaveLength(1);
  }
  for (const field of THRESHOLDS) {
    const group = container.querySelector(`[name="${field.key}"]`).closest('[role="group"]');
    expect(group, field.key).not.toBeNull();
    expect(group.getAttribute('aria-label')).toBe(`${CONTROLS.find(control => control.stage === field.stage).name} thresholds`);
  }
  expect(state.calls).toEqual([]);
});

it('opens the simple view without service calls and requires explicit consent before a save', async () => {
  await review();
  expect(container.querySelector('h1').textContent).toBe('Token savings');
  expect(container.querySelector('dialog').open).toBe(true);
  expect(state.reads.some(url => /pxpipe|headroom|runtime/.test(url))).toBe(false);
  await submit();
  expect(state.calls).toEqual([]);
  expect(container.querySelector('dialog').textContent).toContain('Review and consent');
});

it('saves through the existing hash and consent boundary then verifies the refreshed setting', async () => {
  await review();
  await act(async () => container.querySelector('dialog input[type="checkbox"]').click());
  await submit();
  expect(state.calls).toEqual([
    { url: '/api/admin/shaping/controls', method: 'POST', body: { patch: { rtkEnabled: true }, expectedCurrent: 'a'.repeat(64), consent: ['rtkEnabled'] } },
    { url: '/api/admin/shaping' },
  ]);
  expect(container.textContent).toContain('Tool result reducer saved and verified after refresh');
  expect(container.querySelector('dialog').open).toBe(false);
  expect(container.querySelector('[data-savings-control="rtkEnabled"] input').checked).toBe(true);
});

it('retains a refused change and the saved off state after a settings conflict', async () => {
  state.conflict = true; await review();
  await act(async () => container.querySelector('dialog input[type="checkbox"]').click());
  await submit();
  expect(state.calls).toHaveLength(1);
  expect(container.querySelector('dialog').open).toBe(true);
  expect(container.querySelector('dialog').textContent).toContain('Settings changed after this view was read');
  expect(container.querySelector('[data-savings-control="rtkEnabled"] input').checked).toBe(false);
});

it('edits thresholds, levels and lists directly, reviews once, and verifies the exact patch', async () => {
  await render();
  await act(async () => button('Advanced').click());
  await change('pxpipeTimeoutMs', '12500');
  await change('cavemanLevel', 'lite');
  await change('privacyFilterTerms', 'private-one\nprivate-two');
  expect(state.calls).toEqual([]);
  await act(async () => button('Review setting changes').click());
  expect(container.querySelector('dialog input[type="number"], dialog select, dialog textarea')).toBeNull();
  expect(container.querySelector('dialog').textContent).toContain('12,500');
  await act(async () => container.querySelector('dialog input[type="checkbox"]').click());
  await submit();
  expect(state.calls).toEqual([
    { url: '/api/admin/shaping/controls', method: 'POST', body: { patch: { pxpipeTimeoutMs: 12500, cavemanLevel: 'lite', privacyFilterTerms: ['private-one', 'private-two'] }, expectedCurrent: 'a'.repeat(64), consent: [] } },
    { url: '/api/admin/shaping' },
  ]);
  expect(container.textContent).toContain('Control settings saved and verified after refresh');
  expect(container.querySelector('.shaping-draft-bar')).toBeNull();
});

it('preserves the draft when the separate readback hash cannot confirm persistence', async () => {
  state.mismatch = true;
  await render();
  await act(async () => button('Advanced').click());
  await change('memoryMaxToolTurnsKeepFull', '4');
  await act(async () => button('Review setting changes').click());
  await act(async () => container.querySelector('dialog input[type="checkbox"]').click());
  await submit();
  expect(container.textContent).toContain('Save accepted; refreshed settings could not be confirmed');
  expect(container.querySelector('[name="memoryMaxToolTurnsKeepFull"]').value).toBe('4');
  expect(container.querySelector('.shaping-draft-bar')).not.toBeNull();
});

it('retains the runtime-default timeout and validates numeric limits before review', async () => {
  state.settings.headroomTimeoutMs = 15000;
  await render();
  await act(async () => button('Advanced').click());
  await change('headroomTimeoutMs', '');
  await change('pxpipeTimeoutMs', '600000');
  expect(button('Review setting changes').disabled).toBe(true);
  await change('pxpipeTimeoutMs', '15000');
  await act(async () => button('Review setting changes').click());
  expect(container.querySelector('dialog').textContent).toContain('Runtime default');
  await act(async () => container.querySelector('dialog input[type="checkbox"]').click());
  await submit();
  expect(state.calls[0].body.patch).toEqual({ headroomTimeoutMs: null, pxpipeTimeoutMs: 15000 });
});

it('keeps Advanced drafts and filters when moving through Everyday', async () => {
  await render();
  await act(async () => button('Advanced').click());
  await change('memoryMaxToolTurnsKeepFull', '4');
  const advanced = container.querySelector('[aria-label="Token savings control panel"]');
  const filter = advanced.querySelector('select');
  await act(async () => { filter.value = 'off'; filter.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => button('Everyday').click());
  expect(container.querySelector('.shaping-draft-bar')).not.toBeNull();
  expect(state.calls).toEqual([]);
  await act(async () => button('Advanced').click());
  expect(container.querySelector('[name="memoryMaxToolTurnsKeepFull"]').value).toBe('4');
  expect(filter.value).toBe('off');
  expect(container.querySelectorAll('[role="tablist"]')).toHaveLength(1);
});
