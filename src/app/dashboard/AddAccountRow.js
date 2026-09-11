'use client';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActionIcon, Button, PasswordInput, Select, Text, TextInput, Tooltip } from '@mantine/core';
import { Icon } from '@/shared/components/Icon';
import { call } from '@/shared/api';
import { refusal } from '@/shared/refusal';
import { runGrant, importPasted } from '@/shared/oauthGrant';
import { AI_PROVIDERS } from '@/shared/constants/providers';
import { accountOptionFields } from './connections/AccountOptions';
import { credentialModes } from './accountBoardModel';
import { providerChoiceId, providerChoices } from '@/shared/workspace/scopeOptions';
import styles from '@/shared/workspace/board.module.css';

const MODE_WORD = { oauth: 'Sign in', apikey: 'API key', cookie: 'Cookie', none: 'No credential' };
const PASTE_FLOWS = new Set(['browser_token', 'import_token']);
// Fixed-port sign-ins whose callback lands on a loopback proxy rather than this
// origin. When that callback never arrives the grant has no way to finish on its
// own, so these are the flows that earn a paste-back fallback.
const MANUAL_FALLBACK_PROVIDERS = new Set(['codex', 'xai']);
const OPTION_PROVIDERS = new Set([
  'azure',
  'vertex',
  'vertex-partner',
  'cloudflare-ai',
  'xiaomi-tokenplan',
  'google-pse',
  'linkup',
  'ddgs',
  'xquik',
  'cursor',
  'kilocode',
  'commandcode',
  'tokenrouter',
  'kiro',
  'gitlab',
]);

// The common path only: an API key or a provider sign-in. Providers that need
// endpoint, region or workspace fields keep their full form in Connections.
export function AddAccountRow({ onClose, onAdded }) {
  const entries = useMemo(
    () =>
      Object.values(AI_PROVIDERS)
        .filter((entry) => !entry.hidden)
        .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
    []
  );
  const [selection, setSelection] = useState(null);
  const providerId = providerChoiceId(selection);
  const choices = useMemo(() => providerChoices(entries), [entries]);
  const [mode, setMode] = useState('');
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');
  const [flow, setFlow] = useState(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const [device, setDevice] = useState(null);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);
  const choice = useRef(0);
  useEffect(() => {
    const clear = () => {
      if (document.hidden) setSecret('');
    };
    document.addEventListener('visibilitychange', clear);
    return () => {
      abortRef.current?.abort();
      document.removeEventListener('visibilitychange', clear);
    };
  }, []);
  const entry = entries.find((candidate) => candidate.id === providerId);
  const modes = entry ? credentialModes(entry) : [];
  const needsConnections =
    entry &&
    // An OAuth sign-in collects nothing in this row — the provider's own window
    // does it — so an optional tuning field can never be the reason to send it
    // away. The length test counts accountOptionFields, which ALWAYS appends
    // refreshLeadMs and customHeaders, so any provider declaring even one
    // optional field scored 3+ and was redirected to Connections. codex declares
    // workspaceId and chatgptAccountId purely as post-hoc tuning, scored 4, and
    // became unaddable here: the row rendered "needs extra settings" instead of
    // Sign in, so a second Codex account could not be started at all. The gate
    // belongs on what the row cannot COLLECT.
    (!['oauth', 'apikey'].includes(mode) ||
      (mode === 'apikey' &&
        (OPTION_PROVIDERS.has(entry.id) ||
          entry.baseUrlField ||
          accountOptionFields(entry.id).length > 2)));
  const paste = mode === 'oauth' && PASTE_FLOWS.has(flow?.flowType);
  // Armed the moment a fixed-port sign-in goes live, and kept armed if it then
  // fails. It carries the state of THAT sign-in, so a URL captured from any
  // other grant is refused by the gateway rather than completing this one.
  //
  // It used to be set only on the refusal, which meant it first rendered after
  // the ten-minute poll deadline. An operator whose callback was never going to
  // arrive watched an unchanging row and gave up long before the one control
  // that could have finished the sign-in appeared, which is indistinguishable
  // from the window opening and nothing happening after it.
  const [manual, setManual] = useState(null);
  const [pastedUrl, setPastedUrl] = useState('');
  const [manualBusy, setManualBusy] = useState(false);
  // The connection this row just created, which turns the row into its second
  // stage. Naming is asked for HERE, once there is something to name and with
  // the identity the gateway captured already filled in, rather than before the
  // sign-in where it was the only thing the operator could see.
  const [saved, setSaved] = useState(null);
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  async function pick(value) {
    const current = ++choice.current;
    // A grant still in flight for the PREVIOUS provider is abandoned the moment
    // the operator picks another. Without this it keeps running, and its late
    // result arrives after the epoch check below has already discarded it, so
    // the row stayed busy with no way to recover but a cancel.
    abortRef.current?.abort();
    const id = providerChoiceId(value);
    setSelection(value);
    setFlow(null);
    setError(null);
    setSecret('');
    const next = entries.find((candidate) => candidate.id === id);
    const nextModes = next ? credentialModes(next) : [];
    setMode(nextModes[0] || '');
    if (next?.hasOAuth || nextModes[0] === 'oauth') {
      const probe = await call(
        `/api/oauth/${id}/authorize?redirect_uri=${encodeURIComponent(`${window.location.origin}/callback`)}`
      );
      if (current !== choice.current) return;
      setFlow(probe.ok ? probe.body : { failed: refusal(probe.status, probe.body) });
    }
  }
  async function submit(event) {
    event.preventDefault();
    // The second stage shares this form element, so Enter in the name or note
    // field lands here. It saves the row it is editing; starting a second
    // sign-in from a field that names an account already connected would be the
    // opposite of what was typed.
    if (saved) {
      await saveMetadata();
      return;
    }
    if (!entry || busy) return;
    const current = choice.current;
    setBusy(true);
    setError(null);
    setStep('');
    let out;
    if (mode === 'oauth') {
      if (flow?.failed) {
        setError(flow.failed);
        setBusy(false);
        return;
      }
      if (paste) out = await importPasted(entry.id, { token: secret });
      else {
        const controller = new AbortController();
        abortRef.current = controller;
        out = await runGrant(entry.id, flow?.flowType || 'authorization_code', {
          signal: controller.signal,
          report: (text) => current === choice.current && setStep(text),
          deviceHook: (info) => current === choice.current && setDevice(info),
          // Fires once the loopback proxy is listening and the window has been
          // navigated, so the escape hatch is on screen for the whole wait.
          onFallback: (info) => current === choice.current && setManual(info),
        });
      }
    } else {
      const response = await call('/api/providers', {
        method: 'POST',
        body: { provider: entry.id, name: name.trim() || entry.name || entry.id, apiKey: secret },
      });
      out = response.ok
        ? { ok: true, connection: response.body.connection }
        : { ok: false, status: response.status, body: response.body };
    }
    // The epoch check moved BELOW these resets. A grant abandoned by a provider
    // switch still settles, and when it did the old order returned before
    // clearing `busy`, so the row stayed disabled with no way out but a cancel.
    // Releasing the row is safe for a stale epoch precisely because it owns no
    // selection state; everything after the check does.
    setSecret('');
    setBusy(false);
    setDevice(null);
    setStep('');
    if (current !== choice.current) return;
    if (!out.ok) {
      setError(refusal(out.status, out.body));
      // A refusal that still carries a state keeps the paste box on screen: the
      // provider may already have redirected the operator to a URL holding the
      // code, and that URL is the only thing left that can finish this grant.
      if (mode === 'oauth' && !paste && out.state && MANUAL_FALLBACK_PROVIDERS.has(entry.id)) {
        setManual({ provider: entry.id, state: out.state });
      }
      return;
    }
    await showSaved(out.connection?.id);
  }

  // The identity the gateway captured during the token exchange, read back off
  // the row it saved. Codex spells its upstream account id `chatgptAccountId`
  // and its tier `chatgptPlanType`, so both spellings are read. This is
  // presentation only: it decides the sentence the row shows and the name it
  // prefills, never whether two grants are the same account, which belongs to
  // the repository that writes those columns.
  function identitySentence(connection) {
    const psd = connection?.providerSpecificData || {};
    const who = connection?.email || psd.email || connection?.name || 'this account';
    const plan = psd.plan || psd.chatgptPlanType || '';
    const account = psd.accountId || psd.chatgptAccountId || '';
    const detail = [plan ? `${plan} plan` : '', account ? `account ${String(account).slice(0, 8)}` : '']
      .filter(Boolean)
      .join(', ');
    return detail ? `Signed in as ${who} (${detail}).` : `Signed in as ${who}.`;
  }

  // The account exists and is already on the board by the time this returns.
  // Everything after it edits a row that is already working.
  async function showSaved(connectionId) {
    setManual(null);
    setPastedUrl('');
    const read = connectionId ? await call(`/api/providers/${encodeURIComponent(connectionId)}`) : null;
    if (!read?.ok || read.body?.connection?.id !== connectionId) {
      setError({
        tone: 'warn',
        title: 'The account write was accepted, but the saved account was not read back.',
        next: 'Refresh the list before adding it again.',
      });
      onAdded?.();
      return;
    }
    const connection = read.body.connection;
    onAdded?.(connection);
    // Prefilled from what the sign-in itself reported, so the common case is
    // reading a correct name rather than inventing one.
    setLabel(connection.name || '');
    setNote(connection.providerSpecificData?.accountNote || '');
    setSaved(connection);
  }

  // Both fields are optional and neither gates anything. An untouched name is
  // the one derived from the captured identity, so it is not written back; the
  // note rides in providerSpecificData, which PUT merges rather than replaces.
  // A failure here never discards the account, which is already stored.
  async function saveMetadata() {
    if (!saved || busy) return;
    const trimmedLabel = label.trim();
    const trimmedNote = note.trim();
    const body = {};
    if (trimmedLabel && trimmedLabel !== saved.name) body.name = trimmedLabel;
    if (trimmedNote !== (saved.providerSpecificData?.accountNote || '')) {
      body.providerSpecificData = { accountNote: trimmedNote };
    }
    if (!Object.keys(body).length) {
      onClose?.();
      return;
    }
    setBusy(true);
    setError(null);
    const response = await call(`/api/providers/${encodeURIComponent(saved.id)}`, {
      method: 'PUT',
      body,
    });
    setBusy(false);
    if (!response.ok) {
      setError({
        tone: 'warn',
        title: 'The account is connected, but the name and note were not saved.',
        next: 'Set them from Connections.',
      });
      return;
    }
    const read = await call(`/api/providers/${encodeURIComponent(saved.id)}`);
    onAdded?.(read.ok ? read.body.connection : saved);
    onClose?.();
  }

  // The paste-back fallback. `manual.state` is the state of the sign-in this row
  // started, and the gateway refuses a pasted URL whose own state disagrees with
  // it, so a URL from another flow cannot complete this one. It runs on its own
  // `manualBusy` rather than on `busy`, because the whole point is that it stays
  // usable while the automatic wait is still running.
  async function finishManual() {
    if (!manual || manualBusy) return;
    // The automatic wait is abandoned first, and the epoch is bumped so its late
    // refusal is discarded instead of landing on top of the account this is
    // about to create.
    choice.current += 1;
    abortRef.current?.abort();
    setManualBusy(true);
    setError(null);
    const response = await call(`/api/oauth/${manual.provider}/manual-code`, {
      method: 'POST',
      body: { url: pastedUrl.trim(), state: manual.state },
    });
    setManualBusy(false);
    if (!response.ok || !response.body?.success) {
      // manual-code answers a refusal with an operator-facing sentence, naming a
      // state that belongs to a different sign-in or a session that has expired.
      // That sentence is shown as written rather than flattened into the generic
      // "The request failed", which named neither.
      const stated = typeof response.body?.error === 'string' ? response.body.error.trim() : '';
      setError(stated ? { tone: 'bad', title: stated } : refusal(response.status, response.body));
      return;
    }
    await showSaved(response.body.connection?.id);
  }

  function cancel() {
    choice.current += 1;
    abortRef.current?.abort();
    setSecret('');
    setPastedUrl('');
    setManual(null);
    // Release the loopback port the failed attempt left listening.
    if (manual) call(`/api/oauth/${manual.provider}/stop-proxy`).catch(() => {});
    onClose?.();
  }
  const canSubmit =
    entry &&
    !needsConnections &&
    !busy &&
    !manualBusy &&
    (mode === 'oauth' ? Boolean(flow) && (!paste || secret.trim()) : secret.trim());
  return (
    <form className={styles.addRow} aria-label="Add account" onSubmit={submit}>
      {saved ? (
        <>
          <Text size="xs" className={styles.addNote} role="status">
            {identitySentence(saved)}
          </Text>
          <TextInput
            size="xs"
            aria-label="Account name"
            placeholder="Name"
            value={label}
            onChange={(event) => setLabel(event.currentTarget.value)}
            className={styles.addName}
            maxLength={120}
          />
          <TextInput
            size="xs"
            aria-label="Account note"
            placeholder="Note (optional)"
            value={note}
            onChange={(event) => setNote(event.currentTarget.value)}
            className={styles.addName}
            maxLength={280}
          />
        </>
      ) : (
        <>
          <Select
            size="xs"
            aria-label="Provider"
            placeholder="Provider"
            searchable
            data={choices}
            value={selection}
            onChange={(value) => value && pick(value)}
            className={styles.addProvider}
            nothingFoundMessage="No provider matches"
            allowDeselect={false}
          />
          {modes.length > 1 ? (
            <Select
              size="xs"
              aria-label="Credential type"
              data={modes.map((value) => ({ value, label: MODE_WORD[value] || value }))}
              value={mode}
              onChange={(value) => value && setMode(value)}
              className={styles.addMode}
              allowDeselect={false}
            />
          ) : null}
          {entry && needsConnections ? (
            <Text size="xs" className={styles.addNote}>
              {entry.name || entry.id} needs extra settings.{' '}
              <Link href="/dashboard/connections">Continue in Connections</Link>.
            </Text>
          ) : null}
          {entry && !needsConnections && mode === 'apikey' ? (
            <>
              <TextInput
                size="xs"
                aria-label="Account name"
                placeholder="Name (optional)"
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                className={styles.addName}
                maxLength={120}
              />
              <PasswordInput
                size="xs"
                aria-label="API key"
                placeholder="API key"
                value={secret}
                onChange={(event) => setSecret(event.currentTarget.value)}
                className={styles.addSecret}
                autoComplete="off"
                required
              />
            </>
          ) : null}
          {entry && !needsConnections && mode === 'oauth' ? (
            paste ? (
              <PasswordInput
                size="xs"
                aria-label="Pasted token"
                placeholder="Paste the token from the provider"
                value={secret}
                onChange={(event) => setSecret(event.currentTarget.value)}
                className={styles.addSecret}
                autoComplete="off"
                required
              />
            ) : (
              <Text size="xs" className={styles.addNote}>
                {flow?.failed
                  ? flow.failed.title
                  : flow
                    ? 'Opens the provider sign-in in a new window.'
                    : 'Checking the sign-in method…'}
              </Text>
            )
          ) : null}
          {manual ? (
            <>
              <Text size="xs" className={styles.addNote} role="status">
                If the sign-in window finishes and this row does not, copy the whole address out of
                that window&rsquo;s browser bar and paste it here.
              </Text>
              <TextInput
                size="xs"
                aria-label="Pasted callback URL"
                placeholder="http://localhost:1455/auth/callback?code=…&state=…"
                value={pastedUrl}
                onChange={(event) => setPastedUrl(event.currentTarget.value)}
                onKeyDown={(event) => {
                  // Enter in a text input submits the form it sits in, which
                  // here started a SECOND sign-in and threw the pasted address
                  // away. The key that means "finish" has to finish.
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  finishManual();
                }}
                className={styles.addSecret}
                autoComplete="off"
              />
              <Button
                size="xs"
                variant="light"
                loading={manualBusy}
                disabled={manualBusy || !pastedUrl.trim()}
                onClick={finishManual}
                leftSection={<Icon name="i-check" />}
              >
                Finish sign-in
              </Button>
            </>
          ) : null}
          {device ? (
            <Text size="xs" className={styles.addNote}>
              Enter <code>{device.userCode}</code> at <bdi>{device.verificationUri}</bdi>
            </Text>
          ) : null}
          {step ? (
            <Text size="xs" className={styles.addNote} role="status">
              {step}
            </Text>
          ) : null}
        </>
      )}
      {error ? (
        <Text size="xs" c="orange.8" className={styles.addNote} role="alert">
          {error.title}
          {error.next ? ` ${error.next}` : ''}
          {error.detail ? ` ${error.detail}` : ''}
        </Text>
      ) : null}
      <span className={styles.spacer} />
      {saved ? (
        <Button
          size="xs"
          loading={busy}
          disabled={busy}
          onClick={saveMetadata}
          leftSection={<Icon name="i-check" />}
        >
          Save
        </Button>
      ) : (
        <Button
          type="submit"
          size="xs"
          loading={busy}
          disabled={!canSubmit}
          leftSection={<Icon name={mode === 'oauth' && !paste ? 'i-open' : 'i-check'} />}
        >
          {mode === 'oauth' && !paste ? 'Sign in' : 'Add'}
        </Button>
      )}
      <Tooltip label={saved ? 'Done' : 'Cancel'}>
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={saved ? 'Close the account panel' : 'Cancel adding an account'}
          onClick={saved ? () => onClose?.() : cancel}
        >
          <Icon name="i-close" />
        </ActionIcon>
      </Tooltip>
    </form>
  );
}
