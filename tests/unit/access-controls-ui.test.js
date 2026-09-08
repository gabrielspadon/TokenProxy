// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const fixture = vi.hoisted(() => ({ settings: {}, auth: {}, refresh: vi.fn() }));
vi.mock('@/shared/hooks/usePoll', () => ({ usePoll: url => ({ data: url === '/api/settings' ? fixture.settings : fixture.auth, refresh: fixture.refresh }) }));
const { default: AccessPage } = await import('@/app/dashboard/access/page.js');
let root, container, fetchMock, reply, readback, descriptors;
const writes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH');
const input = label => [...container.querySelectorAll('label')].find(el => el.firstElementChild?.textContent === label)?.querySelector('input');
const button = (text, scope = container) => [...scope.querySelectorAll('button')].find(el => el.textContent.trim() === text);
async function type(label, value) {
  const field = input(label);
  expect(field, label).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const render = () => act(async () => root.render(<AccessPage />));
const confirm = () => act(async () => container.querySelector('dialog[open] form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

beforeEach(async () => {
  fixture.settings = { samlEntryPoint: 'https://id.example/sso', samlIssuer: 'gateway', samlAttributeName: 'displayName', samlAttributeEmail: 'mail', samlLoginLabel: 'Research login', oidcIssuerUrl: 'https://id.example', oidcClientId: 'client', oidcScopes: 'openid', oidcLoginLabel: 'Sign in' };
  fixture.auth = { authMode: 'sso', ssoType: 'saml', requireLogin: true, hasPassword: true, authenticated: true };
  fixture.refresh.mockClear();
  reply = null;
  readback = null;
  fetchMock = vi.fn(async (url, init) => {
    expect(url).toBe('/api/settings');
    if (init?.method === 'PATCH') {
      if (reply) return reply();
      Object.assign(fixture.settings, JSON.parse(init.body));
      return Response.json({ success: true });
    }
    return readback ? readback() : Response.json(fixture.settings);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  descriptors = Object.fromEntries(['showModal', 'close'].map(key => [key, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, key)]));
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value() { this.setAttribute('open', ''); } },
    close: { configurable: true, value() { this.removeAttribute('open'); } },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await render();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  for (const [key, value] of Object.entries(descriptors)) {
    if (value) Object.defineProperty(HTMLDialogElement.prototype, key, value);
    else delete HTMLDialogElement.prototype[key];
  }
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it('edits SAML fields directly, preserves sibling values, reviews a frozen request and separately reads back', async () => {
  expect(input('Display-name attribute').closest('dialog')).toBeNull();
  expect(input('New password').closest('dialog')).toBeNull();
  await type('Display-name attribute', 'name');
  await act(async () => button('Review configuration').click());
  expect(writes()).toHaveLength(0);
  expect(container.querySelector('dialog[open] input')).toBeNull();
  fixture.settings.samlIssuer = 'externally changed';
  await render();
  await confirm();
  expect(JSON.parse(writes()[0][1].body)).toEqual({ samlEntryPoint: 'https://id.example/sso', samlIssuer: 'gateway', samlAttributeName: 'name', samlAttributeEmail: 'mail', samlLoginLabel: 'Research login' });
  expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(['PATCH', 'GET']);
  expect(container.textContent).toContain('saved and read back');
});

it('retains direct edits during polling and clears secrets when a review is cancelled', async () => {
  await type('Signing certificate', 'private-certificate');
  fixture.settings.samlAttributeEmail = 'changed-remotely';
  await render();
  expect(input('Email attribute').value).toBe('mail');
  await act(async () => button('Review configuration').click());
  expect(container.querySelector('dialog[open]').textContent).not.toContain('private-certificate');
  await act(async () => button('Cancel', container.querySelector('dialog[open]')).click());
  expect(input('Signing certificate').value).toBe('');
  expect(writes()).toHaveLength(0);
});

it('uses verified saved and cleared configuration as the direct form baseline without reviving old values', async () => {
  await type('Display-name attribute', 'name');
  await act(async () => button('Review configuration').click());
  await confirm();
  fixture.settings = { ...fixture.settings, samlLoginLabel: 'New server label' };
  await render();
  expect(input('Label on the sign-in action').value).toBe('New server label');
  await act(async () => button('Clear the configuration').click());
  await confirm();
  expect(input('Provider address').value).toBe('');
  await act(async () => button('Review configuration').click());
  await confirm();
  expect(JSON.parse(writes().at(-1)[1].body).samlEntryPoint).toBe('');
  expect(writes()).toHaveLength(3);
});

it('requires matching passwords and clears submitted secrets after a refusal without automatic retry', async () => {
  reply = () => Response.json({ error: 'Invalid current password' }, { status: 401 });
  await type('Current password', 'synthetic-old');
  await type('New password', 'synthetic-new');
  await type('New password again', 'different');
  expect(button('Change password').disabled).toBe(true);
  await type('New password again', 'synthetic-new');
  await act(async () => button('Change password').click());
  expect(writes()).toHaveLength(0);
  await confirm();
  expect(JSON.parse(writes()[0][1].body)).toEqual({ currentPassword: 'synthetic-old', newPassword: 'synthetic-new' });
  expect(input('New password').value).toBe('');
  expect(container.querySelector('dialog[open]').textContent).toContain('not the current password');
  expect(button('Change password', container.querySelector('dialog[open]')).disabled).toBe(true);
  await render();
  expect(writes()).toHaveLength(1);
});

it('keeps accepted configuration with missing readback uncertain and prevents an immediate repeat', async () => {
  readback = () => Response.json({ error: 'Unavailable' }, { status: 503 });
  await type('Display-name attribute', 'name');
  await act(async () => button('Review configuration').click());
  await confirm();
  expect(container.textContent).toContain('refreshed state was not verified');
  expect(button('Save configuration', container.querySelector('dialog[open]')).disabled).toBe(true);
  expect(writes()).toHaveLength(1);
  expect(fixture.refresh).not.toHaveBeenCalled();
});

it('invalidates a secret-bearing review when the document becomes hidden', async () => {
  await type('Signing certificate', 'private-certificate');
  await act(async () => button('Review configuration').click());
  const original = Object.getOwnPropertyDescriptor(document, 'hidden');
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(input('Signing certificate').value).toBe('');
  expect(button('Save configuration', container.querySelector('dialog[open]')).disabled).toBe(true);
  expect(writes()).toHaveLength(0);
  if (original) Object.defineProperty(document, 'hidden', original); else delete document.hidden;
});
