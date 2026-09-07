// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SelectionDock } from '@/shared/workspace/SelectionDock';

let root, container, wide = false, observers;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  observers = [];
  vi.stubGlobal('ResizeObserver', class { constructor(callback) { this.callback = callback; observers.push(this); } observe(target) { this.target = target; } unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', vi.fn((query) => ({ matches: query === '(min-width: 90em)' && wide, addEventListener() {}, removeEventListener() {} })));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  wide = false;
  vi.unstubAllGlobals();
});

function Inventory() {
  const [selected, setSelected] = useState(null);
  return <SelectionDock open={Boolean(selected)} height="620px" closedMaxHeight="380px" title={selected} onClose={() => setSelected(null)} detail={<p>Evidence {selected}</p>}>
    <button onClick={() => setSelected('attempt-101')} aria-pressed={selected === 'attempt-101'}>Inspect first</button>
    <button onClick={() => setSelected('attempt-103')} aria-pressed={selected === 'attempt-103'}>Inspect second</button>
  </SelectionDock>;
}

it('keeps closed comparison content-sized in a labelled local scroll region', async () => {
  await act(async () => root.render(<MantineProvider env="test"><Inventory /></MantineProvider>));
  const comparison = container.querySelector('[aria-label="Inventory comparison"]');
  expect(comparison.style.maxHeight).toBe('380px');
  expect(comparison.style.height).toBe('');
  expect(comparison.tabIndex).toBe(0);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('opens a full-width compact detail with an explicit return to the selected comparison', async () => {
  await act(async () => root.render(<MantineProvider env="test"><Inventory /></MantineProvider>));
  const trigger = container.querySelector('button');
  trigger.focus();
  await act(async () => trigger.click());
  expect(trigger.isConnected).toBe(true);
  expect(document.querySelector('[role="dialog"]').textContent).toContain('attempt-101');
  expect(document.querySelector('[aria-label="Selection details"]').textContent).toContain('Evidence attempt-101');
  expect(document.querySelector('[aria-label="Resize detail panel"]')).toBeNull();
  const back = [...document.querySelectorAll('button')].find(button => button.textContent === 'Return to comparison');
  await act(async () => back.click());
  expect(container.querySelector('[aria-pressed="false"]')).not.toBeNull();
});

it('keeps wide comparison and detail mounted across selections and returns focus on close', async () => {
  wide = true;
  await act(async () => root.render(<MantineProvider env="test"><Inventory /></MantineProvider>));
  const trigger = container.querySelector('button');
  trigger.focus();
  await act(async () => trigger.click());
  const group = container.querySelector('[data-group]');
  const inspector = container.querySelector('#workspace-detail');
  expect(group.style.flexDirection).toBe('row');
  expect(group.style.height).toBe('620px');
  expect(container.querySelector('[aria-label="Resize detail panel"]')).not.toBeNull();
  expect(inspector.textContent).toContain('Evidence attempt-101');
  await act(async () => container.querySelectorAll('[aria-pressed]')[1].click());
  expect(container.querySelector('#workspace-detail')).toBe(inspector);
  expect(inspector.textContent).toContain('Evidence attempt-103');
  await act(async () => container.querySelector('[aria-label="Close selection details"]').click());
  expect(container.querySelector('#workspace-detail')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('uses available container space even when the viewport is wide', async () => {
  wide = true;
  await act(async () => root.render(<MantineProvider env="test"><Inventory /></MantineProvider>));
  const observer = observers.find(item => item.target === container.querySelector('[data-group]').parentElement);
  expect(observer).toBeDefined();
  await act(async () => {
    observer.callback([{ contentRect: { width: 1000, height: 620 } }]);
    await new Promise(resolve => requestAnimationFrame(resolve));
  });
  await act(async () => container.querySelector('button').click());
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Resize detail panel"]')).toBeNull();
});

it('retains comparison state, unsaved details and the focused caret across both responsive transitions', async () => {
  wide = true;
  function Comparison() {
    const [compared, setCompared] = useState(false);
    return <button aria-pressed={compared} onClick={() => setCompared(!compared)}>Compare account</button>;
  }
  function Draft() {
    const [value, setValue] = useState('Original policy');
    return <><button onClick={() => setValue('Unsaved operator policy')}>Edit draft</button>
      <input aria-label="Policy draft" value={value} readOnly /></>;
  }
  await act(async () => root.render(<MantineProvider env="test"><SelectionDock open title="Account"
    onClose={() => {}} detail={<Draft />}><Comparison /></SelectionDock></MantineProvider>));
  const comparison = [...container.querySelectorAll('button')].find(button => button.textContent === 'Compare account');
  await act(async () => {
    comparison.click();
    [...document.querySelectorAll('button')].find(button => button.textContent === 'Edit draft').click();
  });
  const draft = document.querySelector('[aria-label="Policy draft"]');
  draft.focus();
  draft.setSelectionRange(3, 9);
  const observer = observers.find(item => item.target === container.querySelector('[data-group]').parentElement);
  for (const width of [900, 1300]) {
    await act(async () => {
      observer.callback([{ contentRect: { width, height: 620 } }]);
      await new Promise(resolve => requestAnimationFrame(resolve));
    });
    expect(document.querySelector('[aria-label="Policy draft"]')).toBe(draft);
    expect(draft.value).toBe('Unsaved operator policy');
    expect(comparison.isConnected).toBe(true);
    expect(comparison.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(draft);
    expect([draft.selectionStart, draft.selectionEnd]).toEqual([3, 9]);
  }
});
