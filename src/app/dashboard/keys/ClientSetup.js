'use client';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { Icon } from '@/shared/components/Icon';
import { Notice } from '@/shared/components/Notice';
import { call } from '@/shared/api';
import { refusal } from '@/shared/refusal';
import { fmtNum } from '@/shared/format';
import { Button, TextInput } from '@mantine/core';
import { NativeClientBoundary } from './NativeClientBoundary';

// The two tiers an operator can actually run, and what each one settles. The
// third is described and deliberately not offered, because running it spends
// money and that is a decision taken somewhere an operator expects to be
// spending, not behind a button labelled "test".
const RUNNABLE = [
  {
    tier: 'configuration',
    label: 'Check configuration',
    reaches: 'Reaches nothing.',
    proves: 'That the endpoint is well formed and this key is currently valid for the model named.',
  },
  {
    tier: 'authentication',
    label: 'Test against this gateway',
    reaches: 'Reaches this gateway only.',
    proves: 'That the gateway accepts this key over the network and serves its model catalog.',
  },
];

function Endpoint({ label, value, note }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="keys-endpoint">
      <span className="label">{label}</span>
      <code className="keys-secret">
        {value}
      </code>
      {note ? <span className="caption">{note}</span> : null}
      <button type="button" className="button quiet" onClick={copy}>
        <Icon name="i-copy" />
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function Outcome({ outcome }) {
  if (!outcome) return null;
  if (outcome.tier === 'configuration') {
    return (
      <>
        <Notice
          tone={outcome.ok ? 'ok' : 'bad'}
          title={
            outcome.ok ? 'The configuration holds.' : 'The configuration would not work as written.'
          }
          next="Nothing was contacted. This says nothing about whether the gateway is reachable."
        />
        {outcome.findings?.length ? (
          <ul className="keys-findings">
            {outcome.findings.map((f) => (
              <li key={f.code} data-tone={f.severity === 'error' ? 'bad' : 'warn'}>
                {f.detail}
              </li>
            ))}
          </ul>
        ) : null}
      </>
    );
  }
  if (outcome.skipped) {
    return (
      <Notice
        tone="warn"
        title="Not attempted."
        next="The configuration check failed first, so contacting the gateway would have proved nothing. Fix what it reported and run this again."
      />
    );
  }
  return (
    <Notice
      tone={outcome.ok ? 'ok' : 'bad'}
      title={
        outcome.ok
          ? 'The gateway accepted this key.'
          : outcome.timedOut
            ? 'The gateway did not answer in time.'
            : 'The gateway refused or could not be reached.'
      }
      next="This reached this gateway only. It proves nothing about whether an upstream provider is available or what a real request would cost."
      detail={
        outcome.status
          ? `HTTP ${outcome.status} in ${fmtNum(outcome.elapsedMs)}ms`
          : `No response in ${fmtNum(outcome.elapsedMs)}ms`
      }
    />
  );
}

/**
 * The panel is mounted only once its disclosure is opened.
 *
 * `details` hides its children visually but React still renders them, so a
 * panel that fetched on mount would issue one request per key every time the
 * keys page loaded, for configuration nobody had asked to see.
 */
export function ClientSetupDisclosure({ record }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="keys-detail" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Client setup</summary>
      {open ? <ClientSetup record={record} /> : null}
    </details>
  );
}

export function ClientSetup({ record }) {
  return <ClientSetupForKey key={record.id} record={record} />;
}

function ClientSetupForKey({ record }) {
  const [config, setConfig] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [busy, setBusy] = useState(null);
  const [refused, setRefused] = useState(null);
  const [model, setModel] = useState('');
  const id = record.id;

  useEffect(() => {
    let live = true;
    (async () => {
      const res = await call(`/api/keys/${encodeURIComponent(id)}/connectivity`);
      if (!live) return;
      if (res.ok && res.body?.endpoints?.openaiBaseUrl) setConfig(res.body);
      else setRefused(refusal(res.status, res.body));
    })();
    return () => {
      live = false;
    };
  }, [id]);

  const run = useCallback(
    async (tier) => {
      setBusy(tier);
      setRefused(null);
      setOutcome(null);
      const res = await call(`/api/keys/${encodeURIComponent(id)}/connectivity`, {
        method: 'POST',
        body: { tier, ...(model.trim() ? { model: model.trim() } : {}) },
      });
      setBusy(null);
      if (!res.ok) {
        setRefused(refusal(res.status, res.body));
        return;
      }
      setOutcome(res.body);
    },
    [id, model]
  );

  return (
    <div className="keys-setup">
      <p className="caption">
        Configure a client with one of these base URLs and this key. The key itself is not shown
        here; reveal it deliberately when you need it.
      </p>
      {refused ? <Notice {...refused} /> : null}
      {config ? (
        <>
          <div className="keys-endpoints">
            <Endpoint
              label="OpenAI-compatible base URL"
              value={config.endpoints.openaiBaseUrl}
              note="For a client that appends its own path under /v1."
            />
            <Endpoint
              label="Anthropic-style base URL"
              value={config.endpoints.anthropicBaseUrl}
              note="For a client that appends its own full path."
            />
          </div>
          <TextInput label="Model to check" description="Optional provider/model identifier. Without one, this check does not establish permission for a specific model." value={model} onChange={event => { setModel(event.currentTarget.value); setOutcome(null); }} disabled={busy !== null} />
          <div className="verb-row">
            {RUNNABLE.map((t) => (
              <Button
                key={t.tier}
                type="button"
                variant="default"
                disabled={busy !== null}
                onClick={() => run(t.tier)}
              >
                <Icon name="i-check" />
                {t.label}
              </Button>
            ))}
          </div>
          {/* dt and dd are direct children on purpose: globals.css sizes
              dl.facts as a two-column grid, so wrapping each pair in a div
              makes the div the grid item and the max-content column grows to
              the longest sentence, which overflowed the page by 257px at
              390px wide. */}
          <dl className="facts">
            {RUNNABLE.map((t) => (
              <Fragment key={t.tier}>
                <dt>{t.label}</dt>
                <dd>
                  {t.reaches} {t.proves}
                </dd>
              </Fragment>
            ))}
          </dl>
          <Outcome outcome={outcome} />
          <NativeClientBoundary />
          {/* Stated, not offered. An operator should know the check exists and
              know that nothing here will run it for them. */}
          <p className="caption">
            Neither check sends a real completion. A model request against an upstream provider
            is needed to establish that the whole generation path works. It may be billed and is not run from this page.
          </p>
        </>
      ) : refused ? null : (
        <p className="skeleton">Reading</p>
      )}
    </div>
  );
}
