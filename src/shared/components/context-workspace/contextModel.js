export const STAGES = [
  ['tools', 'Tool disclosure'], ['schema', 'Schema distillation'],
  ['thinking', 'Thinking blocks'], ['rtk', 'Tool result reducer'],
  ['privacy', 'Privacy filtering'], ['inject', 'Prompt instructions'],
  ['pxpipe', 'Visual conversion'], ['mem', 'History shaping'],
  ['headroom', 'Headroom'], ['qac', 'Query-aware compression'],
  ['pairs', 'Pair pruning'], ['reorder', 'Message reorder'],
  ['midinject', 'Boundary note'], ['diet', 'Expired result pruning'], ['lingua', 'Selective prose compression'],
  ['epochMicro', 'Boundary-aware clearing'], ['epochAuto', 'Boundary-aware summary'], ['final', 'Final normalization'],
];
export const IDENTITY = {
  explicit: 'Explicit session', inferred: 'Inferred locality',
  routing: 'Routing identity', request: 'Request-only identity',
};
export const IDENTITY_NOTE = {
  explicit: 'Stable client session evidence. A session does not prove a distinct agent.',
  inferred: 'Content-derived routing locality may combine separate agents or requests.',
  routing: 'Routing identity is recorded; its original source is unknown.',
  request: 'Only this request is identified. No conversation continuity is asserted.',
};
export const CONTROLS = {
  rtk: 'Tool result reducer', schema: 'Schema distillation', thinking: 'Thinking blocks',
  privacy: 'Privacy filtering', caveman: 'Caveman', ponytail: 'Ponytail', pxpipe: 'Visual conversion',
  memory: 'History shaping', headroom: 'Headroom', qac: 'Query-aware compression',
  pairs: 'Pair pruning', reorder: 'Message reorder', midinject: 'Boundary note',
  clientOptOut: 'Client opt-out', rtkAllowLossy: 'Lossy tool results allowed',
  schemaAllowLossy: 'Lossy schemas allowed', headroomAllowLossy: 'Lossy Headroom allowed',
  pxpipeAllowLossy: 'Visual conversion allowed',
  contextStructure: 'Structure measurement', epochMicro: 'Boundary-aware clearing', epochAuto: 'Boundary-aware summary',
  diet: 'Expired result pruning', lingua: 'Selective prose compression', adaptiveCacheTtl: 'Adaptive cache lifetime',
};
export const finite = (value) => typeof value === 'number' && Number.isFinite(value);
export function quantity(value, compact = false) {
  return finite(value) ? new Intl.NumberFormat('en', { notation: compact ? 'compact' : 'standard', maximumFractionDigits: compact ? 1 : 0 }).format(value) : 'Unknown';
}
export function signedBytes(value) {
  return finite(value) ? `${value > 0 ? '+' : ''}${quantity(value)} B` : 'Unknown';
}
export function utc(value, short = false) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return 'Unknown';
  return short ? date.toISOString().slice(11, 19) : date.toISOString().replace('T', ' ').slice(0, 19);
}
export function contextUrl(scope, { sessionId, requestId, page = 1, projectLabel, clientTool } = {}) {
  const query = new URLSearchParams({ page: String(page), pageSize: sessionId ? '25' : '20' });
  for (const key of ['provider', 'model', 'connectionId']) if (scope[key]) query.set(key, scope[key]);
  if (scope.start) query.set('from', scope.start);
  if (scope.end) query.set('until', scope.end);
  if (projectLabel) query.set('projectLabel', projectLabel);
  if (clientTool) query.set('clientTool', clientTool);
  if (requestId) query.set('requestId', requestId);
  return `/api/context${sessionId ? `/sessions/${encodeURIComponent(sessionId)}` : ''}?${query}`;
}
export function bucketScope(point, bucketMs, scope) {
  const start = Math.max(Date.parse(point.bucketStart), scope.start ? Date.parse(scope.start) : -Infinity);
  const end = Math.min(Date.parse(point.bucketStart) + bucketMs, scope.end ? Date.parse(scope.end) : Infinity);
  return Number.isFinite(start) && Number.isFinite(end) && end > start
    ? { period: 'custom', start: new Date(start).toISOString(), end: new Date(end).toISOString() } : null;
}
export function orderedStages(stages = []) {
  return [...stages].sort((a, b) => a.ordinal - b.ordinal);
}
export function compareStageRows(current = [], baseline = []) {
  const rows = new Map();
  for (const [side, stages] of [['baseline', baseline], ['selected', current]]) for (const stage of stages) {
    const key = `${stage.ordinal}:${stage.stage}`;
    const row = rows.get(key) || { key, ordinal: stage.ordinal, stage: stage.stage };
    row[side] = stage; rows.set(key, row);
  }
  return [...rows.values()].sort((a,b)=>a.ordinal-b.ordinal || a.stage.localeCompare(b.stage));
}
export function trendOption(trend, colors, scope, theme = { slate: '#52606D', rule: '#D9E1E7', paper: '#F4F6F8' }) {
  const points = trend?.points || [];
  const spansDates = points.length > 1 && points[0].bucketStart.slice(0,10) !== points.at(-1).bucketStart.slice(0,10);
  const times = points.map(point => Date.parse(point.bucketStart)).filter(Number.isFinite);
  const firstBucket = times.length ? Math.min(...times) : undefined;
  const lastBucket = times.length ? Math.max(...times) + (finite(trend?.bucketMs) && trend.bucketMs > 0 ? trend.bucketMs : 60000) : undefined;
  const data = (key) => points.map((point) => [Date.parse(point.bucketStart), finite(point[key]) ? point[key] : null]);
  const grid = [0, 1, 2].map((i) => ({ left: 57, right: 22, top: 4 + i * 44, height: 26 }));
  const xAxis = grid.map((_, i) => ({ type: 'time', gridIndex: i,
    min: scope.start ? Date.parse(scope.start) : firstBucket,
    max: scope.end ? Date.parse(scope.end) : lastBucket,
    axisLabel: { show: i === 2, hideOverlap: true, color: theme.slate, fontSize: 13, formatter: (value) => spansDates ? utc(value).slice(5,16) : utc(value, true) },
    axisLine: { lineStyle: { color: theme.rule } }, axisTick: { show: false },
    splitLine: { show: true, lineStyle: { color: theme.paper } },
  }));
  const yAxis = grid.map((_, i) => ({ type: 'value', gridIndex: i, splitNumber: 1,
    axisLabel: { color: theme.slate, fontSize: 13, formatter: (value) => quantity(value, true) },
    splitLine: { lineStyle: { color: theme.rule } },
  }));
  return { grid, xAxis, yAxis, useUTC: true, textStyle: { fontFamily: 'Manrope, sans-serif', fontSize: 13, color: theme.slate }, axisPointer: { link: [{ xAxisIndex: 'all' }] },
    tooltip: { trigger: 'axis', renderMode: 'richText', confine: true,
      valueFormatter: (value) => finite(value) ? quantity(value) : 'Unknown' },
    series: [
      { name: 'Peak estimated context · tokens', type: 'scatter', xAxisIndex: 0, yAxisIndex: 0, data: data('maxContextEstimate'), symbolSize: 6, itemStyle: { color: colors.input } },
      { name: 'Provider input · tokens', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: data('providerInputTokens'), barMaxWidth: 16, itemStyle: { color: colors.input } },
      { name: 'Cache read · tokens', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: data('cacheReadTokens'), barMaxWidth: 16, itemStyle: { color: colors.cacheRead } },
      { name: 'Body reduction · signed bytes', type: 'bar', xAxisIndex: 2, yAxisIndex: 2, data: data('savedBytes'), barMaxWidth: 16,
        itemStyle: { color: (item) => item.value[1] < 0 ? colors.cacheWrite : colors.output } },
    ],
  };
}
