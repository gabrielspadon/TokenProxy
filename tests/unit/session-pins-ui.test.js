// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ calls: [], preview: null, applied: null, pages: {} }));
vi.mock('@/shared/api', () => ({ call: async (url, options = {}) => {
  state.calls.push({ url, ...options });
  if (url.endsWith('/preview')) return state.preview;
  if (url.endsWith('/apply')) return state.applied;
  if (url.includes('/actions/')) return state.applied;
  return { ok: true, body: state.pages[url] || state.pages.root };
} }));
import SessionPins from '@/shared/components/SessionPins.js';
let container, root;
const pin = { id: 'opaque-pin', revision: 'r'.repeat(64), model: 'claude-fable-5', connectionId: 'account-a',
  state: 'active', provider: 'claude', expiresAt: '2026-09-07T00:00:00.000Z', pinnedAt: '2026-09-06T00:00:00.000Z', lastSeenAt: '2026-09-06T01:00:00.000Z',
  session: null, requests: [], switches: [], actions: [], targets: [{ id: 'account-b', name: 'Account B', enabled: true }] };
const preview = { id: 'action-id', status: 'preview', expectedRevision: pin.revision, model: pin.model, previewExpiresAt: pin.expiresAt,
  preview: { consequence: 'Future selection may choose the same account.', conflicts: [], unknownEvidence: ['provider-acceptance'] } };
beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  state.calls = []; state.preview = { ok: true, body: preview }; state.applied = { ok: true, body: { ...preview, status: 'queued', reason: 'awaiting-subsequent-selection' } };
  state.pages = { root: { version: 1, pins: [pin], next: null, observedAt: pin.lastSeenAt } };
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root.render(<SessionPins />));
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const button = text => [...container.querySelectorAll('button')].find(b => b.textContent.includes(text));
const click = text => act(async () => button(text).click());
async function select() { await click('Inspect'); }
async function submit() { await act(async () => container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }
it('requires preview then explicit apply, retains receipt and refreshes the pin list', async () => {
  await select(); expect(button('Apply this change')).toBeUndefined();
  await submit();
  expect(state.calls.at(-1)).toMatchObject({ url: '/api/admin/session-pins/preview', body: { action: 'clear', expectedRevision: pin.revision, pinId: pin.id } });
  expect(state.calls.some(c => c.url.endsWith('/apply'))).toBe(false);
  expect(container.textContent).toContain('Future selection may choose the same account.');
  await click('Apply this change');
  expect(state.calls.at(-2)).toMatchObject({ url: '/api/admin/session-pins/apply', body: { id: preview.id, expectedRevision: pin.revision } });
  expect(state.calls.at(-1).url).toBe('/api/admin/session-pins');
  expect(container.textContent).toContain('Waiting for a subsequent request');
  expect(button('Apply this change')).toBeUndefined();
  await click('Refresh receipt'); expect(state.calls.at(-1).url).toContain('/actions/action-id');
});
it('edits invalidate a preview and cannot submit a different target under an old receipt', async () => {
  await select(); await submit();
  const actionField = container.querySelector('select');
  await act(async () => { actionField.value = 'reassign'; actionField.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(button('Apply this change')).toBeUndefined();
  const target = container.querySelectorAll('select')[1];
  await act(async () => { target.value = 'account-b'; target.dispatchEvent(new Event('change', { bubbles: true })); });
  await submit();
  expect(state.calls.at(-1).body).toMatchObject({ action: 'reassign', targetConnectionId: 'account-b' });
});
it('shows stale-state refusal, removes apply and requires a new preview', async () => {
  await select(); await submit(); state.applied = { ok: false, status: 409, body: { ...preview, status: 'conflict', reason: 'pin_changed' } };
  await click('Apply this change');
  expect(container.querySelector('[role="alert"]').textContent).toContain('pin changed');
  expect(button('Apply this change')).toBeUndefined();
});
it('a failed preview never enables mutation or substitutes guessed request evidence', async () => {
  state.preview = { ok: false, status: 403, body: { code: 'forbidden_class' } };
  await select(); await submit();
  expect(container.textContent).toContain('No exact retained requests');
  expect(container.querySelector('[role="alert"]').textContent).toContain('forbidden class');
  expect(button('Apply this change')).toBeUndefined();
});
it('pagination returns to the exact previous cursor', async () => {
  state.pages.root.next = 'page-two';
  state.pages['/api/admin/session-pins?before=page-two'] = { ...state.pages.root, next: 'page-three' };
  state.pages['/api/admin/session-pins?before=page-three'] = { ...state.pages.root, next: null };
  await click('Refresh pins'); await click('More pins'); await click('More pins'); await click('Previous pins');
  expect(state.calls.at(-1).url).toBe('/api/admin/session-pins?before=page-two');
});
