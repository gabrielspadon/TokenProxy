'use client';
import { Badge, Button, Group, ScrollArea, Table, Tabs, Text } from '@mantine/core';
import styles from './compatibility.module.css';

const label = format => ({ openai: 'OpenAI chat', claude: 'Claude', gemini: 'Gemini', 'openai-responses': 'Responses' })[format] || format;
const measured = (value, digits = 0) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: digits }) : 'Unknown';
function JsonView({ title, value }) { return <section className={styles.jsonPanel}><h3>{title}</h3><ScrollArea h={390} type="auto" viewportProps={{ tabIndex: 0, role: 'region', 'aria-label': title }}><pre className={styles.json}>{JSON.stringify(value, null, 2)}</pre></ScrollArea></section>; }
export function CompatibilityResult({ packet, onExport, onCancel }) {
  if (!packet) return <div className={styles.empty}><h3>Select a retained run</h3><p>Its exact fixture revision, converted content and local checks appear here. No earlier request is replayed.</p></div>;
  const { run, result = run.result } = packet;
  return <section className={styles.result} aria-label="Selected compatibility run">
    <Group justify="space-between"><div><h2>Run evidence</h2><Text size="sm">{packet.fixture.name} · revision {run.fixtureRevision}</Text></div><Group><Badge color={run.status === 'succeeded' ? 'teal' : run.status === 'failed' ? 'red' : 'gray'} variant="light">{run.status === 'succeeded' ? 'Local checks passed' : run.status}</Badge>{['queued', 'running'].includes(run.status) ? <Button size="xs" color="red" variant="light" onClick={onCancel}>Cancel run</Button> : <Button size="xs" variant="default" onClick={onExport}>Export this run</Button>}</Group></Group>
    <Text size="sm" className={styles.muted}>Local translation only. Provider calls 0 · upstream readiness unknown.</Text>
    {run.error && <p role="alert" className={styles.warning}>{run.error.message}</p>}
    {!result ? <p className={styles.empty}>{['queued', 'running'].includes(run.status) ? 'Waiting for this exact local run to return. You can cancel it.' : 'No conversion result was returned. The terminal receipt is retained.'}</p> : <>
      <div className={styles.route}><span>{label(result.sourceFormat)}</span><span aria-hidden="true">→</span><strong>{result.route.mode === 'pivot' ? 'OpenAI pivot' : result.route.mode === 'passthrough' ? 'Same-format normalization' : 'Direct translator'}</strong><span aria-hidden="true">→</span><span>{label(result.targetFormat)}</span></div>
      <div className={styles.metrics}><span>Input <b>{measured(result.quantities?.inputBytes)} B</b></span><span>Output <b>{measured(result.quantities?.outputBytes)} B</b></span><span>Translator <b>{measured(result.quantities?.translatorDurationMs, 2)} ms</b></span>{result.operation === 'stream' && <span>Events <b>{measured(result.quantities?.inputEvents)} → {measured(result.quantities?.outputEvents)}</b></span>}</div>
      <Tabs defaultValue="checks" keepMounted={false}>
        <Tabs.List aria-label="Local run evidence views"><Tabs.Tab value="checks">Checks</Tabs.Tab><Tabs.Tab value="content">Input and output</Tabs.Tab><Tabs.Tab value="receipt">Receipt</Tabs.Tab></Tabs.List>
        <Tabs.Panel value="checks" pt="sm"><Table.ScrollContainer minWidth={520} scrollAreaProps={{ viewportProps: { tabIndex: 0, role: 'region', 'aria-label': 'Local check results' } }}><Table><Table.Thead><Table.Tr><Table.Th>Check</Table.Th><Table.Th>Result</Table.Th><Table.Th>What this establishes</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{result.checks.map(check => <Table.Tr key={check.id}><Table.Td>{check.label}</Table.Td><Table.Td><span className={check.outcome === 'passed' ? styles.passed : check.outcome === 'failed' ? styles.failed : styles.muted}>{check.outcome}</span></Table.Td><Table.Td>{check.basis}</Table.Td></Table.Tr>)}</Table.Tbody></Table></Table.ScrollContainer><p className={styles.muted}>These structural checks do not establish semantic equivalence or full provider schema acceptance. Byte differences are measured serialized JSON size, not token or cost savings.</p><details><summary>Structural differences</summary><pre className={styles.json}>{JSON.stringify(result.comparison, null, 2)}</pre></details></Tabs.Panel>
        <Tabs.Panel value="content" pt="sm"><div className={styles.jsonGrid}><JsonView title="Retained input" value={result.input}/><JsonView title="Translated output" value={result.output}/></div></Tabs.Panel>
        <Tabs.Panel value="receipt" pt="sm"><dl className={styles.receipt}><dt>Run ID</dt><dd>{run.id}</dd><dt>Fixture hash</dt><dd>{run.fixtureHash}</dd><dt>Created</dt><dd>{run.createdAt}</dd><dt>Finished</dt><dd>{run.finishedAt || 'Not finished'}</dd><dt>Implementation</dt><dd>{run.implementationVersion}</dd><dt>Scope</dt><dd>Installation operator · local translation</dd></dl><p className={styles.muted}>This packet includes one exact run and its fixture revision. It contains explicitly submitted test content; inspect before sharing.</p></Tabs.Panel>
      </Tabs>
    </>}
  </section>;
}
