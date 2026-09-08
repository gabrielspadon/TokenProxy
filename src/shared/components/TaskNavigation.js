'use client';
import { Button } from '@mantine/core';
import { Icon } from './Icon';
import styles from './taskNavigation.module.css';

export function TaskNavigation({ label, value, onChange, items }) {
  return <nav className={styles.tasks} aria-label={label}>
    {items.map(item => <Button key={item.value} size="compact-sm" variant={value === item.value ? 'light' : 'subtle'}
      aria-pressed={value === item.value} onClick={() => onChange(item.value)}
      leftSection={item.icon ? <Icon name={item.icon} /> : undefined}>{item.label}</Button>)}
  </nav>;
}
