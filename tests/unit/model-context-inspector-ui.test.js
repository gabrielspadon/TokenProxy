// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ModelContextPage from '@/app/dashboard/model-context/page';

let root, container;
beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(window, 'matchMedia', { configurable: true,
    value: vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    models: ['alpha', 'beta'].map(model => ({ provider: 'codex', model, name: model,
      staticContextWindow: 200000, contextWindow: 100000, providerConnections: 0 })),
    overrides: { 'codex/alpha': 100000, 'codex/beta': 100000 },
  }), { headers: { 'content-type': 'application/json' } })));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<MantineProvider env="test"><ModelContextPage /></MantineProvider>));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(['models', 'overrides'])('keeps %s row controls linked only while the selected inspector is mounted', async view => {
  if (view === 'overrides') {
    const inventory = container.querySelector('.model-context-tools select');
    await act(async () => {
      inventory.value = view;
      inventory.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  const buttons = [...container.querySelectorAll('.model-context-inventory tbody button')];
  expect(buttons).toHaveLength(2);
  expect(container.querySelector('#model-context-inspector')).toBeNull();
  expect(buttons.every(button => !button.hasAttribute('aria-controls'))).toBe(true);

  await act(async () => buttons[0].click());
  const inspector = container.querySelector('#model-context-inspector');
  expect(inspector).not.toBeNull();
  expect(inspector.closest('aside')).not.toBeNull();
  expect(inspector.closest('[role="dialog"], dialog')).toBeNull();
  expect(inspector.querySelector('[data-context-token-input]').disabled).toBe(false);
  expect(document.activeElement).toBe(inspector.querySelector('[data-context-token-input]'));
  for (const button of buttons) {
    expect(document.getElementById(button.getAttribute('aria-controls'))).toBe(inspector);
  }
  expect(buttons[0].getAttribute('aria-current')).toBe('true');
  await act(async () => buttons[1].click());
  expect(buttons[0].hasAttribute('aria-current')).toBe(false);
  expect(buttons[1].getAttribute('aria-current')).toBe('true');
  expect(inspector.textContent).toContain('codex/beta');

  await act(async () => container.querySelector('button[aria-label="Close selection details"]').click());
  expect(container.querySelector('#model-context-inspector')).toBeNull();
  expect(buttons.every(button => !button.hasAttribute('aria-controls'))).toBe(true);
  expect(buttons.every(button => !button.hasAttribute('aria-current'))).toBe(true);
  expect(document.activeElement).toBe(buttons[1]);
});
