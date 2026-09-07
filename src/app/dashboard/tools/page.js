'use client';
import Link from 'next/link';
import { useState } from 'react';
import { SelectionDock } from '@/shared/workspace/SelectionDock';
import { usePoll } from '@/shared/hooks/usePoll';
import { Freshness } from '@/shared/components/Freshness';
import { Icon } from '@/shared/components/Icon';
import { Notice } from '@/shared/components/Notice';
import { refusal } from '@/shared/refusal';
import styles from './tools.module.css';
import { LOCAL_STDIO_PLUGINS } from '@/shared/constants/coworkPlugins';

export default function ToolsPage() {
  const tools = usePoll('/api/tools', 15000);
  const data = tools.data;
  const summary = data?.summary;
  const [selectedId, setSelectedId] = useState(null);
  const selected = data?.presets?.find((preset) => preset.id === selectedId);
  const setup = LOCAL_STDIO_PLUGINS.find(item => item.name === selected?.id);
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
      <dl className={styles.summary} aria-label="Observed extension summary">
        <div><dt>Bridge presets</dt><dd>{summary?.presets ?? 'Unknown'}</dd></div>
        <div><dt>Running processes</dt><dd>{summary?.running ?? 'Unknown'}</dd></div>
        <div><dt>Attached clients</dt><dd>{summary?.clients ?? 'Unknown'}</dd></div>
      </dl>
      <section>
        <div className="screen-head">
          <h2>Local extension bridge</h2>
          <span className="caption">Observed local process state</span>
        </div>
        {tools.loading && !data ? (
          <p className="skeleton">Reading extensions</p>
        ) : data?.presets?.length ? (
          <SelectionDock
            open={Boolean(selected)}
            title={selected?.name || 'Extension evidence'}
            subtitle={selected?.id}
            onClose={() => setSelectedId(null)}
            height={selected ? '620px' : '380px'}
            closedMaxHeight="380px"
            detail={
              selected && (
                <>
                  <dl className="facts">
                    <dt>Observed process</dt>
                    <dd>
                      {selected.running === true
                        ? 'Running'
                        : selected.running === false
                          ? 'Stopped'
                          : 'Unknown'}
                    </dd>
                    <dt>Attached clients</dt>
                    <dd>{selected.clients ?? 'Unknown'}</dd>
                    <dt>Declared tools</dt>
                    <dd>{selected.declaredToolCount ?? 'Unknown'}</dd>
                    <dt>Transport</dt>
                    <dd>{selected.transport ?? 'Unknown'}</dd>
                    <dt>Local bridge endpoint</dt>
                    <dd>
                      <code>{selected.endpoint ?? 'Unknown'}</code>
                    </dd>
                  </dl>
                  {setup ? <details><summary>Client setup and declared tools</summary>
                    <p>{setup.description}. Each attached client owns its extension process. Browser MCP permits one simultaneous client; other presets share the gateway’s 16-session ceiling.</p>
                    {setup.extensionUrl ? <p><a href={setup.extensionUrl} target="_blank" rel="noopener noreferrer">Install the browser extension</a></p> : null}
                    {setup.setupUrl ? <p><a href={setup.setupUrl} target="_blank" rel="noopener noreferrer">{setup.setupLabel || 'Installation prerequisites'}</a></p> : null}
                    <p>The gateway launches <code>{setup.command} {setup.args.join(' ')}</code> only when a client attaches. Package resolution may download software. This screen does not install or execute it.</p>
                    <p>Configure an SSE MCP server at this gateway’s origin plus <code>{selected.endpoint}</code>. Supply the machine CLI credential in <code>x-tp-cli-token</code>; an inference API key does not authorize this bridge. Keep that credential in your client’s private environment or secret store.</p>
                    <ul>{setup.toolNames.map(name => <li key={name}><code>{name}</code></li>)}</ul>
                  </details> : null}
                  <p>
                    Process state does not establish package installation, tool execution or
                    upstream readiness. No start, installation or test is performed by inspection. A
                    client attaching to the bridge can start its extension.
                  </p>
                </>
              )
            }
          >
            <div
              className={styles.scroll}
              role="region"
              tabIndex={0}
              aria-label="Extension comparison"
            >
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Extension</th>
                    <th>Transport</th>
                    <th>Process</th>
                    <th>Clients</th>
                    <th>Declared tools</th>
                  </tr>
                </thead>
                <tbody>
                  {data.presets.map((p) => (
                    <tr key={p.id} data-selected={p.id === selectedId || undefined}>
                      <td>
                        <button
                          type="button"
                          className="link-button"
                          aria-pressed={p.id === selectedId}
                          onClick={() => setSelectedId(p.id)}
                          data-i18n-skip
                        >
                          {p.name}
                        </button>
                      </td>
                      <td>{p.transport ?? 'Unknown'}</td>
                      <td>
                        {p.running === true
                          ? 'Running'
                          : p.running === false
                            ? 'Stopped'
                            : 'Unknown'}
                      </td>
                      <td>{p.clients ?? 'Unknown'}</td>
                      <td>{p.declaredToolCount ?? 'Unknown'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SelectionDock>
        ) : data ? (
          <div className="chart-empty">
            <Icon name="i-tools" />
            <strong>No local extensions configured</strong>
            <span>Configured MCP presets appear here when the gateway can read them.</span>
          </div>
        ) : null}
        <p className="chart-disclosure">
          Preset definitions do not prove a package is installed. Installation is not probed here.
          Viewing this page reads existing process state. An extension starts when a client attaches
          to its bridge endpoint.
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
      <section><h2>Conversation context through MCP</h2>
        <p>Configure a Streamable HTTP MCP client at this gateway’s origin plus <code>/api/v1/mcp</code>, with a gateway inference key in its Authorization bearer header. It exposes the read-only <code>context_status</code> tool. Use the same session identity header as your inference client, or an explicit eight-character session ID when permitted by this deployment.</p>
        <p>The tool reads retained context evidence. Anonymous callers cannot select another session implicitly. Unknown sessions return no snapshot. This does not generate a completion, change context policy, or prove future context capacity.</p>
        <Link href="/dashboard/keys">Configure a gateway key</Link>
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
