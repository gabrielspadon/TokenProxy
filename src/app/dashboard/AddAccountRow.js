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
import styles from './accountBoard.module.css';

const MODE_WORD = { oauth: 'Sign in', apikey: 'API key', cookie: 'Cookie', none: 'No credential' };
const PASTE_FLOWS = new Set(['browser_token', 'import_token']);
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
  const [providerId, setProviderId] = useState(null);
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
    (OPTION_PROVIDERS.has(entry.id) ||
      entry.baseUrlField ||
      accountOptionFields(entry.id).length > 2 ||
      !['oauth', 'apikey'].includes(mode));
  const paste = mode === 'oauth' && PASTE_FLOWS.has(flow?.flowType);
  async function pick(id) {
    const current = ++choice.current;
    setProviderId(id);
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
    if (current !== choice.current) return;
    setSecret('');
    setBusy(false);
    setDevice(null);
    if (!out.ok) {
      setError(refusal(out.status, out.body));
      return;
    }
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
  function cancel() {
    choice.current += 1;
    abortRef.current?.abort();
    setSecret('');
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
        data={entries.map((item) => ({ value: item.id, label: item.name || item.id }))}
        value={providerId}
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
