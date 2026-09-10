// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ModelContextPage from '@/app/dashboard/model-context/page';

let root, container;
const overrides = { 'codex/alpha': 100000 };
beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })),
  });
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            models: ['alpha', 'beta'].map((model) => ({
              provider: 'codex',
              model,
              name: model,
              staticContextWindow: 200000,
              contextWindow: model === 'alpha' ? 100000 : 200000,
              providerConnections: 0,
            })),
            overrides,
          }),
          { headers: { 'content-type': 'application/json' } }
        )
    )
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <ModelContextPage />
      </MantineProvider>
    )
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const card = (name) => container.querySelector(`article[aria-label="${name}"]`);
const carets = () => [
  ...container.querySelectorAll('button[aria-label^="Expand"], button[aria-label^="Collapse"]'),
];

it('groups every entry by state and edits its window in place, never in a layer', async () => {
  expect(container.querySelector('dialog, [role="dialog"]')).toBeNull();
  expect(container.querySelectorAll('article[data-account-id]')).toHaveLength(2);
  expect(card('alpha').dataset.bucket).toBe('override');
  expect(card('beta').dataset.bucket).toBe('registered');
  const field = card('alpha').querySelector('[data-context-token-input]');
  expect(field.disabled).toBe(false);
  expect(field.value).toBe('100000');
  expect(card('alpha').textContent).toContain('Overridden');
  expect(card('beta').textContent).toContain('Registered');
});

it('only the expanded entry carries its precedence evidence, inline and linked', async () => {
  expect(container.querySelector('[id^="context-detail-"]')).toBeNull();
  expect(carets().every((button) => button.getAttribute('aria-expanded') === 'false')).toBe(true);

  await act(async () => carets()[0].click());
  const detail = container.querySelector('[id^="context-detail-"]');
  expect(detail).not.toBeNull();
  expect(detail.closest('dialog, [role="dialog"]')).toBeNull();
  expect(detail.closest('article[data-account-id]')).toBe(card('alpha'));
  expect(detail.textContent).toContain('codex/alpha');
  expect(card('alpha').dataset.expanded).toBe('true');
  const linked = [...container.querySelectorAll('[aria-controls]')].map((node) =>
    node.getAttribute('aria-controls')
  );
  expect(new Set(linked)).toEqual(new Set([detail.id]));

  await act(async () => carets()[0].click());
  expect(container.querySelector('[id^="context-detail-"]')).toBeNull();
  expect(container.querySelectorAll('[aria-controls]')).toHaveLength(0);
});

it('a removal asks inline beside the entry and sends nothing until it is confirmed', async () => {
  expect(card('beta').querySelector('[aria-label^="Remove the override"]')).toBeNull();
  const remove = card('alpha').querySelector('[aria-label="Remove the override for alpha"]');
  expect(remove).not.toBeNull();
  const reads = fetch.mock.calls.length;
  await act(async () => remove.click());
  expect(fetch.mock.calls).toHaveLength(reads);
  const pair = card('alpha').querySelector(
    '[aria-label="Confirm: Remove the override for alpha"]'
  );
  expect(pair).not.toBeNull();
  expect(pair.closest('dialog, [role="dialog"]')).toBeNull();
  await act(async () =>
    [...pair.querySelectorAll('button')]
      .find((node) => node.textContent.trim() === 'Cancel')
      .click()
  );
  expect(
    card('alpha').querySelector('[aria-label="Confirm: Remove the override for alpha"]')
  ).toBeNull();
  expect(fetch.mock.calls).toHaveLength(reads);
});
