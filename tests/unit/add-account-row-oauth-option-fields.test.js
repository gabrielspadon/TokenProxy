// @vitest-environment jsdom
/**
 * A provider that declares optional tuning fields must still be addable by sign-in.
 *
 * accountOptionFields() always appends refreshLeadMs and customHeaders, so its length
 * is 2 for a provider that declares nothing and 3+ for one that declares anything at
 * all. AddAccountRow used that length as a proxy for "this provider needs settings the
 * row cannot collect" — but an OAuth sign-in collects nothing here, the provider's own
 * window does. codex declares workspaceId and chatgptAccountId as post-hoc tuning,
 * scored 4, and the row rendered "needs extra settings" with no Sign in button, so a
 * second Codex account could not be started from the board at all.
 *
 * The three cases below pin the distinction: codex signs in from the row, a provider
 * with no option fields is unaffected, and an API key provider that genuinely needs an
 * endpoint or a workspace field is still sent to Connections.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/shared/api', () => ({
  call: vi.fn(async () => ({
    ok: true,
    body: { flowType: 'authorization_code_pkce', fixedPort: 1455 },
  })),
}));
vi.mock('@/shared/oauthGrant', () => ({
  importPasted: vi.fn(),
  runGrant: vi.fn(async () => ({ ok: true, connection: { id: 'new-codex-row' } })),
}));
const { AddAccountRow } = await import('@/app/dashboard/AddAccountRow');

let root, container;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
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

const text = () => container.querySelector('form').textContent;
const submitButton = () => container.querySelector('form button[type="submit"]');

async function choose(id) {
  await act(async () => container.querySelector('[aria-label="Provider"]').click());
  const option = [...document.querySelectorAll('[role="option"]')].find(
    (node) => (node.getAttribute('value') || node.dataset.value) === id
  );
  await act(async () => option.click());
}

it('offers sign-in for codex, which declares optional workspace fields', async () => {
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <AddAccountRow />
      </MantineProvider>
    )
  );
  await choose('codex');

  // The defect: "needs extra settings" replaced the sign-in control entirely, so a
  // second Codex account had no way to be started from this row.
  expect(text()).not.toContain('needs extra settings');
  // The label carries its icon glyph as text, so match the word rather than the node.
  expect(submitButton().textContent).toContain('Sign in');
  expect(submitButton().disabled).toBe(false);
});

it('still offers sign-in for an OAuth provider that declares no option fields', async () => {
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <AddAccountRow />
      </MantineProvider>
    )
  );
  await choose('claude');

  expect(text()).not.toContain('needs extra settings');
  // The label carries its icon glyph as text, so match the word rather than the node.
  expect(submitButton().textContent).toContain('Sign in');
});

it('still sends an API key provider that needs endpoint fields to Connections', async () => {
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <AddAccountRow />
      </MantineProvider>
    )
  );
  await choose('azure');

  // azure needs an endpoint, a deployment and an API version; the row cannot collect
  // those, so the redirect is correct and must survive the fix above.
  expect(text()).toContain('needs extra settings');
  expect(submitButton().disabled).toBe(true);
});
