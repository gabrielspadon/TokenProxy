// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import AccessPage from '../../src/app/dashboard/access/page.js';
import SystemPage from '../../src/app/dashboard/system/page.js';

let container, root, auth, probe, version, requests;
const settings = { authMode: 'oidc', oidcIssuerUrl: 'https://identity.example', oidcClientId: 'test-client', oidcScopes: 'openid', requireLogin: true };
const versionOk = { currentVersion: '1.0.0', latestVersion: '1.0.1', hasUpdate: true, isTrayMode: false, buildSha: null };
const json = (body, status = 200) => Response.json(body, { status });
async function mount(component) { await act(async () => root.render(<MantineProvider env="test">{component}</MantineProvider>)); }
async function click(text) {
  const button = [...container.querySelectorAll('button')].find(e => e.textContent.trim() === text);
  expect(button, `Missing button ${text}`).toBeDefined();
  await act(async () => button.click());
}
// Access is a board: a method's controls live in its own card, which opens in
// place rather than in a layer.
async function expand(name) {
  const caret = [...container.querySelectorAll('button')].find(e => e.getAttribute('aria-label') === `Expand ${name}`);
  expect(caret, `Missing caret for ${name}`).toBeDefined();
  await act(async () => caret.click());
}
// A System reading is one row of the control panel; its text is what it says.
function row(id) { return container.querySelector(`[data-row="${id}"]`)?.textContent; }
function probeNotice() { return [...container.querySelectorAll('.notice')].at(-1); }

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  requests = [];
  auth = { authenticated: true, requireLogin: true, authMode: 'oidc', ssoType: 'oidc', hasPassword: false, passwordSource: 'environment', oidcConfigured: true, samlConfigured: false, displayName: 'Test operator', loginMethod: 'Password' };
  probe = { ok: true, discoveryOk: true, clientSecretTested: true, clientSecretValid: true, message: 'Client secret was accepted by the token endpoint.' };
  version = () => json(versionOk);
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET', body: options.body });
    if (url === '/api/auth/status') return json(auth);
    if (url === '/api/settings') return json(settings);
    if (url === '/api/auth/oidc/test' || url === '/api/auth/saml/test') return json(probe);
    if (url === '/api/version') return version();
    if (url === '/api/admin/health') return json({ uptimeSeconds: 10, generatedAt: '2026-09-06T00:00:00Z' });
    if (url === '/api/admin/health/detail') return json({ status: 'ok', checks: { database: { driver: 'sqlite', latencyMs: 1 }, connections: [] } });
    if (url === '/api/settings/require-login') return json({ requireLogin: true });
    if (url === '/api/changelog') return new Response('A recorded change.');
    throw new Error(`Unexpected offline fixture request ${url}`);
  }));
  container = document.createElement('div');document.body.appendChild(container);root = createRoot(container);
});
afterEach(() => { act(() => root.unmount());container.remove();vi.unstubAllGlobals(); });

describe('Access uses the configuration check verdict and states its scope', () => {
  it('renders HTTP 200 with ok=false as a rejection and preserves the provider reason', async () => {
    probe = { ok: false, discoveryOk: true, clientSecretTested: true, clientSecretValid: false, error: 'Discovery loaded, but the client secret is not valid.' };
    await mount(<AccessPage />);await expand('OIDC');await click('Test without saving');
    expect(probeNotice().dataset.tone).toBe('bad');
    expect(probeNotice().textContent).toContain(probe.error);
    expect(probeNotice().textContent).not.toContain('accepted this configuration');
    expect(requests.filter(r => r.method !== 'GET')).toEqual([{ url: '/api/auth/oidc/test', method: 'POST', body: '{}' }]);
  });
  it.each([false, true])('does not infer acceptance when client-secret validity is unknown (tested=%s)', async tested => {
    probe = { ok: true, discoveryOk: true, clientSecretTested: tested, clientSecretValid: null, message: 'Client secret validity was not established.' };
    await mount(<AccessPage />);await expand('OIDC');await click('Test without saving');
    expect(probeNotice().dataset.tone).toBe('warn');
    expect(probeNotice().textContent).toMatch(/not verified/i);
  });
  it('limits a positive OIDC result to discovery and the credential check, without claiming sign-in', async () => {
    await mount(<AccessPage />);await expand('OIDC');await click('Test without saving');
    expect(probeNotice().dataset.tone).toBe('ok');
    expect(probeNotice().textContent).toMatch(/discovery/i);
    expect(probeNotice().textContent).toMatch(/sign-in.*not tested/i);
  });
  it.each([null, {}, { ok: true }, { ok: 'true', discoveryOk: true }])('does not show success for incomplete or malformed application evidence %j', async body => {
    probe = body;await mount(<AccessPage />);await expand('OIDC');await click('Test without saving');
    expect(probeNotice().dataset.tone).not.toBe('ok');
  });
  it('identifies SAML success as a local format check without claiming provider acceptance', async () => {
    auth = { ...auth, authMode: 'saml', ssoType: 'saml', samlConfigured: true };
    probe = { ok: true, certValid: true, message: 'SAML 2.0 configuration verified successfully.' };
    await mount(<AccessPage />);await expand('SAML');await click('Test without saving');
    expect(probeNotice().dataset.tone).toBe('ok');
    expect(probeNotice().textContent).toMatch(/local.*format/i);
    expect(probeNotice().textContent).toMatch(/provider.*not contacted/i);
    expect(container.textContent).not.toContain('A test contacts the provider');
  });
  it.each(['environment', null, undefined])('does not diagnose a public default password from an absent stored hash (%s)', async source => {
    auth = { ...auth, authMode: 'password', passwordSource: source };await mount(<AccessPage />);
    expect(container.textContent).not.toContain('This installation is still on its default password.');
  });
  it('still warns when the effective password source is the built-in default', async () => {
    auth = { ...auth, passwordSource: 'default' };await mount(<AccessPage />);
    expect(container.textContent).toContain('This installation is still on its default password.');
  });
});

describe('System version read failures', () => {
  it('ends all loading placeholders after HTTP 500, shows the reason, and retries only the version read', async () => {
    version = () => json({ message: 'Version lookup unavailable in this runtime.' }, 500);await mount(<SystemPage />);
    for (const id of ['version', 'update']) expect(row(id)).toContain('Not reported');
    expect(row('version')).not.toContain('Tray mode');
    expect(container.textContent).toContain('Version lookup unavailable in this runtime.');
    version = () => json(versionOk);await click('Retry version read');
    expect(row('version')).toContain('1.0.0');expect(row('update')).toContain('Version 1.0.1 is published');expect(row('update')).toContain('Newer version');
    expect(requests.filter(r => r.method !== 'GET')).toEqual([]);expect(requests.filter(r => r.url === '/api/version')).toHaveLength(2);
  });
  it('ends loading and exposes a retry after an interrupted version read', async () => {
    version = () => Promise.reject(new Error('connection ended'));await mount(<SystemPage />);
    expect(row('version')).not.toContain('Reading');
    expect(container.textContent).toContain('Version information could not be read.');
    expect(container.textContent).toContain('Process health is reported separately below.');
    expect([...container.querySelectorAll('button')].some(e => e.textContent === 'Retry version read')).toBe(true);
  });
});
