// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ call: vi.fn(), refresh: vi.fn(), data: {} }));
vi.mock('@/shared/api', () => ({ call: state.call }));
vi.mock('@/shared/hooks/usePoll', () => ({
  usePoll: (url) => ({ data: state.data[url], refresh: state.refresh, loading: false }),
}));
import { CapabilityRouting, CatalogControls } from '@/app/dashboard/models/page';

let root, container;
async function render(node) {
  await act(async () => root.render(<MantineProvider env="test">{node}</MantineProvider>));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Unexpected network request');
    })
  );
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  localStorage.clear();
  state.data = {
    '/api/models': {
      models: [
        {
          fullModel: 'p/model',
          model: 'model',
          name: 'Fixture model',
          provider: 'p',
          alias: 'model',
          aliases: [],
          caps: { contextWindow: 200000, maxOutput: 64000 },
        },
      ],
    },
    '/api/models/disabled': { disabled: {} },
    '/api/models/custom': { models: [] },
    '/api/models/new': { groups: [], totalUnseen: 0 },
    '/api/models/free-sync': { config: { enabled: false, intervalHours: 4 }, providers: {} },
    '/api/combos': { combos: [] },
    '/api/settings': {
      comboStrategy: 'round-robin',
      comboStickyRoundRobinLimit: 4,
      capacityAdapter: {
        vision: { enabled: false, roundRobin: false, models: ['p/vision'] },
        pdf: { enabled: true, roundRobin: true, models: ['p/pdf'] },
        audioInput: { enabled: false, roundRobin: false, models: [] },
        videoInput: { enabled: true, roundRobin: false, models: ['p/video'] },
      },
    },
  };
  state.call.mockReset().mockResolvedValue({ ok: true, status: 200, body: {} });
  state.refresh.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const labelled = (label) => container.querySelector(`[aria-label="${label}"]`);
const button = (text) =>
  [...container.querySelectorAll('button')].find((element) => {
    const copy = element.cloneNode(true);
    copy.querySelectorAll('[aria-hidden="true"]').forEach((icon) => icon.remove());
    return copy.textContent.trim() === text;
  });
async function click(element) {
  await act(async () => element.click());
}
async function type(element, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function press(element, key) {
  await act(async () =>
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  );
}

it('commits an alias from the row itself on Enter, with no dialog anywhere', async () => {
  await render(<CatalogControls />);
  const field = labelled('Alias for p/model');
  expect(field.closest('dialog, [role="dialog"]')).toBeNull();
  await type(field, 'short');
  await press(field, 'Enter');
  expect(state.call).toHaveBeenCalledExactlyOnceWith('/api/models/alias', {
    method: 'PUT',
    body: { model: 'p/model', alias: 'short' },
  });
  expect(state.refresh).toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it('reverts an alias edit on Escape without sending anything', async () => {
  await render(<CatalogControls />);
  const field = labelled('Alias for p/model');
  await type(field, 'short');
  await press(field, 'Escape');
  await act(async () => field.dispatchEvent(new FocusEvent('blur', { bubbles: true })));
  expect(state.call).not.toHaveBeenCalled();
});

it('deletes an alias when the field is emptied', async () => {
  state.data['/api/models'] = {
    models: [
      {
        fullModel: 'p/model',
        model: 'model',
        name: 'Fixture model',
        provider: 'p',
        alias: 'short',
        aliases: ['short'],
        caps: {},
      },
    ],
  };
  await render(<CatalogControls />);
  const field = labelled('Alias for p/model');
  expect(field.value).toBe('short');
  await type(field, '');
  await press(field, 'Enter');
  expect(state.call).toHaveBeenCalledExactlyOnceWith('/api/models/alias?alias=short', {
    method: 'DELETE',
  });
});

it('registers a custom model from the inline add row rather than a dialog', async () => {
  await render(<CatalogControls />);
  await click(button('Register a model'));
  const form = container.querySelector('form[aria-label="Register a custom model"]');
  expect(form).not.toBeNull();
  expect(form.closest('dialog, [role="dialog"]')).toBeNull();
  await type(labelled('Provider alias'), 'p');
  await press(labelled('Provider alias'), 'Enter');
  await type(labelled('Model id'), 'new');
  await press(labelled('Model id'), 'Enter');
  await type(labelled('Context window'), '128000');
  await press(labelled('Context window'), 'Enter');
  await act(async () =>
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  );
  expect(state.call).toHaveBeenCalledExactlyOnceWith('/api/models/custom', {
    method: 'POST',
    body: {
      providerAlias: 'p',
      id: 'new',
      name: undefined,
      vision: false,
      maxInputTokens: 128000,
      maxOutputTokens: undefined,
    },
  });
});

it('asks inline before disabling a model and sends nothing until the pair is confirmed', async () => {
  await render(<CatalogControls />);
  await click(labelled('Disable p/model'));
  expect(state.call).not.toHaveBeenCalled();
  const pair = container.querySelector('[aria-label="Confirm: Disable p/model"]');
  expect(pair).not.toBeNull();
  await click(
    [...pair.querySelectorAll('button')].find((node) => node.textContent.trim() === 'Disable')
  );
  expect(state.call).toHaveBeenCalledExactlyOnceWith('/api/models/disabled', {
    method: 'POST',
    body: { providerAlias: 'p', ids: ['model'], connectionId: null },
  });
});

it('writes the whole four-kind capability object when one capability is toggled', async () => {
  const adapter = state.data['/api/settings'].capacityAdapter;
  await render(<CapabilityRouting />);
  const toggle = container.querySelector('[aria-label="Vision input"] input[type="checkbox"]');
  await click(toggle);
  expect(state.call).toHaveBeenCalledExactlyOnceWith('/api/settings', {
    method: 'PATCH',
    body: { capacityAdapter: { ...adapter, vision: { ...adapter.vision, enabled: true } } },
  });
});

it('saves the sticky round-robin limit alone, leaving the visible strategy untouched', async () => {
  await render(<CapabilityRouting />);
  const field = labelled('Sticky round-robin limit');
  await type(field, '7');
  await press(field, 'Enter');
  expect(state.call).toHaveBeenCalledExactlyOnceWith('/api/settings', {
    method: 'PATCH',
    body: { comboStickyRoundRobinLimit: 7 },
  });
});
