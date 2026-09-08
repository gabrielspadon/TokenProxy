// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QuotaProduct } from '@/app/dashboard/QuotaProduct';
import { groupQuotaProducts } from '@/app/dashboard/quotaProductGroups';

const now = Date.parse('2026-09-08T12:00:00Z');
const keys = ['hourly', 'weekly', 'monthly', 'spark_hourly', 'spark_weekly', 'spark_monthly'];
const fixture = () => keys.map((key, index) => ({
  key, remaining: 15 + index * 10, unlimited: false, threshold: index + 5,
  resetAt: new Date(now + (index + 1) * 3600000).toISOString(),
  observedAt: new Date(now - (index + 1) * 60000).toISOString(),
}));
let root, container, windows, onInspect, onThresholdChange, request;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  windows = Object.freeze(fixture().map(Object.freeze));
  onInspect = vi.fn(); onThresholdChange = vi.fn(); request = vi.fn();
  vi.stubGlobal('fetch', request);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function render({ readings = windows, ...props } = {}) {
  await act(async () => root.render(<MantineProvider env="test">{groupQuotaProducts('codex', readings).map(group =>
    <QuotaProduct key={group.id} group={group} mode="remaining" now={now} onInspect={onInspect}
      thresholdFor={key => readings.find(window => window.key === key).threshold}
      onThresholdChange={onThresholdChange} disabled={false} {...props} />
  )}</MantineProvider>));
}
const lane = key => container.querySelector(`[data-quota-window="${key}"]`);
const field = (key, slider = false) => lane(key).querySelector(`[aria-label="${slider ? 'Adjust auto-pause for' : 'Auto-pause threshold for'} ${key}"]`);
async function fill(input, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('renders six synthetic period windows as two named products without losing percentages or resets', async () => {
  await render();
  const products = [...container.querySelectorAll('section[data-quota-product]')];
  expect(products).toHaveLength(2);
  expect(products.map(product => document.getElementById(product.getAttribute('aria-labelledby')).textContent)).toEqual(['General', 'Codex Spark']);
  expect(container.querySelectorAll('[role="meter"]')).toHaveLength(6);
  for (const [index, window] of windows.entries()) {
    const row = lane(window.key);
    expect(row.querySelector('button').textContent).toBe(['Hourly', 'Weekly', 'Monthly'][index % 3]);
    expect(row.querySelector('[role="meter"]').getAttribute('aria-label')).toBe(`${window.key} remaining`);
    expect(row.querySelector('[role="meter"]').getAttribute('aria-valuenow')).toBe(String(window.remaining));
    expect(row.querySelector('strong').textContent).toBe(`${window.remaining}%`);
    expect(row.textContent).toContain(`Resets in ${index + 1}h 0m`);
    expect(row.querySelector(`[title="${window.resetAt.replace('T', ' ').replace('.000Z', ' UTC')}"]`)).not.toBeNull();
    expect(field(window.key).value).toBe(`${window.threshold}%`);
    expect(field(window.key, true).value).toBe(String(window.threshold));
    expect(field(window.key, true).getAttribute('dir')).toBe('ltr');
    expect(field(window.key, true).closest('[role="meter"]')).toBeNull();
    expect(field(window.key, true).parentElement).toBe(row.querySelector('[role="meter"]').parentElement);
  }
});

it('associates every number input and slider with the remaining-percent pause explanation', async () => {
  await render();
  for (const key of keys) for (const slider of [false, true]) {
    const description = field(key, slider).getAttribute('aria-describedby');
    expect(description).toBeTruthy();
    const help = description.split(/\s+/).map(id => {
      const node = document.getElementById(id);
      expect(node).not.toBeNull();
      return node.textContent;
    }).join(' ');
    expect(help).toMatch(/pause.*%\s*remaining/i);
    expect(help).toMatch(/(?:0%|zero).*off/i);
  }
});

it('passes the unchanged scope key when inspecting every window', async () => {
  await render();
  for (const key of keys) await act(async () => lane(key).querySelector(`[aria-label="Inspect ${key}"]`).click());
  expect(onInspect.mock.calls).toEqual(keys.map(key => [key]));
  expect(onThresholdChange).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

it.each([false, true])('requests scoped threshold edits from controls (slider=%s) without changing observations or saved values', async slider => {
  const before = structuredClone(windows);
  await render();
  for (const [index, key] of keys.entries()) await fill(field(key, slider), 30 + index);
  expect(onThresholdChange.mock.calls).toEqual(keys.map((key, index) => [key, 30 + index]));
  expect(windows).toEqual(before);
  expect(request).not.toHaveBeenCalled();
  expect(onInspect).not.toHaveBeenCalled();
  await render({ thresholdFor: key => 30 + keys.indexOf(key) });
  for (const [index, key] of keys.entries()) {
    expect(field(key).value).toBe(`${30 + index}%`);
    expect(field(key, true).value).toBe(String(30 + index));
    expect(lane(key).querySelector('[role="meter"]').getAttribute('aria-valuenow')).toBe(String(before[index].remaining));
  }
});

it('inverts used-mode meter values and threshold markers while keeping pause edits in remaining percent', async () => {
  await render({ mode: 'used' });
  for (const window of windows) {
    const row = lane(window.key), meter = row.querySelector('[role="meter"]');
    expect(meter.getAttribute('aria-label')).toBe(`${window.key} used`);
    expect(meter.getAttribute('aria-valuenow')).toBe(String(100 - window.remaining));
    expect(meter.getAttribute('aria-valuetext')).toBe(`${100 - window.remaining} percent used; observed capacity`);
    expect(meter.firstElementChild.style.width).toBe(`${100 - window.remaining}%`);
    expect(meter.querySelector('[title]').style.left).toBe(`${100 - window.threshold}%`);
    expect(row.querySelector('strong').textContent).toBe(`${100 - window.remaining}%`);
    expect(field(window.key, true).getAttribute('aria-valuetext')).toContain(`${window.threshold} percent remaining`);
    expect(field(window.key, true).getAttribute('dir')).toBe('rtl');
    expect(field(window.key, true).value).toBe(String(window.threshold));
    expect(field(window.key, true).closest('[role="meter"]')).toBeNull();
    await fill(field(window.key, true), 35);
  }
  expect(onThresholdChange.mock.calls).toEqual(keys.map(key => [key, 35]));
  expect(request).not.toHaveBeenCalled();
});

it('retains each distinct observation age and only summarizes genuinely shared observation timestamps', async () => {
  await render();
  for (const [index, window] of windows.entries()) expect(lane(window.key).textContent).toContain(`Observed ${index + 1}m ago`);
  expect([...container.querySelectorAll('header')].every(header => !header.textContent.includes('Observed'))).toBe(true);
  await render({ readings: windows.map(window => ({ ...window, observedAt: windows[0].observedAt })) });
  for (const product of container.querySelectorAll('section[data-quota-product]')) {
    expect(product.querySelector('header').textContent).toContain('Observed 1m ago');
    expect(product.querySelector('header [title]').getAttribute('title')).toBe('2026-09-08 11:59:00 UTC');
    expect(product.textContent.match(/Observed 1m ago/g)).toHaveLength(1);
    expect(product.querySelector('footer').textContent).not.toContain('Observed');
    expect([...product.querySelectorAll('[data-quota-window]')].every(row => !row.textContent.includes('Observed'))).toBe(true);
  }
});

it('keeps observed capacity after a reset passes instead of refilling it', async () => {
  await render({ now: now + 90 * 60000 });
  const row = lane('hourly');
  expect(row.textContent).toContain('Reset passed · awaiting update');
  expect(row.textContent).toContain('Retained');
  expect(row.getAttribute('data-retained')).toBe('true');
  expect(row.querySelector('[role="meter"]').getAttribute('aria-valuenow')).toBe('15');
  expect(row.querySelector('[role="meter"]').getAttribute('aria-valuetext')).toBe('15 percent remaining; retained capacity');
  expect(row.querySelector('[role="meter"]').firstElementChild.style.width).toBe('15%');
  expect(row.querySelector('[data-next-reset]')).toBeNull();
  expect(lane('weekly').querySelector('[data-next-reset]')).not.toBeNull();
  expect(request).not.toHaveBeenCalled();
});

it('does not present unknown or unlimited readings as numeric meters, while retaining a known zero', async () => {
  const readings = windows.map((window, index) => ({ ...window, ...(index === 0 ? { remaining: null, resetAt: null, threshold: '' } : index === 1 ? { unlimited: true, remaining: 100 } : index === 2 ? { remaining: 0 } : {}) }));
  await render({ readings });
  for (const [key, label] of [['hourly', 'Unknown'], ['weekly', 'Unlimited']]) {
    expect(lane(key).querySelector('[role="meter"]')).toBeNull();
    expect(lane(key).querySelector('strong').textContent).toBe(label);
    expect(lane(key).querySelector('input[type="range"]')).toBeNull();
  }
  expect(lane('hourly').textContent).toContain('Reset unknown');
  expect(lane('hourly').textContent).toContain('Unavailable');
  expect(lane('weekly').textContent).toContain('Not applied');
  expect(lane('monthly').querySelector('[role="meter"]').getAttribute('aria-valuenow')).toBe('0');
  expect(lane('monthly').querySelector('strong').textContent).toBe('0%');
});

it('moves the next-reset indicator without changing product or window order', async () => {
  await render();
  const order = () => [...container.querySelectorAll('[data-quota-window]')].map(row => row.dataset.quotaWindow);
  expect(order()).toEqual(keys);
  expect(lane('hourly').querySelector('[data-next-reset]')).not.toBeNull();
  await render({ readings: [...windows].reverse().map(window => ({ ...window, resetAt: new Date(now + (window.key === 'monthly' ? 60000 : 7200000)).toISOString() })) });
  expect(order()).toEqual(keys);
  expect(lane('monthly').querySelector('[data-next-reset]')).not.toBeNull();
  expect(lane('hourly').querySelector('[data-next-reset]')).toBeNull();
});

it('disables both editing controls while keeping inspection available', async () => {
  await render({ disabled: true });
  for (const key of keys) {
    expect(field(key).disabled).toBe(true);
    expect(field(key, true).disabled).toBe(true);
    expect(lane(key).querySelector('button').disabled).toBe(false);
  }
  expect(onThresholdChange).not.toHaveBeenCalled();
});

it('removes meter width animation when reduced motion is requested', () => {
  const quotaProductCss = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../src/app/dashboard/quotaProduct.module.css'), 'utf8');
  expect(quotaProductCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.fill\s*\{\s*transition:\s*none;/);
});
