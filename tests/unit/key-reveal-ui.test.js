// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';

// The Keys board edits in place: every control saves from its own field, a
// destructive or shown-once act confirms beside itself, and nothing here opens
// a dialog. These tests hold that contract, not the layout.
const fixture = vi.hoisted(() => ({
  calls: [],
  response: null,
  refresh: vi.fn(),
  keyName: 'Workstation',
}));
vi.mock('@/shared/hooks/usePoll', () => ({
  usePoll: (url) => ({
    loading: false,
    goodAt: 1,
    refresh: fixture.refresh,
    data:
      url === '/api/keys'
        ? {
            keys: [
              {
                id: 'fixture-key',
                name: fixture.keyName,
                keyPreview: '••••last',
                secretRedacted: true,
                isActive: true,
                usage: {},
                machineId: 'fixture',
                allowedModels: null,
              },
            ],
          }
        : url === '/api/settings'
          ? { requireApiKey: true, requireLogin: true }
          : { devices: [], windowMinutes: 30 },
  }),
}));
vi.mock('@/store/authStatus', () => ({
  useAuthStatus: (selector) =>
    selector({ status: { authenticated: true, displayName: 'Operator' } }),
}));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));
vi.mock('@/shared/api', () => ({
  call: vi.fn(async (url, options) => {
    fixture.calls.push({ url, ...options });
    return fixture.response;
  }),
}));
const { default: KeysPage } = await import('../../src/app/dashboard/keys/page.js');
const secret = 'sk-fixture-deliberately-revealed-secret';
let container, root;

const buttons = () => [...container.querySelectorAll('button')];
const byLabel = (label) => buttons().find((node) => node.getAttribute('aria-label') === label);
// An icon control renders its glyph as text, so match the tail of the label.
const byText = (text) => buttons().find((node) => node.textContent.trim().endsWith(text));
const field = (label) => container.querySelector(`[aria-label="${label}"]`);

async function render() {
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <KeysPage />
      </MantineProvider>
    )
  );
}
async function click(node) {
  await act(async () => node.click());
}
// Arm the pair, then confirm it. Two deliberate steps, both inline.
async function confirm(label) {
  await click(byText(label));
  await click(byLabel(`Confirm ${label.toLowerCase()}`));
}
async function edit(node, value) {
  await act(async () => {
    const prototype =
      node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value);
    node.dispatchEvent(
      new Event(node instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })
    );
  });
}

beforeEach(async () => {
  fixture.calls = [];
  fixture.keyName = 'Workstation';
  fixture.response = { ok: true, body: { id: 'fixture-key', key: secret, name: 'Workstation' } };
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
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await render();
  await click(byLabel('Configure Workstation'));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

it('expands one key in place and never opens a dialog', async () => {
  expect(container.querySelector('dialog')).toBeNull();
  expect(container.querySelector('[data-account-id="fixture-key"][data-expanded]')).toBeTruthy();
  await click(byLabel('Collapse Workstation'));
  expect(container.querySelector('[data-account-id="fixture-key"][data-expanded]')).toBeNull();
  expect(fixture.calls).toHaveLength(0);
});

it('reveals one key only after an explicit inline confirmation, then clears it', async () => {
  expect(container.textContent).toContain('••••last');
  expect(container.textContent).not.toContain(secret);
  await click(byText('Reveal key'));
  expect(fixture.calls).toHaveLength(0);
  await click(byLabel('Confirm reveal key'));
  expect(fixture.calls).toEqual([{ url: '/api/keys/fixture-key/reveal', method: 'POST' }]);
  expect(container.querySelector('.keys-secret').value).toBe(secret);
  expect(container.querySelector('dialog')).toBeNull();
  await click(byText('Done'));
  expect(container.textContent).not.toContain(secret);
  expect(container.querySelector('.keys-secret')).toBeNull();
});

it('does not put a delayed reveal on screen after the tab was left', async () => {
  let resolve;
  fixture.response = new Promise((done) => {
    resolve = done;
  });
  await confirm('Reveal key');
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => resolve({ ok: true, body: { key: secret } }));
  expect(container.textContent).not.toContain(secret);
  expect(container.querySelector('.keys-secret')).toBeNull();
});

it('clears a revealed credential when the tab becomes hidden', async () => {
  await confirm('Reveal key');
  expect(container.querySelector('.keys-secret').value).toBe(secret);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(container.textContent).not.toContain(secret);
  expect(container.querySelector('.keys-secret')).toBeNull();
});

it('shows a refused reveal as its own sentence without producing a credential', async () => {
  fixture.response = {
    ok: false,
    status: 403,
    body: { code: 'forbidden_class', source: 'tokenproxy-admin', error: 'Operator credential required' },
  };
  await confirm('Reveal key');
  expect(container.textContent).not.toContain(secret);
  expect(container.textContent).toContain('An inference API key does not satisfy this endpoint.');
});

it('saves the protection policy from its own field, sending only that field', async () => {
  fixture.response = { ok: true, body: {} };
  const select = field('Budget protection for Workstation');
  expect(select.value).toBe('reserve-remaining');
  await edit(select, 'strict');
  expect(fixture.calls[0]).toEqual({
    url: '/api/keys/fixture-key',
    method: 'PUT',
    body: { budgetPolicy: 'strict' },
  });
  expect(fixture.refresh).toHaveBeenCalled();
});

it('keeps a refused save visible beside the field it came from', async () => {
  fixture.response = { ok: false, status: 503, body: { error: 'Storage unavailable' } };
  await edit(field('Budget protection for Workstation'), 'strict');
  expect(container.textContent).toContain('Storage unavailable');
  expect(container.querySelector('dialog')).toBeNull();
});

it('selects a key through its enclosing label without configuring or mutating it', async () => {
  // The pick checkbox only exists on the Advanced row board.
  window.localStorage.setItem('tokenproxy.navigation-mode', JSON.stringify('advanced'));
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  const checkbox = container.querySelector(
    'input[type="checkbox"][aria-label="Select Workstation"]'
  );
  expect(checkbox.checked).toBe(false);
  await click(checkbox);
  expect(container.querySelector('input[aria-label="Select Workstation"]').checked).toBe(true);
  expect(fixture.calls).toHaveLength(0);
  window.localStorage.removeItem('tokenproxy.navigation-mode');
});

it('creates a key from the inline row and shows its value once', async () => {
  fixture.response = { ok: true, body: { id: 'key-2', key: secret, name: 'Travel laptop' } };
  await click(buttons().find((node) => node.textContent.trim().endsWith('Create a key')));
  await edit(field('New key name'), 'Travel laptop');
  await edit(field('New key cost ceiling'), '12');
  await click(byText('Create'));
  expect(fixture.calls).toEqual([
    {
      url: '/api/keys',
      method: 'POST',
      body: {
        name: 'Travel laptop',
        expiresAt: null,
        maxPromptTokens: null,
        maxCompletionTokens: null,
        maxCostUsd: 12,
        allowedModels: null,
        budgetPolicy: 'strict',
      },
    },
  ]);
  expect(container.querySelector('.keys-secret').value).toBe(secret);
  expect(container.querySelector('dialog')).toBeNull();
});
