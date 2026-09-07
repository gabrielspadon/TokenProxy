// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CONDITIONS } from '@/lib/notifications/conditions.mjs';

const state = vi.hoisted(() => ({ data: {}, refresh: vi.fn() }));
vi.mock('@/shared/workspace/useResource', () => ({
  useResource: (url) => ({
    data: url?.endsWith('rule-1') ? { rule: state.data.rules[0], versions: [] } : state.data,
    loading: false,
    error: null,
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
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
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
const render = () =>
  act(async () =>
    root.render(
      <MantineProvider env="test">
        <NotificationRules />
      </MantineProvider>
    )
  );

it('closes narrow evidence details while editing and restores the selected rule on cancel', async () => {
  await render();
  await click(rule.name);
  const edit = [...document.querySelectorAll('button')].find(button => button.textContent === 'Edit rule');
  expect(edit).toBeTruthy();
  await act(async () => edit.click());
  expect(container.querySelector('form[aria-label="Notification rule editor"]')).not.toBeNull();
  expect(document.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();
  expect(container.querySelector('button[aria-pressed="true"]').textContent).toBe(rule.name);
  await click('Cancel');
  expect(container.querySelector('form[aria-label="Notification rule editor"]')).toBeNull();
  expect([...document.querySelectorAll('button')].some(button => button.textContent === 'Edit rule')).toBe(true);
});

it('keeps threshold units distinct for quota, age and counted events', async () => {
  state.data.rules = Object.values(CONDITIONS).map((condition, index) => ({
    ...rule,
    id: `rule-${index}`,
    conditionKind: condition.kind,
  }));
  await render();
  const thresholds = [...container.querySelectorAll('tbody tr')].map(
    (row) => row.children[3].textContent
  );
  expect(thresholds).toEqual([
    '10percent remaining',
    '10switches',
    '10minutes since last observation',
    '10failed operations',
  ]);
});

it('uses the explicitly loaded conflict revision, then reads back the saved rule', async () => {
  let submitted = 0;
  const fetcher = vi.fn(async (url, options) => {
    if (options.method === 'PUT') {
      const body = JSON.parse(options.body);
      submitted++;
      if (submitted === 1)
        return Response.json(
          {
            error: 'Conflict',
            expectedRevision: 1,
            current: { ...rule, revision: 2, threshold: 8 },
          },
          { status: 409 }
        );
      expect(body.revision).toBe(2);
      return Response.json({ ...rule, revision: 3 });
    }
    return Response.json({ rule: { ...rule, revision: 3 } });
  });
  vi.stubGlobal('fetch', fetcher);
  await render();
  await click(rule.name);
  await click('Edit rule');
  await act(async () =>
    container
      .querySelector('form')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  );
  expect(container.textContent).toContain('This rule was changed by someone else');
  expect(submitted).toBe(1);
  await click('Load the stored rule and start again');
  await act(async () =>
    container
      .querySelector('form')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  );
  expect(submitted).toBe(2);
  expect(container.textContent).toContain('Rule revision 3 saved and read back');
  expect(fetcher.mock.calls.some(([, options]) => options.method === 'GET')).toBe(true);
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
  await click('Snooze 24h');
  expect(stored.outcome).toBe('firing');
  expect(container.textContent).toContain('Snooze retained until');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
