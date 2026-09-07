'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button, Group, Modal, NativeSelect, Stack, Textarea } from '@mantine/core';
import { call } from '@/shared/api';
import { Notice } from '@/shared/components/Notice';

export function kiroSocialCode(callback, expectedState) {
  let url; try { url = new URL(callback.trim()); } catch { throw new Error('Paste the complete Kiro callback URL.'); }
  if (url.protocol !== 'kiro:' || url.hostname.toLowerCase() !== 'kiro.kiroagent' || url.pathname !== '/authenticate-success') throw new Error('This is not a Kiro authentication callback.');
  if (!expectedState || url.searchParams.get('state') !== expectedState) throw new Error('This callback belongs to another sign-in. Start again.');
  const code = url.searchParams.get('code');
  if (!code) throw new Error('The callback contains no authorization code.');
  return code;
}

export default function KiroSocial({ onSaved }) {
  const [opened, setOpened] = useState(false), [provider, setProvider] = useState('google');
  const [authUrl, setAuthUrl] = useState(''), [callback, setCallback] = useState(''), [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null), [savedId, setSavedId] = useState(null);
  const grant = useRef(null);
  useEffect(() => { const clear = () => { if (document.hidden) setCallback(''); }; document.addEventListener('visibilitychange', clear); return () => { grant.current = null; document.removeEventListener('visibilitychange', clear); }; }, []);
  const close = () => { if (!busy) { grant.current = null; setOpened(false); setAuthUrl(''); setCallback(''); setNotice(null); setSavedId(null); } };
  async function begin() {
    setBusy(true); setNotice(null); grant.current = null; setAuthUrl('');
    const result = await call(`/api/oauth/kiro/social-authorize?provider=${provider}`);
    setBusy(false);
    if (!result.ok || !result.body?.state || !result.body?.codeVerifier || !result.body?.authUrl) { setNotice({ tone: 'bad', title: 'A Kiro sign-in could not be prepared.' }); return; }
    grant.current = { state: result.body.state, codeVerifier: result.body.codeVerifier, provider };
    setAuthUrl(result.body.authUrl);
  }
  async function finish(event) {
    event.preventDefault(); let code;
    try { code = kiroSocialCode(callback, grant.current?.state); } catch (error) { setNotice({ tone: 'bad', title: error.message }); return; }
    const draft = grant.current; setBusy(true); setNotice(null); setCallback(''); grant.current = null; setAuthUrl('');
    const result = await call('/api/oauth/kiro/social-exchange', { method: 'POST', body: { code, codeVerifier: draft.codeVerifier, provider: draft.provider } });
    if (!result.ok || !result.body?.connection?.id) { setBusy(false); setNotice({ tone: 'bad', title: 'Kiro did not complete the account import.', next: 'Start a new sign-in to retry. No credential response is displayed.' }); return; }
    const id = result.body.connection.id;
    const read = await call(`/api/providers/${encodeURIComponent(id)}`);
    setBusy(false); setSavedId(id); onSaved?.();
    setNotice({ tone: read.ok && read.body?.connection?.id === id ? 'ok' : 'warn', title: read.ok && read.body?.connection?.id === id ? 'Kiro account saved and read back.' : 'Kiro accepted the sign-in, but the saved account was not confirmed.', next: 'Do not repeat the import. Stored credentials do not establish successful generation.' });
  }
  return <><Button variant="default" onClick={() => setOpened(true)}>Kiro social sign-in</Button>
    <Modal opened={opened} onClose={close} title="Kiro social sign-in" closeOnClickOutside={!busy} closeOnEscape={!busy}>
      <Stack gap="md"><p>Creates a new Kiro account using Google or GitHub. Finish the provider sign-in, then copy its complete kiro:// callback URL here. The callback is sensitive and is never logged or retained after submission.</p>
        {notice ? <Notice {...notice} /> : null}
        {!savedId ? <><NativeSelect label="Identity provider" value={provider} disabled={busy || Boolean(authUrl)} onChange={event => setProvider(event.currentTarget.value)} data={[{ value: 'google', label: 'Google' }, { value: 'github', label: 'GitHub' }]} />
          {!authUrl ? <Button onClick={begin} loading={busy}>Prepare sign-in</Button> : <><a href={authUrl} target="_blank" rel="noopener noreferrer">Open Kiro sign-in</a><form onSubmit={finish}><Stack><Textarea label="Kiro callback URL" value={callback} disabled={busy} onChange={event => setCallback(event.currentTarget.value)} autoComplete="off" required /><Button type="submit" loading={busy}>Complete account import</Button></Stack></form></>}
        </> : <Link href={`/dashboard/connections/${encodeURIComponent(savedId)}`}>Open saved Kiro account</Link>}
        <Group justify="flex-end"><Button variant="default" disabled={busy} onClick={close}>Close</Button></Group>
      </Stack>
    </Modal></>;
}
