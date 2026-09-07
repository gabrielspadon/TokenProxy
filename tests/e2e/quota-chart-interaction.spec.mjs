import { test, expect } from 'playwright/test';
import { signIn } from './helpers.mjs';
import { CAPACITY_ECONOMICS_FIXTURE as fixture } from './capacity-economics-seed.mjs';
import { METRIC_COLORS } from '../../src/shared/workspace/metricColors.js';

test.use({ viewport: { width: 1440, height: 1000 }, actionTimeout: 10000, navigationTimeout: 10000 });

const preview = response => expect(response?.headers()['x-tokenproxy-preview-kind']).toBe('synthetic-fixture');
const fixed = { period: 'custom', start: '2026-09-07T08:00:00.000Z', end: fixture.capturedAt };

// Read visible pixels only. Never obtain an ECharts instance or dispatch chart
// actions/events. Connected marker pixels provide the physical click targets.
async function visibleMarkers(chart, includeOutsidePlot = false) {
  return chart.evaluate((element, {includeOutsidePlot,colors}) => {
    const layers = [...element.querySelectorAll('canvas')].map(canvas => {
      const bounds = canvas.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return [];
      const sx = canvas.width / bounds.width, sy = canvas.height / bounds.height;
      const width = canvas.width, height = Math.floor((bounds.height - 60) * sy);
      if (height <= 0) return [];
      const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
      const mask = new Uint8Array(width * height);
      for (let i = 0; i < mask.length; i++) {
        const offset = i * 4;
        if (pixels[offset + 3] >= 160 && colors.some(color => color.every((channel, index) => Math.abs(pixels[offset + index] - channel) <= 12))) mask[i] = 1;
      }
      const markers = [];
      for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        const stack = [i]; mask[i] = 0;
        let count = 0, minX = width, maxX = 0, minY = height, maxY = 0;
        while (stack.length) {
          const current = stack.pop(), x = current % width, y = Math.floor(current / width);
          count++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          for (const next of [x > 0 ? current - 1 : -1, x + 1 < width ? current + 1 : -1, current - width, current + width]) {
            if (next >= 0 && next < mask.length && mask[next]) { mask[next] = 0; stack.push(next); }
          }
        }
        const markerWidth = (maxX - minX + 1) / sx, markerHeight = (maxY - minY + 1) / sy;
        if (count >= 4 * sx * sy && markerWidth >= 2 && markerWidth <= 14 && markerHeight >= 2 && markerHeight <= 14) {
          markers.push({ x: (minX + maxX + 1) / (2 * sx), y: (minY + maxY + 1) / (2 * sy),
            left: minX / sx, right: (maxX + 1) / sx, top: minY / sy, bottom: (maxY + 1) / sy });
        }
      }
      if (includeOutsidePlot) return markers.sort((a, b) => a.x - b.x);
      // A grid line under a translucent circle changes that pixel's RGB and
      // splits one visible symbol into two matching components. Join only
      // overlapping horizontal extents separated by at most 2 CSS px, with a
      // combined extent no larger than the selected 11 px symbol plus edging.
      const joined = [];
      for (const marker of markers) {
        const existing = joined.find(part => Math.min(part.right, marker.right) > Math.max(part.left, marker.left)
          && Math.max(part.right, marker.right) - Math.min(part.left, marker.left) <= 14
          && Math.max(part.bottom, marker.bottom) - Math.min(part.top, marker.top) <= 14
          && Math.max(0, marker.top - part.bottom, part.top - marker.bottom) <= 2);
        if (existing) {
          existing.left = Math.min(existing.left, marker.left); existing.right = Math.max(existing.right, marker.right);
          existing.top = Math.min(existing.top, marker.top); existing.bottom = Math.max(existing.bottom, marker.bottom);
          existing.x = (existing.left + existing.right) / 2; existing.y = (existing.top + existing.bottom) / 2;
        } else joined.push({ ...marker });
      }
      // The legend can use the same marker color. Only the actual coordinate
      // grid (65/18/16/64 px in quotaObservationOption) contains observations;
      // retain a 3 px radius for the endpoint circles centered on its border.
      return joined.filter(marker => (
        marker.x >= 62 && marker.x <= bounds.width - 15
        && marker.y >= 13 && marker.y <= bounds.height - 61
      )).sort((a, b) => a.x - b.x);
    });
    return layers.sort((a, b) => b.length - a.length)[0] || [];
  }, {includeOutsidePlot,colors:[METRIC_COLORS.input,METRIC_COLORS.selected].map(color=>[1,3,5].map(offset=>parseInt(color.slice(offset,offset+2),16)))});
}

async function visibleRowIds(table) {
  return table.getByRole('button', { name: /^Inspect quota observation / }).evaluateAll(buttons =>
    buttons.map(button => button.getAttribute('aria-label').replace('Inspect quota observation ', '')));
}

async function visibleSliderHandle(chart, endpointX) {
  return chart.evaluate((element, endpointX) => [...element.querySelectorAll('canvas')].flatMap(canvas => {
    const bounds = canvas.getBoundingClientRect();
    const sx = canvas.width / bounds.width, sy = canvas.height / bounds.height;
    const left = Math.floor((endpointX - 8) * sx), top = Math.floor((bounds.height - 45) * sy);
    const width = Math.ceil(16 * sx), height = canvas.height - top;
    const pixels = canvas.getContext('2d').getImageData(left, top, width, height).data;
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < mask.length; i++) {
      const offset = i * 4;
      if (pixels[offset] >= 235 && pixels[offset + 1] >= 235 && pixels[offset + 2] >= 235 && pixels[offset + 3] >= 230) mask[i] = 1;
    }
    const handles = [];
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const stack = [i]; mask[i] = 0;
      let minX = width, maxX = 0, minY = height, maxY = 0;
      while (stack.length) {
        const current = stack.pop(), x = current % width, y = Math.floor(current / width);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        for (const next of [x > 0 ? current - 1 : -1, x + 1 < width ? current + 1 : -1, current - width, current + width]) {
          if (next >= 0 && next < mask.length && mask[next]) { mask[next] = 0; stack.push(next); }
        }
      }
      const handleWidth = (maxX - minX + 1) / sx, handleHeight = (maxY - minY + 1) / sy;
      if (handleWidth >= 1 && handleWidth <= 8 && handleHeight >= 4 && handleHeight <= 24) {
        handles.push({ x: (left + (minX + maxX + 1) / 2) / sx, y: (top + (minY + maxY + 1) / 2) / sy, width: handleWidth, height: handleHeight });
      }
    }
    return handles;
  }), endpointX);
}

async function allRowIds(analysis, table, total) {
  const ids = [];
  for (let page = 1; page <= Math.ceil(total / 10); page++) {
    if (total > 10) await analysis.getByRole('button', { name: `Quota observation page ${page}`, exact: true }).click();
    const expected = Math.min(10, total - (page - 1) * 10);
    await expect(table.locator('tbody tr')).toHaveCount(expected);
    ids.push(...await visibleRowIds(table));
  }
  return ids;
}

test('quota canvas point selection and slider zoom preserve exact contributing observations', async ({ page }, testInfo) => {
  test.setTimeout(60000);
  const receipt = { fixtureVersion: fixture.version, accountId: fixture.accountIds[0], scope: fixed, intercepted: false, interaction: 'physical-pointer-and-keyboard', stages: [] };
  let guarded = false, analysis;
  const mutations = [];
  const watch = request => { if (request.method() !== 'GET') mutations.push({ method: request.method(), path: new URL(request.url()).pathname }); };
  try {
    expect(process.env.E2E_BASE).toBeTruthy(); expect(process.env.SMOKE_PASSWORD).toBeTruthy();
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(process.env.E2E_BASE).hostname);
    preview(await page.request.get('/api/admin/health', { maxRedirects: 0 }));
    guarded = true;
    await signIn(page);
    const response = await page.request.get(`/api/admin/quota/workbench?${new URLSearchParams({ connectionId: fixture.accountIds[0], start: fixed.start, end: fixed.end })}`, { maxRedirects: 0 });
    preview(response); expect(response.status()).toBe(200);
    const workbench = await response.json();
    expect(workbench.filters.connectionId).toBe(fixture.accountIds[0]);
    const series = workbench.series.find(item => item.unit === 'USD');
    expect(series).toBeTruthy(); expect(series.points).toHaveLength(12);
    const ascending = [...series.points].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
    ascending.forEach((point, index) => {
      expect(point.id).toMatch(/^[a-f0-9]{64}$/);
      expect(point.observedAt).toBe(new Date(Date.parse(fixture.capturedAt) + (-60 + index * 5) * 60000).toISOString());
      expect(point.value).toBe(22 - index * 0.5);
    });
    receipt.windowId = series.id; receipt.unit = series.unit; receipt.originalObservationIds = ascending.map(point => point.id);
    const params = new URLSearchParams(fixed);
    params.set('selected', JSON.stringify({ kind: 'account', id: fixture.accountIds[0], windowScope: series.scope, windowId: series.id }));
    preview(await page.goto(`/dashboard?${params}`));
    await expect(page.getByRole('combobox', { name: 'Reported quota window', exact: true })).toHaveValue(/USD/);
    analysis = page.getByRole('region', { name: 'Quota observation analysis', exact: true });
    const chart = analysis.getByRole('img', { name: `Retained ${series.scope} observations in ${series.analysis.unit}. UTC observation time. Points do not establish continuous monitoring.`, exact: true });
    const table = analysis.getByRole('table', { name: 'Contributing quota observations', exact: true });
    const selected = analysis.locator('[aria-label="Selected quota observation"]');
    await expect(analysis.getByText('12 contributing records', { exact: true })).toBeVisible();
    await chart.scrollIntoViewIfNeeded();
    receipt.initialCanvasCandidates = await visibleMarkers(chart, true);
    await expect.poll(async () => (await visibleMarkers(chart)).length, { timeout: 10000 }).toBe(12);
    const markers = await visibleMarkers(chart), chosenIndex = 6, chosen = ascending[chosenIndex];
    const box = await chart.boundingBox(); expect(box).toBeTruthy();
    page.on('request', watch);
    await page.mouse.click(box.x + markers[chosenIndex].x, box.y + markers[chosenIndex].y);
    await expect(selected.locator('code')).toHaveText(chosen.id);
    const chosenButton = table.getByRole('button', { name: `Inspect quota observation ${chosen.id}`, exact: true });
    await expect(chosenButton).toHaveAttribute('aria-pressed', 'true');
    await expect(table.locator('tbody tr[data-selected="true"]')).toHaveCount(1);
    receipt.stages.push({ phase: 'canvas-point-click', observationId: chosen.id, observedAt: chosen.observedAt, value: chosen.value, marker: markers[chosenIndex] });
    await testInfo.attach('quota-canvas-point-selected.png', { body: await analysis.screenshot(), contentType: 'image/png' });

    const keyboardPoint = ascending[8];
    const keyboardButton = table.getByRole('button', { name: `Inspect quota observation ${keyboardPoint.id}`, exact: true });
    await keyboardButton.focus(); await expect(keyboardButton).toBeFocused(); await keyboardButton.press('Enter');
    await expect(selected.locator('code')).toHaveText(keyboardPoint.id);
    await expect(keyboardButton).toHaveAttribute('aria-pressed', 'true');
    await expect(chosenButton).toHaveAttribute('aria-pressed', 'false');
    receipt.stages.push({ phase: 'keyboard-row-selection', observationId: keyboardPoint.id, key: 'Enter' });

    await chart.scrollIntoViewIfNeeded();
    const dragBox = await chart.boundingBox(); expect(dragBox).toBeTruthy();
    // Read the opaque white thumb interior, avoiding its thin top stem and the
    // separate move bar. Use its rendered center for the physical resize drag.
    const handles = await visibleSliderHandle(chart, markers[0].x);
    receipt.sliderHandleCandidates = handles;
    expect(handles).toHaveLength(1);
    const start = { x: dragBox.x + handles[0].x, y: dragBox.y + handles[0].y };
    const end = { x: start.x + (markers.at(-1).x - markers[0].x) * 0.42, y: start.y };
    receipt.sliderAttempt = { chart: dragBox, handle: handles[0], start, end };
    await page.mouse.move(start.x, start.y);
    await expect.poll(() => chart.locator('canvas').last().evaluate(canvas => getComputedStyle(canvas).cursor), { timeout: 10000 }).toBe('ew-resize');
    await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 24 }); await page.mouse.up();
    const visibleAfterZoom = ascending.slice(5).toReversed().map(point => point.id);
    await expect(analysis.getByText('7 contributing records in this observation zoom', { exact: true })).toBeVisible();
    await expect(table.locator('tbody tr')).toHaveCount(7);
    await expect.poll(() => visibleRowIds(table)).toEqual(visibleAfterZoom);
    const clear = analysis.getByRole('button', { name: 'Clear observation zoom', exact: true });
    await expect(clear).toBeVisible();
    receipt.stages.push({ phase: 'physical-slider-drag', start, end, fractionalStart: 0.42, visibleObservationIds: await visibleRowIds(table) });
    await testInfo.attach('quota-canvas-zoom-filtered.png', { body: await analysis.screenshot(), contentType: 'image/png' });

    await clear.click();
    await expect(clear).toHaveCount(0);
    await expect(analysis.getByText('12 contributing records', { exact: true })).toBeVisible();
    const restoredIds = await allRowIds(analysis, table, 12);
    expect(restoredIds).toEqual(ascending.toReversed().map(point => point.id));
    receipt.stages.push({ phase: 'clear-restores-entire-population', visibleObservationIds: restoredIds });
    await analysis.getByRole('button', { name: 'Quota observation page 1', exact: true }).click();
    await chart.scrollIntoViewIfNeeded();
    await expect.poll(async () => (await visibleMarkers(chart)).length, { timeout: 10000 }).toBe(12);
    expect(mutations).toEqual([]);
    receipt.mutations = mutations; receipt.passed = true;
    await testInfo.attach('quota-canvas-zoom-cleared.png', { body: await analysis.screenshot(), contentType: 'image/png' });
  } catch (error) {
    receipt.passed = false; receipt.failure = error.message;
    if (guarded) await testInfo.attach('quota-chart-interaction-failure.png', { body: await page.screenshot({ fullPage: true, timeout: 10000 }), contentType: 'image/png' }).catch(() => {});
    throw error;
  } finally {
    page.off('request', watch);
    await testInfo.attach('quota-chart-interaction.json', { body: JSON.stringify(receipt, null, 2), contentType: 'application/json' });
  }
});
