// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';

const fixture = vi.hoisted(() => ({ settings: {}, auth: {}, authError: null, refresh: vi.fn() }));
vi.mock('@/shared/hooks/usePoll', () => ({
  usePoll: (url) => ({
    data: url === '/api/settings' ? fixture.settings : fixture.auth,
    error: url === '/api/auth/status' ? fixture.authError : null,
    status: url === '/api/auth/status' && fixture.authError ? 401 : 200,
    refresh: fixture.refresh,
  }),
}));
const { default: AccessPage } = await import('@/app/dashboard/access/page.js');
let root, container, fetchMock, reply, readback;
const writes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH');
// Access is a board. A method's settings live in its own card, which opens in
// place; a Mantine field binds its label to the input by id.
const input = (label) => {
  const node = [...container.querySelectorAll('label')].find(
    (el) => el.textContent.trim() === label
  );
  if (!node) return undefined;
  return node.htmlFor ? document.getElementById(node.htmlFor) : node.querySelector('input');
};
const button = (text, scope = container) =>
  [...scope.querySelectorAll('button')].find((el) => el.textContent.trim() === text);
const card = (id) => container.querySelector(`[data-account-id="${id}"]`);
const ask = (title) => container.querySelector(`[role="group"][aria-label="${title}"]`);
const expand = (name) =>
  act(async () =>
    [...container.querySelectorAll('button')]
      .find((el) => el.getAttribute('aria-label') === `Expand ${name}`)
      .click()
  );
const confirm = (title, verb) => act(async () => button(verb, ask(title)).click());
async function type(label, value) {
  const field = input(label);
  expect(field, label).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const render = () =>
  act(async () =>
    root.render(
      <MantineProvider env="test">
        <AccessPage />
      </MantineProvider>
    )
  );

beforeEach(async () => {
  fixture.settings = {
    samlEntryPoint: 'https://id.example/sso',
    samlIssuer: 'gateway',
    samlAttributeName: 'displayName',
    samlAttributeEmail: 'mail',
    samlLoginLabel: 'Research login',
    oidcIssuerUrl: 'https://id.example',
    oidcClientId: 'client',
    oidcScopes: 'openid',
    oidcLoginLabel: 'Sign in',
  };
  fixture.auth = {
    authMode: 'sso',
    ssoType: 'saml',
    requireLogin: true,
    hasPassword: true,
    authenticated: true,
  };
  fixture.authError = null;
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
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  // The board toolbar carries a SegmentedControl, which measures itself.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await render();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('edits SAML fields directly, preserves sibling values, reviews a frozen request and separately reads back', async () => {
  await expand('SAML');
  expect(container.querySelector('dialog')).toBeNull();
  expect(input('Display-name attribute').closest('[hidden]')).toBeNull();
  await type('Display-name attribute', 'name');
  await act(async () => button('Review configuration').click());
  expect(writes()).toHaveLength(0);
  expect(ask('Configure single sign-on').querySelector('input')).toBeNull();
  fixture.settings.samlIssuer = 'externally changed';
  await render();
  await confirm('Configure single sign-on', 'Save configuration');
  expect(JSON.parse(writes()[0][1].body)).toEqual({
    samlEntryPoint: 'https://id.example/sso',
    samlIssuer: 'gateway',
    samlAttributeName: 'name',
    samlAttributeEmail: 'mail',
    samlLoginLabel: 'Research login',
  });
  expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(['PATCH', 'GET']);
  expect(container.textContent).toContain('saved and read back');
});

it('retains direct edits during polling and clears secrets when a review is cancelled', async () => {
  await expand('SAML');
  await type('Signing certificate', 'private-certificate');
  fixture.settings.samlAttributeEmail = 'changed-remotely';
  await render();
  expect(input('Email attribute').value).toBe('mail');
  await act(async () => button('Review configuration').click());
  expect(ask('Configure single sign-on').textContent).not.toContain('private-certificate');
  await act(async () => button('Cancel', ask('Configure single sign-on')).click());
  expect(input('Signing certificate').value).toBe('');
  expect(writes()).toHaveLength(0);
});

it('uses verified saved and cleared configuration as the direct form baseline without reviving old values', async () => {
  await expand('SAML');
  await type('Display-name attribute', 'name');
  await act(async () => button('Review configuration').click());
  await confirm('Configure single sign-on', 'Save configuration');
  fixture.settings = { ...fixture.settings, samlLoginLabel: 'New server label' };
  await render();
  expect(input('Label on the sign-in action').value).toBe('New server label');
  await act(async () => button('Clear the configuration').click());
  await confirm('Clear the configuration', 'Clear the configuration');
  expect(input('Provider address').value).toBe('');
  await act(async () => button('Review configuration').click());
  await confirm('Configure single sign-on', 'Save configuration');
  expect(JSON.parse(writes().at(-1)[1].body).samlEntryPoint).toBe('');
  expect(writes()).toHaveLength(3);
});

it('requires matching passwords and clears submitted secrets after a refusal without automatic retry', async () => {
  reply = () => Response.json({ error: 'Invalid current password' }, { status: 401 });
  await expand('Password');
  await type('Current password', 'synthetic-old');
  await type('New password', 'synthetic-new');
  await type('New password again', 'different');
  expect(button('Change password', card('password')).disabled).toBe(true);
  await type('New password again', 'synthetic-new');
  await act(async () => button('Change password', card('password')).click());
  expect(writes()).toHaveLength(0);
  await confirm('Change password', 'Change password');
  expect(JSON.parse(writes()[0][1].body)).toEqual({
    currentPassword: 'synthetic-old',
    newPassword: 'synthetic-new',
  });
  expect(input('New password').value).toBe('');
  expect(ask('Change password').textContent).toContain('not the current password');
  expect(button('Change password', ask('Change password')).disabled).toBe(true);
  await render();
  expect(writes()).toHaveLength(1);
});

it('keeps accepted configuration with missing readback uncertain and prevents an immediate repeat', async () => {
  await expand('SAML');
  readback = () => Response.json({ error: 'Unavailable' }, { status: 503 });
  await type('Display-name attribute', 'name');
  await act(async () => button('Review configuration').click());
  await confirm('Configure single sign-on', 'Save configuration');
  expect(container.textContent).toContain('refreshed state was not verified');
  expect(button('Save configuration', ask('Configure single sign-on')).disabled).toBe(true);
  expect(writes()).toHaveLength(1);
  expect(fixture.refresh).not.toHaveBeenCalled();
});

it('invalidates a secret-bearing review when the document becomes hidden', async () => {
  await expand('SAML');
  await type('Signing certificate', 'private-certificate');
  await act(async () => button('Review configuration').click());
  const original = Object.getOwnPropertyDescriptor(document, 'hidden');
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(input('Signing certificate').value).toBe('');
  expect(button('Save configuration', ask('Configure single sign-on')).disabled).toBe(true);
  expect(writes()).toHaveLength(0);
  if (original) Object.defineProperty(document, 'hidden', original);
  else delete document.hidden;
});

it('keeps a failed sign-in status visible and retryable while editing single sign-on', async () => {
  await expand('SAML');
  await type('Display-name attribute', 'retained-name');
  fixture.authError = { error: 'Session expired' };
  await render();
  const retry = button('Retry sign-in status');
  expect(retry.closest('[hidden]')).toBeNull();
  expect(retry.parentElement.textContent).toContain('Your session has ended.');
  expect(input('Display-name attribute').value).toBe('retained-name');
  await act(async () => retry.click());
  expect(fixture.refresh).toHaveBeenCalledTimes(1);
  expect(writes()).toHaveLength(0);
});
