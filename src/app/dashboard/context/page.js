'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { usePoll } from '@/shared/hooks/usePoll';
import { Notice } from '@/shared/components/Notice';
import { Freshness } from '@/shared/components/Freshness';
import { Icon } from '@/shared/components/Icon';
import { ProviderMark } from '@/shared/components/ProviderMark';
import { refusal } from '@/shared/refusal';
import { fmtNum, fmtPct, fmtTime, fmtDuration } from '@/shared/format';
import './styles.css';
const short = (n) =>
  n == null ? '—' : fmtNum(n, { notation: 'compact', maximumFractionDigits: 1 });
const STAGE_NAMES = {
  rtk: 'Tool result reducer',
  mem: 'History shaping',
  tools: 'Tool disclosure',
  schema: 'Schema distillation',
  privacy: 'Privacy filtering',
  inject: 'Prompt instructions',
  pxpipe: 'Compression',
  thinking: 'Thinking blocks',
  headroom: 'Headroom',
  qac: 'Query-aware compression',
  pairs: 'Pair pruning',
  reorder: 'Message reorder',
  midinject: 'Boundary note',
  final: 'Final normalization',
};
const IDENTITY = {
  explicit: 'Explicit session',
  inferred: 'Inferred locality',
  routing: 'Routing identity, provenance unknown',
  request: 'Request-only identity',
};
const fresh = (p) =>
  p.error ? (p.goodAt ? 'stale' : 'reconnecting') : p.loading ? 'connecting' : 'live';
function Stat({ label, value, note }) {
  return (
    <div className="context-stat">
      <span>{label}</span>
      <strong data-i18n-skip>{value}</strong>
      <small>{note}</small>
    </div>
  );
}
function TurnChart({ turns, onSelect, selected }) {
  const rows = turns.map((t, i) => ({
    ...t,
    turn: i + 1,
    newInput:
      t.providerInputTokens == null || t.cacheReadTokens == null
        ? null
        : Math.max(0, t.providerInputTokens - t.cacheReadTokens),
    cache: t.cacheReadTokens,
    output: t.providerOutputTokens,
  }));
  if (!turns.length)
    return (
      <div className="chart-empty">
        <Icon name="i-context" />
        <strong>No turns in this selection</strong>
        <span>Choose another session or wait for the next request.</span>
      </div>
    );
  return (
    <div
      className="context-chart"
      role="img"
      aria-label="Context evolution in tokens by request. Cached input, other input, output, and estimated context."
    >
      <ResponsiveContainer width="100%" height={280} minWidth={1}>
        <ComposedChart
          data={rows}
          margin={{ top: 15, right: 12, left: 0, bottom: 6 }}
          onClick={(e) => {
            if (e?.activeTooltipIndex != null) onSelect(turns[Number(e.activeTooltipIndex)]?.id);
          }}
        >
          <CartesianGrid stroke="var(--rule)" vertical={false} strokeDasharray="3 5" />
          <XAxis
            dataKey="turn"
            axisLine={false}
            tickLine={false}
            tick={{ fill: 'var(--slate)', fontSize: 10 }}
          />
          <YAxis
            tickFormatter={short}
            axisLine={false}
            tickLine={false}
            width={48}
            tick={{ fill: 'var(--slate)', fontSize: 10 }}
          />
          <Tooltip
            formatter={(v, name) => [`${fmtNum(v)} tokens`, name]}
            labelFormatter={(v) => `Request ${v}`}
            contentStyle={{
              background: 'var(--raised)',
              border: '1px solid var(--rule)',
              borderRadius: 8,
              fontSize: 11,
            }}
          />
          <Bar
            dataKey="cache"
            name="Cached input"
            stackId="input"
            fill="var(--signal)"
            isAnimationActive={false}
          />
          <Bar
            dataKey="newInput"
            name="Other input"
            stackId="input"
            fill="var(--context-new)"
            isAnimationActive={false}
          />
          <Bar
            dataKey="output"
            name="Output"
            stackId="input"
            fill="var(--context-output)"
            radius={[3, 3, 0, 0]}
            isAnimationActive={false}
          />
          <Line
            dataKey="contextEstimate"
            name="Estimated context"
            stroke="var(--blue)"
            dot={false}
            strokeWidth={2}
            strokeDasharray="4 4"
            isAnimationActive={false}
          />
          {rows
            .filter((t) => t.compactHint)
            .map((t) => (
              <ReferenceLine
                key={t.id}
                x={t.turn}
                stroke="var(--ember)"
                strokeDasharray="3 3"
                label={{
                  value: 'Prefix change',
                  fill: 'var(--ember)',
                  fontSize: 9,
                  position: 'insideTopRight',
                }}
              />
            ))}
          {selected ? (
            <ReferenceLine
              x={rows.find((r) => r.id === selected)?.turn}
              stroke="var(--ink)"
              strokeOpacity={0.35}
            />
          ) : null}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
function StageLedger({ stages = [] }) {
  return (
    <div className="stage-ledger">
      {stages.map((s, i) => (
        <div className="stage-item" key={`${s.stage}-${i}`}>
          <span className="stage-node" data-applied={s.applied > 0 || s.outcome === 'applied'}>
            <Icon name={s.stage === 'rtk' ? 'i-shaping' : 'i-check'} />
          </span>
          <div className="stage-name">
            <strong>{STAGE_NAMES[s.stage] || s.stage}</strong>
            <small>{s.risk || `${s.applied || 0} applied · ${s.skipped || 0} skipped`}</small>
          </div>
          <div className="stage-values">
            <strong data-i18n-skip>
              {short(s.savedBytes ?? (s.deltaBytes == null ? null : -s.deltaBytes))} B
            </strong>
            <small data-i18n-skip>
              {short(s.beforeBytes)} → {short(s.afterBytes)} B
            </small>
          </div>
        </div>
      ))}
    </div>
  );
}
export default function ContextPage() {
  const [period, setPeriod] = useState('24h');
  const [provider, setProvider] = useState('');
  const [project, setProject] = useState('');
  const [page, setPage] = useState(1);
  const [picked, setPicked] = useState(null);
  const [turnPage, setTurnPage] = useState(1);
  const [turnId, setTurnId] = useState(null);
  const [projectDraft, setProjectDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const since = useMemo(
    () =>
      period === 'all'
        ? null
        : new Date(Date.now() - (period === '7d' ? 7 : 1) * 86400000).toISOString(),
    [period]
  );
  const q = new URLSearchParams({ page: String(page), pageSize: '25' });
  if (since) q.set('from', since);
  if (provider) q.set('provider', provider);
  if (project) q.set('projectLabel', project);
  const overview = usePoll(`/api/context?${q}`, 15000);
  const data = overview.data;
  const summary = data?.summary;
  const sessions = data?.sessions || [];
  const sessionId = picked && sessions.some((s) => s.id === picked) ? picked : sessions[0]?.id;
  const detail = usePoll(
    sessionId ? `/api/context/sessions/${sessionId}?page=${turnPage}&pageSize=50` : null,
    15000
  );
  const turns = detail.data?.turns || [];
  const selected = turns.find((t) => t.id === turnId) || turns.at(-1);
  const projects = data?.projects || [];
  async function saveProject(e) {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    try {
      const r = await fetch(`/api/context/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectLabel: projectDraft.trim() || null }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || 'Project label could not be saved.');
      setEditing(false);
      overview.refresh();
      detail.refresh();
    } catch (error) {
      setSaveError(error.message);
    } finally {
      setSaving(false);
    }
  }
  function chooseSession(s) {
    setPicked(s.id);
    setTurnPage(1);
    setTurnId(null);
    setEditing(false);
  }
  return (
    <>
      <div className="screen-head">
        <div className="page-title">
          <h1>Context</h1>
          <p className="screen-subtitle">
            Follow a conversation from the first request to the final token.
          </p>
        </div>
        <Link className="button quiet" href="/dashboard/shaping">
          <Icon name="i-shaping" />
          Shaping controls
        </Link>
        <Freshness status={fresh(overview)} lastDataAt={overview.goodAt} />
      </div>
      <div className="context-filter">
        <div className="segment-buttons" aria-label="Context period">
          {[
            ['24h', '24 hours'],
            ['7d', '7 days'],
            ['all', 'All retained'],
          ].map(([id, label]) => (
            <button
              key={id}
              aria-pressed={period === id}
              onClick={() => {
                setPeriod(id);
                setPage(1);
                setPicked(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="field">
          <span>Provider</span>
          <select
            className="select"
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
              setPage(1);
              setPicked(null);
            }}
          >
            <option value="">All providers</option>
            {[...new Set((data?.dimensions || []).map((d) => d.provider))].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Project label</span>
          <select
            className="select"
            value={project}
            onChange={(e) => {
              setProject(e.target.value);
              setPage(1);
              setPicked(null);
            }}
          >
            <option value="">All projects</option>
            {projects
              .filter((p) => p.projectLabel)
              .map((p) => (
                <option key={p.projectLabel}>{p.projectLabel}</option>
              ))}
          </select>
        </label>
        <span className="context-retention">
          <Icon name="i-context" />
          {data?.retentionDays ?? '—'} days retained
        </span>
      </div>
      {overview.error ? <Notice {...refusal(overview.status, overview.error)} /> : null}
      <div className="context-stats">
        <Stat
          label="Conversations"
          value={summary?.sessions ?? '—'}
          note={`${summary?.requests ?? '—'} logical requests`}
        />
        <Stat
          label="Provider input"
          value={short(summary?.providerInputTokens)}
          note={`${summary?.providerUsageSamples ?? '—'} provider-reported samples`}
        />
        <Stat
          label="Cache read share"
          value={summary?.cacheHitRate == null ? '—' : fmtPct(summary.cacheHitRate)}
          note="Only requests reporting cache + input"
        />
        <Stat
          label="Body reduction"
          value={`${short(summary?.savedBytes)} B`}
          note="Measured bytes, signed net change"
        />
      </div>
      {!overview.loading && !overview.error && !sessions.length ? (
        <section className="context-onboarding">
          <div className="context-onboarding-icon">
            <Icon name="i-context" />
          </div>
          <h2>Your next conversation starts the timeline</h2>
          <p>
            Context history records request measurements as they pass through the gateway. Existing
            usage cannot be reconstructed into conversations.
          </p>
          <div className="onboarding-steps">
            <span>
              <Icon name="i-keys" />
              Connect your client
            </span>
            <span>
              <Icon name="i-sessions" />
              Send a request
            </span>
            <span>
              <Icon name="i-context" />
              Inspect the context
            </span>
          </div>
          <Link href="/dashboard/keys" className="button">
            View gateway endpoint
            <Icon name="i-right" />
          </Link>
        </section>
      ) : overview.loading && !data ? (
        <section className="chart-empty skeleton">Reading context history</section>
      ) : sessions.length ? (
        <div className="context-workspace">
          <aside className="session-list">
            <div className="session-list-head">
              <h2>Conversations</h2>
              <span>{data.pagination?.totalItems}</span>
            </div>
            {sessions.map((s) => (
              <button
                className="context-session"
                data-selected={s.id === sessionId}
                key={s.id}
                onClick={() => chooseSession(s)}
              >
                <span className="session-icon">
                  <Icon name="i-sessions" />
                </span>
                <span className="session-meta">
                  <strong>{s.projectLabel || `Conversation ${s.id}`}</strong>
                  <small>{s.clientTool || 'Unknown client'}</small>
                  <span>
                    {s.requests} requests <i />
                    {short(s.providerInputTokens)} input
                  </span>
                </span>
              </button>
            ))}
            <div className="context-pager">
              <button
                className="button quiet"
                disabled={!data.pagination?.hasPrev}
                onClick={() => setPage(page - 1)}
              >
                Previous
              </button>
              <span>{page}</span>
              <button
                className="button quiet"
                disabled={!data.pagination?.hasNext}
                onClick={() => setPage(page + 1)}
              >
                Next
              </button>
            </div>
            <p className="session-label-note">
              Project labels are operator assigned. Session identity is observed, with no prompt or
              path stored.
            </p>
          </aside>
          <div className="context-detail">
            <section className="operator-panel">
              <div className="panel-head">
                <div>
                  <h2>{detail.data?.session?.projectLabel || `Conversation ${sessionId}`}</h2>
                  <p>Context evolution · tokens per request attempt</p>
                </div>
                <button
                  className="button quiet"
                  onClick={() => {
                    setEditing(!editing);
                    setProjectDraft(detail.data?.session?.projectLabel || '');
                  }}
                >
                  Edit project
                </button>
              </div>
              {editing ? (
                <form className="project-editor" onSubmit={saveProject}>
                  <label className="field">
                    <span>Project label</span>
                    <input
                      className="input"
                      value={projectDraft}
                      maxLength={120}
                      onChange={(e) => setProjectDraft(e.target.value)}
                    />
                  </label>
                  <button className="button" disabled={saving}>
                    {saving ? 'Saving' : 'Save label'}
                  </button>
                  {saveError ? <Notice tone="bad" title={saveError} /> : null}
                </form>
              ) : null}
              <div className="panel-body">
                <div className="context-legend">
                  <span data-series="cache">Cached input</span>
                  <span data-series="new">Other input</span>
                  <span data-series="output">Output</span>
                  <span data-series="estimate">Estimated context</span>
                </div>
                {detail.error ? (
                  <Notice {...refusal(detail.status, detail.error)} />
                ) : detail.loading ? (
                  <div className="chart-empty skeleton">Reading conversation</div>
                ) : (
                  <TurnChart turns={turns} selected={selected?.id} onSelect={setTurnId} />
                )}
                <p className="chart-disclosure">
                  Bars use upstream usage. The dashed line is a context estimate. A prefix change is
                  a hint, not proof of compaction. Missing cache fields are not filled with zero.
                </p>
                <div className="turn-picker">
                  <label htmlFor="context-turn">Inspect request</label>
                  <select
                    id="context-turn"
                    className="select"
                    value={selected?.id || ''}
                    onChange={(e) => setTurnId(e.target.value)}
                  >
                    {turns.map((t, i) => (
                      <option key={t.id} value={t.id}>
                        Request {i + 1} · {t.model} · {t.status}
                      </option>
                    ))}
                  </select>
                  <button
                    className="button quiet"
                    disabled={!detail.data?.pagination?.hasPrev}
                    onClick={() => setTurnPage(turnPage - 1)}
                  >
                    Previous
                  </button>
                  <button
                    className="button quiet"
                    disabled={!detail.data?.pagination?.hasNext}
                    onClick={() => setTurnPage(turnPage + 1)}
                  >
                    Next
                  </button>
                </div>
              </div>
            </section>
            {selected ? (
              <section className="operator-panel request-inspector">
                <div className="panel-head">
                  <div>
                    <h2>Request details</h2>
                    <p>
                      {fmtTime(selected.timestamp)} · {selected.status}
                    </p>
                  </div>
                  <ProviderMark provider={selected.provider} label />
                </div>
                <div className="panel-body">
                  <div className="request-facts">
                    <Stat
                      label="Model"
                      value={selected.model}
                      note={`Requested ${selected.requestedModel || selected.model}`}
                    />
                    <Stat
                      label="Response time"
                      value={selected.latencyMs == null ? '—' : fmtDuration(selected.latencyMs)}
                      note={`First token ${selected.ttftMs == null ? 'unknown' : fmtDuration(selected.ttftMs)}`}
                    />
                    <Stat
                      label="Provider output"
                      value={short(selected.providerOutputTokens)}
                      note={`${selected.usageSource || 'missing'} usage source`}
                    />
                  </div>
                  <div className="decision-note">
                    <Icon name="i-network" />
                    <span>
                      <strong>Routing decision</strong>
                      <span>
                        {selected.selection || 'No selection reason recorded'} ·{' '}
                        {selected.routeKind || 'Unknown route'} ·{' '}
                        {selected.formatPair || 'No translation pair recorded'}
                      </span>
                    </span>
                  </div>
                  <details className="fold">
                    <summary>Measured shaping stages</summary>
                    {selected.stages?.length ? (
                      <StageLedger stages={selected.stages} />
                    ) : (
                      <p className="empty">No stage measurements were recorded for this request.</p>
                    )}
                  </details>
                </div>
              </section>
            ) : null}
            {detail.data?.switches?.length || detail.data?.pins?.length ? (
              <section className="operator-panel">
                <div className="panel-head">
                  <div>
                    <h2>Connection continuity</h2>
                    <p>Recorded affinity and account changes for this conversation</p>
                  </div>
                </div>
                <div className="panel-body">
                  {(detail.data.switches || []).map((s) => (
                    <div className="continuity-event" key={s.id}>
                      <Icon name="i-network" />
                      <div>
                        <strong>{s.reason || s.trigger || 'Account changed'}</strong>
                        <small>
                          {s.model} · {fmtTime(s.switchedAt)}
                        </small>
                        <span>
                          {s.fromConnectionId || 'No prior account'} →{' '}
                          {s.toConnectionId || 'No next account'}
                        </span>
                      </div>
                    </div>
                  ))}
                  {(detail.data.pins || []).map((p, i) => (
                    <div className="continuity-event" key={`${p.model}-${i}`}>
                      <Icon name="i-access" />
                      <div>
                        <strong>Session affinity · {p.model}</strong>
                        <span>
                          {p.connectionId} · expires {fmtTime(p.expiresAt)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        </div>
      ) : null}
      {data?.stages?.length ? (
        <div className="operator-grid">
          <section className="operator-panel">
            <div className="panel-head">
              <div>
                <h2>Where the bytes changed</h2>
                <p>Aggregate effects across the selected conversations</p>
              </div>
              <Link href="/dashboard/shaping" className="text-link">
                Configure
                <Icon name="i-right" />
              </Link>
            </div>
            <div className="panel-body">
              <StageLedger stages={data.stages} />
            </div>
          </section>
          <section className="operator-panel">
            <div className="panel-head">
              <div>
                <h2>Measurement coverage</h2>
                <p>Keep observed usage separate from estimates</p>
              </div>
            </div>
            <div className="panel-body">
              <div className="coverage-row">
                <span>Provider-reported attempts</span>
                <strong>{summary.providerUsageSamples}</strong>
              </div>
              <div className="coverage-row">
                <span>Estimated attempts</span>
                <strong>{summary.estimatedUsageSamples}</strong>
              </div>
              <div className="coverage-row">
                <span>Missing usage</span>
                <strong>{summary.missingUsageSamples}</strong>
              </div>
              <div className="coverage-row">
                <span>Prefix change hints</span>
                <strong>{summary.compactionHints}</strong>
              </div>
              <p className="chart-disclosure">
                Body reduction is measured in bytes. It is not a billed-token saving.
                Content-changing stages may remove information and need explicit operator intent.
              </p>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
