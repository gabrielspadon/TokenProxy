// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EconomicsTrend } from '../../src/shared/components/workspace/EconomicsTimeChart';

const chart = vi.hoisted(() => ({ props: null }));
vi.mock('@/shared/workspace/AnalyticalChart', () => ({
  METRIC_COLORS: { input: '#5367ad', cacheRead: '#8454a0', cacheWrite: '#925c0b', output: '#52606d', selected: '#006f78' },
  AnalyticalChart: props => { chart.props = props; return <div aria-label={props.label} />; },
}));
let root, container;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it('keeps isolated observations visible after twenty rows while preserving unknown gaps', () => {
  const start = Date.parse('2026-09-07T10:00:00Z');
  const points = Array.from({ length: 24 }, (_, index) => ({
    bucketStartMs: start + index * 240000, bucketStart: new Date(start + index * 240000).toISOString(),
    records: 1, costSamples: 1, recordedCostUsd: index === 0 ? 0 : 0.02, outputSamples: 1, outputTokens: 250,
  }));
  act(() => root.render(<MantineProvider env="test"><EconomicsTrend data={{ series: { points, bucketMs: 60000 } }} /></MantineProvider>));
  const series = chart.props.option.series[0];
  expect(series.showSymbol).toBe(true);
  expect(series.connectNulls).toBe(false);
  expect(series.data.filter(point => point[1] !== null)).toHaveLength(24);
  expect(series.data[0][1]).toBe(0);
  expect(series.data[1][1]).toBeNull();
  expect(chart.props.option.title[0].text).toBe('Recorded amount · USD');
  const formatUsdTick = chart.props.option.yAxis[0].axisLabel.formatter;
  expect([0, 0.005, 0.01, 0.015].map(formatUsdTick)).toEqual(['$0', '$0.005', '$0.01', '$0.015']);
  expect([0.000005, 0.00001, 0.00002].map(formatUsdTick)).toEqual(['$5E-6', '$1E-5', '$2E-5']);
  expect([1000, 1500, 1000000].map(formatUsdTick)).toEqual(['$1K', '$1.5K', '$1M']);
  expect([-0.005, -0.00001].map(formatUsdTick)).toEqual(['$-0.005', '$-1E-5']);
  const tooltip = chart.props.option.tooltip.formatter;
  expect(tooltip([{ seriesIndex: 0, data: series.data[0], value: series.data[0] }])).toContain('$0.00 USD (1/1 samples)');
  expect(tooltip([{ seriesIndex: 0, data: series.data[1], value: series.data[1] }])).toBe('No recorded observations in this interval');
  const tinyPoint = [start, 0.000005, { bucketStartMs: start, costSamples: 1, records: 1 }];
  expect(tooltip([{ seriesIndex: 0, data: tinyPoint, value: tinyPoint }])).toContain('<$0.0001 USD (1/1 samples)');
});
