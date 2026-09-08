'use client';
import { useState } from 'react';
import { Tabs } from '@mantine/core';
import { useRouter, useSearchParams } from 'next/navigation';
import PricingEditor from './PricingEditor';
import BudgetReservations from './BudgetReservations';
import styles from './EconomicsTools.module.css';

export default function EconomicsTools({ children, filters, filterCount = 0 }) {
  const router = useRouter(), params = useSearchParams();
  const selected = params?.get('tool');
  const tool = ['filters', 'pricing', 'budgets'].includes(selected) ? selected : 'analysis';
  const [visited, setVisited] = useState(() => [tool]);
  if (!visited.includes(tool)) setVisited(previous => [...previous, tool]);
  const setTool = value => {
    const query = new URLSearchParams(window.location.search);
    if (value !== 'analysis') query.set('tool', value); else query.delete('tool');
    router.replace(`/dashboard/usage${query.size ? `?${query}` : ''}`, { scroll: false });
  };
  return <Tabs className={styles.tasks} value={tool} onChange={setTool}>
    <Tabs.List aria-label="Economics tasks"><Tabs.Tab value="analysis">Analysis</Tabs.Tab><Tabs.Tab value="filters">Identity filters{filterCount ? ` (${filterCount})` : ''}</Tabs.Tab><Tabs.Tab value="pricing">Pricing</Tabs.Tab><Tabs.Tab value="budgets">Budget reservations</Tabs.Tab></Tabs.List>
    <Tabs.Panel className={styles.analysisPanel} value="analysis">{children}</Tabs.Panel>
    <Tabs.Panel className={styles.taskPanel} value="filters">{filters}</Tabs.Panel>
    <Tabs.Panel className={styles.taskPanel} value="pricing">{visited.includes('pricing') && <PricingEditor />}</Tabs.Panel>
    <Tabs.Panel className={styles.taskPanel} value="budgets">{visited.includes('budgets') && <BudgetReservations />}</Tabs.Panel>
  </Tabs>;
}
