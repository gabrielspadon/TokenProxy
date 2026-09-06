'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ReactFlow, Handle, Position, Background } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ProviderMark, providerIdentity } from '@/shared/components/ProviderMark';
import { Brand } from '@/shared/components/Brand';
import { Icon } from '@/shared/components/Icon';
import { Freshness } from '@/shared/components/Freshness';
import { Notice } from '@/shared/components/Notice';
import { fmtNum } from '@/shared/format';
import { TONE, WORDS } from '@/shared/status';

const RANK = { bad: 3, warn: 2, ok: 1 };
function inspectOnKeyboard(event) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    event.currentTarget.click();
  }
}

// One lane per provider the gateway knows about today: every connected
// provider, every provider with a request in today's rollup, every provider
// with a session open right now. Ordered by today's share, then by what is in
// flight, so the lane the operator is looking for is near the top.
export function buildLanes(usage, conns) {
  const byProvider = usage?.byProvider || {};
  const sessions = usage?.activeSessions || [];
  const names = new Set([
    ...conns.map((c) => c.provider),
    ...Object.keys(byProvider),
    ...sessions.map((s) => s.provider),
  ]);
  const rows = Object.values(byProvider);
  const total = rows.reduce((n, r) => n + (r.requests || 0), 0);
  const peak = rows.reduce((n, r) => Math.max(n, r.promptTokens || 0, r.completionTokens || 0), 0);
  const lanes = [...names].filter(Boolean).map((provider) => {
    const r = byProvider[provider] || {};
    const mine = sessions.filter((s) => s.provider === provider);
    const own = conns.filter((c) => c.provider === provider);
    let tone = null;
    for (const c of own) {
      const t = TONE[c.status] || 'warn';
      if (!tone || RANK[t] > RANK[tone]) tone = t;
    }
    const failedNow = usage?.errorProvider && usage.errorProvider === provider;
    const worst = own.find((c) => (TONE[c.status] || 'warn') === tone);
    return {
      provider,
      requests: r.requests || 0,
      share: total ? (r.requests || 0) / total : 0,
      out: r.promptTokens || 0,
      back: r.completionTokens || 0,
      outFrac: peak ? (r.promptTokens || 0) / peak : 0,
      backFrac: peak ? (r.completionTokens || 0) / peak : 0,
      active: mine.filter((s) => s.status === 'active').length,
      done: mine.filter((s) => s.status === 'done').length,
      failed: mine.filter((s) => s.status === 'error').length + (failedNow ? 1 : 0),
      tone: failedNow ? 'bad' : tone,
      word: failedNow ? WORDS.error : worst ? WORDS[worst.status] || worst.status : null,
      draining: own.some((c) => c.isDraining),
    };
  });
  lanes.sort(
    (a, b) => b.requests - a.requests || b.active - a.active || a.provider.localeCompare(b.provider)
  );
  return {
    lanes,
    total,
    activeTotal: sessions.filter((s) => s.status === 'active').length,
  };
}

function RouterNode({ data }) {
  if (data.kind === 'request')
    return (
      <div className="graph-request" data-selected={data.selected}>
        <Handle type="source" position={Position.Right} />
        <span className="request-client-icon">
          <Icon name="i-tools" />
        </span>
        <div>
          <strong>{data.clientTool || 'Active request'}</strong>
          <span data-i18n-skip>{data.model}</span>
          <small>{data.account || 'Account not reported'}</small>
        </div>
      </div>
    );
  if (data.kind === 'hub')
    return (
      <div className="graph-hub">
        <Handle type="target" position={Position.Left} />
        <Handle type="source" position={Position.Right} />
        <Brand compact />
        <strong>Gateway</strong>
      </div>
    );
  return (
    <div className="graph-provider" data-tone={data.tone} data-selected={data.selected}>
      <Handle type="target" position={Position.Left} />
      <ProviderMark provider={data.provider} />
      <span>
        <strong>{providerIdentity(data.provider).name}</strong>
        <small data-i18n-skip>{data.displayName || 'Account not reported'}</small>
      </span>
      <span className="graph-provider-state">
        {data.active ? (
          <>
            <i />
            {data.active} live
          </>
        ) : (
          data.word || 'Unreported'
        )}
      </span>
    </div>
  );
}
const nodeTypes = { router: RouterNode };
export function RouteMap({
  usage,
  conns,
  stream,
  receivedAt,
  selectedConnection,
  onSelectConnection,
}) {
  const { lanes, total, activeTotal } = useMemo(() => buildLanes(usage, conns), [usage, conns]);
  const [paused, setPaused] = useState(false);
  const [selectedRequest, setSelectedRequest] = useState(null);
  const active = (usage?.activeSessions || []).filter((s) => s.status === 'active');
  const requests = active.slice(0, 3);
  const matches = (s, c) =>
    s.provider === c.provider &&
    s.account &&
    s.account === c.displayName &&
    conns.filter((x) => x.provider === c.provider && x.displayName === c.displayName).length === 1;
  const accounts = conns.slice(0, 6).map((c) => ({
    ...c,
    id: c.connectionId,
    tone: TONE[c.status] || 'warn',
    word: c.isDraining ? 'Draining' : WORDS[c.status] || c.status,
    active: active.filter((s) => matches(s, c)).length,
  }));
  const height = accounts.length ? Math.max(320, accounts.length * 64) : 210;
  const nodes = [
    ...requests.map((s, i) => ({
      id: `request-${i}`,
      ariaLabel: `Inspect request ${i + 1}, ${s.model || 'model unknown'}, ${s.account || 'account unknown'}`,
      ariaRole: 'button',
      domAttributes: { onKeyDown: inspectOnKeyboard },
      type: 'router',
      width: 210,
      height: 74,
      position: { x: 0, y: (height / (requests.length + 1)) * (i + 1) - 37 },
      data: { ...s, kind: 'request', selected: i === selectedRequest },
    })),
    {
      id: 'hub',
      ariaLabel: 'Gateway junction',
      focusable: false,
      type: 'router',
      width: 76,
      height: 76,
      position: { x: 292, y: height / 2 - 38 },
      data: { kind: 'hub' },
    },
    ...accounts.map((c, i) => ({
      id: c.id,
      ariaLabel: `Inspect ${c.displayName || c.provider}, ${c.word || 'health unknown'}`,
      ariaRole: 'button',
      domAttributes: { onKeyDown: inspectOnKeyboard },
      type: 'router',
      width: 260,
      height: 50,
      position: { x: 460, y: 5 + i * 64 },
      data: { ...c, selected: c.id === selectedConnection },
    })),
  ];
  const animate = !paused && stream.status === 'live';
  const edges = [
    ...requests.map((s, i) => ({
      id: `input-${i}`,
      source: `request-${i}`,
      target: 'hub',
      animated: animate,
      style: {
        stroke: `var(--brand-${providerIdentity(s.provider).color})`,
        strokeWidth: 2.4,
        opacity: 0.85,
      },
    })),
    ...accounts.map((c) => ({
      id: `allocation-${c.id}`,
      source: 'hub',
      target: c.id,
      animated: animate && c.active > 0,
      style: {
        stroke: `var(--brand-${providerIdentity(c.provider).color})`,
        strokeWidth: 1.4 + c.active * 1.3,
        opacity: c.active ? 0.9 : 0.35,
      },
    })),
  ];
  const picked = selectedRequest == null ? null : requests[selectedRequest];
  return (
    <section
      className="routing-room"
      aria-labelledby="h-routing"
      data-paused={paused}
      data-live={stream.status === 'live'}
    >
      {stream.status === 'stale' ? (
        <Notice
          tone="warn"
          title="The usage stream stopped."
          next="The last received frame is shown while the gateway reconnects."
        />
      ) : null}
      <div className="routing-head">
        <h2 id="h-routing">Work in motion</h2>
        <div className="routing-tools">
          <Freshness status={stream.status} lastDataAt={receivedAt} />
          <button
            className="graph-toggle"
            aria-label={paused ? 'Resume route animation' : 'Pause route animation'}
            onClick={() => setPaused(!paused)}
          >
            <Icon name={paused ? 'i-play' : 'i-pause'} />
          </button>
        </div>
      </div>
      <div className="routing-main">
        <div className="routing-summary">
          <span>Requests today</span>
          <strong>{usage ? fmtNum(total) : '—'}</strong>
          <span className="routing-active">
            <i data-active={activeTotal > 0} />
            {usage ? `${activeTotal} requests in flight` : 'Waiting for telemetry'}
          </span>
          <span className="routing-allocation-count">
            {conns.length} connections · {lanes.length} providers
          </span>
        </div>
        <div className="flow-column-labels">
          <span>Observed work</span>
          <span>Gateway</span>
          <span>Account allocation</span>
        </div>
        <div className="routing-canvas" style={{ height }}>
          {accounts.length ? (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.055 }}
              nodesDraggable={false}
              nodesConnectable={false}
              edgesFocusable={false}
              deleteKeyCode={null}
              ariaLabelConfig={{
                'node.a11yDescription.default':
                  'Press Enter or Space to inspect the observed request or account.',
              }}
              zoomOnScroll={false}
              panOnDrag={false}
              preventScrolling={false}
              minZoom={0.2}
              maxZoom={1.3}
              onNodeClick={(_, n) => {
                if (n.id.startsWith('request-')) setSelectedRequest(Number(n.id.slice(8)));
                else if (n.id !== 'hub') onSelectConnection(n.id);
              }}
              attributionPosition="bottom-right"
            >
              <Background color="var(--graph-dot)" gap={22} size={1} />
            </ReactFlow>
          ) : (
            <div className="graph-onboarding">
              <Brand compact />
              <strong>
                {usage ? 'Connect your first provider' : 'Listening for the first frame'}
              </strong>
              <p>Configured accounts and observed requests form the routing view.</p>
              <Link className="button" href="/dashboard/connections">
                Add connection
                <Icon name="i-add" />
              </Link>
            </div>
          )}
          {accounts.length && !requests.length ? (
            <div className="flow-idle">
              <Icon name="i-sessions" />
              <span>No requests in flight</span>
              <small>The next request appears here.</small>
            </div>
          ) : null}
        </div>
      </div>
      <div className="routing-mobile-list">
        {accounts.map((c) => (
          <button
            key={c.id}
            onClick={() => onSelectConnection(c.id)}
            aria-pressed={c.id === selectedConnection}
          >
            <ProviderMark provider={c.provider} size="small" label />
            <span>
              {c.displayName}
              <small>{c.active ? `${c.active} in flight` : c.word}</small>
            </span>
          </button>
        ))}
      </div>
      <div className="routing-caption">
        <span>
          <i />
          Motion indicates observed work. Account matches use reported account labels.
        </span>
        <Link href="/dashboard/connections">
          All accounts
          <Icon name="i-right" />
        </Link>
      </div>
      <div className="routing-activity">
        <div className="activity-heading">
          <span>Live requests</span>
          <strong>{activeTotal}</strong>
          <Link href="/dashboard/context">
            Context evolution
            <Icon name="i-right" />
          </Link>
        </div>
        {requests.map((s, i) => (
          <button
            className="flight-row"
            data-selected={i === selectedRequest}
            onClick={() => setSelectedRequest(i)}
            key={i}
          >
            <ProviderMark provider={s.provider} size="small" />
            <span>
              <strong data-i18n-skip>{s.clientTool || s.model || 'Active request'}</strong>
              <small>{s.account || 'Account not reported'}</small>
            </span>
            <span className="flight-signal" aria-hidden="true" />
          </button>
        ))}
        {!activeTotal ? (
          <p className="flight-empty">Requests appear while they are running.</p>
        ) : null}
        {activeTotal > requests.length ? (
          <p className="flight-empty">
            Showing {requests.length} of {activeTotal}. All requests are available in Sessions.
          </p>
        ) : null}
      </div>
      {picked ? (
        <div className="live-request-details">
          <ProviderMark provider={picked.provider} label />
          <span data-i18n-skip>{picked.model}</span>
          <span>
            Input {picked.promptTokens == null ? 'not yet reported' : fmtNum(picked.promptTokens)}
          </span>
          <span>
            Output{' '}
            {picked.completionTokens == null ? 'not yet reported' : fmtNum(picked.completionTokens)}
          </span>
          <button
            className="graph-toggle"
            aria-label="Close request details"
            onClick={() => setSelectedRequest(null)}
          >
            <Icon name="i-close" />
          </button>
        </div>
      ) : null}
      <details className="route-data">
        <summary>All {lanes.length} providers as numbers</summary>
        <div className="rows">
          {lanes.map((l) => (
            <div className="route-data-row" key={l.provider}>
              <ProviderMark provider={l.provider} label />
              <span>{fmtNum(l.requests)} requests</span>
              <span>{fmtNum(l.out)} input</span>
              <span>{fmtNum(l.back)} output</span>
              <span>{l.active} in flight</span>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}
