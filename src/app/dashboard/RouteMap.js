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
import { fmtNum, fmtPct, fmtRelative } from '@/shared/format';
import { TONE, WORDS } from '@/shared/status';

const RANK = { bad: 3, warn: 2, ok: 1 };
const MAX_DOTS = 6;

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
  if (data.hub)
    return (
      <div className="graph-hub">
        <Handle type="source" position={Position.Right} />
        <Brand compact />
        <strong>TokenProxy</strong>
        <span>{data.active ? `${data.active} in flight` : 'Ready to route'}</span>
        <small>One endpoint · every model</small>
      </div>
    );
  return (
    <div className="graph-provider" data-tone={data.tone}>
      <Handle type="target" position={Position.Left} />
      <ProviderMark provider={data.provider} />
      <span>
        <strong>{providerIdentity(data.provider).name}</strong>
        <small>
          {fmtNum(data.requests)} requests <span className="graph-share">{fmtPct(data.share)}</span>
        </small>
      </span>
      <span className="graph-provider-state">
        {data.active ? (
          <>
            <i />
            {data.active} live
          </>
        ) : (
          data.word || 'Idle'
        )}
      </span>
    </div>
  );
}
const nodeTypes = { router: RouterNode };
export function RouteMap({ usage, conns, stream, receivedAt }) {
  const { lanes, total, activeTotal } = useMemo(() => buildLanes(usage, conns), [usage, conns]);
  const [selected, setSelected] = useState(null);
  const [paused, setPaused] = useState(false);
  const visible = lanes.slice(0, 5);
  const height = visible.length ? Math.max(245, visible.length * 54) : 200;
  const nodes = [
    {
      id: 'hub',
      type: 'router',
      width: 150,
      height: 140,
      position: { x: 25, y: height / 2 - 68 },
      data: { hub: true, active: activeTotal },
    },
    ...visible.map((l, i) => ({
      id: l.provider,
      type: 'router',
      width: 263,
      height: 48,
      position: { x: 350, y: 8 + i * 54 },
      data: l,
    })),
  ];
  const edges = visible.map((l) => ({
    id: `route-${l.provider}`,
    source: 'hub',
    target: l.provider,
    animated: !paused && stream.status === 'live' && l.active > 0,
    style: {
      stroke: `var(--brand-${providerIdentity(l.provider).color})`,
      strokeWidth: 1.4 + l.share * 4,
      opacity: l.requests || l.active ? 0.85 : 0.35,
    },
  }));
  const picked = lanes.find((l) => l.provider === selected);
  return (
    <section className="routing-room" aria-labelledby="h-routing">
      {stream.status === 'stale' ? (
        <Notice
          tone="warn"
          title="The usage stream stopped."
          next="The last received frame is shown while the gateway reconnects."
        />
      ) : null}
      <div className="routing-head">
        <div>
          <h2 id="h-routing">Live routing</h2>
          <p>Every request, one connected gateway.</p>
        </div>
        <div className="routing-tools">
          <Freshness status={stream.status} lastDataAt={receivedAt} />
          <button
            className="graph-toggle"
            type="button"
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
          <div className="routing-active">
            <i data-active={activeTotal > 0} />
            {usage ? `${activeTotal} requests in flight` : 'Waiting for telemetry'}
          </div>
          <div className="routing-mini">
            <span>
              {lanes.length}
              <small>Providers seen</small>
            </span>
            <span>
              {conns.length}
              <small>Connections</small>
            </span>
          </div>
          <Link href="/dashboard/connections" className="routing-link">
            Manage connections <Icon name="i-right" />
          </Link>
        </div>
        <div className="routing-canvas" style={{ height }}>
          {lanes.length ? (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.13 }}
              nodesDraggable={false}
              nodesConnectable={false}
              edgesFocusable={false}
              zoomOnScroll={false}
              panOnDrag={false}
              preventScrolling={false}
              onNodeClick={(_, node) => {
                if (node.id !== 'hub') setSelected(node.id);
              }}
              minZoom={0.2}
              maxZoom={1.2}
              attributionPosition="bottom-right"
            >
              <Background color="var(--graph-dot)" gap={20} size={1} />
            </ReactFlow>
          ) : (
            <div className="graph-onboarding">
              <Brand compact />
              <strong>
                {usage ? 'Connect your first provider' : 'Listening for the first frame'}
              </strong>
              <p>
                {usage
                  ? 'Add a connection to start routing requests through your gateway.'
                  : 'The routing map will reflect the gateway’s recorded connections.'}
              </p>
              <Link className="button" href="/dashboard/connections">
                <Icon name="i-add" />
                Add connection
              </Link>
            </div>
          )}
        </div>
      </div>
      <div className="routing-mobile-list">
        {visible.map((l) => (
          <button key={l.provider} onClick={() => setSelected(l.provider)}>
            <ProviderMark provider={l.provider} size="small" label />
            <span>
              {fmtNum(l.requests)}
              <small>{l.active ? `${l.active} in flight` : l.word || 'Idle'}</small>
            </span>
            <span className="mobile-share" style={{ '--share': `${l.share * 100}%` }} />
          </button>
        ))}
      </div>
      <div className="routing-caption">
        <span>
          <i />
          Path width shows today’s request share. Motion means a request is in flight.
        </span>
        <Link href="/dashboard/sessions">
          Inspect sessions <Icon name="i-right" />
        </Link>
      </div>
      {picked ? (
        <div className="route-inspector">
          <ProviderMark provider={picked.provider} label />
          <span>{fmtNum(picked.out)} input tokens</span>
          <span>{fmtNum(picked.back)} output tokens</span>
          <span>{picked.word || 'No connection health reported'}</span>
          <button
            className="graph-toggle"
            aria-label="Close provider details"
            onClick={() => setSelected(null)}
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
