'use client';
import { useCallback, useEffect, useState } from 'react';
import { call } from '@/shared/api';
import { Confirm } from '@/shared/components/Confirm';
import { Notice } from '@/shared/components/Notice';

const label = key => key.replace(/Enabled$/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
const signed = value => `${value > 0 ? '+' : ''}${value.toLocaleString()} B`;
const acknowledged = settings => Object.keys(settings || {}).filter(key => settings[key] === true);
const diff = (before, after) => Object.keys(after || {}).filter(key => JSON.stringify(before?.[key]) !== JSON.stringify(after[key]));
const good = row => row.validity.toolTransactionsValid && row.validity.currentPreserved && row.validity.liveThinkingPreserved && row.validity.errorEvidencePreserved && !row.stages.some(s => s.status === 'error');

export function ShapingWorkbench() {
  const [current, setCurrent] = useState(null), [profiles, setProfiles] = useState([]), [pagination, setPagination] = useState(null), [page, setPage] = useState(1);
  const [draft, setDraft] = useState(null), [name, setName] = useState(''), [editing, setEditing] = useState(null), [consent, setConsent] = useState(false);
  const [baseline, setBaseline] = useState(null), [candidate, setCandidate] = useState(null), [fixtureSetId, setFixtureSetId] = useState('');
  const [experiment, setExperiment] = useState(null), [history, setHistory] = useState([]), [receipts, setReceipts] = useState([]), [review, setReview] = useState(null);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(null), [reviewConsent, setReviewConsent] = useState(false), [unsupportedConsent, setUnsupportedConsent] = useState(false);
  const applyRecords = useCallback(responses => {
    const failed = responses.find(r => !r.ok);
    if (failed) { setNotice({ tone: 'warn', title: 'Workbench unavailable', children: failed.body?.code || 'The saved records could not be read.' }); return; }
    setCurrent(responses[0].body); setProfiles(responses[1].body.rows); setPagination(responses[1].body.pagination); setHistory(responses[2].body.rows); setReceipts(responses[3].body.rows);
    setDraft(previous => previous || responses[0].body.settings);
  }, []);
  const readRecords = useCallback(() => Promise.all([call('/api/admin/shaping'), call(`/api/admin/shaping/profiles?page=${page}&pageSize=10`), call('/api/admin/shaping/experiments?pageSize=10'), call('/api/admin/shaping/receipts?pageSize=10')]), [page]);
  async function refresh() { applyRecords(await readRecords()); }
  useEffect(() => {
    let ignore = false;
    void readRecords().then(responses => { if (!ignore) applyRecords(responses); });
    return () => { ignore = true; };
  }, [readRecords, applyRecords]); // Selection is held separately from the refreshed library.
  async function mutate(path, body, success) {
    setBusy(true); setNotice(null);
    try {
      const response = await call(`/api/admin/shaping/${path}`, { method: 'POST', body });
      if (!response.ok) { setNotice({ tone: 'warn', title: 'Change refused', children: response.body?.code || 'The operation did not complete.' }); return; }
      if (response.status === 207) setNotice({ tone: 'warn', title: 'Persistence unconfirmed', children: response.body.recovery });
      else setNotice({ tone: 'ok', title: success });
      await refresh(); return response.body;
    } finally { setBusy(false); }
  }
  async function save() {
    const result = await mutate('profiles', { name, settings: draft, consent: consent ? acknowledged(draft) : [], ...(editing ? { profileId: editing.profileId, expectedRevision: editing.revision } : {}) }, 'Profile version saved. Live settings were not changed.');
    if (result) { setEditing(result.version); setCandidate(result.version); setConsent(false); }
  }
  async function run() {
    const result = await mutate('experiments', { baselineVersionId: baseline.id, candidateVersionId: candidate.id, fixtureSetId }, 'Offline comparison retained. Live settings were not changed.');
    if (result) setExperiment(result);
  }
  async function inspectExperiment(id) {
    const response = await call(`/api/admin/shaping/experiments/${id}`);
    if (response.ok) {
      setExperiment(response.body);
      const versions = await Promise.all([call(`/api/admin/shaping/profiles/${response.body.baselineVersionId}`), call(`/api/admin/shaping/profiles/${response.body.candidateVersionId}`)]);
      if (versions.every(r => r.ok)) { setBaseline(versions[0].body); setCandidate(versions[1].body); }
    } else setNotice({ tone: 'warn', title: 'Comparison could not be read' });
  }
  const resultMatches = experiment && candidate?.id === experiment.candidateVersionId && baseline?.id === experiment.baselineVersionId;
  async function confirm() {
    const body = review.rollback ? { rollbackReceiptId: review.rollback.id, expectedCurrent: review.currentHash, consent: reviewConsent ? acknowledged(review.settings) : [] } : { versionId: candidate.id, experimentId: experiment.id, expectedCurrent: review.currentHash, consent: reviewConsent ? acknowledged(review.settings) : [], acknowledgeUnsupported: unsupportedConsent ? experiment.result.candidate.unsupported : [] };
    const result = await mutate(review.rollback ? 'rollback' : 'promote', body, review.rollback ? 'Previous Shaping settings restored.' : 'Profile promoted for new requests.');
    if (result) setReview(null);
  }
  function openReview(settings, rollback) { setNotice(null); setReview({ settings, rollback, currentHash: current.currentHash, before: current.settings }); setReviewConsent(false); setUnsupportedConsent(false); }
  if (!current || !draft) return <section><h2>Profiles and offline experiments</h2>{notice ? <Notice {...notice} /> : <p>Reading saved profiles.</p>}</section>;
  return <section className="shaping-workbench" aria-labelledby="shaping-workbench-title">
    <div className="panel-head"><h2 id="shaping-workbench-title">Profiles and offline experiments</h2><button className="button quiet" onClick={refresh} disabled={busy}>Refresh records</button></div>
    <p>Compare local transformations on a reusable synthetic set before applying a named profile. Smaller requests do not establish better answers, fewer billed tokens, or lower cost.</p>
    {notice ? <Notice {...notice} /> : null}
    <div className="shaping-workspace-grid">
      <div className="shaping-library"><h3>Saved versions</h3><p className="caption">{pagination?.total || 0} versions. Selecting one does not change live traffic.</p>
        <div className="rows">{profiles.map(profile => <div className="shaping-profile-row" key={profile.id} data-selected={candidate?.id === profile.id || undefined}>
          <span><strong>{profile.name}</strong><span className="sub">Version {profile.revision} · record {profile.id}</span></span>
          <div className="actions"><button className="button quiet" onClick={() => setBaseline(profile)}>Baseline</button><button className="button quiet" onClick={() => setCandidate(profile)}>Candidate</button><button className="button quiet" onClick={() => { setEditing(profile); setDraft(profile.settings); setName(profile.name); setConsent(false); }}>Revise</button></div>
        </div>)}</div>
        {!profiles.length ? <p>No saved profile yet. Name the settings on the right and save the first version.</p> : null}
        <div className="actions"><button className="button quiet" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page} of {pagination?.pages || 1}</span><button className="button quiet" disabled={page >= (pagination?.pages || 1)} onClick={() => setPage(page + 1)}>Next</button></div>
      </div>
      <div className="shaping-editor"><h3>{editing ? `Revise ${editing.name}` : 'New profile'}</h3>
        <label>Profile name<input value={name} maxLength={100} onChange={e => setName(e.target.value)} /></label>
        <div className="actions"><button className="button quiet" onClick={() => { setDraft(current.settings); setEditing(null); setName(''); setConsent(false); }}>Start from current settings</button></div>
        <details><summary>Review and edit all {Object.keys(draft).length} scoped settings</summary><div className="shaping-setting-grid">{Object.entries(draft).map(([key, value]) => <label key={key}>
          <span>{label(key)}</span>{typeof value === 'boolean' ? <input type="checkbox" checked={value} onChange={e => { setDraft({ ...draft, [key]: e.target.checked }); setConsent(false); }} /> : Array.isArray(value) ? <textarea value={value.join('\n')} onChange={e => { setDraft({ ...draft, [key]: e.target.value ? e.target.value.split('\n') : [] }); setConsent(false); }} /> : key.endsWith('Level') ? <select value={value} onChange={e => { setDraft({ ...draft, [key]: e.target.value }); setConsent(false); }}>{['lite', 'full', 'ultra'].map(level => <option key={level}>{level}</option>)}</select> : <input type="number" value={value ?? ''} onChange={e => { setDraft({ ...draft, [key]: e.target.value === '' ? null : Number(e.target.value) }); setConsent(false); }} />}
        </label>)}</div></details>
        <p className="caption">History pruning, reasoning removal, disclosure, rewriting and prompt additions may alter content. Removed content is not recovered by later disabling a stage.</p>
        <label className="shaping-consent"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />I have reviewed these settings and consent to the selected content-changing transformations in this saved profile.</label>
        <button className="button" disabled={busy || !name.trim() || !consent} onClick={save}>Save profile version</button>
      </div>
    </div>
    <div className="shaping-comparison"><h3>Offline comparison</h3><div className="shaping-comparison-controls">
      <p>Baseline <strong>{baseline ? `${baseline.name} v${baseline.revision}` : 'Choose a saved version'}</strong></p><p>Candidate <strong>{candidate ? `${candidate.name} v${candidate.revision}` : 'Choose a saved version'}</strong></p>
      <label>Synthetic fixture set<select value={fixtureSetId} onChange={e => setFixtureSetId(e.target.value)}><option value="">Select a reusable set</option>{current.fixtureSets.map(set => <option key={set.id} value={set.id}>{set.name} v{set.revision} ({set.count} cases)</option>)}</select></label>
      <button className="button" disabled={busy || !baseline || !candidate || !fixtureSetId} onClick={run}>Run offline comparison</button>
    </div>
    {resultMatches ? <><p className="caption">Stage evaluator only. No provider calls. Token counts, cost, task quality and provider cache billing are unmeasured. Local execution {experiment.result.localExecutionMs.toFixed(2)} ms.</p>
      {experiment.result.candidate.unsupported.length ? <Notice tone="warn" title={`Unsupported candidate stages: ${experiment.result.candidate.unsupported.join(', ')}`} >These services or runtime states were not simulated or contacted.</Notice> : null}
      <div className="shaping-table-scroll"><table><thead><tr><th>Fixture</th><th>Baseline bytes</th><th>Candidate bytes</th><th>Candidate − baseline</th><th>Local time, baseline / candidate</th><th>Integrity checks</th></tr></thead><tbody>{experiment.result.candidate.results.map((row, i) => <tr key={row.fixtureId}><th>{row.fixtureId}</th><td>{experiment.result.baseline.results[i].afterBytes.toLocaleString()}</td><td>{row.afterBytes.toLocaleString()}</td><td>{signed(row.afterBytes - experiment.result.baseline.results[i].afterBytes)}</td><td>{experiment.result.baseline.results[i].latencyMs.toFixed(2)} / {row.latencyMs.toFixed(2)} ms</td><td>{good(row) ? 'Passed fixture checks' : 'Failed, inspect evidence'}</td></tr>)}</tbody></table></div>
      <details><summary>Inspect stage outcomes and retained request evidence</summary>{experiment.result.candidate.results.map(row => <details key={row.fixtureId}><summary>{row.fixtureId}</summary><div className="shaping-table-scroll"><table><thead><tr><th>Stage</th><th>Outcome</th><th>Signed bytes</th><th>Local time</th><th>Coverage</th></tr></thead><tbody>{row.stages.map(stage => <tr key={stage.stage}><th>{stage.stage}</th><td>{stage.status}</td><td>{signed(stage.deltaBytes)}</td><td>{stage.latencyMs.toFixed(2)} ms</td><td>{stage.reason || stage.error || 'Local implementation'}</td></tr>)}</tbody></table></div><p>{row.validity.schemaValidation}</p><pre className="shaping-log">{JSON.stringify({ validity: row.validity, beforeHash: row.beforeHash, afterHash: row.afterHash, output: row.output }, null, 2)}</pre></details>)}</details>
      <button className="button" disabled={busy || !experiment.result.candidate.results.every(good)} onClick={() => openReview(candidate.settings)}>Review promotion</button>
    </> : <p>Choose saved versions and a fixture set. Each comparison is retained and can be reopened below.</p>}
    <details><summary>Recent retained comparisons ({history.length})</summary>{history.map(item => <button className="button quiet" key={item.id} onClick={() => inspectExperiment(item.id)}>{item.createdAt} · {item.fixtureSetId} · records {item.baselineVersionId} / {item.candidateVersionId}</button>)}</details>
    </div>
    <h3>Promotion and rollback receipts</h3><p>{current.coverage.takesEffect} Service endpoints, routing policy and per-plan overrides are outside this profile.</p>
    {receipts.length ? receipts.map(receipt => <div className="shaping-profile-row" key={receipt.id}><span>{receipt.action} · {receipt.createdAt}<span className="sub">{diff(receipt.beforeSettings, receipt.afterSettings).length} changed settings</span></span><button className="button quiet" onClick={() => openReview(receipt.beforeSettings, receipt)}>Review rollback</button></div>) : <p>No profile has been promoted. Existing live settings remain in use.</p>}
    <Confirm open={!!review} title={review?.rollback ? 'Restore previous Shaping settings' : 'Promote this profile'} verb={review?.rollback ? 'Restore settings' : 'Promote profile'} requires="Signed-in local operator; current settings must match this review." changes={current.coverage.takesEffect} undo="Use the retained receipt to review a rollback. Removed request content cannot be recovered." busy={busy || !reviewConsent || (!review?.rollback && experiment?.result.candidate.unsupported.length > 0 && !unsupportedConsent)} refusal={notice?.tone === 'warn' ? notice : null} onConfirm={confirm} onClose={() => setReview(null)}>
      <p>Only the following global settings change.</p><div className="shaping-table-scroll"><table><thead><tr><th>Setting</th><th>Current</th><th>Proposed</th></tr></thead><tbody>{diff(review?.before, review?.settings).map(key => <tr key={key}><th>{label(key)}</th><td>{JSON.stringify(review.before[key])}</td><td>{JSON.stringify(review.settings[key])}</td></tr>)}</tbody></table></div>
      <label className="shaping-consent"><input type="checkbox" checked={reviewConsent} onChange={e => setReviewConsent(e.target.checked)} />I consent to the reviewed content changes for new requests.</label>
      {!review?.rollback && experiment?.result.candidate.unsupported.length ? <label className="shaping-consent"><input type="checkbox" checked={unsupportedConsent} onChange={e => setUnsupportedConsent(e.target.checked)} />I understand {experiment.result.candidate.unsupported.join(', ')} were not evaluated. No task-quality or cost improvement has been established.</label> : null}
    </Confirm>
  </section>;
}
