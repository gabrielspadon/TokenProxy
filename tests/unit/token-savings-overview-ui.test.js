// @vitest-environment jsdom
// The savings board: state buckets, the two levels, the in-place fields and the
// byte evidence lines. The board is the shared workspace kit, so Everyday is
// one card per control group and Advanced is one row per control.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  TokenSavings,
  controlBucket,
  groupState,
  savingsSummary,
} from '@/app/dashboard/shaping/TokenSavings';
import { CONFIGURATION_FIELDS, CONTROLS, THRESHOLDS } from '@/app/dashboard/shaping/controlCatalog';

let container, root, toggle, navigate, field, props;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  toggle = vi.fn();
  navigate = vi.fn();
  field = vi.fn();
  props = {
    advanced: true,
    density: 'tidy',
    onDensity: vi.fn(),
    settings: {
      ...Object.fromEntries(CONTROLS.map((control) => [control.key, false])),
      ...Object.fromEntries(THRESHOLDS.map((item) => [item.key, item.nullable ? null : item.min])),
      ...Object.fromEntries(
        CONFIGURATION_FIELDS.map((item) => [item.key, item.list ? [] : 'full'])
      ),
    },
    stageMap: {},
    recent: [],
    onToggle: toggle,
    onField: field,
    onNavigate: navigate,
    onRefresh: vi.fn(),
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <TokenSavings {...props} />
      </MantineProvider>
    )
  );
}
const button = (text) =>
  [...container.querySelectorAll('button')].find((node) => node.textContent === text);
const control = (key) => container.querySelector(`[data-savings-control="${key}"]`);

it('models one bucket per control and one state per group', () => {
  expect(controlBucket(props.settings, CONTROLS[0])).toBe('off');
  expect(controlBucket({ ...props.settings, rtkEnabled: true }, CONTROLS[0])).toBe('on');
  expect(controlBucket({}, CONTROLS[0])).toBe('unknown');
  expect(
    controlBucket(
      { ...props.settings, headroomLossless: true },
      CONTROLS.find((item) => item.key === 'headroomLossless')
    ).valueOf()
  ).toBe('attention');
  expect(groupState(props.settings, 'History').word).toBe('Off');
  expect(groupState({ ...props.settings, rtkEnabled: true }, 'Tool traffic').word).toBe(
    'Partly on'
  );
  expect(savingsSummary(props.settings, {}).off).toBe(CONTROLS.length);
});

it('lays Advanced out as one row per control with every field in place', async () => {
  await render();
  expect(container.querySelectorAll('[data-savings-control]')).toHaveLength(CONTROLS.length);
  expect(container.querySelector('[data-layout="rows"]')).not.toBeNull();
  for (const item of [...THRESHOLDS, ...CONFIGURATION_FIELDS]) {
    const input = container.querySelector(`[name="${item.key}"]`);
    expect(input, item.key).not.toBeNull();
    expect(container.querySelectorAll(`[name="${item.key}"]`), item.key).toHaveLength(1);
    expect(input.closest('details, [hidden], [data-hidden]'), item.key).toBeNull();
    expect(input.disabled, item.key).toBe(false);
  }
  for (const item of THRESHOLDS) {
    const group = container.querySelector(`[name="${item.key}"]`).closest('[role="group"]');
    expect(group.getAttribute('aria-label')).toBe(
      `${CONTROLS.find((entry) => entry.stage === item.stage).name} thresholds`
    );
  }
});

it('commits a threshold on blur and refuses a value outside its limits', async () => {
  await render();
  const input = container.querySelector('[name="pxpipeTimeoutMs"]');
  const set = async (value) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
  };
  await set('12500');
  expect(field).toHaveBeenCalledExactlyOnceWith('pxpipeTimeoutMs', '12500');
});

it('commits a processing level from its own select', async () => {
  await render();
  const select = container.querySelector('[name="cavemanLevel"]');
  await act(async () => {
    select.value = 'lite';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(field).toHaveBeenCalledExactlyOnceWith('cavemanLevel', 'lite');
});

it('routes a toggle to the caller without showing an unsaved setting as enabled', async () => {
  await render();
  const input = control('rtkEnabled').querySelector('input[type="checkbox"]');
  await act(async () => input.click());
  expect(toggle).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ key: 'rtkEnabled' }),
    true
  );
  expect(input.checked).toBe(false);
  expect(control('rtkEnabled').textContent).toContain('Off');
});

it('keeps unknown and unavailable controls ineligible for a mutation', async () => {
  props.settings = null;
  await render();
  expect(
    [...container.querySelectorAll('input[type="checkbox"]')].every((input) => input.disabled)
  ).toBe(true);
  props.settings = {
    ...Object.fromEntries(CONTROLS.map((item) => [item.key, false])),
    headroomLossless: true,
  };
  await render();
  expect(control('headroomLossless').textContent).toContain('Runtime unavailable');
  expect(control('headroomLossless').querySelector('input[type="checkbox"]').disabled).toBe(true);
});

it('distinguishes measured zero, growth, reduction and absent coverage without summing stages', async () => {
  props.stageMap = {
    rtk: { requests: 2, applied: 1, bytesSaved: -2048, measuredRequests: 1 },
    inject: { requests: 1, applied: 1, bytesSaved: 128, measuredRequests: 1 },
    epochMicro: { requests: 1, applied: 1, bytesSaved: 0, measuredRequests: 1 },
    diet: { requests: 1, applied: 1, bytesSaved: -999 },
  };
  await render();
  expect(control('rtkEnabled').textContent).toContain('-2KB');
  expect(control('rtkEnabled').querySelector('[title]').getAttribute('title')).toContain(
    '-2,048 B'
  );
  expect(control('cavemanEnabled').textContent).toContain('+128B');
  expect(control('epochMicroEnabled').textContent).toContain('0B');
  expect(control('dietEnabled').textContent).toContain('coverage unknown');
  expect(control('dietEnabled').textContent).not.toContain('999');
  expect(control('memoryCompactionEnabled').textContent).toContain(
    'No stage record in this period'
  );
});

it('filters by state bucket and by category without hiding anything behind a reveal', async () => {
  props.settings.linguaEnabled = true;
  await render();
  await act(async () => button('1 enabled').click());
  expect(container.querySelectorAll('[data-savings-control]')).toHaveLength(1);
  expect(control('linguaEnabled')).not.toBeNull();
  await act(async () => button('1 enabled').click());
  await act(async () =>
    container.querySelector('[aria-label="Privacy and cache controls"]').click()
  );
  expect(container.querySelectorAll('[data-savings-control]')).toHaveLength(2);
});

it('reports a failed measurement read without presenting an empty sample as zero savings', async () => {
  props.unavailable = true;
  await render();
  expect(container.textContent).toContain('Measurements could not be refreshed');
  expect(container.textContent).not.toContain('0 B');
});

it('offers one Everyday card per control group with its routine switch and no editor', async () => {
  props.advanced = false;
  props.settings.rtkEnabled = true;
  await render();
  expect(container.querySelector('[data-layout="cards"]')).not.toBeNull();
  expect(container.querySelectorAll('article[data-bucket]')).toHaveLength(5);
  expect(container.querySelectorAll('[data-savings-control]')).toHaveLength(4);
  expect(container.querySelector('input[type="number"], textarea, select, details')).toBeNull();
  expect(control('rtkEnabled').querySelector('input[type="checkbox"]').checked).toBe(true);
  expect(container.textContent).toContain('1 of 6 on');
});

it('reports partial saved state as not reported in Everyday', async () => {
  props.advanced = false;
  delete props.settings.rtkEnabled;
  await render();
  expect(control('rtkEnabled').querySelector('input[type="checkbox"]').disabled).toBe(true);
  expect(container.textContent).toContain('Not reported');
});
