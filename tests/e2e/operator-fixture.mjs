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
    { provider: 'anthropic', model: 'claude-opus-4-6', status: 'active', startedAt: NOW },
    { provider: 'openai', model: 'gpt-5.4', status: 'active', startedAt: NOW },
    { provider: 'anthropic', model: 'claude-opus-4-6', status: 'active', startedAt: NOW },
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
export const contextSummary = {
  attempts: 24,
  requests: 24,
  sessions: 3,
  succeeded: 23,
  pending: 0,
  failed: 1,
  providerUsageSamples: 24,
  estimatedUsageSamples: 0,
  missingUsageSamples: 0,
  providerInputTokens: 915600,
  providerOutputTokens: 21024,
  cacheReadTokens: 702000,
  cacheWriteTokens: 11000,
  savedBytes: 167880,
  cacheHitRate: 0.7667,
  compactionHints: 1,
  firstSeenAt: turns[0].timestamp,
  lastSeenAt: NOW,
};
export const contextOverview = {
  summary: contextSummary,
  sessions: [
    {
      id: 1,
      projectLabel: 'OceanStack',
      identitySource: 'routing',
      clientTool: 'Claude Code',
      firstSeenAt: turns[0].timestamp,
      lastSeenAt: NOW,
      attempts: 24,
      requests: 24,
      providerInputTokens: 915600,
      savedBytes: 167880,
    },
    {
      id: 2,
      projectLabel: 'TokenProxy',
      identitySource: 'routing',
      clientTool: 'Codex',
      firstSeenAt: turns[0].timestamp,
      lastSeenAt: NOW,
      attempts: 18,
      requests: 18,
      providerInputTokens: 615000,
      savedBytes: 88200,
    },
    {
      id: 3,
      projectLabel: null,
      identitySource: 'request',
      clientTool: 'API client',
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      attempts: 1,
      requests: 1,
      providerInputTokens: 2150,
      savedBytes: 0,
    },
  ],
  projects: [
    { projectLabel: 'OceanStack', sessions: 1, attempts: 24 },
    { projectLabel: 'TokenProxy', sessions: 1, attempts: 18 },
    { projectLabel: null, sessions: 1, attempts: 1 },
  ],
  stages,
  dimensions: [],
  pagination: {
    page: 1,
    pageSize: 50,
    totalPages: 1,
    totalItems: 3,
    hasNext: false,
    hasPrev: false,
  },
  recordingStartedAt: turns[0].timestamp,
  retentionDays: 45,
  definitions: {},
};
contextSummary.providerInputTokens = turns.reduce((n, t) => n + t.providerInputTokens, 0);
contextSummary.providerOutputTokens = turns.reduce((n, t) => n + t.providerOutputTokens, 0);
contextSummary.cacheReadTokens = turns.reduce((n, t) => n + (t.cacheReadTokens || 0), 0);
contextSummary.savedBytes = turns.reduce((n, t) => n + t.savedBytes, 0);
contextSummary.cacheHitRate = contextSummary.cacheReadTokens / contextSummary.providerInputTokens;
contextOverview.sessions[0].providerInputTokens = contextSummary.providerInputTokens;
contextOverview.sessions[0].savedBytes = contextSummary.savedBytes;
contextOverview.summary = {
  ...contextSummary,
  requests: 43,
  attempts: 43,
  providerUsageSamples: 43,
  providerInputTokens: contextSummary.providerInputTokens + 617150,
  savedBytes: contextSummary.savedBytes + 88200,
};
contextOverview.dimensions = PROVIDERS.map((provider) => ({ provider }));
export async function installOperatorFixture(page) {
  await page.addInitScript((frame) => {
    const RealEventSource = window.EventSource;
    window.EventSource = class {
      constructor(url) {
        if (!String(url).includes('/api/usage/stream')) return new RealEventSource(url);
        this.readyState = 1;
        this.timer = setTimeout(() => {
          this.onopen?.({});
          this.onmessage?.({ data: JSON.stringify(frame) });
        }, 30);
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
  await page.route('**/api/context?*', (r) => r.fulfill(json(contextOverview)));
  await page.route('**/api/context/sessions/*', (r) =>
    r.fulfill(
      json({
        session: {
          id: Number(new URL(r.request().url()).pathname.split('/').pop()),
          projectLabel: 'OceanStack',
          identitySource: 'routing',
          firstSeenAt: turns[0].timestamp,
          lastSeenAt: NOW,
        },
        summary: contextSummary,
        turns,
        stages,
        pins: [],
        switches: [
          {
            id: 1,
            model: 'research',
            fromConnectionId: 'visual-0',
            toConnectionId: 'visual-1',
            trigger: 'quota',
            reason: 'Connection quota reached',
            switchedAt: turns[16].timestamp,
          },
        ],
        dimensions: [],
        pagination: {
          page: 1,
          pageSize: 50,
          totalItems: 24,
          totalPages: 1,
          hasPrev: false,
          hasNext: false,
        },
      })
    )
  );
  await page.route('**/api/version', (r) =>
    r.fulfill(json({ currentVersion: '0.0.1', hasUpdate: false }))
  );
}
