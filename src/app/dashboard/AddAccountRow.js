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
  // Set only once an automatic attempt has already failed, so the paste box is a
  // fallback rather than the first thing offered. It carries the state of the
  // grant that failed: the pasted URL must match THAT sign-in, not a later one.
  const [manual, setManual] = useState(null);
  const [pastedUrl, setPastedUrl] = useState('');
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
      // The automatic callback failed. For a fixed-port flow that means the
      // loopback callback never landed, which the operator can still finish by
      // hand: the provider already redirected their browser to a URL carrying
      // the code. Offer the paste box bound to THIS sign-in's state, and only
      // now, so it never replaces the automatic attempt.
      if (mode === 'oauth' && !paste && out.state && MANUAL_FALLBACK_PROVIDERS.has(entry.id)) {
        setManual({ provider: entry.id, state: out.state });
      }
      return;
    }
    await applyMetadata(out.connection?.id);
    const savedId = out.connection?.id;
    const read = savedId ? await call(`/api/providers/${encodeURIComponent(savedId)}`) : null;
    if (!read?.ok || read.body?.connection?.id !== savedId) {
      setError({
        tone: 'warn',
        title: 'The account write was accepted, but the saved account was not read back.',
        next: 'Refresh the list before adding it again.',
      });
      onAdded?.();
      return;
    }
    onAdded?.(read.body.connection);
    onClose?.();
  }
  // Optional, and never a precondition for the grant: a sign-in completes with
  // both of these empty. The label goes to the `name` column and the note rides
  // in providerSpecificData, which PUT merges rather than replaces. A failure
  // here is reported without discarding the account that was already saved, and
  // an empty label never overwrites a name the provider derived.
  async function applyMetadata(connectionId) {
    const trimmedLabel = label.trim();
    const trimmedNote = note.trim();
    if (!connectionId || (!trimmedLabel && !trimmedNote)) return;
    const body = {};
    if (trimmedLabel) body.name = trimmedLabel;
    if (trimmedNote) body.providerSpecificData = { accountNote: trimmedNote };
    const saved = await call(`/api/providers/${encodeURIComponent(connectionId)}`, {
      method: 'PUT',
      body,
    });
    if (!saved.ok) {
      setError({
        tone: 'warn',
        title: 'The account was added, but the label and note were not saved.',
        next: 'Set them from Connections.',
      });
    }
  }

  // The paste-back fallback. `manual.state` is the state of the sign-in that
  // failed, and the gateway refuses a pasted URL whose own state disagrees with
  // it, so a URL from another flow cannot complete this one.
  async function finishManual() {
    if (!manual || busy) return;
    setBusy(true);
    setError(null);
    const response = await call(`/api/oauth/${manual.provider}/manual-code`, {
      method: 'POST',
      body: { url: pastedUrl.trim(), state: manual.state },
    });
    setBusy(false);
    if (!response.ok || !response.body?.success) {
      setError(refusal(response.status, response.body));
      return;
    }
    setPastedUrl('');
    setManual(null);
    await applyMetadata(response.body.connection?.id);
    onAdded?.(response.body.connection);
    onClose?.();
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
    (mode === 'oauth' ? Boolean(flow) && (!paste || secret.trim()) : secret.trim());
  return (
    <form className={styles.addRow} aria-label="Add account" onSubmit={submit}>
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
      {entry && !needsConnections && mode === 'oauth' && !paste ? (
        <>
          <TextInput
            size="xs"
            aria-label="Account label"
            placeholder="Label (optional)"
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
      ) : null}
      {manual ? (
        <>
          <Text size="xs" className={styles.addNote} role="status">
            The sign-in window finished, but this app never received the callback. Copy the whole
            address from that window&rsquo;s browser bar and paste it here to finish.
          </Text>
          <TextInput
            size="xs"
            aria-label="Pasted callback URL"
            placeholder="http://localhost:1455/auth/callback?code=…&state=…"
            value={pastedUrl}
            onChange={(event) => setPastedUrl(event.currentTarget.value)}
            className={styles.addSecret}
            autoComplete="off"
          />
          <Button
            size="xs"
            variant="light"
            loading={busy}
            disabled={busy || !pastedUrl.trim()}
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
      {error ? (
        <Text size="xs" c="orange.8" className={styles.addNote} role="alert">
          {error.title}
          {error.next ? ` ${error.next}` : ''}
          {error.detail ? ` ${error.detail}` : ''}
        </Text>
      ) : null}
      <span className={styles.spacer} />
      <Button
        type="submit"
        size="xs"
        loading={busy}
        disabled={!canSubmit}
        leftSection={<Icon name={mode === 'oauth' && !paste ? 'i-open' : 'i-check'} />}
      >
        {mode === 'oauth' && !paste ? 'Sign in' : 'Add'}
      </Button>
      <Tooltip label="Cancel">
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label="Cancel adding an account"
          onClick={cancel}
        >
          <Icon name="i-close" />
        </ActionIcon>
      </Tooltip>
    </form>
  );
}
