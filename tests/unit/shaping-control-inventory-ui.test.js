// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ControlEvidence } from '@/app/dashboard/shaping/ControlInventory';
import { CONTROLS } from '@/app/dashboard/shaping/controlCatalog';
let container, root, investigate;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container); investigate = vi.fn();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function render(key = 'cavemanEnabled', stageMap = {}) { await act(async () => root.render(<MantineProvider env="test"><ControlEvidence control={CONTROLS.find(control => control.key === key)} settings={{ cavemanEnabled: false, memoryHandoffEnabled: true, headroomLossless: true }} stageMap={stageMap} onInvestigate={investigate} /></MantineProvider>)); }
it('keeps evidence in one optional layer without a second editor or inspector', async () => {
  await render('cavemanEnabled', { inject: { requests: 2, applied: 1, measuredRequests: 1, bytesSaved: 64 } });
  expect(container.querySelectorAll('details')).toHaveLength(1);
  expect(container.querySelector('details details')).toBeNull();
  expect(container.querySelector('input, select, textarea')).toBeNull();
  expect(container.querySelector('summary').getAttribute('aria-label')).toBe('Evidence and requirements for Compact response instructions');
  expect(container.textContent).toContain('Off globally');
  expect(container.textContent).toContain('1 applied stage records');
  expect(container.textContent).toContain('+64 B');
  expect(container.textContent).toContain('1 / 2');
  const compare = [...container.querySelectorAll('button')].find(node => node.textContent === 'Compare saved profiles');
  await act(async () => compare.click());
  expect(investigate).toHaveBeenCalledOnce();
});
it.each(['headroomLossless'])('preserves %s compatibility state and explains the missing runtime', async key => {
  await render(key);
  expect(container.textContent).toContain('Runtime unavailable');
  expect(container.textContent).toContain('preserved for compatibility');
  expect(container.textContent).toContain('On globally');
  expect(container.querySelector('input, select, textarea')).toBeNull();
});
