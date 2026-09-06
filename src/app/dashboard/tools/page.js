'use client';
import Link from 'next/link';
import { usePoll } from '@/shared/hooks/usePoll';
import { Freshness } from '@/shared/components/Freshness';
import { Icon } from '@/shared/components/Icon';
import { Notice } from '@/shared/components/Notice';
import { refusal } from '@/shared/refusal';

export default function ToolsPage() {
  const tools = usePoll('/api/tools', 15000);
  const data = tools.data;
  const summary = data?.summary;
  const state = tools.error
    ? tools.goodAt
      ? 'stale'
      : 'reconnecting'
    : tools.loading
      ? 'connecting'
      : 'live';
  return (
    <>
      <div className="screen-head">
        <div className="page-title">
          <h1>Tools</h1>
          <p className="screen-subtitle">The local extensions connected to your gateway.</p>
        </div>
        <button className="button quiet" onClick={tools.refresh}>
          <Icon name="i-refresh" />
          Refresh
        </button>
        <Freshness status={state} lastDataAt={tools.goodAt} />
      </div>
      {tools.error ? <Notice {...refusal(tools.status, tools.error)} /> : null}
      <div className="kpi-grid">
        <div className="kpi">
          <div className="kpi-label">
            Configured extensions
            <Icon name="i-tools" />
          </div>
          <div className="kpi-value">{summary?.presets ?? '—'}</div>
          <p className="kpi-foot">Available local bridge presets</p>
        </div>
        <div className="kpi">
          <div className="kpi-label">
            Running
            <Icon name="i-connections" />
          </div>
          <div className="kpi-value">{summary?.running ?? '—'}</div>
          <p className="kpi-foot">Processes observed by this gateway</p>
        </div>
        <div className="kpi">
          <div className="kpi-label">
            Attached clients
            <Icon name="i-sessions" />
          </div>
          <div className="kpi-value">{summary?.clients ?? '—'}</div>
          <p className="kpi-foot">Open bridge connections</p>
        </div>
      </div>
      <section>
        <div className="screen-head">
          <h2>Local extension bridge</h2>
          <span className="caption">Observed local process state</span>
        </div>
        {tools.loading && !data ? (
          <p className="skeleton">Reading extensions</p>
        ) : data?.presets?.length ? (
          <div className="tool-cards">
            {data.presets.map((p) => (
              <article className="tool-card" key={p.id}>
                <div className="tool-card-head">
                  <span className="tool-symbol">
                    <Icon name="i-tools" />
                  </span>
                  <div>
                    <h3 data-i18n-skip>{p.name}</h3>
                    <p>{p.transport} bridge</p>
                  </div>
                  <span className="status" data-tone={p.running ? 'ok' : undefined}>
                    {p.running ? 'Running' : 'Stopped'}
                  </span>
                </div>
                <div className="tool-card-facts">
                  <span>{p.clients} clients</span>
                  <code>{p.endpoint}</code>
                </div>
              </article>
            ))}
          </div>
        ) : data ? (
          <div className="chart-empty">
            <Icon name="i-tools" />
            <strong>No local extensions configured</strong>
            <span>Configured MCP presets appear here when the gateway can read them.</span>
          </div>
        ) : null}
        <p className="chart-disclosure">
          Viewing this page reads existing state. An extension starts when a client attaches to its
          bridge endpoint.
        </p>
      </section>
      <section>
        <h2>Connect a coding client</h2>
        <p className="screen-subtitle">
          Point a client that supports a custom OpenAI-compatible endpoint to this gateway, then use
          a gateway API key.
        </p>
        <div className="endpoint-bar">
          <Icon name="i-keys" />
          <span>Endpoint and keys</span>
          <Link className="text-link" href="/dashboard/keys">
            Open connection details
            <Icon name="i-right" />
          </Link>
        </div>
      </section>
      <details className="fold">
        <summary>Integration capabilities</summary>
        <p className="caption">
          Automatic client takeover, interception, and vendor-model remapping are not exposed by
          this gateway. Configure your client’s endpoint directly.
        </p>
      </details>
    </>
  );
}
