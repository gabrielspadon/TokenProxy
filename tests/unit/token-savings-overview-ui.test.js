// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TokenSavings } from '@/app/dashboard/shaping/TokenSavings';
import { CONTROLS } from '@/app/dashboard/shaping/controlCatalog';

let container, root, toggle, advanced, props;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  localStorage.clear();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  toggle = vi.fn(); advanced = vi.fn();
  props = { settings: Object.fromEntries(CONTROLS.map(control => [control.key, false])), stageMap: {}, period: 'all', onPeriod: vi.fn(), onToggle: toggle, onAdvanced: advanced, onRefresh: vi.fn() };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function render() { await act(async () => root.render(<MantineProvider env="test"><TokenSavings {...props} /></MantineProvider>)); }
const button = text => [...container.querySelectorAll('button')].find(node => node.textContent === text);
const card = key => container.querySelector(`[data-savings-control="${key}"]`);

it('routes a direct toggle through review without displaying an unsaved setting as enabled', async () => {
  await render();
  const input = card('rtkEnabled').querySelector('input');
  await act(async () => input.click());
  expect(toggle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key: 'rtkEnabled' }), true);
  expect(input.checked).toBe(false);
  expect(card('rtkEnabled').textContent).toContain('Off');
});

it('keeps unknown and unavailable controls ineligible for a mutation', async () => {
  props.settings = null; await render();
  expect([...container.querySelectorAll('input[type="checkbox"]')].every(input => input.disabled)).toBe(true);
  props.settings = { ...Object.fromEntries(CONTROLS.map(control => [control.key, false])), memoryHandoffEnabled: true };
  await render();
  expect(card('memoryHandoffEnabled').textContent).toContain('Runtime unavailable');
  expect(card('memoryHandoffEnabled').querySelector('input').disabled).toBe(true);
  expect(card('memoryHandoffEnabled').querySelector('input').checked).toBe(true);
});

it('distinguishes measured zero, growth, reduction and absent byte coverage without summing stages', async () => {
  props.stageMap = {
    rtk: { requests: 2, applied: 1, bytesSaved: -2048, measuredRequests: 1 },
    inject: { requests: 1, applied: 1, bytesSaved: 128, measuredRequests: 1 },
    epochMicro: { requests: 1, applied: 1, bytesSaved: 0, measuredRequests: 1 },
    diet: { requests: 1, applied: 1, bytesSaved: -999 },
  };
  await render();
  const rows = [...container.querySelectorAll('.savings-byte-row')];
  expect(rows).toHaveLength(4);
  expect(rows.find(row => row.textContent.includes('Tool result reducer')).textContent).toContain('-2,048 B');
  expect(rows.find(row => row.textContent.includes('Compact response instructions')).textContent).toContain('+128 B');
  expect(rows.find(row => row.textContent.includes('Boundary-aware clearing')).textContent).toContain('0 B');
  expect(rows.find(row => row.textContent.includes('Expired result pruning')).textContent).toContain('Not measured');
  expect(container.textContent).not.toContain('-999');
  expect(container.textContent).toContain('not billed token or cost savings');
});

it('filters the full catalog and opens matched categories, including initially hidden controls', async () => {
  props.settings.linguaEnabled = true;
  await render();
  const select = container.querySelector('select');
  await act(async () => { select.value = 'on'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(container.querySelectorAll('[data-savings-control]')).toHaveLength(1);
  expect(card('linguaEnabled')).not.toBeNull();
  expect(card('linguaEnabled').parentElement.hidden).toBe(false);
  await act(async () => card('linguaEnabled').querySelector('button').click());
  expect(advanced).toHaveBeenCalledWith('Controls', 'linguaEnabled');
});

it('remembers category expansion and measurement visibility across remounts', async () => {
  await render();
  await act(async () => container.querySelector('[aria-label="Show History controls"]').click());
  await act(async () => button('Hide measurements').click());
  await act(async () => root.unmount()); root = createRoot(container); await render();
  expect(container.querySelector('[aria-label="Hide History controls"]').getAttribute('aria-expanded')).toBe('true');
  expect(container.querySelector('#savings-byte-evidence').hidden).toBe(true);
});

it('reports a failed measurement read without presenting an empty sample as zero savings', async () => {
  props.unavailable = true; await render();
  expect(container.textContent).toContain('Measurements could not be refreshed');
  expect(container.textContent).toContain('No measurements are available');
  expect(container.querySelectorAll('.savings-byte-row')).toHaveLength(0);
});
