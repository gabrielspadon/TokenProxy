// @vitest-environment jsdom
/**
 * The paste-back fallback as the OPERATOR reaches it, and the two placement
 * defects that made the Codex sign-in unusable.
 *
 * 1. THE FALLBACK WAS UNREACHABLE. `manual` was set only on the grant's refusal,
 *    and a fixed-port grant refuses only after PROXY_QUERY_DEADLINE_MS, which is
 *    600_000. An operator whose loopback callback was never going to arrive saw
 *    an unchanging row for ten minutes, so the one control that could finish the
 *    sign-in never rendered while they were still looking. It is now armed from
 *    runGrant's onFallback, the moment the proxy is listening and the window has
 *    been navigated.
 * 2. ENTER STARTED A SECOND SIGN-IN. The paste box sits inside the add form, and
 *    Enter in a text input submits the form it sits in. The pasted address was
 *    discarded and a fresh grant opened another window, which is the same
 *    symptom the paste box exists to escape.
 * 3. METADATA CAME FIRST. Label and Note were the only editable fields on a
 *    Codex row before sign-in, ahead of the sign-in itself. They now appear
 *    after the connection exists, prefilled from the identity captured during
 *    the token exchange.
 *
 * The state-mismatch refusal is the security boundary and is asserted here as
 * the operator sees it: the gateway's own sentence, not a generic failure.
 * tests/unit/codex-manual-code.test.js owns the gateway half of that check.
 *
 * Every code and state in this file is invented. An authorization code is a
 * credential and no real one appears here.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const SESSION_STATE = 'invented-session-state';
const OTHER_STATE = 'invented-other-state';
const DUMMY_CODE = 'invented-authorization-code';
const CALLBACK = `http://localhost:1455/auth/callback?code=${DUMMY_CODE}&state=${SESSION_STATE}`;

const call = vi.fn();
vi.mock('@/shared/api', () => ({ call: (...args) => call(...args) }));

// runGrant is replaced by a stand-in that behaves like the real fixed-port path:
// it reports the step, arms the fallback, and then never settles, which is
// exactly the state an operator is stuck in when the callback does not land.
const grantCalls = [];
vi.mock('@/shared/oauthGrant', () => ({
  importPasted: vi.fn(),
  runGrant: vi.fn((provider, flowType, options) => {
    grantCalls.push({ provider, flowType, options });
    options?.report?.('Finish the sign-in in the window that opened.');
    options?.onFallback?.({ provider, state: SESSION_STATE });
    return new Promise(() => {});
  }),
}));

const { AddAccountRow } = await import('@/app/dashboard/AddAccountRow');

let root;
let container;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  grantCalls.length = 0;
  call.mockReset();
  call.mockImplementation(async (url) => {
    if (url.includes('/authorize')) {
      return {
        ok: true,
        status: 200,
        body: { flowType: 'authorization_code_pkce', fixedPort: 1455 },
      };
    }
    return { ok: true, status: 200, body: {} };
  });
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

const form = () => container.querySelector('form[aria-label="Add account"]');
const field = (label) =>
  [...form().querySelectorAll('input')].find((node) => node.getAttribute('aria-label') === label);
const button = (word) =>
  [...form().querySelectorAll('button')].find((node) => (node.textContent || '').includes(word));

async function mount(props = {}) {
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <AddAccountRow {...props} />
      </MantineProvider>
    )
  );
}

async function choose(id) {
  await act(async () => container.querySelector('[aria-label="Provider"]').click());
  const option = [...document.querySelectorAll('[role="option"]')].find(
    (node) => (node.getAttribute('value') || node.dataset.value) === id
  );
  await act(async () => option.click());
}

async function type(input, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function signIn() {
  await mount();
  await choose('codex');
  await act(async () => form().querySelector('button[type="submit"]').click());
}

it('offers no metadata field before the sign-in, which used to be all a Codex row showed', async () => {
  await mount();
  await choose('codex');

  const labels = [...form().querySelectorAll('input')].map((node) =>
    node.getAttribute('aria-label')
  );
  expect(labels).not.toContain('Account label');
  expect(labels).not.toContain('Account name');
  expect(labels).not.toContain('Account note');
  expect(button('Sign in')).toBeTruthy();
});

it('offers the paste box while the sign-in is still running, not only once it has timed out', async () => {
  await signIn();

  // The grant above never settles. Before the fix the row could only show this
  // control on the refusal, so at this point there was nothing here at all.
  expect(field('Pasted callback URL')).toBeTruthy();
  expect(button('Finish sign-in')).toBeTruthy();
  expect(grantCalls[0].options.onFallback).toBeTypeOf('function');
});

it('finishes the grant through manual-code with the state the sign-in issued', async () => {
  const onAdded = vi.fn();
  const onClose = vi.fn();
  await mount({ onAdded, onClose });
  await choose('codex');
  await act(async () => form().querySelector('button[type="submit"]').click());

  call.mockImplementation(async (url) => {
    if (url.includes('/manual-code')) {
      return {
        ok: true,
        status: 200,
        body: { success: true, connection: { id: 'invented-connection' } },
      };
    }
    if (url.includes('/api/providers/invented-connection')) {
      return {
        ok: true,
        status: 200,
        body: {
          connection: {
            id: 'invented-connection',
            provider: 'codex',
            name: 'operator@invented.example',
            email: 'operator@invented.example',
            providerSpecificData: {
              chatgptPlanType: 'plus',
              chatgptAccountId: 'invented-account-id',
            },
          },
        },
      };
    }
    return { ok: true, status: 200, body: {} };
  });

  await type(field('Pasted callback URL'), CALLBACK);
  await act(async () => button('Finish sign-in').click());

  const sent = call.mock.calls.find(([url]) => url.includes('/manual-code'));
  expect(sent[0]).toBe('/api/oauth/codex/manual-code');
  expect(sent[1].body).toEqual({ url: CALLBACK, state: SESSION_STATE });
  expect(onAdded).toHaveBeenCalledWith(expect.objectContaining({ id: 'invented-connection' }));

  // Stage two: naming comes after there is an account to name, prefilled from
  // the identity the exchange reported, and the row stays open to show it.
  expect(form().textContent).toContain('operator@invented.example');
  expect(form().textContent).toContain('plus plan');
  expect(field('Account name').value).toBe('operator@invented.example');
  expect(onClose).not.toHaveBeenCalled();
});

it('states the gateway refusal verbatim when the pasted URL belongs to another sign-in', async () => {
  await signIn();

  const refusalText =
    'That callback belongs to a different sign-in. Start the sign-in again and paste the new address.';
  call.mockImplementation(async (url) => {
    if (url.includes('/manual-code'))
      return { ok: false, status: 500, body: { error: refusalText } };
    return { ok: true, status: 200, body: {} };
  });

  await type(
    field('Pasted callback URL'),
    `http://localhost:1455/auth/callback?code=${DUMMY_CODE}&state=${OTHER_STATE}`
  );
  await act(async () => button('Finish sign-in').click());

  // The generic mapper turns a 500 into "The request failed", which named
  // neither a mismatched state nor an expired session.
  expect(form().textContent).toContain('belongs to a different sign-in');
  expect(form().textContent).not.toContain('The request failed');
  // Refused, and still offered: the operator can paste the right address.
  expect(field('Pasted callback URL')).toBeTruthy();
});

it('finishes the sign-in on Enter in the paste box instead of starting a second one', async () => {
  await signIn();
  expect(grantCalls).toHaveLength(1);

  call.mockImplementation(async (url) => {
    if (url.includes('/manual-code'))
      return { ok: false, status: 500, body: { error: 'invented refusal' } };
    return { ok: true, status: 200, body: {} };
  });

  const input = field('Pasted callback URL');
  await type(input, CALLBACK);
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
  });

  expect(call.mock.calls.some(([url]) => url.includes('/manual-code'))).toBe(true);
  // The defect: Enter submitted the form, which threw the pasted address away
  // and opened a second sign-in window.
  expect(grantCalls).toHaveLength(1);
});
