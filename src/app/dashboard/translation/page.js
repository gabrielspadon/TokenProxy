'use client';
import { Button, Input, Textarea } from '@mantine/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useEventStream } from '@/shared/hooks/useEventStream';
import { Freshness } from '@/shared/components/Freshness';
import { Icon } from '@/shared/components/Icon';
import { Notice } from '@/shared/components/Notice';
import { Confirm } from '@/shared/components/Confirm';
import { call } from '@/shared/api';
import { refusal } from '@/shared/refusal';
import { fmtNum } from '@/shared/format';
import './styles.css';
import { sendDiagnostic } from './diagnosticSend';

// The eight fixed artifact names a stage snapshot may be saved or loaded
// under. An arbitrary name is refused server-side, so the UI never offers a
// free-text filename either (docs/contract/05-shaping-translator.md:259-262,
// src/app/api/translator/save/route.js:14-23).
const SNAPSHOT_NAMES = [
  '1_req_client.json',
  '2_req_source.json',
  '3_req_openai.json',
  '4_req_target.json',
  '5_res_provider.txt',
  '6_res_openai.txt',
  '7_res_client.txt',
  '7_res_client.json',
];

const DEPTHS = [
  [1, 'Format detection only'],
  [2, 'Converted to neutral format'],
  [3, 'Converted to target format'],
];

const SAMPLE_BODY = JSON.stringify(
  { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
  null,
  2
);

const OPERATOR = 'Dashboard access under this installation’s sign-in policy.';

// A line that looks like a bearer token, an sk- key, or a cookie header is
// redacted before it ever reaches the DOM. Log lines carry request bodies,
// so this runs on every line, every render, never once at the source.
function redact(line) {
  return line
    .replace(/Bearer\s+\S+/gi, '[redacted]')
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, '[redacted]')
    .replace(/cookie:\s*[^\n]+/gi, 'cookie: [redacted]');
}

function classifySend(status, ok) {
  if (ok) return 'succeeded';
  if (status === 499) return 'abandoned';
  if (status === 0) return 'unconfirmed';
  if (status === 502) return 'timeout';
  if (status === 400) return 'invalid';
  return 'refused';
}

const SEND_WORD = {
  succeeded: 'Response received',
  abandoned: 'Abandoned by the caller',
  timeout: 'Timed out before connection',
  refused: 'Request refused',
  unconfirmed: 'Response unconfirmed',
};
const SEND_TONE = { succeeded: 'ok', abandoned: 'warn', timeout: 'warn', refused: 'bad', unconfirmed: 'warn' };

export default function TranslationPage() {
  const [logs, setLogs] = useState([]);
  const sendController = useRef(null);
  useEffect(() => () => sendController.current?.abort(), []);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const onMessage = useCallback((msg) => {
    if (msg.type === 'clear') {
      setLogs([]);
      return;
    }
    if (pausedRef.current) return;
    if (msg.type === 'init') setLogs(msg.logs.slice(-500));
    else if (msg.type === 'line') setLogs((l) => [...l, msg.line].slice(-500));
    else if (msg.type === 'lines') setLogs((l) => [...l, ...msg.lines].slice(-500));
  }, []);
  const stream = useEventStream('/api/translator/console-logs/stream', onMessage);

  const [filter, setFilter] = useState('');
  const shown = useMemo(
    () => logs.filter((l) => !filter || l.toLowerCase().includes(filter.toLowerCase())),
    [logs, filter]
  );

  const [lastCheck, setLastCheck] = useState(null); // { revision, at, changed }
  const checkNow = async () => {
    const res = await call('/api/translator/console-logs');
    if (!res.ok) {
      setLastCheck({ error: refusal(res.status, res.body) });
      return;
    }
    const revision = res.body.revision;
    const changed = lastCheck?.revision === undefined || lastCheck.revision !== revision;
    if (changed) setLogs(res.body.logs.slice(-500));
    setLastCheck({ revision, at: Date.now(), changed });
  };

  // Translate: depth + body, no persistence, no quota, no outbound call.
  const [depth, setDepth] = useState(1);
  const [clientBodyText, setClientBodyText] = useState(SAMPLE_BODY);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [d1, setD1] = useState(null); // { data } | { error }
  const [d2, setD2] = useState(null);
  const [d3, setD3] = useState(null);
  const bodyRevision = useRef(0);
  const [translating, setTranslating] = useState(false);

  const translate = async () => {
    const revision = bodyRevision.current;
    let parsed;
    try {
      parsed = JSON.parse(clientBodyText);
    } catch (e) {
      setD1({
        error: { tone: 'warn', title: 'The request body is not valid JSON.', detail: e.message },
      });
      return;
    }
    setTranslating(true);
    if (depth === 1) {
      const res = await call('/api/translator/translate', {
        method: 'POST',
        body: { step: 1, body: parsed },
      });
      setTranslating(false);
      if (revision !== bodyRevision.current) return;
      if (!res.ok) {
        setD1({ error: refusal(res.status, res.body) });
        return;
      }
      const { provider: p, model: m } = res.body.result;
      setProvider(p || '');
      setModel(m || '');
      setD1({ data: res.body.result });
      return;
    }
    if (depth === 2) {
      const res = await call('/api/translator/translate', {
        method: 'POST',
        body: { step: 2, body: parsed },
      });
      setTranslating(false);
      if (revision !== bodyRevision.current) return;
      if (!res.ok) {
        setD2({ error: refusal(res.status, res.body) });
        return;
      }
      setD2({ data: res.body.result.body, route: res.body.result.route });
      return;
    }
    if (!d2?.data) {
      setTranslating(false);
      setD3({
        error: {
          tone: 'warn',
          title: 'Convert to the neutral format first.',
          next: 'Run depth 2 before depth 3; the third depth translates its output onward.',
        },
      });
      return;
    }
    if (!provider || !model) {
      setTranslating(false);
      setD3({
        error: {
          tone: 'warn',
          title: 'Provider and model are required for this depth.',
          next: 'Run depth 1 to fill them in, or enter them by hand.',
        },
      });
      return;
    }
    const res = await call('/api/translator/translate', {
      method: 'POST',
      body: { step: 3, body: { provider, model, body: d2.data } },
    });
    setTranslating(false);
    if (revision !== bodyRevision.current) return;
    if (!res.ok) {
      setD3({ error: refusal(res.status, res.body) });
      return;
    }
    setD3({ data: res.body.result });
  };

  // Send: provider + model + body, real call, real quota, may refresh a
  // stored secret. The only action here with effects beyond the trace.
  const [sendBodyText, setSendBodyText] = useState('');
  const [sendResult, setSendResult] = useState(null); // { status, ok, body }
  const [ask, setAsk] = useState(null);
  const [busy, setBusy] = useState(false);
  const [deny, setDeny] = useState(null);
  const [done, setDone] = useState(null);

  const confirm = async () => {
    setBusy(true);
    setDeny(null);
    const res = await ask.run();
    setBusy(false);
    if (!res.ok && ask.hardDeny !== false) {
      setDeny(refusal(res.status, res.body));
    }
    if (ask.done) ask.done(res);
    setAsk(null);
  };
  const close = () => {
    sendController.current?.abort();
    setAsk(null);
    setDeny(null);
  };

  const requestSend = () => {
    let body;
    try {
      body = JSON.parse(sendBodyText || clientBodyText);
    } catch (e) {
      setSendResult({
        ok: false,
        status: 400,
        body: { error: `Body is not valid JSON: ${e.message}` },
      });
      return;
    }
    if (!provider || !model) {
      setSendResult({
        ok: false,
        status: 400,
        body: { error: 'Provider and model are required.' },
      });
      return;
    }
    setAsk({
      kind: 'provider-send',
      title: 'Send this request to a live provider',
      verb: 'Send',
      requires: OPERATOR,
      changes:
        'Uses the first active stored connection for this provider and sends directly through its executor. This may spend quota and refresh stored credentials. It does not test gateway routing, eligibility, fallback or client-key budget admission.',
      undo: 'None. The call already happened and cannot be recalled.',
      irreversible: true,
      hardDeny: false,
      run: async () => {
        const controller = new AbortController();
        sendController.current = controller;
        try { return await sendDiagnostic({ provider, model, body }, controller.signal); }
        finally { if (sendController.current === controller) sendController.current = null; }
      },
      done: (res) => setSendResult(res),
    });
  };

  const clearLogs = () =>
    setAsk({
      title: 'Clear console records',
      verb: 'Clear',
      requires: OPERATOR,
      changes:
        'Every captured console line is discarded. Configuration and stored secrets are untouched.',
      undo: 'None. Records already cleared cannot be brought back.',
      irreversible: true,
      run: () => call('/api/translator/console-logs', { method: 'DELETE' }),
      done: () => {
        setLogs([]);
        setDone({ tone: 'ok', title: 'Console records cleared' });
      },
    });

  // Save / load a fixed-name snapshot. The editor is the only place content
  // comes from or goes to; no input anywhere accepts a filename.
  const [snapshotText, setSnapshotText] = useState('');
  const [snapshotStatus, setSnapshotStatus] = useState({});
  const [snapshotPending, setSnapshotPending] = useState({});
  const saveSnapshot = async (name) => {
    if (snapshotPending[name]) return;
    const content = snapshotText;
    setSnapshotPending(s => ({ ...s, [name]: true }));
    const res = await call('/api/translator/save', {
      method: 'POST',
      body: { file: name, content },
    });
    const readback = res.ok && res.body?.success === true
      ? await call(`/api/translator/load?file=${encodeURIComponent(name)}`)
      : null;
    setSnapshotStatus((s) => ({
      ...s,
      [name]: !res.ok || res.body?.success !== true
        ? refusal(res.status, res.body || { error: 'The save returned no result.' })
        : readback?.ok && readback.body?.success === true && readback.body.content === content
          ? { tone: 'ok', title: 'Saved and read back' }
          : { tone: 'warn', title: 'Save accepted; stored content was not verified.', next: 'Load the stored snapshot before another save. Do not automatically repeat the write.' },
    }));
    setSnapshotPending(s => ({ ...s, [name]: false }));
  };
  const loadSnapshot = async (name) => {
    const res = await call(`/api/translator/load?file=${encodeURIComponent(name)}`);
    if (!res.ok) {
      setSnapshotStatus((s) => ({ ...s, [name]: refusal(res.status, res.body) }));
      return;
    }
    setSnapshotText(res.body.content);
    setSnapshotStatus((s) => ({ ...s, [name]: { tone: 'ok', title: 'Loaded' } }));
  };

  return (
    <>
      <div className="screen-head">
        <h1>Translation</h1>
        <Freshness status={stream.status} lastDataAt={stream.lastDataAt} />
      </div>
      {done ? <Notice {...done} /> : null}
      <p><Link href="/dashboard/requests">Open API requests</Link> for a complete gateway request, or <Link href="/dashboard/compatibility">Open the retained compatibility workbench</Link> to save suitable fixtures, pin revisions, inspect local checks and export a run receipt.</p>

      <section aria-labelledby="h-translate">
        <h2 id="h-translate">Walk the pipeline</h2>
        <p className="caption">
          Translate touches nothing persistent, spends no quota, and makes no outbound call. Only
          the third depth constructs executor diagnostics using a stored account. Credentials are redacted; this does not test authentication or provider acceptance.
        </p>
        <label className="field">
          <span>Request as received</span>
          <Textarea
            classNames={{ input: "translation-code" }}
            rows={6}
            value={clientBodyText}
            onChange={(e) => { bodyRevision.current++; setClientBodyText(e.target.value); setD1(null); setD2(null); setD3(null); }}
            spellCheck={false}

          />
        </label>
        <div className="toolbar">
          <fieldset className="segmented">
            <legend>Depth</legend>
            {DEPTHS.map(([v, label]) => (
              <label key={v}>
                <input
                  type="radio"
                  name="depth"
                  checked={depth === v}
                  onChange={() => setDepth(v)}
                />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
          <label className="field">
            <span>Provider</span>
            <Input
              value={provider}
              onChange={(e) => { bodyRevision.current++; setProvider(e.target.value); setD3(null); }}

            />
          </label>
          <label className="field">
            <span>Model</span>
            <Input
              value={model}
              onChange={(e) => { bodyRevision.current++; setModel(e.target.value); setD3(null); }}

            />
          </label>
          <div className="actions">
            <Button type="button"  onClick={translate} disabled={translating}>
              Translate
            </Button>
          </div>
        </div>

        <h3>Depth 1, format detection</h3>
        {d1?.error ? <Notice {...d1.error} /> : null}
        {d1?.data ? (
          <dl className="facts">
            <dt>Provider</dt>
            <dd>{d1.data.provider}</dd>
            <dt>Model</dt>
            <dd>{d1.data.model}</dd>
            <dt>Detected source format</dt>
            <dd>{d1.data.sourceFormat}</dd>
            <dt>Target format</dt>
            <dd>{d1.data.targetFormat}</dd>
            <dt>Direct bridge or neutral pivot</dt>
            <dd>
              {d1.data.route ? `${d1.data.route.mode} · ${d1.data.route.supported ? 'registered conversion available' : 'conversion unavailable'}` : <span className="unreported">Not reported</span>}
              {d1.data.route?.edges && <p>{d1.data.route.edges.map((edge) => `${edge.from} → ${edge.to}`).join(' · ')}</p>}
            </dd>
          </dl>
        ) : null}

        <h3>Depth 2, converted to neutral format</h3>
        {d2?.error ? <Notice {...d2.error} /> : null}
        {d2?.data ? (
          <>
            <pre className="translation-code" tabIndex={0}>
              {JSON.stringify(d2.data, null, 2)}
            </pre>
            <div className="actions">
              <Button
                type="button"
                variant="subtle"
                onClick={() => setSnapshotText(JSON.stringify(d2.data, null, 2))}
              >
                Copy into the snapshot editor
              </Button>
            </div>
          </>
        ) : null}

        <h3>Depth 3, converted to target format</h3>
        {d3?.error ? <Notice {...d3.error} /> : null}
        {d3?.data ? (
          <>
            <p className="caption">
              Local executor construction only. No authenticated request was sent and no upstream schema acceptance was established. {d3.data.diagnosticRedaction}
            </p>
            <dl className="facts">
              <dt>URL</dt>
              <dd className="id">
                {d3.data.url}
              </dd>
            </dl>
            <pre className="translation-code" tabIndex={0}>
              {JSON.stringify(d3.data.body, null, 2)}
            </pre>
            <div className="actions">
              <Button
                type="button"
                variant="subtle"
                onClick={() => setSnapshotText(JSON.stringify(d3.data.body, null, 2))}
              >
                Copy into the snapshot editor
              </Button>
            </div>
          </>
        ) : null}
      </section>

      <section aria-labelledby="h-send">
        <h2 id="h-send">Send to a provider</h2>
        <p className="caption">
          Sends directly through the first active connection’s provider executor. This may spend real quota and refresh stored credentials. It does not validate full gateway routing, account eligibility, fallback or client-key budget admission.
        </p>
        <label className="field">
          <span>Body to send (defaults to the request above)</span>
          <Textarea
            classNames={{ input: "translation-code" }}
            rows={4}
            placeholder={clientBodyText}
            value={sendBodyText}
            onChange={(e) => setSendBodyText(e.target.value)}
            spellCheck={false}

          />
        </label>
        <div className="actions">
          <Button type="button"  onClick={requestSend}>
            Send
          </Button>
        </div>
        {sendResult ? (
          <dl className="facts">
            <dt>Outcome</dt>
            <dd>
              {sendResult.status === 400 ? (
                <Notice {...refusal(400, sendResult.body)} />
              ) : (
                <span
                  className="status"
                  data-tone={SEND_TONE[classifySend(sendResult.status, sendResult.ok)]}
                >
                  {SEND_WORD[classifySend(sendResult.status, sendResult.ok)]}
                </span>
              )}
            </dd>
            <dt>Stored account selected</dt>
            <dd>{sendResult.metadata?.connectionId || 'Not reported'}</dd>
            <dt>Request scope</dt><dd>{sendResult.metadata?.scope || 'Not reported'}</dd>
            <dt>Refreshed credentials saved</dt><dd>{sendResult.metadata?.credentialRefreshed === true ? 'Yes' : sendResult.metadata?.credentialRefreshed === false ? 'No' : 'Not reported'}</dd>
          </dl>
        ) : null}
        {sendResult?.body?.complete === false && <Notice tone="warn" title="Diagnostic preview is incomplete" next="The response exceeded the 1 MiB preview limit and reading was cancelled. This does not establish provider completion. No request was replayed." />}
        {sendResult?.ok && sendResult.body?.raw ? (
          <>
            <p className="caption">
              What the provider actually returned, before anything translates it back:
            </p>
            <pre className="translation-code" tabIndex={0}>
              {sendResult.body.raw}
            </pre>
            <div className="actions">
              <Button
                type="button"
                variant="subtle"
                onClick={() => setSnapshotText(sendResult.body.raw)}
              >
                Copy into the snapshot editor
              </Button>
            </div>
          </>
        ) : null}
        {sendResult && !sendResult.ok && sendResult.status !== 400 ? (
          <Notice {...refusal(sendResult.status, sendResult.body)} />
        ) : null}
      </section>

      <section aria-labelledby="h-snapshots">
        <h2 id="h-snapshots">Stage snapshots</h2>
        <p className="caption">
          A snapshot lives under one of eight fixed names. An arbitrary name is refused, because a
          name would otherwise choose where on the machine the content lands.
        </p>
        <div className="panel">
          <div className="panel-head">
            <h3>Snapshot editor</h3>
          </div>
          <label className="field">
            <span>Snapshot content, as JSON</span>
            <Textarea
              classNames={{ input: "translation-code" }}
              rows={6}
              value={snapshotText}
              onChange={(e) => setSnapshotText(e.target.value)}
              spellCheck={false}

            />
          </label>
          <p className="caption">
            Load a name below to read it here. Save writes this text back under that name.
          </p>
        </div>
        <div className="panel">
          <div className="panel-head">
            <h3>The eight fixed names</h3>
          </div>
          <div className="rows">
            {SNAPSHOT_NAMES.map((name) => (
              <div key={name} className="row translation-snapshot-row">
                <span className="id">
                  {name}
                </span>
                <Button type="button" variant="default" onClick={() => loadSnapshot(name)}>
                  <Icon name="i-refresh" />
                  Load
                </Button>
                <Button type="button" variant="default" disabled={snapshotPending[name]} onClick={() => saveSnapshot(name)}>
                  <Icon name="i-edit" />
                  Save
                </Button>
                {snapshotStatus[name] ? <Notice {...snapshotStatus[name]} /> : null}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section aria-labelledby="h-console">
        <div className="screen-head">
          <h2 id="h-console">Console records</h2>
          <Freshness status={stream.status} lastDataAt={stream.lastDataAt} />
        </div>
        <p className="caption">
          Every line is plain text. A bearer token, an sk- key, or a cookie header is replaced with
          [redacted] before it renders. No session, client, or request id is ever shown as a
          labelled fact here.
        </p>
        <div className="panel">
          <div className="panel-head">
            <h3>Live console</h3>
            <span className="caption">
              <span>{fmtNum(shown.length)}</span> <span>of</span>{' '}
              <span>{fmtNum(logs.length)}</span> <span>lines shown</span>
            </span>
          </div>
          <div className="verb-row">
            <label className="field">
              <span>Filter</span>
              <Input value={filter} onChange={(e) => setFilter(e.target.value)} />
            </label>
            <Button type="button" variant="default" onClick={() => setPaused((p) => !p)}>
              <Icon name={paused ? 'i-play' : 'i-pause'} />
              {paused ? 'Resume' : 'Pause'}
            </Button>
            <Button type="button" variant="default" onClick={checkNow}>
              <Icon name="i-refresh" />
              Check for new lines
            </Button>
            <Button type="button" color="red" onClick={clearLogs}>
              <Icon name="i-delete" />
              Clear
            </Button>
          </div>
          {lastCheck ? (
            lastCheck.error ? (
              <Notice {...lastCheck.error} />
            ) : (
              <p className="caption">
                {lastCheck.changed ? 'New lines arrived.' : 'Nothing new since last look.'} Revision{' '}
                <span>{fmtNum(lastCheck.revision)}</span>
              </p>
            )
          ) : null}
          {stream.status === 'stale' ? (
            <Notice
              tone="warn"
              title="The console stream stopped."
              next="Lines below are from the last frame received. Reconnecting in the background."
            />
          ) : null}
          {logs.length === 0 ? (
            <p className="empty">
              No console record yet. One appears here the next time the gateway logs anything.
            </p>
          ) : null}
          {logs.length && shown.length === 0 ? (
            <p className="empty">No line matches this filter.</p>
          ) : null}
          {shown.length ? (
            <ol
              className="translation-log"
              tabIndex={0}
              aria-label="Console lines"
              aria-live={paused ? undefined : 'polite'}
            >
              {shown.map((line, i) => (
                <li key={i}>
                  {redact(line)}
                </li>
              ))}
            </ol>
          ) : null}
          <p className="caption">Capped at 500 lines in this view.</p>
        </div>
      </section>

      <Confirm
        open={Boolean(ask)}
        title={ask?.title}
        verb={ask?.verb}
        requires={ask?.requires}
        changes={ask?.changes}
        undo={ask?.undo}
        irreversible={ask?.irreversible || false}
        busy={busy}
        refusal={deny}
        onConfirm={confirm}
        onClose={close}
      >
        {busy && ask?.kind === 'provider-send' && <Button variant="default" onClick={() => sendController.current?.abort()}>Stop reading this send</Button>}
      </Confirm>
    </>
  );
}
