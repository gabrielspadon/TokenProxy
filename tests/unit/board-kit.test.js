// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Board, BoardGroup, BoardSummary, BoardToolbar, Card, DENSITY_KEY, DENSITY_STOPS, DensitySwitch, EvidenceLine, StateWord, isEverydayRoute, resolveDensity } from '@/shared/workspace/Board';

let root, host;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = (node) => act(async () => root.render(<MantineProvider env="test">{node}</MantineProvider>));

it('composes a board with summary chips, toolbar, group, card and evidence lines', async () => {
  const picked = [];
  await render(
    <Board label="Things" advanced={false} density="tidy">
      <BoardSummary label="Thing summary" chips={[{ count: 3, label: 'things' }, { id: 'ready', tone: 'positive', count: 2, label: 'ready' }]} active={null} onPick={(id) => picked.push(id)} note="a note" />
      <BoardToolbar search="" onSearch={() => {}} searchLabel="Search things" actions={<DensitySwitch value="tidy" onChange={() => {}} />} />
      <BoardGroup label="Ready" tone="positive" count={2}>
        <Card id="a" bucket="ready" label="Alpha" head={<b>Alpha</b>} state={<StateWord tone="positive">Ready</StateWord>}>
          <EvidenceLine label="Session" remaining={88} level="good" value="88%" note="in 1h" onInspect={() => {}} />
          <EvidenceLine label="Usage" shares={[{ kind: 'input', percent: 70 }, { kind: 'read', percent: 20 }, { kind: 'write', percent: 10 }]} value="73.5K" note="20% read" />
          <EvidenceLine label="Weekly" unknown value="—" note="" />
        </Card>
      </BoardGroup>
    </Board>
  );
  const board = host.querySelector('section[aria-label="Things"]');
  expect(board.dataset.layout).toBe('cards');
  expect(board.dataset.density).toBe('tidy');
  const chips = [...host.querySelectorAll('[aria-label="Thing summary"] button')];
  expect(chips.map((chip) => chip.textContent)).toEqual(['3 things', '2 ready']);
  await act(async () => chips[1].click());
  expect(picked).toEqual(['ready']);
  expect(host.querySelector('[role="searchbox"][aria-label="Search things"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="Density"]')).not.toBeNull();
  expect(host.querySelector('section[aria-label="Ready items"] h3').textContent).toBe('Ready2');
  const meters = host.querySelectorAll('[role="meter"]');
  expect(meters).toHaveLength(1);
  expect(meters[0].getAttribute('aria-valuenow')).toBe('88');
  expect(host.querySelector('[data-usage] [data-share="read"]').style.width).toBe('20%');
  expect(host.querySelector('[data-level="good"]')).not.toBeNull();
  expect(host.querySelectorAll('[data-unknown]')).toHaveLength(1);
});

it('offers four ordered density stops and carries the chosen one onto the board', async () => {
  const chosen = [];
  await render(
    <Board label="Things" density="compact">
      <BoardToolbar actions={<DensitySwitch value="compact" onChange={(value) => chosen.push(value)} />} />
    </Board>
  );
  const scale = host.querySelector('[aria-label="Density"]');
  expect([...scale.querySelectorAll('label')].map((node) => node.textContent))
    .toEqual(['Compact', 'Dense', 'Tidy', 'Comfy']);
  expect(host.querySelector('section[aria-label="Things"]').dataset.density).toBe('compact');
  // Every stop is a labelled radio, so the scale is reachable by keyboard and
  // announces which step is current.
  const radios = [...scale.querySelectorAll('input[type="radio"]')];
  expect(radios).toHaveLength(4);
  expect(radios.find((input) => input.checked).value).toBe('compact');
  await act(async () => radios[3].click());
  expect(chosen).toEqual(['comfy']);
});

it('keeps a stored density, falls back for a malformed one, and never silently renames a stop', () => {
  expect(DENSITY_KEY).toBe('tokenproxy.capacity-density');
  expect(DENSITY_STOPS.map((stop) => stop.value)).toEqual(['compact', 'dense', 'tidy', 'comfy']);
  // The two values earlier builds could have written read back unchanged.
  for (const stored of ['tidy', 'comfy']) expect(resolveDensity(stored)).toBe(stored);
  for (const stored of ['compact', 'dense']) expect(resolveDensity(stored)).toBe(stored);
  // Anything else resolves rather than rendering an unknown attribute.
  for (const broken of ['cosy', '', null, undefined, 0, {}, 'COMFY']) expect(resolveDensity(broken)).toBe('tidy');
});

it('derives the level from the route boundary, not from a stored preference', () => {
  expect(isEverydayRoute('/dashboard/context')).toBe(true);
  expect(isEverydayRoute('/dashboard/context/session-1')).toBe(true);
  // A sibling route that merely starts with the same letters is not Context.
  expect(isEverydayRoute('/dashboard/context-limits')).toBe(false);
  for (const route of ['/dashboard', '/dashboard/usage', '/dashboard/connections', '/dashboard/model-context']) {
    expect(isEverydayRoute(route)).toBe(false);
  }
  // An unknown or absent path presents the full controls rather than hiding them.
  for (const unknown of ['/missing', '', null, undefined]) expect(isEverydayRoute(unknown)).toBe(false);
});
