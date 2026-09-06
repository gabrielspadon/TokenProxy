'use client';
import { useMemo } from 'react';
import { Button, Table } from '@mantine/core';
import { AnalyticalChart, METRIC_COLORS } from '@/shared/workspace/AnalyticalChart';
import { bucketScope, quantity, signedBytes, trendOption, utc } from './contextModel';
import styles from './context.module.css';

export function ContextTracks({ trend, scope, onScope }) {
  const option = useMemo(() => trendOption(trend, METRIC_COLORS, scope), [trend, scope]);
  const points = trend?.points || [];
  const focus = (point) => { const next = point && bucketScope(point, trend.bucketMs, scope); if (next) onScope(next); };
  if (!points.length) return <p className={styles.emptyInline}>No time buckets were recorded in this session selection.</p>;
  return <section className={styles.tracks} aria-label="Session evidence tracks">
    <div className={styles.trackHeading}><h3>Context evolution</h3><span>{quantity(points.length)} occupied buckets · all filtered attempts</span></div>
    <div className={styles.trackCanvas}><div className={styles.trackLabels}><span><i style={{ background: METRIC_COLORS.selected }} />Peak estimate<small>tokens / bucket</small></span><span><i style={{ background: METRIC_COLORS.input }} />Input / cache read<small>provider tokens</small></span><span><i style={{ background: '#8291ae' }} />Body reduction<small>signed byte sum</small></span></div><AnalyticalChart option={option} height={150} label="Context estimates, provider input and cache reads, and signed body reduction across all filtered session attempts. Empty intervals are omitted. Select a bucket to focus the shared time range." onEvents={{ click: (event) => focus(points[event.dataIndex]) }} /></div>
    <div className={styles.trackNote}><span>Input includes cache. Missing samples stay unknown. Points do not represent active duration.</span><span><i style={{ background: METRIC_COLORS.cacheRead }} />Cache read</span></div>
    <details className={styles.bucketTable}><summary>Read bucket values or focus an interval</summary><Table.ScrollContainer minWidth={650} type="native"><Table className={styles.table} aria-label="Full session time buckets"><Table.Thead><Table.Tr><Table.Th>Bucket · UTC</Table.Th><Table.Th>Attempts</Table.Th><Table.Th>Peak estimate</Table.Th><Table.Th>Input</Table.Th><Table.Th>Cache read</Table.Th><Table.Th>Body reduction</Table.Th><Table.Th>Shared range</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{points.map((point) => <Table.Tr key={point.bucketStart}><Table.Td>{utc(point.bucketStart)}</Table.Td><Table.Td>{quantity(point.attempts)}</Table.Td><Table.Td>{quantity(point.maxContextEstimate)}</Table.Td><Table.Td>{quantity(point.providerInputTokens)}</Table.Td><Table.Td>{quantity(point.cacheReadTokens)}</Table.Td><Table.Td>{signedBytes(point.savedBytes)}</Table.Td><Table.Td><Button size="compact-xs" variant="subtle" onClick={() => focus(point)} aria-label={`Focus interval ${utc(point.bucketStart)} UTC`}>Focus interval</Button></Table.Td></Table.Tr>)}</Table.Tbody></Table></Table.ScrollContainer><p className={styles.footnote}>Each bucket is {quantity(trend.bucketMs / 1000)} seconds wide. Only occupied intervals are returned, at most 120. Positive reduction means a smaller body.</p></details>
  </section>;
}
