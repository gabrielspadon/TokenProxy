'use client';
import { Fragment, useCallback, useState } from 'react';
import Link from 'next/link';
import { usePoll } from '@/shared/hooks/usePoll';
import { Freshness } from '@/shared/components/Freshness';
import { Notice } from '@/shared/components/Notice';
import { Confirm } from '@/shared/components/Confirm';
import { call } from '@/shared/api';
import { refusal } from '@/shared/refusal';
import { poolTestVerdict } from '@/shared/poolTestVerdict';
import { fmtNum } from '@/shared/format';
import { Icon } from '@/shared/components/Icon';
import './styles.css';

const NODE_TYPE_WORD = {
  'openai-compatible': 'OpenAI compatible',
  'multi-compatible': 'OpenAI and Anthropic compatible',
  'custom-embedding': 'Custom embedding',
  'anthropic-compatible': 'Anthropic compatible',
};

const TEST_WORD = { unknown: 'Not tested', active: 'Reachable', error: 'Failed' };
const TEST_TONE = { unknown: 'warn', active: 'ok', error: 'bad' };

function pollFresh(p) {
  if (p.loading) return 'connecting';
  if (p.error && p.goodAt) return 'stale';
  if (p.error) return 'reconnecting';
  return 'live';
}

// The hard rule of this slice: a proxy URL may embed `user:pass@`. Never show it.
function maskProxyUrl(url) {
  const s = String(url || '');
  try {
    const u = new URL(s);
    if (u.username || u.password) return s.replace(`${u.username}:${u.password}@`, '•••@');
    return s;
  } catch {
    return s.replace(/\/\/[^/@]+@/, '//•••@');
  }
}

const NODE_BLANK = {
  name: '',
  prefix: '',
  type: 'openai-compatible',
  apiType: 'chat',
  baseUrl: '',
};
const POOL_BLANK = { name: '', proxyUrl: '', noProxy: '', type: 'http', strictProxy: false };

export default function NetworkPage() {
  const nodes = usePoll('/api/provider-nodes', 30000);
  const pools = usePoll('/api/proxy-pools?includeUsage=true', 15000);
  const settings = usePoll('/api/settings', 30000);

  const [action, setAction] = useState(null); // { kind, node? | pool? }
  const [nodeForm, setNodeForm] = useState(NODE_BLANK);
  const [poolForm, setPoolForm] = useState(POOL_BLANK);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(null);
  const [result, setResult] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [outbound, setOutbound] = useState(null); // draft while editing, else null
  const [strategyProvider, setStrategyProvider] = useState('');
  const [strategyPoolId, setStrategyPoolId] = useState('');

  const nodeRows = nodes.data?.nodes || [];
  const poolRows = pools.data?.proxyPools || [];
  const outboundEnabled = settings.data?.outboundProxyEnabled;
  const outboundUrl = settings.data?.outboundProxyUrl || '';
  const outboundNoProxy = settings.data?.outboundNoProxy || '';
  const connectTimeoutMs = settings.data?.connectTimeoutMs;
  const providerStrategies = settings.data?.providerStrategies || {};

  const close = useCallback(() => {
    setAction(null);
    setRefused(null);
  }, []);
  const openNode = (kind, node) => {
    setRefused(null);
    setResult(null);
    setNodeForm(
      node
        ? {
            name: node.name || '',
            prefix: node.prefix || '',
            type: node.type,
            apiType: node.apiType || 'chat',
            baseUrl: node.baseUrl || '',
          }
        : NODE_BLANK
    );
    setAction({ kind, node });
  };
  const openPool = (kind, pool) => {
    setRefused(null);
    setResult(null);
    setPoolForm(
      pool
        ? {
            name: pool.name || '',
            proxyUrl: '',
            noProxy: pool.noProxy || '',
            type: pool.type || 'http',
            strictProxy: pool.strictProxy === true,
          }
        : POOL_BLANK
    );
    setAction({ kind, pool });
  };

  const run = async () => {
    if (!action) return;
    setBusy(true);
    setRefused(null);
    let res;
    if (action.kind === 'createNode') {
      res = await call('/api/provider-nodes', { method: 'POST', body: nodeForm });
    } else if (action.kind === 'editNode') {
      res = await call(`/api/provider-nodes/${encodeURIComponent(action.node.id)}`, {
        method: 'PUT',
        body: nodeForm,
      });
    } else if (action.kind === 'deleteNode') {
      res = await call(`/api/provider-nodes/${encodeURIComponent(action.node.id)}`, {
        method: 'DELETE',
      });
    } else if (action.kind === 'createPool') {
      res = await call('/api/proxy-pools', { method: 'POST', body: poolForm });
    } else if (action.kind === 'editPool') {
      const body = { ...poolForm };
      if (!body.proxyUrl) delete body.proxyUrl;
      res = await call(`/api/proxy-pools/${encodeURIComponent(action.pool.id)}`, {
        method: 'PUT',
        body,
      });
    } else if (action.kind === 'deletePool') {
      res = await call(`/api/proxy-pools/${encodeURIComponent(action.pool.id)}`, {
        method: 'DELETE',
      });
    } else if (action.kind === 'outboundOn' || action.kind === 'outboundOff') {
      res = await call('/api/settings', {
        method: 'PATCH',
        body: {
          outboundProxyEnabled: action.kind === 'outboundOn',
          outboundProxyUrl: outbound?.url ?? outboundUrl,
          outboundNoProxy: outbound?.noProxy ?? outboundNoProxy,
        },
      });
    }
    setBusy(false);
    if (!res.ok) {
      setRefused(refusal(res.status, res.body));
      return;
    }
    if (action.kind.startsWith('outbound')) {
      setOutbound(null);
      settings.refresh();
    } else if (action.kind.endsWith('Node')) nodes.refresh();
    else pools.refresh();
    setResult({ tone: 'ok', title: 'Done.' });
    close();
  };

  const testPool = async (pool) => {
    setTestResult(null);
    const res = await call(`/api/proxy-pools/${encodeURIComponent(pool.id)}/test`, {
      method: 'POST',
    });
    setTestResult({ id: pool.id, ...poolTestVerdict(res, refusal) });
    pools.refresh();
  };

  const saveStrategy = async () => {
    setResult(null);
    const res = await call('/api/settings', {
      method: 'PATCH',
      body: {
        providerStrategyPatch: {
          providerId: strategyProvider.trim(),
          values: { proxyPoolId: strategyPoolId || '__none__' },
        },
      },
    });
    if (!res.ok) {
      setResult(refusal(res.status, res.body));
      return;
    }
    settings.refresh();
  };

  const NODE_COPY = {
    createNode: {
      title: 'Add a provider node',
      verb: 'Create',
      requires: 'An operator session.',
      changes: 'Registers a new upstream endpoint that a connection can be pointed at.',
      undo: 'Delete the node.',
    },
    editNode: {
      title: 'Save node',
      verb: 'Save',
      requires: 'An operator session.',
      changes:
        "Updates the node's prefix, API dialect and base URL, and cascades them into every connection bound to it.",
      undo: 'Change the fields back.',
    },
    deleteNode: {
      title: 'Delete node',
      verb: 'Delete',
      requires: 'An operator session.',
      changes: `Removes this node, every provider connection registered against it, and every model alias that points at it, in one step.`,
      undo: 'None. A deleted node, its connections and its aliases cannot be restored.',
      irreversible: true,
    },
  };
  const POOL_COPY = {
    createPool: {
      title: 'Add a proxy pool',
      verb: 'Create',
      requires: 'An operator session.',
      changes: 'Registers a new outbound path a connection or a provider strategy can be bound to.',
      undo: 'Delete the pool.',
    },
    editPool: {
      title: 'Save pool',
      verb: 'Save',
      requires: 'An operator session.',
      changes:
        'Updates this pool. Changing its strictness updates every connection and every provider strategy currently bound to it, atomically.',
      undo: 'Change the fields back.',
    },
    deletePool: (pool) => ({
      title: 'Delete pool',
      verb: 'Delete',
      requires: 'An operator session.',
      changes: pool?.boundConnectionCount
        ? `${fmtNum(pool.boundConnectionCount)} connection${pool.boundConnectionCount === 1 ? '' : 's'} bound to this pool will be refused: a pool still in use is not deleted.`
        : 'No connection is bound to this pool. It is deleted immediately.',
      undo: 'None. A deleted pool cannot be restored.',
      irreversible: true,
    }),
    outboundOn: {
      title: 'Turn on the outbound proxy',
      verb: 'Turn on',
      requires: 'An operator session.',
      changes:
        'Every upstream call not routed through a specific pool uses this proxy from now on.',
      undo: 'Turn it off again.',
    },
    outboundOff: {
      title: 'Turn off the outbound proxy',
      verb: 'Turn off',
      requires: 'An operator session.',
      changes:
        'Every upstream call not routed through a specific pool goes out directly from now on.',
      undo: 'Turn it on again.',
    },
  };
  const copyFor = action
    ? NODE_COPY[action.kind] ||
      (action.kind === 'deletePool' ? POOL_COPY.deletePool(action.pool) : POOL_COPY[action.kind])
    : null;

  return (
    <>
      <div className="screen-head">
        <h1>Network</h1>
        <Freshness status={pollFresh(pools)} lastDataAt={pools.goodAt} />
      </div>
      {result ? <Notice {...result} /> : null}

      <div className="measures">
        <div className="measure big">
          <span className="label">Provider nodes</span>
          <span className="value" data-i18n-skip>
            {nodes.data ? fmtNum(nodeRows.length) : '—'}
          </span>
        </div>
        <div className="measure big">
          <span className="label">Proxy pools</span>
          <span className="value" data-i18n-skip>
            {pools.data ? fmtNum(poolRows.length) : '—'}
          </span>
        </div>
        <div className="measure big">
          <span className="label">Provider strategies</span>
          <span className="value" data-i18n-skip>
            {settings.data ? fmtNum(Object.keys(providerStrategies).length) : '—'}
          </span>
        </div>
        <div className="measure big network-onoff">
          <span className="label">Outbound proxy</span>
          <span className="value">
            {settings.data ? outboundEnabled ? 'On' : 'Off' : <span data-i18n-skip>—</span>}
          </span>
        </div>
      </div>

      <section aria-labelledby="h-outbound" className="panel">
        <div className="screen-head">
          <h2 id="h-outbound">Outbound proxy</h2>
          <Freshness status={pollFresh(settings)} lastDataAt={settings.goodAt} />
        </div>
        <p>
          The single path every upstream call takes when it is not routed through a specific pool
          below.
        </p>
        {settings.error && !settings.data ? (
          <Notice {...refusal(settings.status, settings.error)} />
        ) : null}
        {settings.data ? (
          <>
            <dl className="facts">
              <dt>State</dt>
              <dd>
                <span className="status" data-tone={outboundEnabled ? 'ok' : 'warn'}>
                  {outboundEnabled ? 'On' : 'Off, so upstream calls go out directly'}
                </span>
              </dd>
              {outboundEnabled ? (
                <>
                  <dt>Proxy URL</dt>
                  <dd data-i18n-skip>
                    {maskProxyUrl(outboundUrl) || <span className="unreported">Not set</span>}
                  </dd>
                  <dt>No-proxy list</dt>
                  <dd data-i18n-skip>
                    {outboundNoProxy || <span className="unreported">None</span>}
                  </dd>
                </>
              ) : null}
              <dt>Global connect-timeout default</dt>
              <dd data-i18n-skip>
                {connectTimeoutMs != null ? (
                  `${fmtNum(connectTimeoutMs)} ms`
                ) : (
                  <span className="unreported">Not reported</span>
                )}
              </dd>
            </dl>
            {outbound ? (
              <div className="network-form">
                <label className="field">
                  <span>Proxy URL</span>
                  <input
                    className="input"
                    type="password"
                    autoComplete="off"
                    value={outbound.url}
                    placeholder="http://user:pass@host:port"
                    onChange={(e) => setOutbound((o) => ({ ...o, url: e.target.value }))}
                  />
                </label>
                <label className="field">
                  <span>No-proxy list</span>
                  <input
                    className="input"
                    type="text"
                    value={outbound.noProxy}
                    onChange={(e) => setOutbound((o) => ({ ...o, noProxy: e.target.value }))}
                  />
                </label>
                <div className="verb-row">
                  <button
                    type="button"
                    className="button"
                    onClick={() => setAction({ kind: 'outboundOn' })}
                  >
                    <Icon name="i-play" />
                    Turn on
                  </button>
                  <button type="button" className="button quiet" onClick={() => setOutbound(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="verb-row">
                {outboundEnabled ? (
                  <>
                    <button
                      type="button"
                      className="button"
                      onClick={() => setOutbound({ url: '', noProxy: outboundNoProxy })}
                    >
                      <Icon name="i-edit" />
                      Change proxy URL
                    </button>
                    <button
                      type="button"
                      className="button danger"
                      onClick={() => setAction({ kind: 'outboundOff' })}
                    >
                      <Icon name="i-pause" />
                      Turn off
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="button"
                    onClick={() => setOutbound({ url: '', noProxy: '' })}
                  >
                    <Icon name="i-network" />
                    Set an outbound proxy
                  </button>
                )}
              </div>
            )}
          </>
        ) : settings.loading ? (
          <p className="skeleton">Reading</p>
        ) : null}
      </section>

      <section aria-labelledby="h-nodes">
        <div className="screen-head">
          <h2 id="h-nodes">Provider nodes</h2>
          <button type="button" className="button" onClick={() => openNode('createNode')}>
            <Icon name="i-add" />
            Add a node
          </button>
        </div>
        <p>
          A self-registered upstream endpoint beyond the built-in provider catalog. A connection
          references it by id.
        </p>
        {nodes.error && !nodes.data ? <Notice {...refusal(nodes.status, nodes.error)} /> : null}
        {nodes.loading && !nodes.data ? <p className="skeleton">Reading</p> : null}
        {nodes.data && nodeRows.length === 0 ? (
          <p className="empty">
            No node is registered. Add one to route through a custom endpoint.
          </p>
        ) : null}
        {nodeRows.length ? (
          <div className="rows">
            <div className="row head network-node-row">
              <span>Node</span>
              <span>Dialect</span>
              <span />
            </div>
            {nodeRows.map((n) => (
              <div className="row network-node-row" key={n.id}>
                <span className="who">
                  <span className="name" data-i18n-skip>
                    {n.name}
                  </span>
                  <span className="sub">
                    <span className="id" data-i18n-skip>
                      {n.prefix}
                    </span>{' '}
                    <span data-i18n-skip>{n.baseUrl}</span>
                  </span>
                </span>
                <span data-i18n-skip>{NODE_TYPE_WORD[n.type] || n.type}</span>
                <div className="actions">
                  <button
                    type="button"
                    className="button quiet"
                    onClick={() => openNode('editNode', n)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="button danger"
                    onClick={() => openNode('deleteNode', n)}
                  >
                    Delete node
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="h-pools">
        <div className="screen-head">
          <h2 id="h-pools">Proxy pools</h2>
          <button type="button" className="button" onClick={() => openPool('createPool')}>
            <Icon name="i-add" />
            Add a pool
          </button>
        </div>
        <p>
          A named outbound path a connection or a provider strategy can be bound to instead of
          routing directly.
        </p>
        {pools.error && !pools.data ? <Notice {...refusal(pools.status, pools.error)} /> : null}
        {pools.loading && !pools.data ? <p className="skeleton">Reading</p> : null}
        {pools.data && poolRows.length === 0 ? (
          <p className="empty">
            No pool exists. Add one to give a connection or a provider strategy somewhere to route
            through.
          </p>
        ) : null}
        {poolRows.length ? (
          <div className="rows">
            <div className="row head network-pool-row">
              <span>Pool</span>
              <span>Bound</span>
              <span>Test</span>
              <span />
            </div>
            {poolRows.map((p) => (
              <div className="row network-pool-row" key={p.id}>
                <span className="who">
                  <span className="name" data-i18n-skip>
                    {p.name}
                  </span>
                  <span className="sub">
                    <span className="id" data-i18n-skip>
                      {maskProxyUrl(p.proxyUrl)}
                    </span>
                    {p.strictProxy ? (
                      <>
                        {' '}
                        <span className="status" data-tone="warn">
                          Strict
                        </span>
                      </>
                    ) : null}
                  </span>
                </span>
                <span data-i18n-skip>
                  {p.boundConnectionCount ? (
                    <Link href="/dashboard/connections" prefetch={false}>
                      {fmtNum(p.boundConnectionCount)}
                    </Link>
                  ) : (
                    fmtNum(0)
                  )}
                </span>
                <span>
                  <span className="status" data-tone={TEST_TONE[p.testStatus] || 'warn'}>
                    {TEST_WORD[p.testStatus] || 'Not tested'}
                  </span>
                  {p.lastError ? (
                    <span className="caption" data-i18n-skip>
                      {p.lastError}
                    </span>
                  ) : null}
                  {testResult?.id === p.id ? <Notice {...testResult} /> : null}
                </span>
                <div className="actions">
                  <button type="button" className="button quiet" onClick={() => testPool(p)}>
                    <Icon name="i-test" />
                    Test
                  </button>
                  <button
                    type="button"
                    className="button quiet"
                    onClick={() => openPool('editPool', p)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="button danger"
                    onClick={() => openPool('deletePool', p)}
                  >
                    Delete pool
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="h-strategy" className="panel">
        <h2 id="h-strategy">Per-provider proxy strategy</h2>
        <p>
          Binds one proxy pool to a provider id, for every connection under that provider that has
          no pool of its own.
        </p>
        <div className="network-form network-form-strategy">
          <label className="field">
            <span>Provider id</span>
            <input
              className="input"
              type="text"
              data-i18n-skip
              value={strategyProvider}
              onChange={(e) => setStrategyProvider(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Proxy pool</span>
            <select
              className="select"
              value={strategyPoolId}
              onChange={(e) => setStrategyPoolId(e.target.value)}
            >
              <option value="">No pool, route directly</option>
              {poolRows
                .filter((p) => p.isActive)
                .map((p) => (
                  <option key={p.id} value={p.id} data-i18n-skip>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
          <div className="verb-row">
            <button
              type="button"
              className="button"
              disabled={!strategyProvider.trim()}
              onClick={saveStrategy}
            >
              <Icon name="i-edit" />
              Save strategy
            </button>
          </div>
        </div>
        {Object.keys(providerStrategies).length ? (
          <dl className="facts">
            {Object.entries(providerStrategies).map(([pid, st]) => (
              <Fragment key={pid}>
                <dt data-i18n-skip>{pid}</dt>
                <dd>
                  {st.proxyPoolId ? (
                    <>
                      {poolRows.find((p) => p.id === st.proxyPoolId)?.name || (
                        <span className="id" data-i18n-skip>
                          {st.proxyPoolId}
                        </span>
                      )}
                      {st.strictProxy ? (
                        <>
                          {' '}
                          <span className="status" data-tone="warn">
                            Strict
                          </span>
                        </>
                      ) : null}
                    </>
                  ) : (
                    <span>Routes directly</span>
                  )}
                </dd>
              </Fragment>
            ))}
          </dl>
        ) : null}
      </section>

      <section aria-labelledby="h-network-gap">
        <h2 id="h-network-gap">Not reported</h2>
        <ul className="bullets">
          <li>
            A rotation strategy across several proxy pools for one provider. Only a single pool
            binding per provider exists in the settings schema, so this screen can bind or clear one
            pool and nothing more.
          </li>
        </ul>
      </section>

      <Confirm
        open={!!action}
        busy={busy}
        refusal={refused}
        title={copyFor?.title}
        verb={copyFor?.verb}
        requires={copyFor?.requires}
        changes={copyFor?.changes}
        undo={copyFor?.undo}
        irreversible={!!copyFor?.irreversible}
        onConfirm={run}
        onClose={close}
      >
        {action?.kind === 'createNode' || action?.kind === 'editNode' ? (
          <div className="network-form">
            <label className="field">
              <span>Name</span>
              <input
                className="input"
                type="text"
                value={nodeForm.name}
                onChange={(e) => setNodeForm((f) => ({ ...f, name: e.target.value }))}
              />
            </label>
            <label className="field">
              <span>Prefix</span>
              <input
                className="input"
                type="text"
                value={nodeForm.prefix}
                onChange={(e) => setNodeForm((f) => ({ ...f, prefix: e.target.value }))}
              />
            </label>
            {action.kind === 'createNode' ? (
              <label className="field">
                <span>Type</span>
                <select
                  className="select"
                  value={nodeForm.type}
                  onChange={(e) => setNodeForm((f) => ({ ...f, type: e.target.value }))}
                >
                  <option value="openai-compatible">OpenAI compatible</option>
                  <option value="multi-compatible">OpenAI and Anthropic compatible</option>
                  <option value="custom-embedding">Custom embedding</option>
                  <option value="anthropic-compatible">Anthropic compatible</option>
                </select>
              </label>
            ) : null}
            {nodeForm.type === 'openai-compatible' ? (
              <label className="field">
                <span>API type</span>
                <select
                  className="select"
                  value={nodeForm.apiType}
                  onChange={(e) => setNodeForm((f) => ({ ...f, apiType: e.target.value }))}
                >
                  <option value="chat">Chat</option>
                  <option value="responses">Responses</option>
                </select>
              </label>
            ) : null}
            <label className="field">
              <span>Base URL</span>
              <input
                className="input"
                type="text"
                data-i18n-skip
                value={nodeForm.baseUrl}
                onChange={(e) => setNodeForm((f) => ({ ...f, baseUrl: e.target.value }))}
              />
            </label>
          </div>
        ) : null}
        {action?.kind === 'createPool' || action?.kind === 'editPool' ? (
          <div className="network-form">
            <label className="field">
              <span>Name</span>
              <input
                className="input"
                type="text"
                value={poolForm.name}
                onChange={(e) => setPoolForm((f) => ({ ...f, name: e.target.value }))}
              />
            </label>
            <label className="field">
              <span>Proxy URL</span>
              <input
                className="input"
                type="password"
                autoComplete="off"
                placeholder={
                  action.kind === 'editPool'
                    ? 'Leave empty to keep the current URL'
                    : 'http://user:pass@host:port'
                }
                value={poolForm.proxyUrl}
                onChange={(e) => setPoolForm((f) => ({ ...f, proxyUrl: e.target.value }))}
              />
            </label>
            <label className="field">
              <span>No-proxy list</span>
              <input
                className="input"
                type="text"
                value={poolForm.noProxy}
                onChange={(e) => setPoolForm((f) => ({ ...f, noProxy: e.target.value }))}
              />
            </label>
            <label className="network-check">
              <input
                type="checkbox"
                checked={poolForm.strictProxy}
                onChange={(e) => setPoolForm((f) => ({ ...f, strictProxy: e.target.checked }))}
              />
              <span>
                Strict: a connection or strategy bound here fails outright rather than falling back
                to a direct connection
              </span>
            </label>
          </div>
        ) : null}
      </Confirm>
    </>
  );
}
