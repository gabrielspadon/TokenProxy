'use client';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ActionIcon } from '@mantine/core';
import { useElementSize, useMediaQuery, useMounted } from '@mantine/hooks';
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
  closedMaxHeight,
  minimumComparisonWidth = 760,
}) {
  const desktop = useMediaQuery('(min-width: 90em)');
  const { ref: containerRef, width } = useElementSize();
  const wide = width > 0 ? width >= minimumComparisonWidth + 388 : desktop;
  const mounted = useMounted();
  const detailTarget = useMemo(() => mounted ? document.createElement('div') : null, [mounted]);
  const detailFocus = useRef(null);
  // A stable portal target preserves draft state while the layout changes its host.
  const attachDetail = useCallback((host) => {
    if (!host || !detailTarget) return;
    host.appendChild(detailTarget);
    const retained = detailFocus.current;
    if (retained?.element.isConnected) {
      retained.element.focus({ preventScroll: true });
      if (typeof retained.start === 'number') retained.element.setSelectionRange(retained.start, retained.end);
    }
    return () => {
      const element = document.activeElement;
      if (detailTarget.contains(element)) {
        detailFocus.current = { element, start: element.selectionStart, end: element.selectionEnd };
      }
    };
  }, [detailTarget]);
  const scrollIntoView = useCallback((node) => {
    node?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  const origin = useRef(null);
  const previousOpen = useRef(false);
  useEffect(() => {
    if (open && !previousOpen.current) origin.current = document.activeElement;
    if (!open && previousOpen.current && origin.current?.isConnected) origin.current.focus();
    previousOpen.current = open;
  }, [open, wide]);
  const heading = <div className={styles.dockHeading}>{mark}<div>
    <h2>{title}</h2>{subtitle && <p>{subtitle}</p>}
  </div></div>;
  const inventory = <div role="region" aria-label="Inventory comparison" tabIndex={0}
    className={styles.inventoryRegion} style={{ maxHeight: closedMaxHeight }}>{children}</div>;
  return <div ref={containerRef} className={styles.dockViewport} data-open={open || undefined}>
    <Group orientation="horizontal" className={styles.inspectorGroup} style={{ height: wide && open ? height : undefined, minHeight: wide && open && height !== '100%' ? 420 : 0 }}>
      <Panel id="workspace-main" minSize={wide && open ? `${minimumComparisonWidth}px` : 0}>
        {inventory}
      </Panel>
      {wide && open && (
        <>
          <Separator className={styles.resizeHandle} aria-label="Resize detail panel" />
          <Panel id="workspace-detail" defaultSize="380px" minSize="320px" maxSize="45%">
            <aside className={styles.selectionDock} aria-label="Selection details">
              <div className={styles.dockHead}>
                {heading}
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  aria-label="Close selection details"
                  onClick={onClose}
                >
                  <Icon name="i-close" />
                </ActionIcon>
              </div>
              <div ref={attachDetail} />
            </aside>
          </Panel>
        </>
      )}
    </Group>
    {!wide && open && (
      // Below the comparison width the detail stacks under the inventory as
      // a full-width section, never a drawer: no layer, same page, scrolled
      // into view with its own close control.
      <aside className={styles.selectionDock} data-stacked aria-label="Selection details" ref={scrollIntoView}>
        <div className={styles.dockHead}>
          {heading}
          <ActionIcon variant="subtle" color="gray" aria-label="Close selection details" onClick={onClose}>
            <Icon name="i-close" />
          </ActionIcon>
        </div>
        <div ref={attachDetail} />
      </aside>
    )}
    {open && detailTarget && createPortal(detail, detailTarget)}
  </div>;
}
