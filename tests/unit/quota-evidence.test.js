// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import {
  QuotaSummary,
  WindowEvidence,
  orderQuotaWindows,
  quotaPercentage,
} from '../../src/shared/workspace/QuotaEvidence';

let root, container;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const weekly = {
  scope: 'Weekly (7d)',
  durationMs: 604800000,
  remaining: 80,
  limit: 100,
  percentage: { value: 9, observedAt: '2026-09-06T10:00:00Z', freshness: { state: 'stale' } },
};
const session = {
  scope: 'Session (5h)',
  durationMs: 18000000,
  remaining: 0,
  limit: 100,
  percentage: { value: 68 },
};
function render(component) {
  act(() => root.render(<MantineProvider env="test">{component}</MantineProvider>));
}

it('keeps both window constraints visible and selects the exact scope', () => {
  const inspect = vi.fn();
  render(<QuotaSummary windows={[session, weekly]} onInspect={inspect} />);
  const buttons = [...container.querySelectorAll('button')];
  expect(buttons.map((button) => button.textContent)).toEqual(['Weekly (7d)9%', 'Session (5h)68%']);
  act(() => buttons[1].click());
  expect(inspect).toHaveBeenCalledWith('Session (5h)');
  expect(container.textContent).not.toContain('80%');
});

it('keeps unknown units unknown instead of deriving percentage from stored quantity', () => {
  const unknown = { scope: 'Unspecified', remaining: 60, limit: 100, confidence: 'unknown' };
  render(<WindowEvidence window={unknown} />);
  expect(container.querySelector('span').textContent).toBe('Unknown headroom');
  expect(container.querySelector('[role="progressbar"]')).toBeNull();
  expect(quotaPercentage(unknown)).toBeNull();
});

it('displays a measured zero and rejects invalid percentage quantities', () => {
  render(<WindowEvidence window={{ ...weekly, percentage: { value: 0 } }} />);
  expect(container.querySelector('span').textContent).toBe('0% remaining');
  for (const value of [null, '20', -1, 101, Infinity, NaN])
    expect(quotaPercentage({ percentage: { value } })).toBeNull();
});

it('orders explicitly reported durations, leaves input intact and does not infer monthly duration', () => {
  const monthly = { scope: 'Monthly', durationMs: null };
  const input = [monthly, session, weekly];
  expect(orderQuotaWindows(input).map((window) => window.scope)).toEqual([
    'Weekly (7d)',
    'Session (5h)',
    'Monthly',
  ]);
  expect(input[0]).toBe(monthly);
});
