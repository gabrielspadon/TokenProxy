export const quotaNumber = (value) =>
  typeof value === 'number' && Number.isFinite(value)
    ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)
    : 'Unknown';
export const quotaTimestamp = (value) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZone: 'UTC',
      })
    : 'Unknown';

export const QUOTA_TREND_EXPLANATIONS = {
  insufficient_samples:
    'At least five distinct observations are needed in the current consumption segment.',
  missing_measurement: 'The latest observation has no usable balance in this unit.',
  inconsistent_measurement: 'A recorded balance conflicts with its reported scale.',
  short_span: 'The current segment covers less than 15 minutes.',
  ambiguous_observations: 'Different values were recorded at the same observation time.',
  unknown_observation_time: 'One or more observations have no source timestamp.',
  future_observation: 'A source timestamp is later than this investigation’s end time.',
  stale: 'The latest observation is too old for this observed cadence.',
  observation_gap: 'The current segment contains a gap longer than four typical intervals.',
  rolling_replenishment_unknown: 'Rolling-window replenishment is not modeled by this scenario.',
  reset_elapsed:
    'The recorded reset deadline passed without sufficiently current replacement evidence.',
  no_observed_consumption:
    'The median observed consumption rate is zero; no finite exhaustion time is supported.',
  not_observed: 'These records are not identified as actual quota observations.',
  unrepresentable_horizon:
    'The observed rate projects beyond the supported date range; no dated exhaustion estimate can be shown.',
};

export function quotaWorkbenchUrl(scope, connectionId, anchor) {
  const params = new URLSearchParams({ connectionId });
  if (scope.provider) params.set('provider', scope.provider);
  if (scope.start) params.set('start', scope.start);
  params.set('end', scope.end || new Date(anchor).toISOString());
  return `/api/admin/quota/workbench?${params}`;
}

export function quotaChecksUrl(analysisUrl, page = 1, eventType = null) {
  const params = new URLSearchParams(analysisUrl.split('?')[1]);
  if (!params.has('start')) params.set('start', '1970-01-01T00:00:00.000Z');
  params.set('kind', 'checks');
  params.set('page', String(page));
  params.set('pageSize', '10');
  if (eventType) params.set('eventType', eventType);
  return `/api/admin/quota/history?${params}`;
}

export function quotaObservationOption(series, selectedId, zoom) {
  const points = series.points.filter(
    (point) =>
      point.observedAt &&
      Number.isFinite(Date.parse(point.observedAt)) &&
      typeof point.value === 'number' &&
      Number.isFinite(point.value)
  );
  const times = points.map((point) => Date.parse(point.observedAt));
  const start = times.length ? Math.min(...times) : 0,
    end = times.length ? Math.max(...times) : 1;
  return {
    animation: false,
    grid: { left: 65, right: 18, top: 16, bottom: 64 },
    tooltip: {
      trigger: 'item',
      renderMode: 'richText',
      formatter: (event) =>
        `${quotaTimestamp(event.data?.observedAt)} UTC\n${quotaNumber(event.data?.value?.[1])} ${series.analysis.unit || 'unknown units'}`,
    },
    xAxis: {
      type: 'time',
      min: start,
      max: end === start ? end + 1000 : end,
      axisLabel: {
        hideOverlap: true,
        formatter: (value) => new Date(value).toISOString().slice(5, 16).replace('T', ' '),
      },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      min: series.measurement === 'percentage' ? 0 : undefined,
      max: series.measurement === 'percentage' ? 100 : undefined,
      axisLabel: { formatter: (value) => quotaNumber(value) },
      splitLine: { lineStyle: { color: '#e9edf4' } },
    },
    dataZoom: [
      {
        type: 'slider',
        bottom: 5,
        height: 20,
        showDetail: false,
        ...(zoom ? { startValue: zoom[0], endValue: zoom[1] } : { start: 0, end: 100 }),
      },
    ],
    series: [
      {
        type: 'scatter',
        name: series.analysis.unit,
        symbolSize: (value, event) => (event.data.id === selectedId ? 11 : 6),
        data: points.map((point) => ({
          id: point.id,
          observedAt: point.observedAt,
          value: [Date.parse(point.observedAt), point.value],
          itemStyle: { color: point.id === selectedId ? '#455bca' : '#527b9a' },
        })),
      },
    ],
  };
}

export function observationZoom(event, series) {
  const bounds = event.batch?.[0] || event;
  if (typeof bounds.startValue === 'number' && typeof bounds.endValue === 'number')
    return [bounds.startValue, bounds.endValue];
  const times = series.points
    .filter((point) => point.observedAt && Number.isFinite(Date.parse(point.observedAt)))
    .map((point) => Date.parse(point.observedAt));
  if (!times.length || !Number.isFinite(bounds.start) || !Number.isFinite(bounds.end)) return null;
  const minimum = Math.min(...times),
    span = Math.max(...times) - minimum;
  return [minimum + (span * bounds.start) / 100, minimum + (span * bounds.end) / 100];
}
