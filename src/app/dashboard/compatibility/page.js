'use client';
import { useCallback, useEffect, useState } from 'react';
import { call } from '@/shared/api';
import { refusal } from '@/shared/refusal';
import { Notice } from '@/shared/components/Notice';
import { CompatibilityResult } from '@/shared/compatibility/CompatibilityResult';
import { SAMPLE_FIXTURES } from '@/shared/compatibility/samples';
import { TERMINAL } from '@/lib/compatibility/model.mjs';
import styles from './workbench.module.css';

const short = (value) => (value ? `${value.slice(0, 8)}…` : 'unknown');
const when = (value) => (value ? value.replace('T', ' ').slice(0, 19) : 'unknown');
const emptyDraft = {
  name: '',
  sourceFormat: 'openai',
  targetFormat: 'claude',
  operation: 'request',
  model: 'synthetic-model',
  origin: 'synthetic',
  payloadText: '',
};

export default function CompatibilityPage() {
  const [catalog, setCatalog] = useState(null);
  const [refused, setRefused] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [editing, setEditing] = useState(null); // { id, revision } when revising
  const [consent, setConsent] = useState(false);
  const [runs, setRuns] = useState(null);
  const [runPage, setRunPage] = useState(1);
  const [packet, setPacket] = useState(null);

  const applyCatalog = useCallback((response) => {
    if (!response.ok) setRefused(refusal(response.status, response.body));
    else {
      setRefused(null);
      setCatalog(response.body);
    }
  }, []);
  const readCatalog = useCallback(
    () => call('/api/admin/compatibility').then(applyCatalog),
    [applyCatalog]
  );
  const applyRuns = useCallback((response) => {
    if (response.ok) setRuns(response.body);
  }, []);
  const readRuns = useCallback(
    () => call(`/api/admin/compatibility/runs?page=${runPage}&pageSize=25`).then(applyRuns),
    [runPage, applyRuns]
  );
  const applyPacket = useCallback((response) => {
    if (response.ok) setPacket(response.body);
    else setNotice(refusal(response.status, response.body));
  }, []);
  const readPacket = useCallback(
    (id) => call(`/api/admin/compatibility/runs/${id}`).then(applyPacket),
    [applyPacket]
  );

  useEffect(() => {
    void readCatalog();
  }, [readCatalog]);
  useEffect(() => {
    void readRuns();
  }, [readRuns]);
  // Poll only while the selected run has not reached a terminal receipt.
  useEffect(() => {
    if (!packet || TERMINAL.includes(packet.run.status)) return undefined;
    const timer = setInterval(() => {
      void readPacket(packet.run.id);
      void readRuns();
    }, 1000);
    return () => clearInterval(timer);
  }, [packet, readPacket, readRuns]);

  function loadFixture(fixture) {
    setEditing({ id: fixture.id, revision: fixture.revision });
    setConsent(false);
    setDraft({
      name: fixture.name,
      sourceFormat: fixture.definition.sourceFormat,
      targetFormat: fixture.definition.targetFormat,
      operation: fixture.definition.operation,
      model: fixture.definition.model,
      origin: fixture.definition.origin,
      payloadText: JSON.stringify(fixture.definition.payload, null, 2),
    });
  }
  function loadSample(sample) {
    setEditing(null);
    setConsent(false);
    setDraft({
      name: sample.name,
      sourceFormat: sample.definition.sourceFormat,
      targetFormat: sample.definition.targetFormat,
      operation: sample.definition.operation,
      model: sample.definition.model,
      origin: sample.definition.origin,
      payloadText: JSON.stringify(sample.definition.payload, null, 2),
    });
  }
  async function saveFixture() {
    let payload;
    try {
      payload = JSON.parse(draft.payloadText);
    } catch {
      setNotice({
        tone: 'warn',
        title: 'The payload is not valid JSON.',
        next: 'Fix it and save again. Nothing was retained.',
      });
      return;
    }
    const definition = {
      version: 1,
      origin: draft.origin,
      suitable: consent,
      operation: draft.operation,
      sourceFormat: draft.sourceFormat,
      targetFormat: draft.targetFormat,
      model: draft.model,
      payload,
    };
    setBusy(true);
    setNotice(null);
    const response = editing
      ? await call(`/api/admin/compatibility/fixtures/${editing.id}`, {
          method: 'PATCH',
          body: { name: draft.name, definition, revision: editing.revision },
        })
      : await call('/api/admin/compatibility/fixtures', {
          method: 'POST',
          body: { name: draft.name, definition },
        });
    setBusy(false);
    if (!response.ok) {
      setNotice({
        tone: 'warn',
        title: 'Fixture refused',
        next: response.body?.error || 'The fixture was not retained.',
      });
      return;
    }
    setEditing({ id: response.body.id, revision: response.body.revision });
    setNotice({
      tone: 'ok',
      title: `Revision ${response.body.revision} retained. No run was started.`,
    });
    await readCatalog();
  }
  async function submitRun(fixture) {
    setBusy(true);
    setNotice(null);
    const response = await call('/api/admin/compatibility/runs', {
      method: 'POST',
      body: { fixtureId: fixture.id, revision: fixture.revision },
    });
    setBusy(false);
    if (!response.ok) {
      setNotice({
        tone: 'warn',
        title: response.body?.code === 'queue_full' ? 'Queue full, run refused' : 'Run refused',
        next: response.body?.error || 'Nothing was scheduled.',
      });
      return;
    }
    await readRuns();
    await readPacket(response.body.id);
  }
  async function cancelRun(id) {
    const response = await call(`/api/admin/compatibility/runs/${id}/cancel`, { method: 'POST' });
    if (!response.ok) setNotice(refusal(response.status, response.body));
    await readRuns();
    if (packet?.run.id === id) await readPacket(id);
  }
  function exportPacket() {
    if (!packet) return;
    const blob = new Blob([JSON.stringify(packet, null, 2)], { type: 'application/json' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `compatibility-run-${packet.run.id}.json`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  const pending = runs?.items.filter((run) => !TERMINAL.includes(run.status)) || [];
  const running = pending.filter((run) => run.status === 'running').length;
  const queued = pending.filter((run) => run.status === 'queued').length;

  return (
    <>
      <div className="screen-head">
        <h1>Compatibility</h1>
      </div>
      <p>
        Retained local translation runs on explicitly suitable fixtures. No provider is called, no
        credential is read, and no result establishes upstream readiness.
      </p>
      {refused ? <Notice {...refused} /> : null}
      {notice ? <Notice {...notice} /> : null}
      {!catalog && !refused ? <p className="skeleton">Reading retained fixtures</p> : null}
      {catalog ? (
        <div className={styles.grid}>
          <section className={styles.book} aria-labelledby="compat-fixtures">
            <h2 id="compat-fixtures">Fixture book</h2>
            <p className="caption">
              {catalog.fixtures.length} fixtures of {catalog.limits.fixtureIds} retained. A run pins
              one exact revision.
            </p>
            <div>
              {catalog.fixtures.map((fixture) => (
                <div
                  key={fixture.id}
                  className={styles.fixtureRow}
                  data-selected={editing?.id === fixture.id || undefined}
                >
                  <span>
                    <strong>{fixture.name}</strong>
                    <span className={styles.sub}>
                      rev {fixture.revision} · {fixture.definition.sourceFormat} →{' '}
                      {fixture.definition.targetFormat} · {fixture.definition.operation} · hash{' '}
                      {short(fixture.contentHash)}
                    </span>
                  </span>
                  <span className={styles.actions}>
                    <button
                      type="button"
                      className="button quiet"
                      onClick={() => loadFixture(fixture)}
                    >
                      Revise
                    </button>
                    <button
                      type="button"
                      className="button"
                      disabled={busy || fixture.archived}
                      onClick={() => submitRun(fixture)}
                    >
                      Run revision {fixture.revision}
                    </button>
                  </span>
                </div>
              ))}
              {!catalog.fixtures.length ? (
                <p className="empty">
                  No fixture is retained yet. Save one on this page; historical traffic is never
                  imported.
                </p>
              ) : null}
            </div>
            <div className={styles.editor}>
              <h3>{editing ? `Revise as revision ${editing.revision + 1}` : 'New fixture'}</h3>
              <div className={styles.actions}>
                {SAMPLE_FIXTURES.map((sample) => (
                  <button
                    key={sample.name}
                    type="button"
                    className="button quiet"
                    onClick={() => loadSample(sample)}
                  >
                    Insert {sample.name.toLowerCase()}
                  </button>
                ))}
                {editing ? (
                  <button
                    type="button"
                    className="button quiet"
                    onClick={() => {
                      setEditing(null);
                      setDraft(emptyDraft);
                      setConsent(false);
                    }}
                  >
                    Start a new fixture instead
                  </button>
                ) : null}
              </div>
              <div className={styles.editorGrid}>
                <label>
                  Fixture name
                  <input
                    value={draft.name}
                    maxLength={120}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </label>
                <label>
                  Model label (no account is selected)
                  <input
                    value={draft.model}
                    maxLength={160}
                    onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                  />
                </label>
                <label>
                  Source format
                  <select
                    value={draft.sourceFormat}
                    onChange={(e) => setDraft({ ...draft, sourceFormat: e.target.value })}
                  >
                    {catalog.formats.map((format) => (
                      <option key={format}>{format}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Target format
                  <select
                    value={draft.targetFormat}
                    onChange={(e) => setDraft({ ...draft, targetFormat: e.target.value })}
                  >
                    {catalog.formats.map((format) => (
                      <option key={format}>{format}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Operation
                  <select
                    value={draft.operation}
                    onChange={(e) => setDraft({ ...draft, operation: e.target.value })}
                  >
                    <option value="request">request</option>
                    <option value="stream">stream (ordered synthetic events)</option>
                  </select>
                </label>
                <label>
                  Origin
                  <select
                    value={draft.origin}
                    onChange={(e) => setDraft({ ...draft, origin: e.target.value })}
                  >
                    <option value="synthetic">synthetic</option>
                    <option value="operator-submitted">operator-submitted</option>
                  </select>
                </label>
              </div>
              <label>
                {draft.operation === 'stream' ? 'Ordered JSON event list' : 'Request payload JSON'}
                <textarea
                  value={draft.payloadText}
                  spellCheck={false}
                  onChange={(e) => setDraft({ ...draft, payloadText: e.target.value })}
                />
              </label>
              <label className={styles.consent}>
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                This is synthetic or suitable operator-submitted test content with no credentials or
                private production traffic. Credential-like content is refused, not redacted.
              </label>
              <button
                type="button"
                className="button"
                disabled={busy || !draft.name.trim() || !consent}
                onClick={saveFixture}
              >
                {editing ? 'Save as new revision' : 'Save fixture'}
              </button>
            </div>
          </section>
          <section className={styles.inspector} aria-labelledby="compat-runs">
            <h2 id="compat-runs">Runs</h2>
            <p className={styles.queue} aria-live="polite">
              One isolated worker, <b>{catalog.limits.queued}</b> waiting slots,{' '}
              <b>{catalog.limits.timeoutMs / 1000} s</b> deadline. Now <b>{running}</b> running ·{' '}
              <b>{queued}</b> queued. A submission past the queue is refused, never dropped.
            </p>
            <div
              className={styles.tableScroll}
              tabIndex={0}
              role="region"
              aria-label="Retained run history"
            >
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Created (UTC)</th>
                    <th scope="col">Fixture</th>
                    <th scope="col">Rev</th>
                    <th scope="col">Hash</th>
                    <th scope="col">Implementation</th>
                    <th scope="col">State</th>
                    <th scope="col">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {(runs?.items || []).map((run) => (
                    <tr key={run.id} data-selected={packet?.run.id === run.id || undefined}>
                      <td>{when(run.createdAt)}</td>
                      <td>
                        <button
                          type="button"
                          aria-label={`Inspect run ${run.id}`}
                          onClick={() => readPacket(run.id)}
                        >
                          <code>{short(run.fixtureId)}</code>
                        </button>
                      </td>
                      <td>{run.fixtureRevision}</td>
                      <td>
                        <code>{short(run.fixtureHash)}</code>
                      </td>
                      <td>
                        <code>{run.implementationVersion || 'unknown'}</code>
                      </td>
                      <td>{run.status}</td>
                      <td>
                        {TERMINAL.includes(run.status) ? (
                          '—'
                        ) : (
                          <button type="button" onClick={() => cancelRun(run.id)}>
                            Cancel
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {runs && !runs.items.length ? (
                <p className="empty">No run is retained yet. Start one from the fixture book.</p>
              ) : null}
            </div>
            {runs?.pagination ? (
              <div className={styles.actions}>
                <button
                  type="button"
                  className="button quiet"
                  disabled={runPage === 1}
                  onClick={() => setRunPage(runPage - 1)}
                >
                  Previous
                </button>
                <span className="caption">
                  Page {runs.pagination.page} of {Math.max(1, runs.pagination.totalPages)} ·{' '}
                  {runs.pagination.total} retained
                </span>
                <button
                  type="button"
                  className="button quiet"
                  disabled={runPage >= runs.pagination.totalPages}
                  onClick={() => setRunPage(runPage + 1)}
                >
                  Next
                </button>
              </div>
            ) : null}
            <CompatibilityResult
              packet={packet}
              onExport={exportPacket}
              onCancel={() => packet && cancelRun(packet.run.id)}
            />
          </section>
        </div>
      ) : null}
      {catalog ? (
        <section aria-labelledby="compat-evidence">
          <h2 id="compat-evidence">Capability evidence</h2>
          <p className="caption">{catalog.evidenceBasis}</p>
          <div
            className={styles.tableScroll}
            tabIndex={0}
            role="region"
            aria-label="Retained edge evidence"
          >
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">Target</th>
                  <th scope="col">Operation</th>
                  <th scope="col">Runs</th>
                  <th scope="col">Passed</th>
                  <th scope="col">Failed</th>
                  <th scope="col">Other terminal</th>
                  <th scope="col">Last run (UTC)</th>
                </tr>
              </thead>
              <tbody>
                {catalog.evidence.map((edge) => (
                  <tr key={`${edge.sourceFormat}:${edge.targetFormat}:${edge.operation}`}>
                    <td>{edge.sourceFormat || 'unknown'}</td>
                    <td>{edge.targetFormat || 'unknown'}</td>
                    <td>{edge.operation || 'unknown'}</td>
                    <td>{edge.runs}</td>
                    <td>{edge.passed}</td>
                    <td>{edge.failed}</td>
                    <td>{edge.other}</td>
                    <td>{when(edge.lastRunAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!catalog.evidence.length ? (
              <p className="empty">
                No retained run yet, so no edge has evidence. Absence of evidence is unknown, not
                unsupported.
              </p>
            ) : null}
          </div>
        </section>
      ) : null}
    </>
  );
}
