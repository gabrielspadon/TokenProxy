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
import { OperationHistoryInspector } from '@/shared/workspace/OperationHistoryInspector';
import { ProbeConsequence } from './ProbeConsequence';
import { AccountPaths } from './AccountPaths';
import { fmtNum } from '@/shared/format';
import { Icon } from '@/shared/components/Icon';
import { AI_PROVIDERS, NO_AUTH_PROVIDER_IDS, isNoAuthProvider } from '@/shared/constants/providers';
import './styles.css';
import NetworkOptions from './NetworkOptions';

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
    if (u.username || u.password) return s.replace(/\/\/[^/@]+@/, '//•••@');
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
  openaiUrl: '',
  anthropicUrl: '',
  supportsResponses: false,
};
const POOL_BLANK = { name: '', proxyUrl: '', noProxy: '', type: 'http', strictProxy: false };

export default function NetworkPage() {
  const nodes = usePoll('/api/provider-nodes', 30000);
  const pools = usePoll('/api/proxy-pools?includeUsage=true', 15000);
  const settings = usePoll('/api/settings', 30000);
  const connections = usePoll('/api/providers', 30000);

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
  const [strategyRotation, setStrategyRotation] = useState('none');
  const [strategyReview, setStrategyReview] = useState(null);
  // Which pool's retained probe history is open. One at a time: the inspector
  // pages a bounded query, so opening every row at once would fan out reads.
  const [historyPoolId, setHistoryPoolId] = useState(null);

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
    setBusy(false);
    setPoolForm(POOL_BLANK);
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
            openaiUrl: node.transports?.find(transport => transport.format === 'openai')?.baseUrl || node.baseUrl || '',
            anthropicUrl: node.transports?.find(transport => transport.format === 'claude')?.baseUrl || '',
            supportsResponses: node.transports?.some(transport => transport.format === 'openai-responses') || false,
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
      if (!res.status) {
        setRefused({ tone: 'warn', title: 'The network configuration outcome is unknown.', next: 'Close and refresh the relevant inventory before taking another action. Do not repeat the interrupted mutation.' });
        setBusy(true);
        return;
      }
      setRefused(refusal(res.status, res.body));
      return;
    }
    setBusy(true);
    const isNode = action.kind.endsWith('Node');
    const isPool = action.kind.endsWith('Pool');
    const deleting = action.kind.startsWith('delete');
    let verified = false;
    if (isNode || isPool) {
      const readback = await call(isNode ? '/api/provider-nodes' : '/api/proxy-pools');
      const records = isNode ? readback.body?.nodes : readback.body?.proxyPools;
      const expected = isNode ? res.body?.node : res.body?.proxyPool;
      const id = action.node?.id || action.pool?.id || expected?.id;
      const record = records?.find(value => value.id === id);
      const fields = isNode ? ['name', 'prefix', 'baseUrl', 'transports'] : ['name', 'type', 'proxyUrl', 'noProxy', 'strictProxy', 'isActive'];
      verified = !!id && readback.ok && Array.isArray(records) && (deleting ? !record : record && expected && fields.every(field => JSON.stringify(record[field]) === JSON.stringify(expected[field])));
    } else {
      const readback = await call('/api/settings');
      verified = readback.ok && readback.body?.outboundProxyEnabled === (action.kind === 'outboundOn');
    }
    if (!verified) {
      setRefused({ tone: 'warn', title: 'The change was accepted; refreshed configuration was not verified.', next: 'Close and refresh before making another change. Do not repeat the mutation.' });
      return;
    }
    setBusy(false);
    if (action.kind.startsWith('outbound')) {
      setOutbound(null);
      settings.refresh();
    } else if (action.kind.endsWith('Node')) nodes.refresh();
    else pools.refresh();
    setResult({ tone: 'ok', title: 'Configuration saved and verified.' });
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
    if (!strategyReview || !isNoAuthProvider(strategyReview.providerId)) return;
    setBusy(true);
    setRefused(null);
    setResult(null);
    const res = await call('/api/settings', {
      method: 'PATCH',
      body: {
        providerStrategyPatch: {
          providerId: strategyReview.providerId,
          values: { proxyPoolId: strategyReview.poolId || '__none__', rotateStrategy: strategyReview.rotation },
        },
      },
    });
    if (!res.ok) {
      setRefused(refusal(res.status, res.body));
      if (res.status) setBusy(false);
      return;
    }
    const readback = await call('/api/settings');
    const saved = readback.body?.providerStrategies?.[strategyReview.providerId] || {};
    if (!readback.ok || (saved.proxyPoolId || '') !== strategyReview.poolId || (saved.rotateStrategy || 'none') !== strategyReview.rotation) {
      setRefused({ tone: 'warn', title: 'The strategy was accepted; refreshed policy was not verified.', next: 'Close and refresh settings before making another change. Do not repeat the mutation.' });
      return;
    }
    setBusy(false);
    setStrategyReview(null);
    setResult({ tone: 'ok', title: 'Virtual-account proxy strategy saved and verified.' });
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

      <dl className="network-summary" aria-label="Network configuration summary">
        <div><dt>Provider nodes</dt><dd><bdi>{nodes.data ? fmtNum(nodeRows.length) : 'Unknown'}</bdi></dd></div>
        <div><dt>Proxy pools</dt><dd><bdi>{pools.data ? fmtNum(poolRows.length) : 'Unknown'}</bdi></dd></div>
        <div><dt>Provider strategies</dt><dd><bdi>{settings.data ? fmtNum(Object.keys(providerStrategies).length) : 'Unknown'}</bdi></dd></div>
        <div><dt>Outbound proxy</dt><dd>{settings.data ? outboundEnabled ? 'On' : 'Off' : 'Unknown'}</dd></div>
      </dl>
      {connections.error ? <Notice {...refusal(connections.status, connections.error)} /> : null}
      {connections.data && pools.data ? <AccountPaths connections={connections.data.connections || []} pools={poolRows} /> : <p className="caption">Account paths require both the account and pool inventories.</p>}

      <section aria-labelledby="h-outbound" className="panel">
        <div className="screen-head">
          <h2 id="h-outbound">Outbound proxy</h2>
          <Freshness status={pollFresh(settings)} lastDataAt={settings.goodAt} />
        </div>
        <p>
          The global proxy setting. Account-specific assignments and proxy pools can override
          this path. Inspect an account above for its configured path; reachability requires a
          separate observed test.
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
                  {outboundEnabled ? 'On' : 'Off at the global level'}
                </span>
              </dd>
              {outboundEnabled ? (
                <>
                  <dt>Proxy URL</dt>
                  <dd>
                    {maskProxyUrl(outboundUrl) || <span className="unreported">Not set</span>}
                  </dd>
                  <dt>No-proxy list</dt>
                  <dd>
                    {outboundNoProxy || <span className="unreported">None</span>}
                  </dd>
                </>
              ) : null}
              <dt>Global connect-timeout default</dt>
              <dd>
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
                  <span className="name">
                    {n.name}
                  </span>
                  <span className="sub">
                    <span className="id">
                      {n.prefix}
                    </span>{' '}
                    <span>{n.baseUrl}</span>
                  </span>
                </span>
                <span>{NODE_TYPE_WORD[n.type] || n.type}</span>
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
        {/* Said once for the whole table rather than repeated per row, where
            the sentence inflated the row's auto track and crushed the pool
            name column. The column holds the pool's own mutable field, which
            every probe overwrites: a cancelled, conflicted or unresolved probe
            never reaches it at all. */}
        <p>
          The latest-applied column is the pool&apos;s own current state, overwritten by each
          probe. A probe that was cancelled, that conflicted with a configuration change, or that
          never finished leaves no mark there. Open a pool&apos;s probe history to see those.
        </p>
        {/* The consequence sits above the controls it describes and is named by
            every Test button below through aria-describedby, so it is reachable
            from the control by keyboard and by screen reader alike. */}
        <ProbeConsequence id="probe-consequence" />
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
              <span>Latest applied</span>
              <span />
            </div>
            {poolRows.map((p) => (
              <Fragment key={p.id}>
              <div className="row network-pool-row">
                <span className="who">
                  <span className="name">
                    {p.name}
                  </span>
                  <span className="sub">
                    <span className="id">
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
                <span>
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
                    <span className="caption">
                      {p.lastError}
                    </span>
                  ) : null}
                  {testResult?.id === p.id ? <Notice {...testResult} /> : null}
                </span>
                <div className="actions">
                  <button
                    type="button"
                    className="button quiet"
                    aria-describedby="probe-consequence"
                    onClick={() => testPool(p)}
                  >
                    <Icon name="i-test" />
                    Test
                  </button>
                  <button
                    type="button"
                    className="button quiet"
                    aria-expanded={historyPoolId === p.id}
                    onClick={() => setHistoryPoolId((open) => (open === p.id ? null : p.id))}
                  >
                    {historyPoolId === p.id ? 'Hide probe history' : 'Probe history'}
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
              {historyPoolId === p.id ? (
                <OperationHistoryInspector key={p.id} subjectId={p.id} label={p.name} />
              ) : null}
              </Fragment>
            ))}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="h-strategy" className="panel">
        <NetworkOptions pools={poolRows} onSaved={() => { nodes.refresh(); pools.refresh(); settings.refresh(); }} />
        <h2 id="h-strategy">Per-provider proxy strategy</h2>
        <p>
          Binds a proxy pool to the virtual account of a provider that uses no credentials.
          Stored credentialed accounts use their own account policy and do not inherit this strategy.
        </p>
        <div className="network-form network-form-strategy">
          <label className="field">
            <span>Provider id</span>
            <select
              className="select"
              value={strategyProvider}
              onChange={event => {
                const provider = event.target.value;
                const current = providerStrategies[provider] || {};
                setStrategyProvider(provider);
                setStrategyPoolId(current.proxyPoolId || '');
                setStrategyRotation(current.rotateStrategy || 'none');
              }}
            ><option value="">Choose a provider without credentials</option>{NO_AUTH_PROVIDER_IDS.map(id => <option key={id} value={id}>{AI_PROVIDERS[id]?.name || id}</option>)}</select>
          </label>
          <label className="field"><span>Pool selection mode</span><select className="select" value={strategyRotation} onChange={event => setStrategyRotation(event.target.value)}><option value="none">Fixed pool</option><option value="round-robin">Round-robin across active pools</option><option value="random">Random across active pools</option></select></label>
          <label className="field">
            <span>Proxy pool</span>
            <select
              className="select"
              value={strategyPoolId}
              disabled={strategyRotation !== 'none'}
              onChange={(e) => setStrategyPoolId(e.target.value)}
            >
              <option value="">No selection; global/environment path</option>
              {poolRows
                .filter((p) => p.isActive)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
          <div className="verb-row">
            <button
              type="button"
              className="button"
              disabled={!isNoAuthProvider(strategyProvider) || busy || !!settings.error}
              onClick={() => { setRefused(null); setStrategyReview({ providerId: strategyProvider, poolId: strategyPoolId, rotation: strategyRotation }); }}
            >
              <Icon name="i-edit" />
              Save strategy
            </button>
          </div>
        </div>
        <p className="caption">Round-robin and random choose among all active pools with an address at routing time, ignoring the fixed pool while rotation is selected. Each chosen pool supplies its own strictness. No fixed selection means global or environment routing may apply; it does not force a direct path.</p>
        {Object.keys(providerStrategies).length ? (
          <dl className="facts">
            {Object.entries(providerStrategies).map(([pid, st]) => (
              <Fragment key={pid}>
                <dt>{pid}</dt>
                <dd>
                  {!isNoAuthProvider(pid) ? 'This network strategy does not affect credentialed accounts.' : st.rotateStrategy && st.rotateStrategy !== 'none' ? <span>{st.rotateStrategy === 'round-robin' ? 'Round-robin across active pools' : st.rotateStrategy === 'random' ? 'Random across active pools' : 'Unrecognized stored rotation mode'}</span> : st.proxyPoolId ? (
                    <>
                      {poolRows.find((p) => p.id === st.proxyPoolId)?.name || (
                        <span className="id">
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
                    <span>No fixed pool; global/environment path</span>
                  )}
                </dd>
              </Fragment>
            ))}
          </dl>
        ) : null}
      </section>

      <Confirm open={!!strategyReview} busy={busy} refusal={refused} title="Review virtual-account proxy strategy" verb="Apply proxy strategy" requires="A local operator session and a provider that uses no credentials."
        changes="Changes pool selection on subsequent routing for this provider's virtual account. Rotation uses all active pools with addresses. Credentialed accounts retain their separate account policies."
        undo="Restore the previous mode and fixed pool. A saved strategy does not move in-flight responses."
        onConfirm={saveStrategy} onClose={() => { setStrategyReview(null); setRefused(null); setBusy(false); }}>
        <dl className="facts"><dt>Provider</dt><dd><bdi>{strategyReview?.providerId}</bdi></dd><dt>Selection mode</dt><dd><bdi>{strategyReview?.rotation}</bdi></dd><dt>Fixed pool</dt><dd><bdi>{strategyReview?.poolId || 'No selection'}</bdi></dd></dl>
      </Confirm>

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
            {nodeForm.type === 'multi-compatible' ? <>
              <label className="field"><span>OpenAI endpoint URL</span><input className="input" type="url" required value={nodeForm.openaiUrl} onChange={event => setNodeForm(value => ({ ...value, openaiUrl: event.target.value }))} /></label>
              <label className="field"><span>Anthropic endpoint URL</span><input className="input" type="url" required value={nodeForm.anthropicUrl} onChange={event => setNodeForm(value => ({ ...value, anthropicUrl: event.target.value }))} /></label>
              <label className="network-check"><input type="checkbox" checked={nodeForm.supportsResponses} onChange={event => setNodeForm(value => ({ ...value, supportsResponses: event.target.checked }))} /><span>Register the OpenAI Responses transport</span></label>
              <p className="caption">Stores both endpoint formats. This local configuration does not establish provider support or send a validation request.</p>
            </> : <label className="field">
              <span>Base URL</span>
              <input
                className="input"
                type="text"

                value={nodeForm.baseUrl}
                onChange={(e) => setNodeForm((f) => ({ ...f, baseUrl: e.target.value }))}
              />
            </label>}
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
