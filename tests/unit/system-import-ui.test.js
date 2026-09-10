// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { MantineProvider } from '@mantine/core';
import { createRoot } from 'react-dom/client';

const fixture = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('@/shared/hooks/usePoll', () => ({
  usePoll: url => ({
    data: url === '/api/settings/require-login' ? { requireLogin: true } : null,
    loading: false,
    status: url === '/api/settings/require-login' ? 200 : 503,
    error: url === '/api/settings/require-login' ? null : { error: 'Synthetic observation unavailable' },
    refresh: () => fixture.refresh(url),
  }),
}));

const { default: SystemPage } = await import('@/app/dashboard/system/page.js');
const endpoint = '/api/settings/database';
const backup = { settings: { requireLogin: true }, providerConnections: [], apiKeys: [] };
const partial = {
  success: true,
  outcome: 'partial',
  completion: { databaseImported: true, outboundProxyEnvironment: 'failed' },
  message: 'The database import completed, but the process proxy environment could not be refreshed. Read the restored configuration before taking another action. Do not automatically repeat the import.',
};
let root, container, fetchMock, importResponse, dialogDescriptors;

beforeEach(async () => {
  fixture.refresh.mockClear();
  importResponse = async () => Response.json(partial, { status: 207 });
  fetchMock = vi.fn(async (url, options) => {
    if (url === '/api/changelog') return new Response('', { status: 200 });
    if (url === endpoint && options?.method === 'POST') return importResponse();
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // The board toolbar carries a SegmentedControl, which measures itself.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  dialogDescriptors = Object.fromEntries(['showModal', 'close'].map(method => [method, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, method)]));
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value() { this.setAttribute('open', ''); } },
    close: { configurable: true, value() { this.removeAttribute('open'); } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<MantineProvider env="test"><SystemPage /></MantineProvider>));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  for (const [method, descriptor] of Object.entries(dialogDescriptors || {})) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, method, descriptor);
    else delete HTMLDialogElement.prototype[method];
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const importCalls = () => fetchMock.mock.calls.filter(([url, options]) => url === endpoint && options?.method === 'POST');
// Import is one row of the System control panel; its confirmation opens under
// that row rather than in a dialog over the page.
const databaseSection = () => container.querySelector('[data-setting="import"]');
const asking = () => databaseSection().querySelector('form[aria-label="Import configuration"]');
const receipt = () =>
  [...databaseSection().querySelectorAll('.notice')].find(node =>
    /Database imported|returned successfully/.test(node.textContent)
  );

async function submitBackup() {
  const file = new File([JSON.stringify(backup)], 'synthetic-backup.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => JSON.stringify(backup) });
  const upload = databaseSection().querySelector('input[type="file"]');
  Object.defineProperty(upload, 'files', { configurable: true, value: [file] });
  await act(async () => upload.dispatchEvent(new Event('change', { bubbles: true })));
  expect(importCalls()).toHaveLength(0);
  await act(async () => [...databaseSection().querySelectorAll('button')].find(node => node.textContent.trim() === 'Import configuration').click());
  const ask = asking();
  expect(ask.querySelector('input[type="file"]')).toBeNull();
  expect(ask.textContent).toContain('synthetic-backup.json');
  await act(async () => {
    const password = ask.querySelector('input[type="password"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(password, 'synthetic-password');
    password.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => ask.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  return ask;
}

it.each([true, false])('keeps a committed import with failed process refresh as a warning, with route message %s', async withMessage => {
  const body = { ...partial };
  if (!withMessage) delete body.message;
  importResponse = async () => Response.json(body, { status: 207 });
  await submitBackup();

  const notice = receipt();
  expect(notice.dataset.tone).toBe('warn');
  expect(notice.textContent).toContain('Database imported; runtime refresh incomplete.');
  expect(notice.textContent).toContain('Do not automatically repeat the import.');
  expect(notice.textContent).not.toContain('returned successfully');
  expect(asking()).toBeNull();
  expect(fixture.refresh.mock.calls).toEqual([['/api/admin/health/detail'], ['/api/settings']]);
  expect(importCalls()).toHaveLength(1);
  expect(JSON.parse(importCalls()[0][1].body)).toEqual({ ...backup, password: 'synthetic-password' });
  expect([...container.querySelectorAll('input[type="password"]')].every(input => input.value === '')).toBe(true);

  await act(async () => root.render(<MantineProvider env="test"><SystemPage /></MantineProvider>));
  expect(importCalls()).toHaveLength(1);
  expect(receipt().dataset.tone).toBe('warn');
  expect(container.textContent).toContain('Synthetic observation unavailable');
  expect(container.textContent).not.toContain('Up to date');
});

it('keeps a lost import response uncertain without claiming commit or automatically resubmitting', async () => {
  importResponse = async () => { throw new TypeError('Synthetic response lost'); };
  const ask = await submitBackup();
  const notice = ask.querySelector('.notice');
  expect(asking()).not.toBeNull();
  expect(notice.textContent).toContain('The gateway did not answer.');
  expect(notice.textContent).not.toContain('Nothing was changed');
  expect(receipt()).toBeUndefined();
  expect(fixture.refresh).not.toHaveBeenCalled();
  await act(async () => root.render(<MantineProvider env="test"><SystemPage /></MantineProvider>));
  expect(importCalls()).toHaveLength(1);
  expect(container.textContent).not.toContain('Database imported; runtime refresh incomplete.');
  expect(container.textContent).not.toContain('The database import returned successfully.');
});

it('keeps password refusal distinct from a committed partial import', async () => {
  importResponse = async () => Response.json({ error: 'Invalid password' }, { status: 401 });
  const ask = await submitBackup();
  const notice = ask.querySelector('.notice');
  expect(notice.dataset.tone).toBe('warn');
  expect(notice.textContent).toContain('That password is not right.');
  expect(notice.textContent).toContain('Nothing was changed.');
  expect(receipt()).toBeUndefined();
  expect(fixture.refresh).not.toHaveBeenCalled();
  expect(importCalls()).toHaveLength(1);
});
