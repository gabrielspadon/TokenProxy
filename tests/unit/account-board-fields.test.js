// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider, Tooltip } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CommitNumber, NameField } from '@/shared/workspace/CommitFields';
import { QuotaLine } from '@/app/dashboard/QuotaLine';

let root, container;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const render = (element) => act(async () => root.render(<MantineProvider env="test">{element}</MantineProvider>));
const input = () => container.querySelector('input');
async function type(value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const key = (name) => act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })));
const blur = () => act(async () => input().dispatchEvent(new FocusEvent('focusout', { bubbles: true })));

it.each([
  [-1, '0', 'depleted', false],
  [0, '100', 'good', true],
  [1000, '100', 'good', true],
  [16 * 60_000, '0', 'depleted', false],
])('keeps quota meter, label and estimated reset evidence consistent at offset %i', async (offset, value, level, estimated) => {
  const resetAt = Date.parse('2026-01-01T12:00:00Z');
  const window = { key: 'session (5h)', label: 'Session', remaining: 0,
    resetAt: new Date(resetAt).toISOString(), observedAt: new Date(resetAt - 60_000).toISOString() };
  await render(<QuotaLine window={window} now={resetAt + offset} onInspect={() => {}} />);
  const meter = container.querySelector('[role="meter"]');
  expect(meter.getAttribute('aria-valuenow')).toBe(value);
  expect(meter.firstElementChild.style.width).toBe(`${value}%`);
  expect(container.querySelector('[data-level]').getAttribute('data-level')).toBe(level);
  expect(meter.getAttribute('aria-valuetext').startsWith('Estimated')).toBe(estimated);
  expect(container.textContent).toContain(`${estimated ? '≈' : ''}${value}%`);
  expect(container.querySelector('button').title.includes('last observed 0%')).toBe(estimated);
});

it('commits a changed number on Enter and on blur, once each, and never an unchanged one', async () => {
  const onCommit = vi.fn();
  await render(<Tooltip label="help"><CommitNumber aria-label="Priority" value={3} min={1} onCommit={onCommit} /></Tooltip>);
  expect(input().value).toBe('3');
  await type('1');
  await key('Enter');
  expect(onCommit).toHaveBeenCalledWith(1);
  await type('3');
  await blur();
  expect(onCommit).toHaveBeenCalledTimes(1);
  await type('7');
  await blur();
  expect(onCommit).toHaveBeenLastCalledWith(7);
  expect(onCommit).toHaveBeenCalledTimes(2);
});

it('reverts to the saved value on Escape and on an emptied field, and sends one save per value', async () => {
  const onCommit = vi.fn();
  await render(<CommitNumber aria-label="Threshold" value={0} min={0} max={100} suffix="%" onCommit={onCommit} />);
  expect(input().value).toBe('0%');
  await type('25');
  await key('Escape');
  expect(input().value).toBe('0%');
  await type('');
  await blur();
  expect(onCommit).not.toHaveBeenCalled();
  expect(input().value).toBe('0%');
  await type('30');
  await key('Enter');
  await blur();
  expect(onCommit).toHaveBeenCalledTimes(1);
  expect(onCommit).toHaveBeenCalledWith(30);
});

it('follows a new saved value from outside', async () => {
  const onCommit = vi.fn();
  await render(<CommitNumber aria-label="Threshold" value={0} onCommit={onCommit} />);
  await render(<CommitNumber aria-label="Threshold" value={40} onCommit={onCommit} />);
  expect(input().value).toBe('40');
});

it('renames on Enter, keeps the name on Escape, and ignores blank or unchanged names', async () => {
  const onCommit = vi.fn();
  const onOpen = vi.fn();
  await render(<NameField name="Account A" onCommit={onCommit} onOpen={onOpen} expanded={false} />);
  await act(async () => container.querySelector('[aria-label="Rename Account A"]').click());
  await type('Account B');
  await key('Enter');
  expect(onCommit).toHaveBeenCalledWith('Account B');
  await act(async () => container.querySelector('[aria-label="Rename Account A"]').click());
  await type('Discarded');
  await key('Escape');
  expect(onCommit).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('Account A');
  await act(async () => container.querySelector('[aria-label="Rename Account A"]').click());
  await type('   ');
  await blur();
  expect(onCommit).toHaveBeenCalledTimes(1);
  await act(async () => container.querySelector('button').click());
  expect(onOpen).toHaveBeenCalled();
});
