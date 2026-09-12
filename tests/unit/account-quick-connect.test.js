// @vitest-environment jsdom
// The branded quick-connection buttons on the account board.
//
// Capacity's only way to add an account was a generic "Add account" button
// opening a <Select> over every non-hidden provider. These three buttons open
// the SAME AddAccountRow already on one provider, so nothing about the grant,
// the paste-back fallback or the naming stage is reimplemented.
//
// Everything here is intercepted at @/shared/api and @/shared/oauthGrant: no
// OAuth window opens, no upstream is contacted, and no account is created.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ calls: [], grantsStarted: [] }));
vi.mock('@/shared/api', () => ({
  call: vi.fn(async (url) => {
    fixture.calls.push(url);
    if (url.includes('/authorize')) return { ok: true, body: { flowType: 'authorization_code' } };
    return { ok: true, body: {} };
  }),
}));
vi.mock('@/shared/oauthGrant', () => ({
  importPasted: vi.fn(),
  runGrant: vi.fn((provider) => {
    fixture.grantsStarted.push(provider);
    return new Promise(() => {});
  }),
}));
const { AddAccountRow } = await import('@/app/dashboard/AddAccountRow');

let root, container;
beforeEach(() => {
  fixture.calls = [];
  fixture.grantsStarted = [];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = () => {};
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = (element) =>
  act(async () => root.render(<MantineProvider env="test">{element}</MantineProvider>));
const submitButton = () => container.querySelector('form button[type="submit"]');

// The three ids the board offers, each a real registry entry with
// `category: 'oauth'`. A typo here would render a button whose provider does
// not exist, which is exactly the "invented provider" the brief forbids.
for (const [id, label] of [['codex', 'Codex'], ['claude', 'Claude Code'], ['kimi', 'Kimi']]) {
  it(`opens the shipped sign-in flow already on ${label}`, async () => {
    await render(<AddAccountRow provider={id} />);
    // It probed THAT provider's authorize route, which is how the row learns
    // the flow type. A preselection that skipped this would leave the row
    // unable to start a grant at all.
    expect(fixture.calls.some((url) => url.startsWith(`/api/oauth/${id}/authorize`))).toBe(true);
    // Already on the OAuth path: no provider picker step, and the action word
    // is the sign-in one rather than "Add".
    expect(submitButton().textContent).toContain('Sign in');
    expect(submitButton().disabled).toBe(false);
  });
}

it('starts the grant for the preselected provider and no other', async () => {
  await render(<AddAccountRow provider="claude" />);
  await act(async () => {
    container
      .querySelector('form')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(fixture.grantsStarted).toEqual(['claude']);
});

it('still offers the full picker when no provider is preselected', async () => {
  await render(<AddAccountRow />);
  expect(container.querySelector('[aria-label="Provider"]')).not.toBeNull();
  // Nothing is probed until something is chosen, so the generic path is
  // unchanged by the preselection feature.
  expect(fixture.calls).toEqual([]);
  expect(submitButton().disabled).toBe(true);
});

it('names the account panel for screen readers and keeps its cancel control', async () => {
  await render(<AddAccountRow provider="kimi" />);
  expect(container.querySelector('form').getAttribute('aria-label')).toBe('Add account');
  expect(
    container.querySelector('[aria-label="Cancel adding an account"]')
  ).not.toBeNull();
});
