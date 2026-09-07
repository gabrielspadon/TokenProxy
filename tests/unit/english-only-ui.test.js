// @vitest-environment jsdom
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const requestBoundary = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('next/server', () => ({ connection: requestBoundary }));

vi.mock('@/lib/network/initOutboundProxy', () => ({}));
vi.mock('@/app/globals.css', () => ({}));
vi.mock('@/app/operator.css', () => ({}));
vi.mock('@/app/workspace.css', () => ({}));
vi.mock('@mantine/core/styles.layer.css', () => ({}));
vi.mock('@mantine/dates/styles.layer.css', () => ({}));
vi.mock('@mantine/notifications/styles.layer.css', () => ({}));
vi.mock('@/shared/services/bootstrap', () => ({}));
vi.mock('@/lib/consoleLogBuffer', () => ({ initConsoleLogCapture: vi.fn() }));
vi.mock('@/shared/workspace/UiProvider', () => ({ UiProvider: ({ children }) => children }));
vi.mock('@mantine/core', () => ({ ColorSchemeScript: () => null }));
vi.mock('@/shared/hooks/useSearch', () => ({ useSearch: () => '' }));

import RootLayout from '@/app/layout';
import LoginPage from '@/app/login/page';
import { fmtNum, fmtRelative } from '@/shared/format';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root;

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  root = null;
  document.cookie = 'locale=; Max-Age=0';
  document.documentElement.lang = 'en';
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  requestBoundary.mockReset();
});

describe('English-only interface', () => {
  it('waits for a request before producing the operator document', async () => {
    let acceptRequest;
    requestBoundary.mockImplementationOnce(() => new Promise(resolve => { acceptRequest = resolve; }));
    let rendered = false;
    const pending = RootLayout({ children: <main>Operator account</main> }).then(element => {
      rendered = true;
      return element;
    });
    await Promise.resolve();
    expect(requestBoundary).toHaveBeenCalledOnce();
    expect(rendered).toBe(false);
    acceptRequest();
    const html = renderToStaticMarkup(await pending);
    expect(html).toContain('lang="en"');
    expect(html).toContain('dir="ltr"');
    expect(html).toContain('Operator account');
  });

  it('keeps number and relative-time formatting English after an external language change', () => {
    document.documentElement.lang = 'ar';
    expect(fmtNum(1234.5)).toBe('1,234.5');
    expect(fmtRelative('2026-09-07T12:01:00Z', Date.parse('2026-09-07T12:00:00Z'))).toBe('in 1 min.');
  });

  it.each(['ar', 'fa', 'zh-CN', '%invalid'])('ignores a saved %s locale while retaining user text', async (locale) => {
    document.cookie = `locale=${locale}`;
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const userText = 'Pesquisa 中文 العربية <script>alert(1)</script>';
    const html = renderToStaticMarkup(await RootLayout({ children: <main><h1>Workspace preferences</h1><p>{userText}</p></main> }));
    const rendered = new DOMParser().parseFromString(html, 'text/html');
    expect(rendered.documentElement.lang).toBe('en');
    expect(rendered.documentElement.dir).toBe('ltr');
    expect(rendered.querySelector('h1').textContent).toBe('Workspace preferences');
    expect(rendered.querySelector('p').textContent).toBe(userText);
    expect(rendered.querySelector('p script')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('renders sign-in in English and preserves multilingual SSO labels without loading catalogs', async () => {
    document.cookie = 'locale=ar';
    const label = 'Entrar 中文 العربية';
    const fetch = vi.fn(async () => ({ json: async () => ({ hasPassword: true, oidcConfigured: true, oidcLoginLabel: label }) }));
    vi.stubGlobal('fetch', fetch);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<LoginPage />));
    expect(container.textContent).toContain('Sign in');
    expect(container.querySelector('a[href="/api/auth/oidc/start"]').textContent).toBe(label);
    expect(container.querySelector('select')).toBeNull();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/auth/status']);
  });

  it('does not ship the language selector, locale endpoint, translation runtime or catalogs', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    for (const path of [
      'src/i18n/runtime.js', 'src/i18n/server.js', 'src/i18n/config.js',
      'src/i18n/RuntimeI18nProvider.js', 'src/shared/components/LocaleSelect.js',
      'src/shared/constants/locales.js', 'src/app/api/locale/route.js',
      'public/i18n/literals/ar.json', 'public/i18n/literals/zh-CN.json',
    ]) expect(existsSync(resolve(repoRoot, path)), path).toBe(false);
  });
});
