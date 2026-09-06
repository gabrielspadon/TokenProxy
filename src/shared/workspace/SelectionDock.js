'use client';
import { ActionIcon } from '@mantine/core';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { Icon } from '@/shared/components/Icon';
import styles from './workspace.module.css';

export function SelectionDock({
  children,
  open,
  title,
  subtitle,
  mark,
  onClose,
  detail,
  height = 'calc(100dvh - 328px)',
}) {
  return (
    <Group orientation="vertical" style={{ height, minHeight: 380 }}>
      <Panel id="workspace-main" defaultSize={open ? '62%' : '100%'} minSize="25%">
        {children}
      </Panel>
      {open && (
        <>
          <Separator className={styles.resizeHandle} aria-label="Resize detail panel" />
          <Panel id="workspace-detail" defaultSize="38%" minSize="22%">
            <aside className={styles.selectionDock} aria-label="Selection details">
              <div className={styles.dockHead}>
                <div className={styles.dockHeading}>
                  {mark}
                  <div>
                    <h2>{title}</h2>
                    {subtitle && <p>{subtitle}</p>}
                  </div>
                </div>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  aria-label="Close selection details"
                  onClick={onClose}
                >
                  <Icon name="i-close" />
                </ActionIcon>
              </div>
              {detail}
            </aside>
          </Panel>
        </>
      )}
    </Group>
  );
}
