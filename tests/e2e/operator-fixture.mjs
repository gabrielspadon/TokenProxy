// Browser-only visual fixture. Never imported by application code or written to a database.
export const NOW = '2026-09-06T14:30:00.000Z';
export const PROVIDERS = ['anthropic', 'openai', 'gemini', 'deepseek', 'groq'];
export const connections = PROVIDERS.map((provider, i) => ({
  id: `visual-${i}`,
  connectionId: `visual-${i}`,
  provider,
  name: [
    'Research workspace',
    'Engineering team',
    'Multimodal lab',
    'Reasoning pool',
    'Fast inference',
  ][i],
  displayName: [
    'Research workspace',
    'Engineering team',
    'Multimodal lab',
    'Reasoning pool',
    'Fast inference',
  ][i],
  status: i === 3 ? 'cooldown' : 'healthy',
  priority: i + 1,
  isActive: true,
  authType: i < 2 ? 'oauth' : 'apikey',
  lastError: i === 3 ? 'Rate limit · retries cooling down' : null,
}));
export const byProvider = Object.fromEntries(
  PROVIDERS.map((p, i) => [
    p,
    {
      requests: [1840, 1234, 627, 318, 176][i],
      promptTokens: [2890000, 1940000, 978000, 437000, 215000][i],
      completionTokens: [410000, 302000, 183000, 71000, 41000][i],
      cost: [8.41, 6.12, 1.79, 0.53, 0.21][i],
    },
  ])
);
export const usage = {
  period: 'today',
  totalRequests: 4195,
  totalCost: 17.06,
  byProvider,
  byModel: {},
  byApiKey: {},
  byConnection: {},
  byClientTool: {},
  activeSessions: [
    {
      provider: 'anthropic',
      account: 'Research workspace',
      model: 'claude-opus-4-6',
      status: 'active',
      startedAt: NOW,
    },
    {
      provider: 'openai',
      account: 'Engineering team',
      model: 'gpt-5.4',
      status: 'active',
      startedAt: NOW,
    },
    {
      provider: 'anthropic',
      account: 'Research workspace',
      model: 'claude-sonnet-4-6',
      status: 'active',
      startedAt: NOW,
    },
  ],
  recentRequests: PROVIDERS.map((provider, i) => ({
    id: `request-${i}`,
    provider,
    model: ['claude-opus-4-6', 'gpt-5.4', 'gemini-3.1-pro', 'deepseek-v4', 'llama-3.3-70b'][i],
    timestamp: new Date(Date.parse(NOW) - i * 45000).toISOString(),
    promptTokens: 2200 + i * 930,
    completionTokens: 370 + i * 130,
    status: i === 3 ? 'error' : 'ok',
  })),
  activeRequests: [],
  errorProvider: null,
};
export const chart = Array.from({ length: 24 }, (_, i) => ({
  label: `${String(i).padStart(2, '0')}:00`,
  bucketStart: new Date(Date.parse(NOW) - (23 - i) * 3600000).toISOString(),
  requests: [
    12, 8, 4, 7, 18, 26, 74, 96, 155, 122, 167, 144, 192, 233, 168, 222, 270, 214, 298, 246, 201,
    156, 86, 51,
  ][i],
  cost: 0.12 + i * 0.05,
  promptTokens: 4500 + i * 880,
  completionTokens: 430 + i * 93,
}));
export const state = {
  measures: {
    throughput: { value: 1.86 },
    errorRate: { value: 0.012 },
    latencyP95: { value: 2840 },
    spend: { value: 3.2 },
    connectedUpstreams: { value: 5 },
    degradedUpstreams: { value: 1 },
    failoverCount: { value: null, unavailable: 'Not recorded by this gateway.' },
  },
  freshness: { state: 'live', lastEventAt: NOW },
  providerHealth: { status: 'degraded', degradedProviderCount: 1 },
  unanswerable: ['Model-specific cooldowns are not included in this health sample.'],
};
export const stages = [
  {
    stage: 'tools',
    samples: 24,
    beforeBytes: 680000,
    afterBytes: 660000,
    savedBytes: 20000,
    applied: 24,
    skipped: 0,
  },
  {
    stage: 'rtk',
    samples: 24,
    beforeBytes: 660000,
    afterBytes: 520000,
    savedBytes: 140000,
    applied: 18,
    skipped: 6,
  },
  {
    stage: 'mem',
    samples: 24,
    beforeBytes: 520000,
    afterBytes: 380000,
    savedBytes: 140000,
    applied: 6,
    skipped: 18,
  },
  {
    stage: 'final',
    samples: 24,
    beforeBytes: 380000,
    afterBytes: 380000,
    savedBytes: 0,
    applied: 0,
    skipped: 0,
  },
];
export const turns = Array.from({ length: 24 }, (_, i) => ({
  id: `turn-${i + 1}`,
  timestamp: new Date(Date.parse(NOW) - (23 - i) * 120000).toISOString(),
  status: i === 22 ? 'error' : 'success',
  attempt: 1,
  provider: i < 16 ? 'anthropic' : 'openai',
  model: i < 16 ? 'claude-opus-4-6' : 'gpt-5.4',
  requestedModel: 'research',
  clientTool: 'Claude Code',
  contextEstimate: i < 14 ? 12000 + i * 2500 : 15000 + (i - 14) * 2200,
  providerInputTokens: 14000 + i * 2100,
  providerOutputTokens: 600 + i * 24,
  cacheReadTokens: i ? 9500 + i * 1750 : 0,
  cacheWriteTokens: i ? null : 11000,
  savedBytes: 900 + i * 530,
  bodyBeforeBytes: 30000 + i * 3900,
  bodyAfterBytes: 29000 + i * 3370,
  compactHint: i === 14,
  usageSource: 'provider',
  messageCount: 9 + i * 2,
  toolCount: 12,
  routeKind: 'combo',
  selection: 'session-affinity',
  formatPair: 'claude→openai',
  latencyMs: 2100 + i * 70,
  ttftMs: 350 + i * 7,
  stages: stages.map((s, j) => ({
    ordinal: j,
    stage: s.stage,
    beforeBytes: 10000 - j * 1000,
    afterBytes: 9000 - j * 1000,
    deltaBytes: -1000,
    outcome: 'applied',
    risk:
      s.stage === 'rtk'
        ? 'semantic-preserving'
        : s.stage === 'mem'
          ? 'content-changing'
          : 'normalization',
  })),
}));
// Reconcile every test aggregate to its underlying rows, including stage boundaries.
for (const [metric, target] of Object.entries({
  requests: 4195,
  cost: 17.06,
  promptTokens: 6460000,
  completionTokens: 1007000,
})) {
  const total = chart.reduce((n, r) => n + r[metric], 0);
  let assigned = 0;
  chart.forEach((r, i) => {
    r[metric] =
      i === chart.length - 1
        ? target - assigned
        : Math.floor((r[metric] / total) * target * 100) / 100;
    assigned += r[metric];
  });
}
for (const t of turns) {
  const saved = t.bodyBeforeBytes - t.bodyAfterBytes;
  const changes = [Math.floor(saved * 0.12), Math.floor(saved * 0.52), 0, 0];
  changes[2] = saved - changes[0] - changes[1];
  let before = t.bodyBeforeBytes;
  t.savedBytes = saved;
  t.stages = t.stages.map((s, i) => {
    const after = before - changes[i];
    const row = {
      ...s,
      beforeBytes: before,
      afterBytes: after,
      deltaBytes: -changes[i],
      outcome: changes[i] ? 'applied' : 'unchanged',
    };
    before = after;
    return row;
  });
}
for (const s of stages) {
  const rows = turns.flatMap((t) => t.stages).filter((r) => r.stage === s.stage);
  Object.assign(s, {
    samples: rows.length,
    beforeBytes: rows.reduce((n, r) => n + r.beforeBytes, 0),
    afterBytes: rows.reduce((n, r) => n + r.afterBytes, 0),
    savedBytes: rows.reduce((n, r) => n - r.deltaBytes, 0),
    applied: rows.filter((r) => r.outcome === 'applied').length,
    skipped: 0,
  });
}
const contextRecords = [
  {
    session: {
      id: 1,
      projectLabel: 'OceanStack',
      identitySource: 'explicit',
      clientTool: 'Claude Code',
    },
    turns: turns.map((t) => ({
      ...t,
      connectionId: t.provider === 'anthropic' ? 'visual-0' : 'visual-1',
      controls: { rtk: true, rtkAllowLossy: false, headroom: true, headroomAllowLossy: false },
    })),
  },
  {
    session: { id: 2, projectLabel: 'TokenProxy', identitySource: 'inferred', clientTool: 'Codex' },
    turns: turns.slice(0, 18).map((t, i) => ({
      ...t,
      id: `codex-${i}`,
      provider: 'openai',
      model: 'gpt-5.4',
      connectionId: 'visual-1',
      clientTool: 'Codex',
      compactHint: false,
    })),
  },
  {
    session: { id: 3, projectLabel: null, identitySource: 'request', clientTool: 'API client' },
    turns: [
      {
        ...turns[0],
        id: 'api-1',
        provider: 'gemini',
        model: 'gemini-3.1-pro',
        connectionId: 'visual-2',
        clientTool: 'API client',
        providerInputTokens: 2150,
        providerOutputTokens: 300,
        cacheReadTokens: 0,
        cacheWriteTokens: null,
        savedBytes: 0,
        bodyBeforeBytes: 8000,
        bodyAfterBytes: 8000,
        stages: [],
      },
    ],
  },
];
function summarize(rows, sessionCount = 1) {
  const total = (key) => rows.reduce((n, r) => n + (r[key] || 0), 0);
  return {
    attempts: rows.length,
    requests: rows.length,
    sessions: sessionCount,
    succeeded: rows.filter((r) => r.status === 'success').length,
    pending: 0,
    failed: rows.filter((r) => r.status === 'error').length,
    providerUsageSamples: rows.length,
    estimatedUsageSamples: 0,
    missingUsageSamples: 0,
    providerInputTokens: total('providerInputTokens'),
    providerOutputTokens: total('providerOutputTokens'),
    cacheReadTokens: total('cacheReadTokens'),
    cacheWriteTokens: total('cacheWriteTokens'),
    savedBytes: total('savedBytes'),
    cacheHitRate: total('providerInputTokens')
      ? total('cacheReadTokens') / total('providerInputTokens')
      : null,
    compactionHints: rows.filter((r) => r.compactHint).length,
    firstSeenAt: rows[0]?.timestamp || null,
    lastSeenAt: rows.at(-1)?.timestamp || null,
  };
}
function stageTotals(rows) {
  const stages = rows.flatMap((t) => t.stages || []);
  return [...new Set(stages.map((s) => s.stage))].map((stage) => {
    const own = stages.filter((s) => s.stage === stage);
    const total = (key) => own.reduce((n, s) => n + (s[key] || 0), 0);
    return {
      stage,
      samples: own.length,
      beforeBytes: total('beforeBytes'),
      afterBytes: total('afterBytes'),
      savedBytes: -total('deltaBytes'),
      applied: own.filter((s) => s.outcome === 'applied').length,
      skipped: own.filter((s) => s.outcome === 'skipped').length,
    };
  });
}
function recordFilter(records, query = new URLSearchParams()) {
  return records
    .filter(
      (r) => !query.get('projectLabel') || r.session.projectLabel === query.get('projectLabel')
    )
    .map((r) => ({
      ...r,
      turns: r.turns.filter(
        (t) =>
          ['provider', 'model', 'connectionId', 'clientTool'].every(
            (k) => !query.get(k) || t[k] === query.get(k)
          ) &&
          (!query.get('from') || t.timestamp >= query.get('from')) &&
          (!query.get('to') || t.timestamp <= query.get('to'))
      ),
    }))
    .filter((r) => r.turns.length);
}
function dimensions(rows) {
  return [...new Set(rows.map((t) => `${t.provider}|${t.model}|${t.connectionId}`))].map((key) => {
    const [provider, model, connectionId] = key.split('|');
    return {
      provider,
      model,
      connectionId,
      ...summarize(
        rows.filter(
          (t) => t.provider === provider && t.model === model && t.connectionId === connectionId
        )
      ),
    };
  });
}
function overviewFor(records) {
  const rows = records.flatMap((r) => r.turns);
  return {
    summary: summarize(rows, records.length),
    sessions: records.map((r) => ({
      ...r.session,
      ...summarize(r.turns),
      firstSeenAt: r.turns[0]?.timestamp,
      lastSeenAt: r.turns.at(-1)?.timestamp,
    })),
    projects: records.map((r) => ({
      projectLabel: r.session.projectLabel,
      sessions: 1,
      attempts: r.turns.length,
    })),
    stages: stageTotals(rows),
    dimensions: dimensions(rows),
    pagination: {
      page: 1,
      pageSize: 25,
      totalItems: records.length,
      totalPages: 1,
      hasPrev: false,
      hasNext: false,
    },
    recording: { rejectedAttempts: 0, lastRejectedAt: null, scope: 'all retained attempts' },
    recordingStartedAt: turns[0].timestamp,
    retentionDays: 45,
    definitions: {},
  };
}
export const contextSummary = summarize(contextRecords[0].turns);
export const contextOverview = overviewFor(contextRecords);
export async function installOperatorFixture(page) {
  const records = structuredClone(contextRecords);
  await page.addInitScript((frame) => {
    const RealEventSource = window.EventSource;
    window.EventSource = class {
      constructor(url) {
        if (!String(url).includes('/api/usage/stream')) return new RealEventSource(url);
        this.readyState = 1;
        this.timer = setTimeout(() => {
          this.onopen?.({});
          this.onmessage?.({ data: JSON.stringify(frame) });
        }, window.__operatorStreamDelayMs ?? 30);
      }
      close() {
        clearTimeout(this.timer);
        this.readyState = 2;
      }
    };
  }, usage);
  const json = (body) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  await page.route('**/api/usage/stream*', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify(usage)}\n\n`,
    })
  );
  await page.route('**/api/system/state*', (r) => r.fulfill(json(state)));
  await page.route('**/api/admin/health', (r) =>
    r.fulfill(json({ uptimeSeconds: 184322, status: 'healthy' }))
  );
  await page.route('**/api/admin/health/detail', (r) =>
    r.fulfill(
      json({
        checks: { connections, database: { status: 'healthy', driver: 'SQLite', latencyMs: 2 } },
      })
    )
  );
  await page.route('**/api/admin/quota', (r) =>
    r.fulfill(
      json({
        snapshots: connections.slice(0, 3).map((c, i) => ({
          connectionId: c.id,
          provider: c.provider,
          windows: [
            {
              scope: 'Requests · 5 hours',
              limit: 1000,
              remaining: [780, 430, 910][i],
              confidence: 'measured',
              resetAt: new Date(Date.parse(NOW) + 3600000).toISOString(),
              observedAt: NOW,
            },
          ],
        })),
      })
    )
  );
  await page.route('**/api/usage/chart*', (r) => r.fulfill(json(chart)));
  await page.route('**/api/providers', (r) => r.fulfill(json({ connections })));
  await page.route('**/api/admin/qualification', (r) => r.fulfill(json({ connections })));
  await page.route('**/api/admin/drain?*', (r) => r.fulfill(json({ connections: [] })));
  await page.route('**/api/context?*', (r) =>
    r.fulfill(json(overviewFor(recordFilter(records, new URL(r.request().url()).searchParams))))
  );
  await page.route('**/api/context/sessions/*', (r) => {
    const url = new URL(r.request().url());
    const record = records.find((s) => s.session.id === Number(url.pathname.split('/').pop()));
    if (!record)
      return r.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'No such session' }),
      });
    if (r.request().method() === 'PATCH') {
      record.session.projectLabel = r.request().postDataJSON().projectLabel;
      return r.fulfill(json({ session: record.session }));
    }
    const filtered = recordFilter([record], url.searchParams)[0]?.turns || [];
    return r.fulfill(
      json({
        session: {
          ...record.session,
          firstSeenAt: record.turns[0].timestamp,
          lastSeenAt: record.turns.at(-1).timestamp,
        },
        summary: summarize(filtered),
        turns: filtered,
        stages: stageTotals(filtered),
        pins: [],
        switches:
          record.session.id === 1
            ? [
                {
                  id: 1,
                  model: 'research',
                  fromConnectionId: 'visual-0',
                  toConnectionId: 'visual-1',
                  trigger: 'quota',
                  reason: 'Connection quota reached',
                  switchedAt: turns[16].timestamp,
                },
              ]
            : [],
        dimensions: dimensions(filtered),
        pagination: {
          page: 1,
          pageSize: 50,
          totalItems: filtered.length,
          totalPages: 1,
          hasPrev: false,
          hasNext: false,
        },
      })
    );
  });
  await page.route('**/api/version', (r) =>
    r.fulfill(json({ currentVersion: '0.0.1', hasUpdate: false }))
  );
}
