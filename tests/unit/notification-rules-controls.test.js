// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CONDITIONS } from '@/lib/notifications/conditions.mjs';

const state = vi.hoisted(() => ({ data: {}, refresh: vi.fn(), error: null, loading: false }));
vi.mock('@/shared/workspace/useResource', () => ({
  useResource: (url) => ({
    data: url?.endsWith('rule-1') ? { rule: state.data.rules[0], versions: [] } : state.data,
    loading: state.loading,
    error: state.error,
    refresh: state.refresh,
  }),
}));
const { NotificationRules } = await import('@/shared/workspace/NotificationRules');
let root, container;
const rule = {
  id: 'rule-1',
  name: 'Synthetic quota rule',
  conditionKind: 'quota_risk',
  scopeKind: 'global',
  scopeId: null,
  threshold: 10,
  durationSeconds: 900,
  cooldownSeconds: 3600,
  enabled: true,
  revision: 1,
};
const event = {
  id: 'event-1',
  ruleId: 'rule-1',
  ruleRevision: 1,
  scopeKey: 'synthetic-account',
  firedAt: '2026-09-07T12:00:00Z',
  outcome: 'firing',
  snoozedUntil: null,
  evidence: { kind: 'quotaObservation', refs: [] },
  observedValue: 5,
};
const click = (text) =>
  act(async () =>
    [...container.querySelectorAll('button')].find((button) => button.textContent === text)?.click()
  );
// Every control on this board carries an aria-label that names its rule, so
// the tests address the same label an operator's screen reader would read.
const byLabel = (label, scope = container) => scope.querySelector(`[aria-label="${label}"]`);
const named = (text) =>
  [...container.querySelectorAll('button')].find((button) => button.textContent === text);
const change = (node, value) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
const press = (node, key) =>
  act(async () => node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
// A field that saves from itself: type, then commit with Enter.
const commit = async (node, value) => {
  await change(node, value);
  await press(node, 'Enter');
};
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  state.error = null;
  state.loading = false;
  state.data = {
    rules: [rule],
    events: [],
    conditions: Object.values(CONDITIONS),
    unavailableConditions: [],
  };
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
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
const render = (props) =>
  act(async () =>
    root.render(
      <MantineProvider env="test">
        <NotificationRules {...props} />
      </MantineProvider>
    )
  );

it('edits a rule in place inside its own card and writes nothing when the edit is abandoned', async () => {
  const fetcher = vi.fn(() => {
    throw new Error('Unexpected request');
  });
  vi.stubGlobal('fetch', fetcher);
  await render();
  await click(rule.name);
  const detail = container.querySelector(`[role="region"][aria-label="Evidence for ${rule.name}"]`);
  expect(detail.closest(`article[data-account-id="${rule.id}"]`)).not.toBeNull();
  expect(detail.closest('details, dialog, [role="dialog"]')).toBeNull();
  expect(named(rule.name).getAttribute('aria-expanded')).toBe('true');
  expect([...document.querySelectorAll('button')].some((button) => button.textContent === 'Edit rule')).toBe(false);
  expect(document.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();

  await act(async () => byLabel(`Rename ${rule.name}`).click());
  const name = byLabel(`Rule name for ${rule.name}`);
  expect(name.closest('details, dialog, [role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(name);
  await change(name, 'Abandoned draft');
  await press(name, 'Escape');
  expect(byLabel(`Rule name for ${rule.name}`)).toBeNull();
  expect(named(rule.name).textContent).toBe(rule.name);

  await click(rule.name);
  expect(container.querySelector(`[role="region"][aria-label="Evidence for ${rule.name}"]`)).toBeNull();
  expect(named(rule.name).getAttribute('aria-expanded')).toBe('false');
  expect(fetcher).not.toHaveBeenCalled();
});

it('retains the local rename draft through refreshes and temporary read errors', async () => {
  await render();
  await act(async () => byLabel(`Rename ${rule.name}`).click());
  const name = byLabel(`Rule name for ${rule.name}`);
  await change(name, 'Local draft');
  state.data = { ...state.data, rules: [{ ...rule, revision: 2, name: 'Concurrent stored rule' }] };
  state.error = 'Synthetic refresh failure';
  await render();
  expect(byLabel('Rule name for Concurrent stored rule')).toBe(name);
  expect(name.value).toBe('Local draft');
  // The inventory absorbs the concurrent write while the draft survives it.
  expect(container.querySelector(`article[data-account-id="${rule.id}"]`).getAttribute('aria-label')).toBe(
    'Concurrent stored rule'
  );
  expect(container.textContent).toContain('Synthetic refresh failure');
  state.error = null;
  await render();
  expect(byLabel('Rule name for Concurrent stored rule')).toBe(name);
  expect(name.value).toBe('Local draft');
});

it('keeps the threshold control mounted after readback and writes the revision it last read', async () => {
  let saved = { ...rule };
  const revisions = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options = {}) => {
      expect(url).toBe(`/api/admin/notification-rules/${rule.id}`);
      if (options.method === 'PUT') {
        const body = JSON.parse(options.body);
        revisions.push(body.revision);
        saved = { ...saved, ...body, id: rule.id, revision: body.revision + 1 };
        return Response.json(saved);
      }
      return Response.json({ rule: saved });
    })
  );
  await render({ advanced: true });
  const row = container.querySelector(`article[data-rule-id="${rule.id}"]`);
  const threshold = byLabel(`Threshold for ${rule.name}`);
  for (const [next, revision] of [
    [11, 2],
    [12, 3],
  ]) {
    await commit(threshold, String(next));
    expect(container.querySelector(`article[data-rule-id="${rule.id}"]`)).toBe(row);
    expect(byLabel(`Threshold for ${rule.name}`)).toBe(threshold);
    expect(container.textContent).toContain(`Threshold saved at revision ${revision}.`);
  }
  expect(revisions).toEqual([1, 2]);
});

it('keeps threshold units distinct for quota, age and counted events', async () => {
  state.data.rules = Object.values(CONDITIONS).map((condition, index) => ({
    ...rule,
    id: `rule-${index}`,
    conditionKind: condition.kind,
  }));
  await render();
  const thresholds = [...container.querySelectorAll('article[data-account-id]')].map(
    (card) =>
      [...card.querySelectorAll('span')].find((span) => span.textContent === 'Threshold')
        ?.nextElementSibling.textContent
  );
  expect(thresholds).toEqual([
    '10 regressed checks',
    '10 failed transformation stages',
    '10 percent remaining',
    '10 switches',
    '10 minutes since last observation',
    '10 failed operations',
  ]);
});

it('absorbs a concurrent revision bump by writing the revision it just read, then reads back', async () => {
  let stored = { ...rule, revision: 2, threshold: 8 };
  let racing = false;
  const seen = [];
  const fetcher = vi.fn(async (url, options = {}) => {
    if (options.method === 'PUT') {
      const body = JSON.parse(options.body);
      seen.push(body.revision);
      if (body.revision !== stored.revision)
        return Response.json(
          { error: 'Conflict', expectedRevision: stored.revision },
          { status: 409 }
        );
      stored = { ...stored, ...body, id: rule.id, revision: body.revision + 1 };
      return Response.json(stored);
    }
    const snapshot = stored;
    // A competing writer that lands between this read and the write below.
    if (racing) stored = { ...stored, revision: stored.revision + 1 };
    return Response.json({ rule: snapshot });
  });
  vi.stubGlobal('fetch', fetcher);
  // The rendered inventory still shows revision 1; the write reads first, so
  // the stored revision 2 is what it carries.
  await render({ advanced: true });
  await commit(byLabel(`Threshold for ${rule.name}`), '9');
  expect(seen).toEqual([2]);
  expect(container.textContent).toContain('Threshold saved at revision 3.');
  expect(fetcher.mock.calls.filter(([, options]) => (options.method || 'GET') === 'GET')).toHaveLength(2);

  racing = true;
  await commit(byLabel(`Threshold for ${rule.name}`), '7');
  expect(seen).toEqual([2, 3]);
  expect(container.textContent).toContain('No automatic retry was sent.');
});

it('retains an explicit acknowledgement error without retrying or declaring success', async () => {
  state.data.events = [event];
  const fetcher = vi.fn(async () =>
    Response.json({ error: 'Synthetic write unavailable' }, { status: 503 })
  );
  vi.stubGlobal('fetch', fetcher);
  await render();
  await click('Acknowledge');
  expect(container.querySelector('[role="alert"]').textContent).toContain(
    'Synthetic write unavailable'
  );
  expect(container.textContent).toContain('No automatic retry was sent');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('checks retained snooze state after the action and does not call a provider', async () => {
  state.data.events = [event];
  let stored;
  const fetcher = vi.fn(async (url, options) => {
    expect(url).toMatch(/^\/api\/admin\/notification-rules/);
    if (options.method === 'POST') {
      stored = { ...event, snoozedUntil: JSON.parse(options.body).until };
      return Response.json(stored);
    }
    return Response.json({ events: [stored] });
  });
  vi.stubGlobal('fetch', fetcher);
  await render();
  expect(byLabel(`Snooze alert on ${event.scopeKey} for 24 hours`)).not.toBeNull();
  await click('Snooze');
  expect(stored.outcome).toBe('firing');
  expect(container.textContent).toContain('Snooze retained until');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
