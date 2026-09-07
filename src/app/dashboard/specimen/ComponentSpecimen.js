'use client';
import { useState } from 'react';
import { Alert, Badge, Button, Checkbox, Group, Loader, Menu, Paper, Select, Stack, Table, Tabs, Text, TextInput, Tooltip } from '@mantine/core';
import { ProviderMark } from '@/shared/components/ProviderMark';
import { Icon } from '@/shared/components/Icon';
import { AnalyticalChart, METRIC_COLORS } from '@/shared/workspace/AnalyticalChart';
import { SelectionDock } from '@/shared/workspace/SelectionDock';
import styles from './specimen.module.css';

const ACCOUNTS = [
  { id: 'example-team', provider: 'claude', name: 'Research team · primary', state: 'Available', quota: '62%', cost: '$12.40' },
  { id: 'example-personal', provider: 'openai', name: 'Personal account with a deliberately long descriptive name', state: 'Constrained', quota: '8%', cost: '$3.08' },
  { id: 'example-custom', provider: 'custom-example', name: 'Custom endpoint', state: 'Unknown', quota: 'Unknown', cost: 'Unknown' },
];
const CHART = {
  grid: { left: 40, right: 20, top: 16, bottom: 32 },
  xAxis: { type: 'category', data: ['09:00', '10:00', '11:00'] },
  yAxis: { type: 'value', name: 'Requests', minInterval: 1 },
  series: [{ type: 'bar', name: 'Completed requests', data: [4, 7, 5], itemStyle: { color: METRIC_COLORS.input }, barMaxWidth: 36 }],
  tooltip: { trigger: 'axis' },
};

export default function ComponentSpecimen() {
  const [selection, setSelection] = useState(null);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);
  return <Stack gap="lg" className={styles.page}>
    <header><Text c="dimmed" mb={8}>Workspace design system</Text><h1>Component specimen</h1>
      <p className={styles.intro}>Production components and explicit example states. These examples are synthetic and do not change gateway settings.</p></header>
    <Paper withBorder p="lg"><h2>Typography and measurement</h2><Group align="flex-start" gap="xl" mt="md">
      <div><Text fw={500}>Account capacity</Text><Text c="dimmed">A label and its explanation</Text></div>
      <div><Text className={styles.value}>12,486</Text><Text c="dimmed">Provider-reported input tokens</Text></div>
      <div><Text className={styles.code}>attempt-example-001</Text><Text c="dimmed">Exact synthetic identifier</Text></div>
    </Group></Paper>
    <Paper withBorder p="lg"><h2>Actions and feedback</h2><Group mt="md">
      <Button onClick={() => setSaved(true)}>Save example</Button><Button variant="default" onClick={() => setSaved(false)}>Reset example</Button>
      <Button variant="subtle">Quiet action</Button><Button color="red" variant="outline" onClick={() => setError(true)}>Show failure</Button>
      <Button loading>Saving example</Button><Tooltip label="No account is selected"><span tabIndex={0}><Button disabled>Drain account</Button></span></Tooltip>
      <Menu><Menu.Target><Button variant="default" rightSection={<Icon name="i-chevron-down" />}>More actions</Button></Menu.Target>
        <Menu.Dropdown><Menu.Item onClick={() => setSaved(true)}>Show saved state</Menu.Item><Menu.Item onClick={() => setError(true)}>Show failed state</Menu.Item></Menu.Dropdown></Menu>
    </Group>{saved && <Alert color="teal" mt="md" role="status">The example state changed in this page only.</Alert>}
    {error && <Alert color="red" mt="md" role="alert" withCloseButton onClose={() => setError(false)}>The example save was refused. Entered values remain available for correction.</Alert>}</Paper>
    <Paper withBorder p="lg"><h2>Fields and validation</h2><div className={styles.fields}>
      <TextInput label="Account label" defaultValue="Research team" description="Visible to this operator workspace." />
      <Select label="Priority" data={['Normal', 'High', 'Low']} defaultValue="Normal" />
      <TextInput label="Invalid example" defaultValue="" error="Enter a name before saving." />
      <Checkbox label="Apply to subsequent requests" description="In-flight work remains on its current account." />
    </div></Paper>
    <Paper withBorder p="lg"><h2>States and tabs</h2><Group mt="md"><Badge color="green">Available</Badge><Badge color="yellow">Constrained</Badge><Badge color="red">Failed</Badge><Badge color="gray">Unknown</Badge><Badge color="petrol">Selected</Badge></Group>
      <Tabs defaultValue="empty" mt="md"><Tabs.List><Tabs.Tab value="empty">Empty</Tabs.Tab><Tabs.Tab value="loading">Loading</Tabs.Tab><Tabs.Tab value="failure">Failure</Tabs.Tab></Tabs.List>
        <Tabs.Panel value="empty" pt="md"><Text>No retained observations in this period. Extend the period or inspect the account configuration.</Text></Tabs.Panel>
        <Tabs.Panel value="loading" pt="md"><Group role="status"><Loader size="sm" /><Text>Reading retained observations…</Text></Group></Tabs.Panel>
        <Tabs.Panel value="failure" pt="md"><Alert color="red">Observations could not be refreshed. Previously displayed evidence retains its original observation time.</Alert></Tabs.Panel>
      </Tabs></Paper>
    <Paper withBorder p="lg"><h2>Account comparison and inspector</h2><Text c="dimmed" mb="md">Select an example account. Wide views retain the comparison; compact views provide a full-width detail and return.</Text>
      <SelectionDock open={Boolean(selection)} title={selection?.name} subtitle="Synthetic account evidence" onClose={() => setSelection(null)} height="460px"
        mark={selection && <ProviderMark provider={selection.provider} />} detail={<div className={styles.inspection}><Text>Quota and cost have separate units and sources.</Text><Text mt="md">Reported quota remaining <strong>{selection?.quota}</strong></Text><Text mt="md">Recorded estimate <strong>{selection?.cost}</strong></Text></div>}>
        <Table.ScrollContainer minWidth={560} type="native"><Table><Table.Thead><Table.Tr><Table.Th>Account</Table.Th><Table.Th>Status</Table.Th><Table.Th ta="right">Quota</Table.Th><Table.Th ta="right">Recorded estimate</Table.Th></Table.Tr></Table.Thead>
          <Table.Tbody>{ACCOUNTS.map(account => <Table.Tr key={account.id} data-selected={selection?.id === account.id || undefined} className={styles.row}>
            <Table.Td><Group wrap="nowrap"><ProviderMark provider={account.provider} /><button className={styles.accountButton} aria-pressed={selection?.id === account.id} onClick={() => setSelection(account)}>{account.name}</button></Group></Table.Td>
            <Table.Td>{account.state}</Table.Td><Table.Td ta="right">{account.quota}</Table.Td><Table.Td ta="right">{account.cost}</Table.Td>
          </Table.Tr>)}</Table.Tbody></Table></Table.ScrollContainer>
      </SelectionDock></Paper>
    <Paper withBorder p="lg"><h2>Chart and data equivalent</h2><Text c="dimmed">Synthetic completed request counts, three hourly observations on 7 September 2026, UTC. The chart does not claim live traffic.</Text>
      <AnalyticalChart option={CHART} height={210} label="Synthetic requests, 09:00 four, 10:00 seven, 11:00 five" />
      <Text>09:00 · 4 requests &nbsp; 10:00 · 7 requests &nbsp; 11:00 · 5 requests</Text></Paper>
  </Stack>;
}
