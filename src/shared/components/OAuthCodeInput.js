'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Group, PasswordInput, Stack, Text } from '@mantine/core';

export function useOAuthCodeInput() {
  const pending = useRef(null);
  const [waiting, setWaiting] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const requestCode = useCallback(({ state, signal }) => new Promise(resolve => {
    pending.current?.finish(null);
    if (signal?.aborted) { resolve(null); return; }
    let finished = false;
    const finish = value => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      pending.current = null;
      setWaiting(false);
      setCode('');
      resolve(value);
    };
    const abort = () => finish(null);
    const timer = setTimeout(() => finish({ error: 'Sign-in timed out. Start again.' }), 300000);
    pending.current = { state, finish };
    signal?.addEventListener('abort', abort, { once: true });
    setCode('');
    setError('');
    setWaiting(true);
  }), []);
  useEffect(() => () => pending.current?.finish(null), []);
  const submit = () => {
    const active = pending.current;
    if (!active) return;
    const value = code.trim();
    const [authorizationCode, suppliedState, ...extra] = value.split('#');
    if (!authorizationCode || /\s/.test(value) || extra.length || (suppliedState && suppliedState !== active.state)) {
      setError('This code does not match the current sign-in. Copy the code from the window just opened.');
      return;
    }
    active.finish({ code: authorizationCode, state: active.state });
  };
  const codeInput = waiting ? (
    <Stack gap="xs" role="group" aria-label="Complete Claude sign-in" style={{ width: '100%' }}>
      <Text size="xs">Claude shows a code after sign-in. Paste it here to connect this account.</Text>
      <PasswordInput label="Claude sign-in code" value={code} onChange={event => setCode(event.currentTarget.value)}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); submit(); } }}
        autoComplete="off" error={error || undefined} size="xs" />
      <Group gap="xs">
        <Button type="button" size="compact-xs" disabled={!code.trim()} onClick={submit}>Complete sign-in</Button>
        <Button type="button" size="compact-xs" variant="default" onClick={() => pending.current?.finish(null)}>Cancel sign-in</Button>
      </Group>
    </Stack>
  ) : null;
  return { requestCode, codeInput };
}
