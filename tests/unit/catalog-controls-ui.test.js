// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ call: vi.fn(), refresh: vi.fn(), data: {} }));
vi.mock('@/shared/api', () => ({ call: state.call }));
vi.mock('@/shared/hooks/usePoll', () => ({ usePoll: url => ({ data: state.data[url], refresh: state.refresh, loading: false }) }));
import { CatalogControls } from '@/app/dashboard/models/page';

let root, container;
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request'); }));
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  state.data = {
    '/api/models': { models: [{ fullModel: 'p/model', model: 'model', provider: 'p', alias: 'short' }] },
    '/api/models/custom': { models: [] },
    '/api/combos': { combos: [] },
    '/api/settings': { comboStrategy: 'round-robin', comboStickyRoundRobinLimit: 4, capacityAdapter: {
      vision: { enabled: false, roundRobin: false, models: ['p/vision'] },
      pdf: { enabled: true, roundRobin: true, models: ['p/pdf'] },
      audioInput: { enabled: false, roundRobin: false, models: [] },
      videoInput: { enabled: true, roundRobin: false, models: ['p/video'] },
    } },
  };
  state.call.mockReset().mockResolvedValue({ ok: true, status: 200, body: {} });
  state.refresh.mockReset();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<CatalogControls />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const button = (text, scope = container) => [...scope.querySelectorAll('button')].find(element => {
  const label = element.cloneNode(true);
  label.querySelectorAll('[aria-hidden="true"]').forEach(icon => icon.remove());
  return label.textContent.trim() === text;
});
const input = label => [...container.querySelectorAll('label')].find(element => element.querySelector('span')?.textContent === label)?.querySelector('input, select');
async function click(text, scope) { await act(async () => button(text, scope).click()); }
async function fill(label, value) {
  const element = input(label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}
async function submit() {
  await act(async () => container.querySelector('dialog form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}

it('edits an alias on the page, retains cancelled review and sends only the reviewed value', async () => {
  await click('Set alias');
  expect(container.querySelector('dialog').open).toBe(false);
  expect(input('Alias').closest('dialog')).toBeNull();
  expect(document.activeElement).toBe(input('Alias'));
  await fill('Alias', 'intended'); await click('Review change');
  const dialog = container.querySelector('dialog');
  expect(dialog.open).toBe(true);
  expect(dialog.querySelector('input, select, textarea')).toBeNull();
  expect(dialog.textContent).toContain('intended');
  expect(state.call).not.toHaveBeenCalled();
  await click('Cancel', dialog);
  expect(input('Alias').value).toBe('intended');
  await fill('Alias', 'revised'); await click('Review change'); await submit();
  expect(state.call).toHaveBeenCalledExactlyOnceWith('/api/models/alias', { method: 'PUT', body: { model: 'p/model', alias: 'revised' } });
  expect(state.refresh).toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps custom registration fields in its working section before final confirmation', async () => {
  await click('Register a model');
  await fill('Provider', 'p'); await fill('Model id', 'new'); await fill('Context window', '128000');
  expect(input('Model id').closest('section[aria-labelledby="h-custom"]')).not.toBeNull();
  expect(container.querySelector('dialog').open).toBe(false);
  await click('Review change');
  expect(container.querySelector('dialog').textContent).toContain('128000');
  expect(state.call).not.toHaveBeenCalled();
  await submit();
  expect(state.call).toHaveBeenCalledExactlyOnceWith('/api/models/custom', { method: 'POST', body: { providerAlias: 'p', id: 'new', name: undefined, vision: false, maxInputTokens: 128000, maxOutputTokens: undefined } });
});

it.each(['-1', '1.5'])('refuses invalid token limit %s before opening a registration review', async value => {
  await click('Register a model');
  await fill('Provider', 'p'); await fill('Model id', 'new'); await fill('Context window', value);
  await click('Review change');
  expect(input('Context window').validity.valid).toBe(false);
  expect(container.querySelector('dialog').open).toBe(false);
  expect(state.call).not.toHaveBeenCalled();
});

it('preserves the visible saved strategy when only its sticky limit is edited', async () => {
  await fill('Sticky round-robin limit', '7'); await click('Save defaults');
  expect(container.querySelector('dialog').textContent).toContain('round-robin');
  await submit();
  expect(state.call).toHaveBeenCalledExactlyOnceWith('/api/settings', { method: 'PATCH', body: { comboStrategy: 'round-robin', comboStickyRoundRobinLimit: 7 } });
});

it('reviews a capability edit and preserves every sibling capability in the full settings object', async () => {
  const adapter = state.data['/api/settings'].capacityAdapter;
  const row = container.querySelector('section[aria-labelledby="h-decisions"] .rows .row');
  await act(async () => row.querySelector('input[type="checkbox"]').click());
  await click('Save', row);
  expect(state.call).not.toHaveBeenCalled();
  expect(container.querySelector('dialog').textContent).toContain('p/vision');
  await submit();
  expect(state.call).toHaveBeenCalledExactlyOnceWith('/api/settings', { method: 'PATCH', body: { capacityAdapter: { ...adapter, vision: { ...adapter.vision, enabled: true } } } });
});
