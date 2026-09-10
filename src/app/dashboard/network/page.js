'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ActionIcon,
  Button,
  Checkbox,
  NativeSelect,
  Tabs,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { usePoll } from '@/shared/hooks/usePoll';
import { Freshness } from '@/shared/components/Freshness';
import { Notice } from '@/shared/components/Notice';
import { call } from '@/shared/api';
import { refusal } from '@/shared/refusal';
import { poolTestVerdict } from '@/shared/poolTestVerdict';
import { OperationHistoryInspector } from '@/shared/workspace/OperationHistoryInspector';
import { CommitText } from '@/shared/workspace/CommitFields';
import { InlineConfirm } from '@/shared/workspace/InlineConfirm';
import { ProbeConsequence } from './ProbeConsequence';
import { AccountPaths } from './AccountPaths';
import { fmtNum } from '@/shared/format';
import { Icon } from '@/shared/components/Icon';
import { AI_PROVIDERS, NO_AUTH_PROVIDER_IDS, isNoAuthProvider } from '@/shared/constants/providers';
import './styles.css';
import NetworkOptions from './NetworkOptions';
import shared from '@/shared/workspace/workspace.module.css';
import {
  Board,
  BoardGroup,
  BoardSummary,
  BoardToolbar,
  DensitySwitch,
  EvidenceLine,
  StateWord,
  boardStyles as board,
  useDensity,
  useLevel,
} from '@/shared/workspace/Board';

const NODE_TYPES = [
  { value: 'openai-compatible', label: 'OpenAI compatible' },
  { value: 'multi-compatible', label: 'OpenAI and Anthropic compatible' },
  { value: 'custom-embedding', label: 'Custom embedding' },
  { value: 'anthropic-compatible', label: 'Anthropic compatible' },
];
const NODE_TYPE_WORD = Object.fromEntries(NODE_TYPES.map((item) => [item.value, item.label]));
// Short enough for the board's state column; the full dialect name rides the
// tooltip and the Everyday group heading.
const NODE_TYPE_SHORT = {
  'openai-compatible': 'OpenAI',
  'multi-compatible': 'OpenAI + Claude',
  'custom-embedding': 'Embedding',
  'anthropic-compatible': 'Anthropic',
};

// A pool's own recorded probe outcome. `untested` and `unknown` are the same
// absence of evidence and read as one word.
const POOL_BUCKETS = [
  { id: 'active', label: 'Reachable', tone: 'positive' },
  { id: 'error', label: 'Failed', tone: 'refusal' },
  { id: 'unknown', label: 'Not tested', tone: 'ember' },
];
const poolBucket = (pool) =>
  pool.testStatus === 'active' ? 'active' : pool.testStatus === 'error' ? 'error' : 'unknown';
const poolTone = (pool) => POOL_BUCKETS.find((item) => item.id === poolBucket(pool))?.tone;
const poolWord = (pool) => POOL_BUCKETS.find((item) => item.id === poolBucket(pool))?.label;

const TASKS = [
  { value: 'paths', label: 'Paths' },
  { value: 'pools', label: 'Pools' },
  { value: 'nodes', label: 'Nodes' },
  { value: 'relay', label: 'Relay' },
];

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
const toast = (color, message, title) =>
  notifications.show({ color, message, title, autoClose: color === 'teal' ? 4000 : 9000 });

const nodeFields = (node) => ({
  name: node.name || '',
  prefix: node.prefix || '',
  type: node.type,
  apiType: node.apiType || 'chat',
  baseUrl: node.baseUrl || '',
  openaiUrl:
    node.transports?.find((transport) => transport.format === 'openai')?.baseUrl ||
    node.baseUrl ||
    '',
  anthropicUrl:
    node.transports?.find((transport) => transport.format === 'claude')?.baseUrl || '',
  supportsResponses:
    node.transports?.some((transport) => transport.format === 'openai-responses') || false,
});
const poolFields = (pool) => ({
  name: pool.name || '',
  proxyUrl: '',
  noProxy: pool.noProxy || '',
  type: pool.type || 'http',
  strictProxy: pool.strictProxy === true,
});

export default function NetworkPage() {
  const nodes = usePoll('/api/provider-nodes', 30000);
  const pools = usePoll('/api/proxy-pools?includeUsage=true', 15000);
  const settings = usePoll('/api/settings', 30000);
  const connections = usePoll('/api/providers', 30000);
  const advanced = useLevel();
  const [density, setDensity] = useDensity();

  const [task, setTask] = useState('paths');
  const [uncertain, setUncertain] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [poolQuery, setPoolQuery] = useState('');
  const [poolBucketFilter, setPoolBucketFilter] = useState(null);
  const [nodeQuery, setNodeQuery] = useState('');
  const [nodeTypeFilter, setNodeTypeFilter] = useState(null);
  const [openPoolId, setOpenPoolId] = useState(null);
  const [openNodeId, setOpenNodeId] = useState(null);
  const [confirming, setConfirming] = useState(null); // { kind, id }
  const [addingPool, setAddingPool] = useState(false);
  const [addingNode, setAddingNode] = useState(false);
  const [nodeForm, setNodeForm] = useState(NODE_BLANK);
  const [poolForm, setPoolForm] = useState(POOL_BLANK);
  const [outbound, setOutbound] = useState(null); // draft while editing, else null
  const [outboundReview, setOutboundReview] = useState(null); // 'on' | 'off'
  const [strategyProvider, setStrategyProvider] = useState('');
  const [strategyPoolId, setStrategyPoolId] = useState('');
  const [strategyRotation, setStrategyRotation] = useState('none');
  const [strategyReview, setStrategyReview] = useState(null);

  useEffect(() => {
    const clear = () => {
      if (document.hidden) {
        setPoolForm((current) => ({ ...current, proxyUrl: '' }));
        setOutbound((current) => (current ? { ...current, url: '' } : null));
      }
    };
    document.addEventListener('visibilitychange', clear);
    return () => document.removeEventListener('visibilitychange', clear);
  }, []);

  const nodeRows = useMemo(() => nodes.data?.nodes || [], [nodes.data]);
  const poolRows = useMemo(() => pools.data?.proxyPools || [], [pools.data]);
  const outboundEnabled = settings.data?.outboundProxyEnabled;
  const outboundUrl = settings.data?.outboundProxyUrl || '';
  const outboundNoProxy = settings.data?.outboundNoProxy || '';
  const connectTimeoutMs = settings.data?.connectTimeoutMs;
  const providerStrategies = settings.data?.providerStrategies || {};
  const maxBound = Math.max(1, ...poolRows.map((pool) => pool.boundConnectionCount || 0));

  // One mutation path for every write on this page: send, read the inventory
  // back, and report what the read-back established rather than what the write
  // returned. An interrupted write is reported as unknown and never repeated.
  const write = useCallback(
    async ({ path, method = 'POST', body, verify, label }) => {
      setBusy(true);
      setRefused(null);
      const response = await call(path, { method, ...(body === undefined ? {} : { body }) });
      setPoolForm((current) => ({ ...current, proxyUrl: '' }));
      if (!response.ok) {
        setBusy(false);
        if (!response.status) {
          setUncertain(true);
          setRefused({
            tone: 'warn',
            title: 'The network configuration outcome is unknown.',
            next: 'Refresh the relevant inventory before taking another action. Do not repeat the interrupted mutation.',
          });
          return false;
        }
        setRefused(refusal(response.status, response.body));
        return false;
      }
      const verified = await verify(response);
      setBusy(false);
      if (!verified) {
        setUncertain(true);
        setRefused({
          tone: 'warn',
          title: 'The change was accepted; refreshed configuration was not verified.',
          next: 'Refresh before making another change. Do not repeat the mutation.',
        });
        return false;
      }
      toast('teal', `${label} saved and verified.`);
      return true;
    },
    []
  );

  const verifyRecord = (collectionPath, collection, resultKey, id, fields, deleting) => async (
    response
  ) => {
    const readback = await call(collectionPath);
    const records = readback.body?.[collection];
    const expected = response.body?.[resultKey];
    const target = id || expected?.id;
    const record = records?.find((value) => value.id === target);
    return Boolean(
      target &&
        readback.ok &&
        Array.isArray(records) &&
        (deleting
          ? !record
          : record &&
            expected &&
            fields.every(
              (field) => JSON.stringify(record[field]) === JSON.stringify(expected[field])
            ))
    );
  };
  const POOL_VERIFY = ['name', 'type', 'proxyUrl', 'noProxy', 'strictProxy', 'isActive'];
  const NODE_VERIFY = ['name', 'prefix', 'baseUrl', 'transports'];

  async function savePool(pool, patch) {
    const body = { ...poolFields(pool), ...patch };
    if (!body.proxyUrl) delete body.proxyUrl;
    const ok = await write({
      path: `/api/proxy-pools/${encodeURIComponent(pool.id)}`,
      method: 'PUT',
      body,
      label: 'Pool',
      verify: verifyRecord('/api/proxy-pools', 'proxyPools', 'proxyPool', pool.id, POOL_VERIFY),
    });
    if (ok) pools.refresh();
  }
  async function createPool() {
    const ok = await write({
      path: '/api/proxy-pools',
      body: poolForm,
      label: 'Pool',
      verify: verifyRecord('/api/proxy-pools', 'proxyPools', 'proxyPool', null, POOL_VERIFY),
    });
    if (ok) {
      setPoolForm(POOL_BLANK);
      setAddingPool(false);
      pools.refresh();
    }
  }
  async function removePool(pool) {
    const ok = await write({
      path: `/api/proxy-pools/${encodeURIComponent(pool.id)}`,
      method: 'DELETE',
      label: 'Pool removal',
      verify: verifyRecord(
        '/api/proxy-pools',
        'proxyPools',
        'proxyPool',
        pool.id,
        POOL_VERIFY,
        true
      ),
    });
    setConfirming(null);
    if (ok) pools.refresh();
  }
  async function saveNode(node, patch) {
    const ok = await write({
      path: `/api/provider-nodes/${encodeURIComponent(node.id)}`,
      method: 'PUT',
      body: { ...nodeFields(node), ...patch },
      label: 'Node',
      verify: verifyRecord('/api/provider-nodes', 'nodes', 'node', node.id, NODE_VERIFY),
    });
    if (ok) nodes.refresh();
  }
  async function createNode() {
    const ok = await write({
      path: '/api/provider-nodes',
      body: nodeForm,
      label: 'Node',
      verify: verifyRecord('/api/provider-nodes', 'nodes', 'node', null, NODE_VERIFY),
    });
    if (ok) {
      setNodeForm(NODE_BLANK);
      setAddingNode(false);
      nodes.refresh();
    }
  }
  async function removeNode(node) {
    const ok = await write({
      path: `/api/provider-nodes/${encodeURIComponent(node.id)}`,
      method: 'DELETE',
      label: 'Node removal',
      verify: verifyRecord('/api/provider-nodes', 'nodes', 'node', node.id, NODE_VERIFY, true),
    });
    setConfirming(null);
    if (ok) nodes.refresh();
  }
  async function applyOutbound(on) {
    const ok = await write({
      path: '/api/settings',
      method: 'PATCH',
      body: {
        outboundProxyEnabled: on,
        outboundProxyUrl: outbound?.url ?? outboundUrl,
        outboundNoProxy: outbound?.noProxy ?? outboundNoProxy,
      },
      label: 'Outbound proxy',
      verify: async () => {
        const readback = await call('/api/settings');
        return readback.ok && readback.body?.outboundProxyEnabled === on;
      },
    });
    setOutboundReview(null);
    if (ok) {
      setOutbound(null);
      settings.refresh();
    }
  }

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
    const ok = await write({
      path: '/api/settings',
      method: 'PATCH',
      body: {
        providerStrategyPatch: {
          providerId: strategyReview.providerId,
          values: {
            proxyPoolId: strategyReview.poolId || '__none__',
            rotateStrategy: strategyReview.rotation,
          },
        },
      },
      label: 'Virtual-account proxy strategy',
      verify: async () => {
        const readback = await call('/api/settings');
        const saved = readback.body?.providerStrategies?.[strategyReview.providerId] || {};
        return (
          readback.ok &&
          (saved.proxyPoolId || '') === strategyReview.poolId &&
          (saved.rotateStrategy || 'none') === strategyReview.rotation
        );
      },
    });
    setStrategyReview(null);
    if (ok) settings.refresh();
  };

  const poolNeedle = poolQuery.trim().toLowerCase();
  const visiblePools = poolRows.filter(
    (pool) =>
      (!poolBucketFilter || poolBucket(pool) === poolBucketFilter) &&
      (!poolNeedle ||
        [pool.name, pool.id, maskProxyUrl(pool.proxyUrl)]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(poolNeedle)))
  );
  const poolCounts = Object.fromEntries(
    POOL_BUCKETS.map((item) => [item.id, poolRows.filter((pool) => poolBucket(pool) === item.id).length])
  );
  const nodeNeedle = nodeQuery.trim().toLowerCase();
  const visibleNodes = nodeRows.filter(
    (node) =>
      (!nodeTypeFilter || node.type === nodeTypeFilter) &&
      (!nodeNeedle ||
        [node.name, node.prefix, node.baseUrl]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(nodeNeedle)))
  );

  const poolEvidence = (pool) => (
    <>
      <EvidenceLine
        label="Routing"
        meter={false}
        level={pool.isActive === false ? 'depleted' : 'good'}
        value={pool.isActive === false ? 'Off' : 'On'}
        note={pool.isActive === false ? 'bindings are refused' : 'available to bindings'}
      />
      <EvidenceLine
        label="Bound"
        shares={[
          {
            kind: 'input',
            percent: Math.min(100, ((pool.boundConnectionCount || 0) / maxBound) * 100),
          },
        ]}
        value={fmtNum(pool.boundConnectionCount || 0)}
        note={pool.strictProxy ? 'strict binding' : 'direct fallback allowed'}
      />
    </>
  );

  const poolIdentity = (pool, expanded, onOpen) => (
    <div className={board.identity}>
      <span className="network-mark" aria-hidden="true">
        <Icon name="i-network" />
      </span>
      <div className={board.identityText}>
        <span className={board.nameLine}>
          <button
            type="button"
            className={board.nameButton}
            aria-expanded={expanded}
            aria-label={`Inspect pool ${pool.name || pool.id}`}
            onClick={onOpen}
          >
            {pool.name || pool.id}
          </button>
        </span>
        <small title={maskProxyUrl(pool.proxyUrl)}>{maskProxyUrl(pool.proxyUrl)}</small>
      </div>
    </div>
  );

  const poolActions = (pool) => (
    <div className={board.actions}>
      <Tooltip label="Run a probe. It can change whether this pool is active.">
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={`Test ${pool.name || pool.id}`}
          aria-describedby="probe-consequence"
          disabled={busy || uncertain}
          onClick={() => testPool(pool)}
        >
          <Icon name="i-test" />
        </ActionIcon>
      </Tooltip>
      {advanced ? (
        <Tooltip label="Delete this pool">
          <ActionIcon
            variant="subtle"
            color="red"
            aria-label={`Delete pool ${pool.name || pool.id}`}
            disabled={busy || uncertain}
            onClick={() => setConfirming({ kind: 'pool', id: pool.id })}
          >
            <Icon name="i-close" />
          </ActionIcon>
        </Tooltip>
      ) : null}
    </div>
  );

  const poolDetail = (pool) => (
    <>
      <div className="network-edit" aria-label={`Edit pool ${pool.name || pool.id}`}>
        <CommitText
          label="Name"
          className={board.addName}
          value={pool.name || ''}
          disabled={busy || uncertain}
          onCommit={(name) => savePool(pool, { name })}
        />
        <CommitText
          label="Proxy URL"
          type="password"
          autoComplete="off"
          className={board.addSecret}
          placeholder="Leave empty to keep the current URL"
          value=""
          disabled={busy || uncertain}
          onCommit={(proxyUrl) => proxyUrl && savePool(pool, { proxyUrl })}
        />
        <CommitText
          label="No-proxy list"
          className={board.addName}
          value={pool.noProxy || ''}
          disabled={busy || uncertain}
          onCommit={(noProxy) => savePool(pool, { noProxy })}
        />
        <Checkbox
          size="xs"
          label="Strict: a binding here fails outright rather than falling back to a direct connection"
          checked={pool.strictProxy === true}
          disabled={busy || uncertain}
          onChange={(event) => savePool(pool, { strictProxy: event.currentTarget.checked })}
        />
      </div>
      <OperationHistoryInspector key={pool.id} subjectId={pool.id} label={pool.name} />
    </>
  );

  const nodeIdentity = (node, expanded, onOpen) => (
    <div className={board.identity}>
      <span className="network-mark" aria-hidden="true">
        <Icon name="i-models" />
      </span>
      <div className={board.identityText}>
        <span className={board.nameLine}>
          <button
            type="button"
            className={board.nameButton}
            aria-expanded={expanded}
            aria-label={`Inspect node ${node.name || node.id}`}
            onClick={onOpen}
          >
            {node.name || node.id}
          </button>
        </span>
        <small title={node.baseUrl}>
          {node.prefix} · {node.baseUrl}
        </small>
      </div>
    </div>
  );

  // An endpoint is a name, not a proportion. A card has no room for the URL
  // beside its dialect, and the identity line above already carries it.
  const nodeEvidence = (node, compact) => (
    <EvidenceLine
      label="Endpoint"
      meter={false}
      value={
        compact
          ? node.apiType === 'responses'
            ? 'Responses'
            : 'Chat'
          : node.baseUrl || 'Not set'
      }
      note={compact ? null : `${node.apiType === 'responses' ? 'Responses' : 'Chat'} · not tested`}
      title={`${node.baseUrl || 'No base URL set'}. A node is configuration only; nothing here establishes that the endpoint answers.`}
    />
  );

  const nodeDetail = (node) => (
    <div className="network-edit" aria-label={`Edit node ${node.name || node.id}`}>
      <CommitText
        label="Name"
        className={board.addName}
        value={node.name || ''}
        disabled={busy || uncertain}
        onCommit={(name) => saveNode(node, { name })}
      />
      <CommitText
        label="Prefix"
        className={board.addName}
        value={node.prefix || ''}
        disabled={busy || uncertain}
        onCommit={(prefix) => saveNode(node, { prefix })}
      />
      {node.type === 'multi-compatible' ? (
        <>
          <CommitText
            label="OpenAI endpoint URL"
            type="url"
            className={board.addSecret}
            value={nodeFields(node).openaiUrl}
            disabled={busy || uncertain}
            onCommit={(openaiUrl) => saveNode(node, { openaiUrl })}
          />
          <CommitText
            label="Anthropic endpoint URL"
            type="url"
            className={board.addSecret}
            value={nodeFields(node).anthropicUrl}
            disabled={busy || uncertain}
            onCommit={(anthropicUrl) => saveNode(node, { anthropicUrl })}
          />
          <Checkbox
            size="xs"
            label="Register the OpenAI Responses transport"
            checked={nodeFields(node).supportsResponses}
            disabled={busy || uncertain}
            onChange={(event) =>
              saveNode(node, { supportsResponses: event.currentTarget.checked })
            }
          />
        </>
      ) : (
        <CommitText
          label="Base URL"
          className={board.addSecret}
          value={node.baseUrl || ''}
          disabled={busy || uncertain}
          onCommit={(baseUrl) => saveNode(node, { baseUrl })}
        />
      )}
      {node.type === 'openai-compatible' ? (
        <NativeSelect
          size="xs"
          label="API type"
          className={board.addMode}
          value={nodeFields(node).apiType}
          disabled={busy || uncertain}
          onChange={(event) => saveNode(node, { apiType: event.currentTarget.value })}
          data={[
            { value: 'chat', label: 'Chat' },
            { value: 'responses', label: 'Responses' },
          ]}
        />
      ) : null}
      <p className={board.muted}>
        Saving a node cascades its prefix, dialect and base URL into every connection bound to it.
        This local configuration does not establish provider support or send a validation request.
      </p>
    </div>
  );

  return (
    <div className={shared.lensPage} data-density={density}>
      <div className={shared.lensHeading}>
        <div className={shared.lensTitle}>
          <h1>Network</h1>
          <p>
            The path each account takes out, the pools it can take, and the endpoints it can reach
          </p>
        </div>
        <div className="network-heading-actions">
          <Freshness status={pollFresh(pools)} lastDataAt={pools.goodAt} />
          <Tabs
            value={task}
            onChange={(value) => {
              setRefused(null);
              setConfirming(null);
              setTask(value);
            }}
            className="network-tasks"
          >
            <Tabs.List aria-label="Network tasks" className={board.tabList}>
              {TASKS.map((item) => (
                <Tabs.Tab key={item.value} value={item.value} className={board.tab}>
                  {item.label}
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs>
        </div>
      </div>
      <div className={shared.lensBody}>
      {uncertain ? (
        <Notice tone="warn" title="Refresh the configuration before another change.">
          <Button size="compact-xs" variant="default" onClick={() => window.location.reload()}>
            Reload saved configuration
          </Button>
        </Notice>
      ) : null}
      {refused ? <Notice {...refused} /> : null}

      <dl className="network-summary" aria-label="Network configuration summary">
        <div>
          <dt>Provider nodes</dt>
          <dd>
            <bdi>{nodes.data ? fmtNum(nodeRows.length) : 'Unknown'}</bdi>
          </dd>
        </div>
        <div>
          <dt>Proxy pools</dt>
          <dd>
            <bdi>{pools.data ? fmtNum(poolRows.length) : 'Unknown'}</bdi>
          </dd>
        </div>
        <div>
          <dt>Provider strategies</dt>
          <dd>
            <bdi>{settings.data ? fmtNum(Object.keys(providerStrategies).length) : 'Unknown'}</bdi>
          </dd>
        </div>
        <div>
          <dt>Outbound proxy</dt>
          <dd>{settings.data ? (outboundEnabled ? 'On' : 'Off') : 'Unknown'}</dd>
        </div>
      </dl>

      {task === 'paths' ? (
        <>
          {connections.error ? <Notice {...refusal(connections.status, connections.error)} /> : null}
          {connections.data && pools.data ? (
            <AccountPaths
              connections={connections.data.connections || []}
              pools={poolRows}
              onSaved={connections.refresh}
              density={density}
              onDensity={setDensity}
              showDensity
            />
          ) : (
            <p className="caption">Account paths require both the account and pool inventories.</p>
          )}

          <section aria-labelledby="h-outbound">
            <div className="network-lens-row">
              <h3 id="h-outbound" className="network-lens">
                Outbound proxy
              </h3>
              <Freshness status={pollFresh(settings)} lastDataAt={settings.goodAt} />
            </div>
            {settings.error && !settings.data ? (
              <Notice {...refusal(settings.status, settings.error)} />
            ) : null}
            {settings.data ? (
              <Board label="Outbound proxy" advanced={advanced} density={density} layout="cards">
                <BoardSummary
                  label="Outbound proxy summary"
                  chips={[
                    {
                      tone: outboundEnabled ? 'positive' : 'ember',
                      count: outboundEnabled ? 'On' : 'Off',
                      label: 'at the global level',
                    },
                  ]}
                  note={
                    <span title="The global proxy setting. Account-specific assignments and proxy pools can override this path. Inspect an account above for its configured path; reachability requires a separate observed test.">
                      {`${connectTimeoutMs != null ? `${fmtNum(connectTimeoutMs)} ms connect timeout · ` : ''}${
                        outboundEnabled
                          ? `through ${maskProxyUrl(outboundUrl) || 'an unset URL'}`
                          : 'every upstream call goes out directly unless a pool says otherwise'
                      }`}
                    </span>
                  }
                />
                <BoardToolbar
                  actions={
                    outbound ? null : outboundEnabled ? (
                      <>
                        <Button
                          size="xs"
                          variant="default"
                          leftSection={<Icon name="i-edit" />}
                          onClick={() => setOutbound({ url: '', noProxy: outboundNoProxy })}
                        >
                          Change proxy URL
                        </Button>
                        <Button
                          size="xs"
                          color="red"
                          variant="light"
                          leftSection={<Icon name="i-pause" />}
                          onClick={() => setOutboundReview('off')}
                        >
                          Turn off
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="xs"
                        leftSection={<Icon name="i-network" />}
                        onClick={() => setOutbound({ url: '', noProxy: '' })}
                      >
                        Set an outbound proxy
                      </Button>
                    )
                  }
                />
                {outbound ? (
                  <div className={board.addRow} role="group" aria-label="Outbound proxy">
                    <TextInput
                      size="xs"
                      label="Proxy URL"
                      type="password"
                      autoComplete="off"
                      className={board.addSecret}
                      value={outbound.url}
                      placeholder="http://user:pass@host:port"
                      onChange={(e) => {
                      const next = e.currentTarget.value;
                      setOutbound((o) => ({ ...o, url: next }));
                    }}
                    />
                    <TextInput
                      size="xs"
                      label="No-proxy list"
                      className={board.addName}
                      value={outbound.noProxy}
                      onChange={(e) => {
                      const next = e.currentTarget.value;
                      setOutbound((o) => ({ ...o, noProxy: next }));
                    }}
                    />
                    <Button
                      size="xs"
                      leftSection={<Icon name="i-play" />}
                      disabled={busy}
                      onClick={() => setOutboundReview('on')}
                    >
                      Turn on
                    </Button>
                    <Button size="xs" variant="default" onClick={() => setOutbound(null)}>
                      Cancel
                    </Button>
                  </div>
                ) : null}
                {outboundReview ? (
                  <InlineConfirm
                    role="alertdialog"
                    danger
                    question={
                      outboundReview === 'on'
                        ? 'Every upstream call not routed through a specific pool uses this proxy from now on.'
                        : 'Every upstream call not routed through a specific pool goes out directly from now on.'
                    }
                    verb={outboundReview === 'on' ? 'Turn on' : 'Turn off'}
                    busy={busy}
                    onConfirm={() => applyOutbound(outboundReview === 'on')}
                    onCancel={() => setOutboundReview(null)}
                  />
                ) : null}
              </Board>
            ) : settings.loading ? (
              <p className="skeleton">Reading</p>
            ) : null}
          </section>

          <NetworkOptions actionId="timeout" onSaved={settings.refresh} />
          <NetworkOptions actionId="test" />

          <section aria-labelledby="h-strategy">
            <h3 id="h-strategy" className="network-lens" title="Binds a proxy pool to the virtual account of a provider that uses no credential. Stored credentialed accounts use their own account policy and do not inherit this strategy. Round-robin and random choose among all active pools with an address at routing time, ignoring the fixed pool while rotation is selected.">
              Per-provider proxy strategy
            </h3>
            <Board label="Provider proxy strategy" advanced={advanced} density={density} layout="cards">
              <div className={board.addRow} role="group" aria-label="Provider proxy strategy">
                <NativeSelect
                  size="xs"
                  label="Provider id"
                  className={board.addProvider}
                  value={strategyProvider}
                  onChange={(event) => {
                    const provider = event.currentTarget.value;
                    const current = providerStrategies[provider] || {};
                    setStrategyProvider(provider);
                    setStrategyPoolId(current.proxyPoolId || '');
                    setStrategyRotation(current.rotateStrategy || 'none');
                  }}
                  data={[
                    { value: '', label: 'Choose a provider without credentials' },
                    ...NO_AUTH_PROVIDER_IDS.map((id) => ({
                      value: id,
                      label: AI_PROVIDERS[id]?.name || id,
                    })),
                  ]}
                />
                <NativeSelect
                  size="xs"
                  label="Pool selection mode"
                  className={board.addMode}
                  value={strategyRotation}
                  onChange={(event) => setStrategyRotation(event.currentTarget.value)}
                  data={[
                    { value: 'none', label: 'Fixed pool' },
                    { value: 'round-robin', label: 'Round-robin across active pools' },
                    { value: 'random', label: 'Random across active pools' },
                  ]}
                />
                <NativeSelect
                  size="xs"
                  label="Proxy pool"
                  className={board.addName}
                  value={strategyPoolId}
                  disabled={strategyRotation !== 'none'}
                  onChange={(e) => setStrategyPoolId(e.currentTarget.value)}
                  data={[
                    { value: '', label: 'No selection; global or environment path' },
                    ...poolRows
                      .filter((p) => p.isActive)
                      .map((p) => ({ value: p.id, label: p.name })),
                  ]}
                />
                <Button
                  size="xs"
                  leftSection={<Icon name="i-edit" />}
                  disabled={!isNoAuthProvider(strategyProvider) || busy || !!settings.error}
                  onClick={() => {
                    setRefused(null);
                    setStrategyReview({
                      providerId: strategyProvider,
                      poolId: strategyPoolId,
                      rotation: strategyRotation,
                    });
                  }}
                >
                  Save strategy
                </Button>
              </div>
              {strategyReview ? (
                <InlineConfirm
                  role="alertdialog"
                  danger
                  question={`Pool selection for ${strategyReview.providerId} changes on subsequent routing: ${strategyReview.rotation}, fixed pool ${strategyReview.poolId || 'none'}. Credentialed accounts keep their own policies.`}
                  verb="Apply proxy strategy"
                  busy={busy}
                  onConfirm={saveStrategy}
                  onCancel={() => setStrategyReview(null)}
                />
              ) : null}
              {Object.keys(providerStrategies).length ? (
                <div className={board.group}>
                  <dl className="facts network-strategies">
                    {Object.entries(providerStrategies).map(([pid, st]) => (
                      <div key={pid}>
                        <dt>{pid}</dt>
                        <dd>
                          {!isNoAuthProvider(pid)
                            ? 'This network strategy does not affect credentialed accounts.'
                            : st.rotateStrategy && st.rotateStrategy !== 'none'
                              ? st.rotateStrategy === 'round-robin'
                                ? 'Round-robin across active pools'
                                : st.rotateStrategy === 'random'
                                  ? 'Random across active pools'
                                  : 'Unrecognized stored rotation mode'
                              : st.proxyPoolId
                                ? `${poolRows.find((p) => p.id === st.proxyPoolId)?.name || st.proxyPoolId}${st.strictProxy ? ' · Strict' : ''}`
                                : 'No fixed pool; global or environment path'}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ) : null}
            </Board>
          </section>
        </>
      ) : null}

      {task === 'nodes' ? (
        <>
          <section aria-labelledby="h-nodes">
            <h3 id="h-nodes" className="network-lens">
              Provider nodes
            </h3>
            <Board
              label="Provider nodes"
              data-compare="none"
              advanced={advanced}
              density={density}
              layout={advanced ? 'rows' : 'cards'}
            >
              <BoardSummary
                label="Node summary"
                active={nodeTypeFilter}
                onPick={setNodeTypeFilter}
                chips={
                  nodes.data
                    ? [
                        {
                          count: nodeRows.length,
                          label: nodeRows.length === 1 ? 'node' : 'nodes',
                        },
                        ...NODE_TYPES.filter((type) =>
                          nodeRows.some((node) => node.type === type.value)
                        ).map((type) => ({
                          id: type.value,
                          count: nodeRows.filter((node) => node.type === type.value).length,
                          label: type.label.toLowerCase(),
                        })),
                      ]
                    : [{ count: '—', label: 'nodes' }]
                }
                note={
                  <span title="A self-registered upstream endpoint beyond the built-in provider catalog. A connection references it by id.">
                    Configuration only; nothing here establishes that an endpoint answers
                  </span>
                }
              />
              <BoardToolbar
                search={nodeQuery}
                onSearch={setNodeQuery}
                searchLabel="Search nodes"
                actions={
                  <>
                    <Button
                      size="xs"
                      leftSection={<Icon name="i-add" />}
                      aria-expanded={addingNode}
                      onClick={() => setAddingNode((value) => !value)}
                    >
                      Add a node
                    </Button>
                    <Tooltip label="Re-read the node inventory">
                      <ActionIcon
                        variant="default"
                        aria-label="Refresh nodes"
                        loading={nodes.loading}
                        onClick={nodes.refresh}
                      >
                        <Icon name="i-refresh" />
                      </ActionIcon>
                    </Tooltip>
                  </>
                }
              >
                <Tooltip label="How much room every board on this page takes">
                  <DensitySwitch value={density} onChange={setDensity} />
                </Tooltip>
              </BoardToolbar>
              {addingNode ? (
                <div className={board.addRow} role="group" aria-label="Add a provider node">
                  <TextInput
                    size="xs"
                    label="Name"
                    className={board.addName}
                    value={nodeForm.name}
                    onChange={(e) => {
                      const next = e.currentTarget.value;
                      setNodeForm((f) => ({ ...f, name: next }));
                    }}
                  />
                  <TextInput
                    size="xs"
                    label="Prefix"
                    className={board.addName}
                    value={nodeForm.prefix}
                    onChange={(e) => {
                      const next = e.currentTarget.value;
                      setNodeForm((f) => ({ ...f, prefix: next }));
                    }}
                  />
                  <NativeSelect
                    size="xs"
                    label="Type"
                    className={board.addProvider}
                    value={nodeForm.type}
                    onChange={(e) => {
                      const next = e.currentTarget.value;
                      setNodeForm((f) => ({ ...f, type: next }));
                    }}
                    data={NODE_TYPES}
                  />
                  {nodeForm.type === 'openai-compatible' ? (
                    <NativeSelect
                      size="xs"
                      label="API type"
                      className={board.addMode}
                      value={nodeForm.apiType}
                      onChange={(e) => {
                      const next = e.currentTarget.value;
                      setNodeForm((f) => ({ ...f, apiType: next }));
                    }}
                      data={[
                        { value: 'chat', label: 'Chat' },
                        { value: 'responses', label: 'Responses' },
                      ]}
                    />
                  ) : null}
                  {nodeForm.type === 'multi-compatible' ? (
                    <>
                      <TextInput
                        size="xs"
                        label="OpenAI endpoint URL"
                        type="url"
                        className={board.addSecret}
                        value={nodeForm.openaiUrl}
                        onChange={(e) => {
                      const next = e.currentTarget.value;
                      setNodeForm((f) => ({ ...f, openaiUrl: next }));
                    }}
                      />
                      <TextInput
                        size="xs"
                        label="Anthropic endpoint URL"
                        type="url"
                        className={board.addSecret}
                        value={nodeForm.anthropicUrl}
                        onChange={(e) => {
                      const next = e.currentTarget.value;
                      setNodeForm((f) => ({ ...f, anthropicUrl: next }));
                    }}
                      />
                      <Checkbox
                        size="xs"
                        label="Register the OpenAI Responses transport"
                        checked={nodeForm.supportsResponses}
                        onChange={(e) => {
                      const next = e.currentTarget.checked;
                      setNodeForm((f) => ({ ...f, supportsResponses: next }));
                    }}
                      />
                    </>
                  ) : (
                    <TextInput
                      size="xs"
                      label="Base URL"
                      className={board.addSecret}
                      value={nodeForm.baseUrl}
                      onChange={(e) => {
                      const next = e.currentTarget.value;
                      setNodeForm((f) => ({ ...f, baseUrl: next }));
                    }}
                    />
                  )}
                  <Button size="xs" disabled={busy} onClick={createNode}>
                    Create
                  </Button>
                  <Button size="xs" variant="default" onClick={() => setAddingNode(false)}>
                    Cancel
                  </Button>
                </div>
              ) : null}
              {advanced && visibleNodes.length ? (
                <div className={board.head} aria-hidden="true">
                  <span />
                  <span>Node</span>
                  <span>Dialect</span>
                  <span>Endpoint</span>
                  <span>Registered</span>
                  <span>Delete</span>
                </div>
              ) : null}
              {advanced ? (
                <div className={board.rows}>
                  {visibleNodes.map((node) => {
                    const expanded = openNodeId === node.id;
                    return (
                      <article
                        key={node.id}
                        className={board.row}
                        data-node-id={node.id}
                        data-expanded={expanded || undefined}
                        aria-label={node.name || node.id}
                      >
                        <div className={board.main}>
                          <Tooltip label={expanded ? 'Collapse' : 'Edit this node'}>
                            <button
                              type="button"
                              className={board.caret}
                              aria-expanded={expanded}
                              aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.name || node.id}`}
                              onClick={() => setOpenNodeId(expanded ? null : node.id)}
                            >
                              <Icon name={expanded ? 'i-chevron-up' : 'i-chevron-down'} />
                            </button>
                          </Tooltip>
                          {nodeIdentity(node, expanded, () =>
                            setOpenNodeId(expanded ? null : node.id)
                          )}
                          <div className={board.state}>
                            <Tooltip label={NODE_TYPE_WORD[node.type] || node.type}>
                              <span>
                                <StateWord>{NODE_TYPE_SHORT[node.type] || node.type}</StateWord>
                              </span>
                            </Tooltip>
                          </div>
                          <div className={board.quota}>{nodeEvidence(node)}</div>
                          <div className={board.activity}>
                            <span>{node.prefix}</span>
                            <small>{node.id}</small>
                          </div>
                          <div className={board.actions}>
                            <Tooltip label="Delete this node">
                              <ActionIcon
                                variant="subtle"
                                color="red"
                                aria-label={`Delete node ${node.name || node.id}`}
                                disabled={busy || uncertain}
                                onClick={() => setConfirming({ kind: 'node', id: node.id })}
                              >
                                <Icon name="i-close" />
                              </ActionIcon>
                            </Tooltip>
                          </div>
                        </div>
                        {confirming?.kind === 'node' && confirming.id === node.id ? (
                          <InlineConfirm
                            role="alertdialog"
                            danger
                            question="Removes this node, every provider connection registered against it, and every model alias that points at it. A deleted node cannot be restored."
                            verb="Delete node"
                            busy={busy}
                            onConfirm={() => removeNode(node)}
                            onCancel={() => setConfirming(null)}
                          />
                        ) : null}
                        {expanded ? (
                          <div className={board.detail} role="region" aria-label="Node settings">
                            {nodeDetail(node)}
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              ) : (
                NODE_TYPES.map((type) => {
                  const members = visibleNodes.filter((node) => node.type === type.value);
                  if (!members.length) return null;
                  return (
                    <BoardGroup key={type.value} label={type.label} count={members.length}>
                      {members.map((node) => {
                        const expanded = openNodeId === node.id;
                        return (
                          <article
                            key={node.id}
                            className={board.card}
                            data-node-id={node.id}
                            data-expanded={expanded || undefined}
                            aria-label={node.name || node.id}
                          >
                            <header className={board.cardHead}>
                              {nodeIdentity(node, expanded, () =>
                                setOpenNodeId(expanded ? null : node.id)
                              )}
                              <Tooltip label={expanded ? 'Collapse' : 'Edit this node'}>
                                <button
                                  type="button"
                                  className={board.caret}
                                  aria-expanded={expanded}
                                  aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.name || node.id}`}
                                  onClick={() => setOpenNodeId(expanded ? null : node.id)}
                                >
                                  <Icon name={expanded ? 'i-chevron-up' : 'i-chevron-down'} />
                                </button>
                              </Tooltip>
                            </header>
                            <div className={board.cardState}>
                              <Tooltip label={NODE_TYPE_WORD[node.type] || node.type}>
                                <span>
                                  <StateWord>{NODE_TYPE_SHORT[node.type] || node.type}</StateWord>
                                </span>
                              </Tooltip>
                            </div>
                            <div className={board.cardWindows}>{nodeEvidence(node, true)}</div>
                            {expanded ? (
                              <div
                                className={board.detail}
                                role="region"
                                aria-label="Node settings"
                              >
                                {nodeDetail(node)}
                              </div>
                            ) : null}
                          </article>
                        );
                      })}
                    </BoardGroup>
                  );
                })
              )}
              <div className={board.messages}>
                {nodes.error && !nodes.data ? <Notice {...refusal(nodes.status, nodes.error)} /> : null}
                {nodes.loading && !nodes.data ? (
                  <p className={board.empty} role="status">
                    Reading nodes…
                  </p>
                ) : null}
                {nodes.data && nodeRows.length === 0 ? (
                  <p className={board.empty}>
                    No node is registered. Add one to route through a custom endpoint.
                  </p>
                ) : null}
                {nodeRows.length > 0 && visibleNodes.length === 0 ? (
                  <p className={board.empty}>
                    No node matches.{' '}
                    <button
                      type="button"
                      className={board.linkButton}
                      onClick={() => {
                        setNodeQuery('');
                        setNodeTypeFilter(null);
                      }}
                    >
                      Clear filters
                    </button>
                  </p>
                ) : null}
              </div>
            </Board>
          </section>
          <NetworkOptions actionId="adapter" onSaved={nodes.refresh} />
          <NetworkOptions actionId="export" />
        </>
      ) : null}

      {task === 'pools' ? (
        <>
          <section aria-labelledby="h-pools">
            <h3 id="h-pools" className="network-lens">
              Proxy pools
            </h3>
            <Board
              label="Proxy pools"
              data-compare="none"
              advanced={advanced}
              density={density}
              layout={advanced ? 'rows' : 'cards'}
            >
              <BoardSummary
                label="Pool summary"
                active={poolBucketFilter}
                onPick={setPoolBucketFilter}
                chips={
                  pools.data
                    ? [
                        {
                          count: poolRows.length,
                          label: poolRows.length === 1 ? 'pool' : 'pools',
                        },
                        ...POOL_BUCKETS.map((item) => ({
                          id: item.id,
                          tone: item.tone,
                          count: poolCounts[item.id],
                          label: item.label.toLowerCase(),
                        })),
                      ]
                    : [{ count: '—', label: 'pools' }]
                }
                note={
                  <span title="A named outbound path a connection or a provider strategy can be bound to instead of routing directly. A probe writes activation in the same transaction as its receipt, so it takes effect the moment the probe answers.">
                    Latest applied is the pool&apos;s own current state, overwritten by each probe: a probe that was cancelled, that conflicted with a configuration change, or that never finished leaves no mark there.
                  </span>
                }
              />
              <BoardToolbar
                search={poolQuery}
                onSearch={setPoolQuery}
                searchLabel="Search pools"
                actions={
                  <>
                    <Button
                      size="xs"
                      leftSection={<Icon name="i-add" />}
                      aria-expanded={addingPool}
                      onClick={() => setAddingPool((value) => !value)}
                    >
                      Add a pool
                    </Button>
                    <Tooltip label="Re-read the pool inventory">
                      <ActionIcon
                        variant="default"
                        aria-label="Refresh pools"
                        loading={pools.loading}
                        onClick={pools.refresh}
                      >
                        <Icon name="i-refresh" />
                      </ActionIcon>
                    </Tooltip>
                  </>
                }
              >
                <Tooltip label="How much room every board on this page takes">
                  <DensitySwitch value={density} onChange={setDensity} />
                </Tooltip>
              </BoardToolbar>
              <ProbeConsequence id="probe-consequence" />
              {addingPool ? (
                <div className={board.addRow} role="group" aria-label="Add a proxy pool">
                  <TextInput
                    size="xs"
                    label="Name"
                    className={board.addName}
                    value={poolForm.name}
                    onChange={(e) => {
                      const next = e.currentTarget.value;
                      setPoolForm((f) => ({ ...f, name: next }));
                    }}
                  />
                  <TextInput
                    size="xs"
                    label="Proxy URL"
                    type="password"
                    autoComplete="off"
                    className={board.addSecret}
                    placeholder="http://user:pass@host:port"
                    value={poolForm.proxyUrl}
                    onChange={(e) => {
                      const next = e.currentTarget.value;
                      setPoolForm((f) => ({ ...f, proxyUrl: next }));
                    }}
                  />
                  <TextInput
                    size="xs"
                    label="No-proxy list"
                    className={board.addName}
                    value={poolForm.noProxy}
                    onChange={(e) => {
                      const next = e.currentTarget.value;
                      setPoolForm((f) => ({ ...f, noProxy: next }));
                    }}
                  />
                  <Checkbox
                    size="xs"
                    label="Strict: a binding here fails outright rather than falling back to a direct connection"
                    checked={poolForm.strictProxy}
                    onChange={(e) => {
                      const next = e.currentTarget.checked;
                      setPoolForm((f) => ({ ...f, strictProxy: next }));
                    }}
                  />
                  <Button size="xs" disabled={busy} onClick={createPool}>
                    Create
                  </Button>
                  <Button size="xs" variant="default" onClick={() => setAddingPool(false)}>
                    Cancel
                  </Button>
                </div>
              ) : null}
              {advanced && visiblePools.length ? (
                <div className={board.head} aria-hidden="true">
                  <span />
                  <span>Pool</span>
                  <span>Latest applied</span>
                  <span>Routing and bindings</span>
                  <span>Recorded error</span>
                  <span>Test · delete</span>
                </div>
              ) : null}
              {advanced ? (
                <div className={board.rows}>
                  {visiblePools.map((pool) => {
                    const expanded = openPoolId === pool.id;
                    return (
                      <article
                        key={pool.id}
                        className={board.row}
                        data-pool-id={pool.id}
                        data-expanded={expanded || undefined}
                        data-bucket={poolBucket(pool)}
                        aria-label={pool.name || pool.id}
                      >
                        <div className={board.main}>
                          <Tooltip label={expanded ? 'Collapse' : 'Settings and probe history'}>
                            <button
                              type="button"
                              className={board.caret}
                              aria-expanded={expanded}
                              aria-label={`${expanded ? 'Collapse' : 'Expand'} ${pool.name || pool.id}`}
                              onClick={() => setOpenPoolId(expanded ? null : pool.id)}
                            >
                              <Icon name={expanded ? 'i-chevron-up' : 'i-chevron-down'} />
                            </button>
                          </Tooltip>
                          {poolIdentity(pool, expanded, () =>
                            setOpenPoolId(expanded ? null : pool.id)
                          )}
                          <div className={board.state}>
                            <StateWord tone={poolTone(pool)}>{poolWord(pool)}</StateWord>
                          </div>
                          <div className={board.quota}>{poolEvidence(pool)}</div>
                          <div className={board.activity}>
                            {pool.lastError ? (
                              <small title={pool.lastError}>{pool.lastError}</small>
                            ) : (
                              <small>No error recorded</small>
                            )}
                            {pool.boundConnectionCount ? (
                              <Link href="/dashboard/connections" prefetch={false}>
                                {fmtNum(pool.boundConnectionCount)} bound
                              </Link>
                            ) : null}
                          </div>
                          {poolActions(pool)}
                        </div>
                        {testResult?.id === pool.id ? <Notice {...testResult} /> : null}
                        {confirming?.kind === 'pool' && confirming.id === pool.id ? (
                          <InlineConfirm
                            role="alertdialog"
                            danger
                            question={
                              pool.boundConnectionCount
                                ? `${fmtNum(pool.boundConnectionCount)} connection${pool.boundConnectionCount === 1 ? '' : 's'} bound to this pool will be refused: a pool still in use is not deleted.`
                                : 'No connection is bound to this pool. A deleted pool cannot be restored.'
                            }
                            verb="Delete pool"
                            busy={busy}
                            onConfirm={() => removePool(pool)}
                            onCancel={() => setConfirming(null)}
                          />
                        ) : null}
                        {expanded ? (
                          <div className={board.detail} role="region" aria-label="Pool settings">
                            {poolDetail(pool)}
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              ) : (
                POOL_BUCKETS.map((item) => {
                  const members = visiblePools.filter((pool) => poolBucket(pool) === item.id);
                  if (!members.length) return null;
                  return (
                    <BoardGroup
                      key={item.id}
                      label={item.label}
                      tone={item.tone}
                      count={members.length}
                    >
                      {members.map((pool) => {
                        const expanded = openPoolId === pool.id;
                        return (
                          <article
                            key={pool.id}
                            className={board.card}
                            data-pool-id={pool.id}
                            data-expanded={expanded || undefined}
                            data-bucket={poolBucket(pool)}
                            aria-label={pool.name || pool.id}
                          >
                            <header className={board.cardHead}>
                              {poolIdentity(pool, expanded, () =>
                                setOpenPoolId(expanded ? null : pool.id)
                              )}
                              <Tooltip label={expanded ? 'Collapse' : 'Settings and probe history'}>
                                <button
                                  type="button"
                                  className={board.caret}
                                  aria-expanded={expanded}
                                  aria-label={`${expanded ? 'Collapse' : 'Expand'} ${pool.name || pool.id}`}
                                  onClick={() => setOpenPoolId(expanded ? null : pool.id)}
                                >
                                  <Icon name={expanded ? 'i-chevron-up' : 'i-chevron-down'} />
                                </button>
                              </Tooltip>
                            </header>
                            <div className={board.cardState}>
                              <StateWord tone={poolTone(pool)}>{poolWord(pool)}</StateWord>
                              <span className={board.spacer} />
                              {poolActions(pool)}
                            </div>
                            <div className={board.cardWindows}>{poolEvidence(pool)}</div>
                            {testResult?.id === pool.id ? <Notice {...testResult} /> : null}
                            {confirming?.kind === 'pool' && confirming.id === pool.id ? (
                              <InlineConfirm
                                role="alertdialog"
                                danger
                                question={
                                  pool.boundConnectionCount
                                    ? `${fmtNum(pool.boundConnectionCount)} connection${pool.boundConnectionCount === 1 ? '' : 's'} bound to this pool will be refused.`
                                    : 'No connection is bound to this pool. A deleted pool cannot be restored.'
                                }
                                verb="Delete pool"
                                busy={busy}
                                onConfirm={() => removePool(pool)}
                                onCancel={() => setConfirming(null)}
                              />
                            ) : null}
                            {expanded ? (
                              <div
                                className={board.detail}
                                role="region"
                                aria-label="Pool settings"
                              >
                                {poolDetail(pool)}
                              </div>
                            ) : null}
                          </article>
                        );
                      })}
                    </BoardGroup>
                  );
                })
              )}
              <div className={board.messages}>
                {pools.error && !pools.data ? <Notice {...refusal(pools.status, pools.error)} /> : null}
                {pools.loading && !pools.data ? (
                  <p className={board.empty} role="status">
                    Reading pools…
                  </p>
                ) : null}
                {pools.data && poolRows.length === 0 ? (
                  <p className={board.empty}>
                    No pool exists. Add one to give a connection or a provider strategy somewhere to
                    route through.
                  </p>
                ) : null}
                {poolRows.length > 0 && visiblePools.length === 0 ? (
                  <p className={board.empty}>
                    No pool matches.{' '}
                    <button
                      type="button"
                      className={board.linkButton}
                      onClick={() => {
                        setPoolQuery('');
                        setPoolBucketFilter(null);
                      }}
                    >
                      Clear filters
                    </button>
                  </p>
                ) : null}
              </div>
            </Board>
          </section>
          <NetworkOptions actionId="delete" pools={poolRows} onSaved={pools.refresh} />
        </>
      ) : null}

      {task === 'relay' ? (
        <>
          <h3 className="network-lens">Deploy outbound relay</h3>
          <NetworkOptions actionId="cloudflare" onSaved={pools.refresh} />
          <NetworkOptions actionId="vercel" onSaved={pools.refresh} />
        </>
      ) : null}
      </div>
    </div>
  );
}
