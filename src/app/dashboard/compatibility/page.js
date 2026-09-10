'use client';
import {
  ActionIcon,
  Button,
  Checkbox,
  Loader,
  NativeSelect,
  SegmentedControl,
  Table,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { call } from '@/shared/api';
import { refusal } from '@/shared/refusal';
import { Icon } from '@/shared/components/Icon';
import { Notice } from '@/shared/components/Notice';
import { CompatibilityResult } from '@/shared/compatibility/CompatibilityResult';
import { SAMPLE_FIXTURES } from '@/shared/compatibility/samples';
import { CONTROLLED_PROVIDERS, CONTROLLED_SCENARIOS, SCOPES, TERMINAL } from '@/lib/compatibility/model.mjs';
import {
  Board,
  BoardGroup,
  BoardSummary,
  BoardToolbar,
  Card,
  DensitySwitch,
  EvidenceLine,
  StateWord,
  useDensity,
  useLevel,
} from '@/shared/workspace/Board';
import board from '@/shared/workspace/board.module.css';
import shared from '@/shared/workspace/workspace.module.css';
import { InlineConfirm } from '@/shared/workspace/InlineConfirm';
import styles from './workbench.module.css';

const VIEWS = [
  { value: 'fixtures', label: 'Fixtures' },
  { value: 'runs', label: 'Runs' },
  { value: 'matrix', label: 'Evidence' },
];
const FIXTURE_BUCKETS = [
  { id: 'active', label: 'Active', tone: 'positive' },
  { id: 'archived', label: 'Archived', tone: null },
];
const RUN_BUCKETS = [
  { id: 'live', label: 'Not terminal', tone: 'ember' },
  { id: 'failed', label: 'Failed', tone: 'refusal' },
  { id: 'passed', label: 'Passed', tone: 'positive' },
];
// One retained run sits in exactly one bucket. Anything terminal that did not
// succeed is failed; anything not terminal is live.
const runState = (status) =>
  status === 'succeeded'
    ? { bucket: 'passed', tone: 'positive' }
    : TERMINAL.includes(status)
      ? { bucket: 'failed', tone: 'refusal' }
      : { bucket: 'live', tone: 'ember' };

const short = (value) => (value ? `${value.slice(0, 8)}…` : 'unknown');
const when = (value) => (value ? value.replace('T', ' ').slice(0, 19) : 'unknown');
const emptyDraft = {
  scope: 'local-translation',
  provider: 'openai',
  scenario: 'native-fields',
  name: '',
  sourceFormat: 'openai',
  targetFormat: 'claude',
  operation: 'request',
  model: 'synthetic-model',
  origin: 'synthetic',
  payloadText: '',
};

export default function CompatibilityPage() {
  const advanced = useLevel();
  const [density, setDensity] = useDensity();
  const [view, setView] = useState('fixtures');
  const [search, setSearch] = useState('');
  const [bucket, setBucket] = useState(null);
  const [runBucket, setRunBucket] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [baseline, setBaseline] = useState('');
  const [highlightedCheck, setHighlightedCheck] = useState('');
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
  const [runsError, setRunsError] = useState(null);
  const [fixtureFilter, setFixtureFilter] = useState('');
  const [archiveTarget, setArchiveTarget] = useState(null);
  const [archiveRefusal, setArchiveRefusal] = useState(null);
  const packetRequest = useRef(0);

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
    if (response.ok) {
      setRuns(response.body);
      setRunsError(null);
    } else setRunsError(refusal(response.status, response.body));
  }, []);
  const readRuns = useCallback(
    () =>
      call(
        `/api/admin/compatibility/runs?page=${runPage}&pageSize=25${fixtureFilter ? `&fixtureId=${encodeURIComponent(fixtureFilter)}` : ''}`
      ).then(applyRuns),
    [runPage, fixtureFilter, applyRuns]
  );
  const applyPacket = useCallback((response) => {
    if (response.ok) setPacket(response.body);
    else setNotice(refusal(response.status, response.body));
  }, []);
  const readPacket = useCallback(
    async (id) => {
      const requestId = ++packetRequest.current;
      const response = await call(`/api/admin/compatibility/runs/${id}`);
      if (requestId === packetRequest.current) applyPacket(response);
    },
    [applyPacket]
  );

  useEffect(() => {
    void readCatalog();
  }, [readCatalog]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('runId'), previous = params.get('compareRunId');
    if (!id) return;
    let stale = false;
    const requestId = ++packetRequest.current;
    void call(`/api/admin/compatibility/runs/${encodeURIComponent(id)}${previous ? `?baseline=${encodeURIComponent(previous)}` : ''}`).then(response => { if (!stale && requestId === packetRequest.current) { setView('runs'); setBaseline(previous || ''); setHighlightedCheck(params.get('checkId') || ''); applyPacket(response); } });
    return () => { stale = true; };
  }, [applyPacket]);
  useEffect(() => {
    void readRuns();
  }, [readRuns]);
  // Poll only while the selected run has not reached a terminal receipt.
  useEffect(() => {
    if (!packet) return undefined;
    if (TERMINAL.includes(packet.run.status)) {
      void readRuns();
      void readCatalog();
      return undefined;
    }
    const timer = setInterval(() => {
      void readPacket(packet.run.id);
      void readRuns();
      void readCatalog();
    }, 1000);
    return () => clearInterval(timer);
  }, [packet, readPacket, readRuns, readCatalog]);

  function loadFixture(fixture) {
    setEditing({ id: fixture.id, revision: fixture.revision, archived: fixture.archived });
    setConsent(false);
    setDraft({
      scope: fixture.definition.scope || 'local-translation',
      provider: fixture.definition.provider || 'openai',
      scenario: fixture.definition.scenario || 'native-fields',
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
      scope: sample.definition.scope || 'local-translation',
      provider: sample.definition.provider || 'openai',
      scenario: sample.definition.scenario || 'native-fields',
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
      scope: draft.scope,
      ...(draft.scope !== 'local-translation' ? { provider: draft.provider, scenario: draft.scenario, fixtureVersion: 'controlled-v1' } : {}),
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
          body: { name: draft.name, definition, revision: editing.revision, archived: editing.archived === true },
        })
      : await call('/api/admin/compatibility/fixtures', {
          method: 'POST',
          body: { name: draft.name, definition },
        });
    setBusy(false);
    if (!response.ok) {
      setNotice({
        tone: 'warn',
        title: response.status === 0 ? 'Fixture save is unconfirmed' : 'Fixture refused',
        next:
          response.status === 0
            ? 'Refresh retained evidence before saving again. The request may have reached storage; no automatic retry was sent.'
            : response.status === 409
              ? `${response.body?.error || 'The stored fixture changed.'} Refresh retained evidence and choose Revise to load the stored revision. Your draft remains here.`
              : response.body?.error || 'The fixture was not retained.',
      });
      if (response.status === 409) await readCatalog();
      return;
    }
    setEditing({ id: response.body.id, revision: response.body.revision, archived: response.body.archived });
    const stored = await call(`/api/admin/compatibility/fixtures/${response.body.id}`);
    setNotice({
      tone:
        stored.ok &&
        stored.body?.revision === response.body.revision &&
        stored.body?.contentHash === response.body.contentHash
          ? 'ok'
          : 'warn',
      title:
        stored.ok &&
        stored.body?.revision === response.body.revision &&
        stored.body?.contentHash === response.body.contentHash
          ? `Revision ${response.body.revision} retained and read back. No run was started.`
          : 'The save returned, but its exact revision could not be read back. Refresh before editing again.',
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
        title:
          response.status === 0
            ? 'Run acceptance is unknown'
            : response.body?.code === 'queue_full'
              ? 'Queue full, run refused'
              : 'Run refused',
        next:
          response.status === 0
            ? 'Refresh retained run history before another submission. The original request may have been accepted; it was not automatically replayed.'
            : response.body?.error || 'Nothing was scheduled.',
      });
      return;
    }
    await readRuns();
    setView('runs');
    await readPacket(response.body.id);
  }
  async function cancelRun(id) {
    const response = await call(`/api/admin/compatibility/runs/${id}/cancel`, { method: 'POST' });
    if (!response.ok) setNotice(refusal(response.status, response.body));
    await readRuns();
    if (packet?.run.id === id) await readPacket(id);
  }
  async function changeArchive() {
    const fixture = archiveTarget;
    setBusy(true);
    setArchiveRefusal(null);
    const response = await call(`/api/admin/compatibility/fixtures/${fixture.id}`, {
      method: 'PATCH',
      body: { name: fixture.name, definition: fixture.definition, revision: fixture.revision, archived: !fixture.archived },
    });
    if (!response.ok) {
      setBusy(false);
      setArchiveRefusal({ tone: 'warn', title: response.status === 0 ? 'Archive change is unconfirmed' : 'Archive change refused', next: `${response.body?.error || 'Refresh retained fixtures before another attempt.'} Your editor draft is unchanged; no request was replayed.` });
      return;
    }
    const stored = await call(`/api/admin/compatibility/fixtures/${fixture.id}`);
    const verified = stored.ok && stored.body.revision === response.body.revision && stored.body.archived === !fixture.archived;
    setNotice({ tone: verified ? 'ok' : 'warn', title: verified ? (fixture.archived ? 'Fixture restored and read back.' : 'Fixture archived and read back.') : 'The change returned, but its exact revision could not be verified. Refresh retained fixtures before another change.' });
    setArchiveTarget(null);
    setBusy(false);
    await readCatalog();
  }
  async function compareBaseline() {
    if (!packet || !baseline) return;
    const response = await call(`/api/admin/compatibility/runs/${packet.run.id}?baseline=${encodeURIComponent(baseline)}`);
    if (response.ok) setPacket(response.body);
    else setNotice(refusal(response.status, response.body));
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

  const fixtureName = (run) =>
    (catalog?.fixtures || []).find((fixture) => fixture.id === run.fixtureId)?.name ||
    short(run.fixtureId);
  const running = runs?.queue?.running ?? 'unknown';
  const queued = runs?.queue?.queued ?? 'unknown';
  const text = search.trim().toLowerCase();
  const fixtures = (catalog?.fixtures || []).filter(
    (fixture) =>
      (!bucket || (bucket === 'archived') === Boolean(fixture.archived)) &&
      `${fixture.name} ${fixture.definition.sourceFormat} ${fixture.definition.targetFormat} ${fixture.definition.operation}`
        .toLowerCase()
        .includes(text)
  );
  const summary = {
    active: (catalog?.fixtures || []).filter((fixture) => !fixture.archived).length,
    archived: (catalog?.fixtures || []).filter((fixture) => fixture.archived).length,
  };
  const runItems = (runs?.items || []).filter(
    (run) => !runBucket || runState(run.status).bucket === runBucket
  );
  const runSummary = (runs?.items || []).reduce(
    (counts, run) => {
      counts[runState(run.status).bucket] += 1;
      return counts;
    },
    { passed: 0, failed: 0, live: 0 }
  );
  const comparison = (
    <div className={board.comparisonHead}>
      <NativeSelect
        size="xs"
        aria-label="Exact baseline"
        className={board.sort}
        value={baseline}
        data={[
          { value: '', label: 'Choose a retained run' },
          ...(runs?.items || [])
            .filter((run) => run.id !== packet?.run.id && ['succeeded', 'failed'].includes(run.status))
            .map((run) => ({ value: run.id, label: `${short(run.id)} · ${run.scope} · ${run.status}` })),
        ]}
        onChange={(event) => setBaseline(event.currentTarget.value)}
      />
      <Button size="compact-xs" variant="default" disabled={!baseline} onClick={compareBaseline}>
        Compare baseline
      </Button>
    </div>
  );

  const closePacket = () => {
    packetRequest.current++;
    setPacket(null);
  };
  const evidencePanel = packet ? (
    <>
      <div className={board.comparisonHead}>
        <strong>Run evidence</strong>
        <span className={board.muted}>{packet.run.id}</span>
        <span className={board.spacer} />
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label="Close selection details"
          onClick={closePacket}
        >
          <Icon name="i-close" />
        </ActionIcon>
      </div>
      <CompatibilityResult
        key={packet.run.id}
        packet={packet}
        highlightedCheck={highlightedCheck}
        onExport={exportPacket}
        onCancel={() => cancelRun(packet.run.id)}
        comparisonControl={comparison}
      />
    </>
  ) : null;
  // One fixture, whichever level is on screen. The head carries identity, the
  // state row the retained state, the lines the retained run evidence, and the
  // detail the archive confirmation.
  function fixtureEvidence(fixture) {
    const edge = (catalog?.evidence || []).find((item) => item.fixtureHash === fixture.contentHash);
    if (!edge)
      return (
        <EvidenceLine
          label="Local checks"
          unknown
          value="No run"
          note="Absence of evidence is unknown, not unsupported"
        />
      );
    const total = Math.max(1, edge.runs);
    return (
      <EvidenceLine
        label="Local checks"
        shares={[
          { kind: 'read', percent: (edge.passed / total) * 100 },
          { kind: 'write', percent: (edge.failed / total) * 100 },
        ]}
        value={`${edge.passed} / ${edge.runs}`}
        note={`${edge.failed} failed`}
        title="Retained local run outcomes for this exact fixture hash."
      />
    );
  }
  const fixtureIdentity = (fixture) =>
    `rev ${fixture.revision} · ${fixture.definition.sourceFormat} → ${fixture.definition.targetFormat} · ${fixture.definition.operation} · ${short(fixture.contentHash)}`;
  const archiveDetail = (fixture) =>
    archiveTarget?.id === fixture.id ? (
      <InlineConfirm
        title={fixture.archived ? 'Restore this fixture' : 'Archive this fixture'}
        verb={fixture.archived ? 'Confirm restore' : 'Confirm archive'}
        irreversible={!fixture.archived}
        changes={
          fixture.archived
            ? 'Allows new local runs. Existing run evidence and your unsaved editor draft remain unchanged.'
            : 'Prevents new runs of every revision. Existing evidence and your unsaved editor draft are retained. Restore the fixture to allow new runs again.'
        }
        undo={
          fixture.archived
            ? 'Archive it again here. No provider request is sent.'
            : 'Restore it here. No provider request is sent.'
        }
        busy={busy}
        refusal={archiveRefusal}
        onConfirm={changeArchive}
        onCancel={() => {
          if (!busy) {
            setArchiveTarget(null);
            setArchiveRefusal(null);
          }
        }}
      />
    ) : null;
  const runButton = (fixture) => (
    <Button
      size="compact-xs"
      disabled={busy || fixture.archived}
      onClick={() => submitRun(fixture)}
    >
      Run revision {fixture.revision}
    </Button>
  );
  const fixtureIcons = (fixture) => (
    <>
      <Tooltip label={fixture.archived ? 'Restore fixture' : 'Archive fixture'}>
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={`${fixture.archived ? 'Restore fixture' : 'Archive fixture'} ${fixture.name}`}
          disabled={busy}
          onClick={() => {
            setArchiveRefusal(null);
            setArchiveTarget(archiveTarget?.id === fixture.id ? null : fixture);
          }}
        >
          <Icon name={fixture.archived ? 'i-show' : 'i-hide'} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Revise as a new revision">
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={`Revise ${fixture.name}`}
          onClick={() => {
            loadFixture(fixture);
            setEditorOpen(true);
          }}
        >
          <Icon name="i-edit" />
        </ActionIcon>
      </Tooltip>
    </>
  );
  const fixtureActions = (fixture) => (
    <>
      {fixtureIcons(fixture)}
      {runButton(fixture)}
    </>
  );

  const editor = (
    <div className={styles.editor} role="region" aria-label="Fixture editor">
      <div className={board.comparisonHead}>
        <strong>
          {editing ? `Revise as revision ${editing.revision + 1}` : 'Create a fixture'}
        </strong>
        {SAMPLE_FIXTURES.map((sample) => (
          <Button
            key={sample.name}
            size="compact-xs"
            variant="default"
            onClick={() => loadSample(sample)}
          >
            Insert {sample.name.toLowerCase()}
          </Button>
        ))}
        {editing ? (
          <Button
            size="compact-xs"
            variant="default"
            onClick={() => {
              setEditing(null);
              setDraft(emptyDraft);
              setConsent(false);
            }}
          >
            Start a new fixture instead
          </Button>
        ) : null}
        <span className={board.spacer} />
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label="Close the fixture editor"
          onClick={() => setEditorOpen(false)}
        >
          <Icon name="i-close" />
        </ActionIcon>
      </div>
      <div className={styles.editorGrid}>
        <NativeSelect
          size="xs"
          label="Execution scope"
          value={draft.scope}
          data={SCOPES}
          onChange={(event) =>
            setDraft({ ...draft, scope: event.currentTarget.value, operation: 'request' })
          }
        />
        {draft.scope !== 'local-translation' ? (
          <>
            <NativeSelect
              size="xs"
              label="Exact controlled provider"
              value={draft.provider}
              data={CONTROLLED_PROVIDERS}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  provider: event.currentTarget.value,
                  targetFormat: event.currentTarget.value,
                })
              }
            />
            <NativeSelect
              size="xs"
              label="Versioned scenario"
              value={draft.scenario}
              data={CONTROLLED_SCENARIOS}
              onChange={(event) => setDraft({ ...draft, scenario: event.currentTarget.value })}
            />
          </>
        ) : null}
        <TextInput
          size="xs"
          label="Fixture name"
          value={draft.name}
          maxLength={120}
          onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
        />
        <TextInput
          size="xs"
          label="Model label (no account is selected)"
          value={draft.model}
          maxLength={160}
          onChange={(event) => setDraft({ ...draft, model: event.currentTarget.value })}
        />
        <NativeSelect
          size="xs"
          label="Source format"
          value={draft.sourceFormat}
          data={catalog?.formats || []}
          onChange={(event) => setDraft({ ...draft, sourceFormat: event.currentTarget.value })}
        />
        <NativeSelect
          size="xs"
          label="Target format"
          value={draft.targetFormat}
          data={catalog?.formats || []}
          onChange={(event) => setDraft({ ...draft, targetFormat: event.currentTarget.value })}
        />
        <NativeSelect
          size="xs"
          label="Operation"
          value={draft.operation}
          data={[
            { value: 'request', label: 'request' },
            { value: 'stream', label: 'stream (ordered synthetic events)' },
          ]}
          onChange={(event) => setDraft({ ...draft, operation: event.currentTarget.value })}
        />
        <NativeSelect
          size="xs"
          label="Origin"
          value={draft.origin}
          data={['synthetic', 'operator-submitted']}
          onChange={(event) => setDraft({ ...draft, origin: event.currentTarget.value })}
        />
      </div>
      <Textarea
        size="xs"
        mt="xs"
        label={draft.operation === 'stream' ? 'Ordered JSON event list' : 'Request payload JSON'}
        value={draft.payloadText}
        spellCheck={false}
        autosize
        minRows={6}
        maxRows={18}
        className={styles.payload}
        onChange={(event) => setDraft({ ...draft, payloadText: event.currentTarget.value })}
      />
      <Checkbox
        size="xs"
        mt="xs"
        mb="xs"
        checked={consent}
        onChange={(event) => setConsent(event.currentTarget.checked)}
        label="This is synthetic or suitable operator-submitted test content with no private production traffic. Sign-in material is refused, not redacted."
      />
      <Button size="xs" disabled={busy || !draft.name.trim() || !consent} onClick={saveFixture}>
        {editing ? 'Save as new revision' : 'Save fixture'}
      </Button>
    </div>
  );

  return (
    <div className={shared.lensPage} data-density={density}>
      <div className={shared.lensHeading}>
        <div className={shared.lensTitle}>
          <h1>Compatibility</h1>
          <p>
            {advanced ? 'Advanced' : 'Everyday'} · versioned translation fixtures and their retained
            local evidence
          </p>
        </div>
        <SegmentedControl
          size="xs"
          aria-label="Compatibility task"
          value={view}
          onChange={setView}
          data={VIEWS}
          className={styles.views}
        />
      </div>
      <div className={`${shared.lensBody} ${styles.body}`}>
        <p className={styles.lead}>
          Versioned translation, controlled executor and gateway routing fixtures. No provider is
          called, no stored sign-in material is read, and no result establishes upstream readiness.
        </p>
        {refused ? <Notice {...refused} /> : null}
        {notice ? (
          <div role="status">
            <Notice {...notice} />
          </div>
        ) : null}
      {view === 'fixtures' ? (
        <Board label="Fixture book" advanced={advanced} density={density} compare="none">
          <BoardSummary
            label="Fixture summary"
            active={bucket}
            onPick={(next) => setBucket(next === bucket ? null : next)}
            chips={[
              { count: catalog ? catalog.fixtures.length : '—', label: 'fixtures' },
              { id: 'active', tone: 'positive', count: summary.active, label: 'active' },
              { id: 'archived', count: summary.archived, label: 'archived' },
            ]}
            note={catalog ? `${catalog.limits.fixtureIds} retained · one run pins one revision` : null}
          />
          <BoardToolbar
            search={search}
            onSearch={setSearch}
            searchLabel="Search fixtures"
            actions={
              <>
                <DensitySwitch value={density} onChange={setDensity} />
                <Button
                  size="xs"
                  leftSection={<Icon name="i-add" />}
                  aria-expanded={editorOpen}
                  onClick={() => setEditorOpen((open) => !open)}
                >
                  New fixture
                </Button>
                <Tooltip label="Re-read retained fixtures and evidence">
                  <ActionIcon
                    variant="default"
                    aria-label="Refresh retained evidence"
                    onClick={() => {
                      void readCatalog();
                      void readRuns();
                    }}
                  >
                    <Icon name="i-refresh" />
                  </ActionIcon>
                </Tooltip>
              </>
            }
          />
          {editorOpen ? editor : null}
          {advanced ? (
            <div className={board.head} aria-hidden="true">
              <span />
              <span>Fixture</span>
              <span>State</span>
              <span>Retained local evidence</span>
              <span>Run this revision</span>
              <span>Actions</span>
            </div>
          ) : null}
          {!advanced
            ? FIXTURE_BUCKETS.map((item) => {
                const members = fixtures.filter(
                  (fixture) => (fixture.archived ? 'archived' : 'active') === item.id
                );
                if (!members.length) return null;
                return (
                  <BoardGroup
                    key={item.id}
                    label={item.label}
                    tone={item.tone}
                    count={members.length}
                  >
                    {members.map((fixture) => (
                      <Card
                        key={fixture.id}
                        id={fixture.id}
                        bucket={item.id}
                        expanded={archiveTarget?.id === fixture.id}
                        label={fixture.name}
                        head={
                          <>
                            <Icon name="i-compatibility" />
                            <div className={board.identityText}>
                              <span className={board.nameLine}>{fixture.name}</span>
                              <small>{fixtureIdentity(fixture)}</small>
                            </div>
                          </>
                        }
                        state={
                          <>
                            <StateWord tone={item.tone}>{item.label}</StateWord>
                            <span className={board.spacer} />
                            <span className={board.actions}>{fixtureActions(fixture)}</span>
                          </>
                        }
                        detail={archiveDetail(fixture)}
                      >
                        {fixtureEvidence(fixture)}
                      </Card>
                    ))}
                  </BoardGroup>
                );
              })
            : null}
          <div className={board.rows} hidden={!advanced}>
            {advanced
              ? fixtures.map((fixture) => (
                  <article
                    key={fixture.id}
                    className={board.row}
                    data-expanded={archiveTarget?.id === fixture.id || undefined}
                    data-bucket={fixture.archived ? 'archived' : 'active'}
                    aria-label={fixture.name}
                  >
                    <div className={board.main}>
                      <span className={board.caret} aria-hidden="true">
                        <Icon name="i-compatibility" />
                      </span>
                      <div className={board.identity}>
                        <div className={board.identityText}>
                          <span className={board.nameLine}>{fixture.name}</span>
                          <small>{fixtureIdentity(fixture)}</small>
                        </div>
                      </div>
                      <div className={board.state}>
                        <StateWord tone={fixture.archived ? null : 'positive'}>
                          {fixture.archived ? 'Archived' : 'Active'}
                        </StateWord>
                      </div>
                      <div className={board.quota}>{fixtureEvidence(fixture)}</div>
                      <div className={board.activity}>
                        {runButton(fixture)}
                        <small>{short(fixture.contentHash)}</small>
                      </div>
                      <div className={board.actions}>{fixtureIcons(fixture)}</div>
                    </div>
                    {archiveDetail(fixture)}
                  </article>
                ))
              : null}
          </div>
          <div className={board.messages}>
            {!catalog && !refused ? (
              <div className={board.empty}>
                <Loader size="xs" /> Reading retained fixtures…
              </div>
            ) : null}
            {catalog && !catalog.fixtures.length ? (
              <div className={board.empty}>
                No fixture is retained yet. Create one above; historical traffic is never imported.
              </div>
            ) : null}
            {catalog && catalog.fixtures.length > 0 && !fixtures.length ? (
              <div className={board.empty}>
                No fixture matches.{' '}
                <button
                  type="button"
                  className={board.linkButton}
                  onClick={() => {
                    setSearch('');
                    setBucket(null);
                  }}
                >
                  Clear filters
                </button>
              </div>
            ) : null}
          </div>
        </Board>
      ) : null}
      {view === 'runs' ? (
        <Board label="Retained run history" advanced={advanced} density={density} compare="none">
          <BoardSummary
            label="Run summary"
            active={runBucket}
            onPick={(next) => setRunBucket(next === runBucket ? null : next)}
            chips={[
              { count: runs?.pagination?.total ?? '—', label: 'runs' },
              { id: 'passed', tone: 'positive', count: runSummary.passed, label: 'passed' },
              { id: 'failed', tone: 'refusal', count: runSummary.failed, label: 'failed' },
              { id: 'live', tone: 'ember', count: runSummary.live, label: 'not terminal' },
            ]}
            note={
              catalog
                ? `One worker · ${catalog.limits.queued} waiting slots · ${catalog.limits.timeoutMs / 1000} s deadline · ${running} running, ${queued} queued`
                : null
            }
          />
          <BoardToolbar
            actions={
              <>
                <Tooltip label="Re-read retained runs and fixtures">
                  <ActionIcon
                    variant="default"
                    aria-label="Refresh retained evidence"
                    onClick={() => {
                      void readRuns();
                      void readCatalog();
                    }}
                  >
                    <Icon name="i-refresh" />
                  </ActionIcon>
                </Tooltip>
              </>
            }
          >
            <NativeSelect
              size="xs"
              aria-label="Run history fixture"
              className={board.sort}
              value={fixtureFilter}
              data={[
                { value: '', label: 'Every fixture' },
                ...(catalog?.fixtures || []).map((fixture) => ({
                  value: fixture.id,
                  label: fixture.name,
                })),
              ]}
              onChange={(event) => {
                setFixtureFilter(event.currentTarget.value);
                setRunPage(1);
              }}
            />
          </BoardToolbar>
          {runsError ? (
            <div className={board.notice}>
              <Notice
                {...runsError}
                next="Retained rows may be stale. Refresh history to recover; no run is replayed."
              />
            </div>
          ) : null}
          {!advanced
            ? RUN_BUCKETS.map((item) => {
                const members = runItems.filter((run) => runState(run.status).bucket === item.id);
                if (!members.length) return null;
                return (
                  <BoardGroup
                    key={item.id}
                    label={item.label}
                    tone={item.tone}
                    count={members.length}
                  >
                    {members.map((run) => (
                      <Card
                        key={run.id}
                        id={run.id}
                        bucket={item.id}
                        expanded={packet?.run.id === run.id}
                        label={`Run ${run.id}`}
                        head={
                          <>
                            <Icon name="i-compatibility" />
                            <div className={board.identityText}>
                              <button
                                type="button"
                                className={board.nameButton}
                                aria-label={`Inspect run ${run.id}`}
                                aria-expanded={packet?.run.id === run.id}
                                onClick={() => readPacket(run.id)}
                              >
                                {fixtureName(run)}
                              </button>
                              <small>
                                rev {run.fixtureRevision} · {short(run.fixtureHash)} ·{' '}
                                {when(run.createdAt)}
                              </small>
                            </div>
                            {TERMINAL.includes(run.status) ? null : (
                              <Tooltip label="Cancel this run">
                                <ActionIcon
                                  variant="subtle"
                                  color="orange"
                                  aria-label={`Cancel run ${run.id}`}
                                  onClick={() => cancelRun(run.id)}
                                >
                                  <Icon name="i-close" />
                                </ActionIcon>
                              </Tooltip>
                            )}
                          </>
                        }
                        state={
                          <>
                            <StateWord tone={item.tone}>{run.status}</StateWord>
                            <span className={board.spacer} />
                            <span className={board.cardAttempts}>{run.scope}</span>
                          </>
                        }
                        detail={packet?.run.id === run.id ? evidencePanel : null}
                      >
                        <span
                          className={board.muted}
                          title={`Implementation ${run.implementationVersion || 'unknown'}, fixture ${run.fixtureId}`}
                        >
                          {run.implementationVersion || 'unknown'} · fixture {short(run.fixtureId)}
                        </span>
                      </Card>
                    ))}
                  </BoardGroup>
                );
              })
            : null}
          {advanced ? (
            <div
              className={styles.tableScroll}
              role="region"
              aria-label="Retained run history"
              tabIndex={0}
            >
              <Table striped className={board.evidenceTable}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Created (UTC)</Table.Th>
                    <Table.Th>Fixture</Table.Th>
                    <Table.Th>Rev</Table.Th>
                    <Table.Th>Hash</Table.Th>
                    <Table.Th>Implementation</Table.Th>
                    <Table.Th>State</Table.Th>
                    <Table.Th>Action</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {runItems.map((run) => (
                    <Table.Tr key={run.id} data-selected={packet?.run.id === run.id || undefined}>
                      <Table.Td>{when(run.createdAt)}</Table.Td>
                      <Table.Td>
                        <button
                          type="button"
                          className={board.nameButton}
                          aria-label={`Inspect run ${run.id}`}
                          onClick={() => readPacket(run.id)}
                        >
                          <code>{short(run.fixtureId)}</code>
                        </button>
                      </Table.Td>
                      <Table.Td>{run.fixtureRevision}</Table.Td>
                      <Table.Td>
                        <code>{short(run.fixtureHash)}</code>
                      </Table.Td>
                      <Table.Td>
                        <code>{run.implementationVersion || 'unknown'}</code>
                      </Table.Td>
                      <Table.Td>
                        <StateWord tone={runState(run.status).tone}>{run.status}</StateWord>
                      </Table.Td>
                      <Table.Td>
                        {TERMINAL.includes(run.status) ? (
                          '—'
                        ) : (
                          <Button
                            size="compact-xs"
                            variant="default"
                            onClick={() => cancelRun(run.id)}
                          >
                            Cancel
                          </Button>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
          ) : null}
          {advanced && packet ? (
            <div className={board.detail} role="region" aria-label="Compatibility evidence">
              {evidencePanel}
            </div>
          ) : null}
          {runs?.pagination ? (
            <div className={board.comparisonHead}>
              <Button
                size="compact-xs"
                variant="default"
                disabled={runPage === 1}
                onClick={() => setRunPage(runPage - 1)}
              >
                Previous
              </Button>
              <span className={board.muted}>
                Page {runs.pagination.page} of {Math.max(1, runs.pagination.totalPages)} ·{' '}
                {runs.pagination.total} retained
              </span>
              <Button
                size="compact-xs"
                variant="default"
                disabled={runPage >= runs.pagination.totalPages}
                onClick={() => setRunPage(runPage + 1)}
              >
                Next
              </Button>
            </div>
          ) : null}
          <div className={board.messages}>
            {runs && !runs.items.length ? (
              <div className={board.empty}>
                No run is retained yet. Start one from the fixture book.
              </div>
            ) : null}
            {runs?.items.length > 0 && !packet ? (
              <div className={board.empty}>
                Select a retained run. Its exact fixture revision, converted content and local checks
                appear here; no earlier request is replayed.
              </div>
            ) : null}
          </div>
        </Board>
      ) : null}
      {view === 'matrix' && catalog ? (
        <Board label="Capability evidence" advanced={advanced} density={density} compare="none">
          <BoardSummary
            label="Edge summary"
            chips={[
              { count: catalog.evidence.length, label: 'edges' },
              {
                tone: 'positive',
                count: catalog.evidence.reduce((total, edge) => total + edge.passed, 0),
                label: 'passed',
              },
              {
                tone: 'refusal',
                count: catalog.evidence.reduce((total, edge) => total + edge.failed, 0),
                label: 'failed',
              },
            ]}
            note={catalog.evidenceBasis}
          />
          {catalog.regressions?.map((item) => (
            <div className={board.notice} key={item.currentRunId} role="status">
              Observed regression · {item.scope} ·{' '}
              {item.regressions.map((check) => check.checkId).join(', ')}{' '}
              <Button
                size="compact-xs"
                variant="subtle"
                onClick={() => {
                  setView('runs');
                  void readPacket(item.currentRunId);
                }}
              >
                Inspect exact current run
              </Button>
            </div>
          ))}
          {!advanced ? (
            <BoardGroup label="Retained edges" count={catalog.evidence.length}>
              {catalog.evidence.map((edge) => (
                <Card
                  key={`${edge.fixtureHash}:${edge.implementationHash}:${edge.scope}`}
                  id={edge.fixtureHash}
                  bucket={edge.failed ? 'failed' : 'passed'}
                  label={`${edge.scope} ${edge.sourceFormat} to ${edge.targetFormat}`}
                  head={
                    <>
                      <Icon name="i-compatibility" />
                      <div className={board.identityText}>
                        <span className={board.nameLine}>
                          {edge.sourceFormat || 'unknown'} → {edge.targetFormat || 'unknown'}
                        </span>
                        <small>
                          {edge.scope} · {edge.provider} / {edge.model} ·{' '}
                          {edge.operation || 'unknown'}
                        </small>
                      </div>
                    </>
                  }
                  state={
                    <>
                      <StateWord tone={edge.failed ? 'refusal' : edge.passed ? 'positive' : null}>
                        {edge.failed ? 'Failing' : edge.passed ? 'Passing' : 'No terminal run'}
                      </StateWord>
                      <span className={board.spacer} />
                      <span className={board.cardAttempts}>{when(edge.lastRunAt)}</span>
                    </>
                  }
                >
                  <EvidenceLine
                    label="Outcomes"
                    shares={[
                      { kind: 'read', percent: (edge.passed / Math.max(1, edge.runs)) * 100 },
                      { kind: 'write', percent: (edge.failed / Math.max(1, edge.runs)) * 100 },
                    ]}
                    value={`${edge.passed} / ${edge.runs}`}
                    note={`${edge.failed} failed · ${edge.other} other`}
                  />
                  <EvidenceLine
                    label="Not terminal"
                    unknown
                    value={`${edge.pending ?? 'unknown'} / ${edge.unknown ?? 'unknown'}`}
                    note="pending / unknown"
                  />
                </Card>
              ))}
            </BoardGroup>
          ) : (
            <div
              className={styles.tableScroll}
              role="region"
              aria-label="Retained edge evidence"
              tabIndex={0}
            >
              <Table striped className={board.evidenceTable}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Scope / target / version</Table.Th>
                    <Table.Th>Source</Table.Th>
                    <Table.Th>Target</Table.Th>
                    <Table.Th>Operation</Table.Th>
                    <Table.Th>Runs</Table.Th>
                    <Table.Th>Passed</Table.Th>
                    <Table.Th>Failed</Table.Th>
                    <Table.Th>Other terminal</Table.Th>
                    <Table.Th>Pending / unknown</Table.Th>
                    <Table.Th>Last run (UTC)</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {catalog.evidence.map((edge) => (
                    <Table.Tr key={`${edge.fixtureHash}:${edge.implementationHash}:${edge.scope}`}>
                      <Table.Td>
                        {edge.scope}
                        <br />
                        {edge.provider} / {edge.model}
                        <br />
                        {edge.scenario} · {edge.fixtureVersion}
                        <br />
                        <code>
                          {short(edge.fixtureHash)} · {short(edge.implementationHash)}
                        </code>
                      </Table.Td>
                      <Table.Td>{edge.sourceFormat || 'unknown'}</Table.Td>
                      <Table.Td>{edge.targetFormat || 'unknown'}</Table.Td>
                      <Table.Td>{edge.operation || 'unknown'}</Table.Td>
                      <Table.Td>{edge.runs}</Table.Td>
                      <Table.Td>{edge.passed}</Table.Td>
                      <Table.Td>{edge.failed}</Table.Td>
                      <Table.Td>{edge.other}</Table.Td>
                      <Table.Td>
                        {edge.pending ?? 'unknown'} / {edge.unknown ?? 'unknown'}
                      </Table.Td>
                      <Table.Td>{when(edge.lastRunAt)}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
          )}
          <div className={board.messages}>
            {!catalog.evidence.length ? (
              <div className={board.empty}>
                No retained run yet, so no edge has evidence. Absence of evidence is unknown, not
                unsupported.
              </div>
            ) : null}
          </div>
        </Board>
      ) : null}
      </div>
    </div>
  );
}
