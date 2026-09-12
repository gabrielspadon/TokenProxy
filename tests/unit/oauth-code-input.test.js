// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useOAuthCodeInput } from '@/shared/components/OAuthCodeInput';

let host, root, api;
function Harness() { api = useOAuthCodeInput(); return api.codeInput; }
beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<MantineProvider env="test"><Harness /></MantineProvider>));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function fill(value) {
  const input = host.querySelector('input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const submit = () => act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Complete sign-in').click());

it('rejects another sign-in code and resolves only the current state, clearing the secret', async () => {
  let result;
  await act(async () => { result = api.requestCode({ state: 'current' }); });
  await fill('code#another'); await submit();
  expect(host.textContent).toContain('does not match');
  expect(host.querySelector('input').type).toBe('password');
  await fill('code#current'); await submit();
  expect(await result).toEqual({ code: 'code', state: 'current' });
  expect(host.querySelector('input')).toBeNull();
});

it('settles cancellation and removes the code input when its caller aborts', async () => {
  const controller = new AbortController(); let result;
  await act(async () => { result = api.requestCode({ state: 'current', signal: controller.signal }); });
  await fill('private-code');
  await act(async () => controller.abort());
  expect(await result).toBeNull();
  expect(host.querySelector('input')).toBeNull();
});

it('expires an unfinished sign-in instead of holding a pending grant forever', async () => {
  vi.useFakeTimers(); let result;
  await act(async () => { result = api.requestCode({ state: 'current' }); });
  await act(async () => vi.advanceTimersByTimeAsync(300000));
  expect(await result).toEqual({ error: 'Sign-in timed out. Start again.' });
  expect(host.querySelector('input')).toBeNull();
});
