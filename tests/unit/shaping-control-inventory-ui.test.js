// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ControlInventory } from '@/app/dashboard/shaping/ControlInventory';
import { CONTROLS } from '@/app/dashboard/shaping/controlCatalog';
let container, root, toggle;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container); toggle = vi.fn();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function render() { await act(async () => root.render(<MantineProvider env="test"><ControlInventory settings={{ cavemanEnabled: false, memoryHandoffEnabled: true, headroomLossless: true }} stageMap={{}} onToggle={toggle} renderThresholds={() => null} /></MantineProvider>)); }
it('opens the selected control through the shared adaptive inspector and clears the selection on return', async () => {
  await render();
  expect(container.querySelectorAll('button[data-control]')).toHaveLength(CONTROLS.length);
  expect(document.querySelector('#shaping-control-inspector')).toBeNull();
  const selected = container.querySelector('[data-control="cavemanEnabled"]');
  await act(async () => { selected.focus(); selected.click(); });
  expect(selected.getAttribute('aria-current')).toBe('true');
  expect(document.querySelector('#shaping-control-inspector')).not.toBeNull();
  const action = [...document.querySelectorAll('button')].find(node => node.textContent === 'Turn on');
  await act(async () => action.click());
  expect(toggle).toHaveBeenCalledWith(expect.objectContaining({ key: 'cavemanEnabled' }), true);
  await act(async () => document.querySelector('button[aria-label="Close selection details"]').click());
  expect(document.querySelector('#shaping-control-inspector')).toBeNull();
  expect(selected.hasAttribute('aria-current')).toBe(false);
});
it.each(['memoryHandoffEnabled'])('preserves %s compatibility state without offering a working runtime toggle', async key => {
  await render(); await act(async () => container.querySelector(`[data-control="${key}"]`).click());
  const inspector = document.querySelector('#shaping-control-inspector');
  expect(inspector.textContent).toContain('Runtime unavailable');
  expect(inspector.textContent).toContain('preserved for compatibility');
  expect([...inspector.querySelectorAll('button')].some(node => /Turn on|Turn off/.test(node.textContent))).toBe(false);
});
