'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEventStream } from '@/shared/hooks/useEventStream';
import { Freshness } from '@/shared/components/Freshness';
import { Notice } from '@/shared/components/Notice';
import { Confirm } from '@/shared/components/Confirm';
import { call } from '@/shared/api';
import { refusal } from '@/shared/refusal';
import { fmtNum } from '@/shared/format';
import './styles.css';

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

const OPERATOR = 'An operator session on this gateway.';

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
  if (status === 502) return 'timeout';
  if (status === 400) return 'invalid';
  return 'refused';
}

const SEND_WORD = {
  succeeded: 'Succeeded',
  abandoned: 'Abandoned by the caller',
  timeout: 'Timed out before connection',
  refused: 'Refused upstream',
};
const SEND_TONE = { succeeded: 'ok', abandoned: 'warn', timeout: 'warn', refused: 'bad' };

// Captures raw text so the panel can show what the provider actually
// returned. `@/shared/api`'s call() discards a non-JSON body, which this
// action needs, so it fetches directly rather than through that helper.
async function sendRaw(body) {
  try {
    const res = await fetch('/api/translator/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, status: res.status, body: await res.json().catch(() => null) };
    return { ok: true, status: res.status, body: { raw: await res.text() } };
  } catch (e) {
    return { ok: false, status: 0, body: { error: e.message, code: 'network' } };
  }
}

export default function TranslationPage() {
  const [logs, setLogs] = useState([]);
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
  const [translating, setTranslating] = useState(false);

  const translate = async () => {
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
      if (!res.ok) {
        setD2({ error: refusal(res.status, res.body) });
        return;
      }
      setD2({ data: res.body.result.body });
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
      title: 'Send this request to a live provider',
      verb: 'Send',
      requires: OPERATOR,
      changes:
        'A stored account is selected for the provider, a real upstream call is made, and it spends real quota against that account. A refresh during the call writes a new stored secret back.',
      undo: 'None. The call already happened and cannot be recalled.',
      irreversible: true,
      hardDeny: false,
      run: () => sendRaw({ provider, model, body }),
      done: (res) => setSendResult({ ok: res.ok, status: res.status, body: res.body }),
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
  const saveSnapshot = async (name) => {
    const res = await call('/api/translator/save', {
      method: 'POST',
      body: { file: name, content: snapshotText },
    });
    setSnapshotStatus((s) => ({
      ...s,
      [name]: res.ok ? { tone: 'ok', title: 'Saved' } : refusal(res.status, res.body),
    }));
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

      <section aria-labelledby="h-translate">
        <h2 id="h-translate">Walk the pipeline</h2>
        <p className="caption">
          Translate touches nothing persistent, spends no quota, and makes no outbound call. Only
          the third depth produces anything a provider could receive.
        </p>
        <label className="field">
          <span>Request as received</span>
          <textarea
            className="input translation-code"
            rows={6}
            value={clientBodyText}
            onChange={(e) => setClientBodyText(e.target.value)}
            spellCheck={false}
            data-i18n-skip
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
            <input
              className="input"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              data-i18n-skip
            />
          </label>
          <label className="field">
            <span>Model</span>
            <input
              className="input"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              data-i18n-skip
            />
          </label>
          <div className="actions">
            <button type="button" className="button" onClick={translate} disabled={translating}>
              Translate
            </button>
          </div>
        </div>

        <h3>Depth 1, format detection</h3>
        {d1?.error ? <Notice {...d1.error} /> : null}
        {d1?.data ? (
          <dl className="facts">
            <dt>Provider</dt>
            <dd data-i18n-skip>{d1.data.provider}</dd>
            <dt>Model</dt>
            <dd data-i18n-skip>{d1.data.model}</dd>
            <dt>Detected source format</dt>
            <dd data-i18n-skip>{d1.data.sourceFormat}</dd>
            <dt>Target format</dt>
            <dd data-i18n-skip>{d1.data.targetFormat}</dd>
            <dt>Direct bridge or neutral pivot</dt>
            <dd>
              <span className="unreported">Not reported</span>
              {/* docs/contract/05-shaping-translator.md:276-284 */}
              <details className="why">
                <summary>Why</summary>
                <p>
                  No route exposes the registered translator pairs or which ones are direct routes.
                </p>
              </details>
            </dd>
          </dl>
        ) : null}

        <h3>Depth 2, converted to neutral format</h3>
        {d2?.error ? <Notice {...d2.error} /> : null}
        {d2?.data ? (
          <>
            <pre className="translation-code" tabIndex={0} data-i18n-skip>
              {JSON.stringify(d2.data, null, 2)}
            </pre>
            <div className="actions">
              <button
                type="button"
                className="link-button"
                onClick={() => setSnapshotText(JSON.stringify(d2.data, null, 2))}
              >
                Copy into the snapshot editor
              </button>
            </div>
          </>
        ) : null}

        <h3>Depth 3, converted to target format</h3>
        {d3?.error ? <Notice {...d3.error} /> : null}
        {d3?.data ? (
          <>
            <p className="caption">
              This is the only depth that produces anything a provider could receive.
            </p>
            <dl className="facts">
              <dt>URL</dt>
              <dd className="id" data-i18n-skip>
                {d3.data.url}
              </dd>
            </dl>
            <pre className="translation-code" tabIndex={0} data-i18n-skip>
              {JSON.stringify(d3.data.body, null, 2)}
            </pre>
            <div className="actions">
              <button
                type="button"
                className="link-button"
                onClick={() => setSnapshotText(JSON.stringify(d3.data.body, null, 2))}
              >
                Copy into the snapshot editor
              </button>
            </div>
          </>
        ) : null}
      </section>

      <section aria-labelledby="h-send">
        <h2 id="h-send">Send to a provider</h2>
        <p className="caption">
          The one action here with effects beyond the trace: it selects a stored account, spends
          real quota, and a refresh mid-call writes a new stored secret back.
        </p>
        <label className="field">
          <span>Body to send (defaults to the request above)</span>
          <textarea
            className="input translation-code"
            rows={4}
            placeholder={clientBodyText}
            value={sendBodyText}
            onChange={(e) => setSendBodyText(e.target.value)}
            spellCheck={false}
            data-i18n-skip
          />
        </label>
        <div className="actions">
          <button type="button" className="button" onClick={requestSend}>
            Send
          </button>
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
            <dd>
              <span className="unreported">Not reported</span>
              {/* src/app/api/translator/send/route.js:97-103, :111 */}
              <details className="why">
                <summary>Why</summary>
                <p>
                  The response carries no connection id and no refresh flag either on success or on
                  failure.
                </p>
              </details>
            </dd>
          </dl>
        ) : null}
        {sendResult?.ok && sendResult.body?.raw ? (
          <>
            <p className="caption">
              What the provider actually returned, before anything translates it back:
            </p>
            <pre className="translation-code" tabIndex={0} data-i18n-skip>
              {sendResult.body.raw}
            </pre>
            <div className="actions">
              <button
                type="button"
                className="link-button"
                onClick={() => setSnapshotText(sendResult.body.raw)}
              >
                Copy into the snapshot editor
              </button>
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
        <label className="field">
          <span>Editor</span>
          <textarea
            className="input translation-code"
            rows={6}
            value={snapshotText}
            onChange={(e) => setSnapshotText(e.target.value)}
            spellCheck={false}
            data-i18n-skip
          />
        </label>
        <div className="rows">
          {SNAPSHOT_NAMES.map((name) => (
            <div
              key={name}
              className="row"
              style={{ gridTemplateColumns: 'minmax(0, 1fr) auto auto' }}
            >
              <span className="id" data-i18n-skip>
                {name}
              </span>
              <button type="button" className="link-button" onClick={() => loadSnapshot(name)}>
                Load
              </button>
              <button type="button" className="link-button" onClick={() => saveSnapshot(name)}>
                Save
              </button>
              {snapshotStatus[name] ? <Notice {...snapshotStatus[name]} /> : null}
            </div>
          ))}
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
        <div className="toolbar">
          <label className="field">
            <span>Filter</span>
            <input className="input" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </label>
          <div className="actions">
            <button type="button" className="button quiet" onClick={() => setPaused((p) => !p)}>
              {paused ? 'Resume' : 'Pause'}
            </button>
            <button type="button" className="link-button" onClick={checkNow}>
              Check for new lines
            </button>
            <button type="button" className="button danger" onClick={clearLogs}>
              Clear
            </button>
          </div>
        </div>
        {lastCheck ? (
          lastCheck.error ? (
            <Notice {...lastCheck.error} />
          ) : (
            <p className="caption">
              {lastCheck.changed ? 'New lines arrived.' : 'Nothing new since last look.'} Revision{' '}
              <span data-i18n-skip>{fmtNum(lastCheck.revision)}</span>
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
          <ol className="translation-log" tabIndex={0} aria-label="Console lines" aria-live={paused ? undefined : 'polite'}>
            {shown.map((line, i) => (
              <li key={i} data-i18n-skip>
                {redact(line)}
              </li>
            ))}
          </ol>
        ) : null}
        <p className="caption">
          Capped at 500 lines in this view. <span data-i18n-skip>{fmtNum(logs.length)}</span> held,{' '}
          <span data-i18n-skip>{fmtNum(shown.length)}</span> shown.
        </p>
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
      />
    </>
  );
}
