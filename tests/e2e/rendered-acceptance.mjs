import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { authenticateRedesign, installRedesignBrowser } from './redesign-fixtures/browser.mjs';
import { sourceManifest } from '../../scripts/redesign-preview.mjs';

const root = process.argv[2],
  artifacts = process.argv[3],
  only = (process.argv[4] || '').split(',').filter(Boolean),
  receiptName = process.argv[5] || 'browser-receipt.json',
  wantsReducedMotion = process.argv[6] !== 'skip-reduced-motion';
assert.ok(
  root && artifacts,
  'Usage: rendered-acceptance.mjs <ownedPreviewRoot> <artifactsDir> [routes] [receipt] [skip-reduced-motion]'
);
const runtime = JSON.parse(await readFile(join(root, 'process.json'), 'utf8'));
const owner = JSON.parse(await readFile(join(root, 'owner.json'), 'utf8'));
assert.equal(runtime.runId, owner.runId, 'Preview receipt must belong to the owned run');
assert.equal(owner.kind, 'tokenproxy-redesign-preview-v1');
await mkdir(artifacts, { recursive: true });

// Each destination names the level-1 heading that proves its own content
// rendered. Every marker was read off the rendered page, not the file: /dashboard
// renders "Capacity", /dashboard/usage renders "Economics", /dashboard/shaping
// renders "Token savings", and /dashboard/models renders "Models" from
// src/shared/models-policy/ModelsPolicy.js rather than from its route file.
const destinations = [
  { route: '/dashboard', label: 'Capacity', heading: 'Capacity', level: 1 },
  { route: '/dashboard/context', label: 'Context trace', heading: 'Context trace', level: 1 },
  { route: '/dashboard/usage', label: 'Economics', heading: 'Economics', level: 1 },
  { route: '/dashboard/connections', label: 'Connections', heading: 'Connections', level: 1 },
  { route: '/dashboard/models', label: 'Models', heading: 'Models', level: 1 },
  { route: '/dashboard/shaping', label: 'Token savings', heading: 'Token savings', level: 1 },
  { route: '/dashboard/keys', label: 'Keys', heading: 'Keys', level: 1 },
  { route: '/dashboard/tools', label: 'Tools', heading: 'Tools', level: 1 },
  { route: '/dashboard/notifications', label: 'Notifications', heading: 'Notifications', level: 1 },
  { route: '/dashboard/system', label: 'System', heading: 'System', level: 1 },
];
const viewports = [
  { width: 1440, height: 1000 },
  { width: 1920, height: 1080 },
  { width: 390, height: 844 },
];
// A Next dev server compiles each route into the same 4 GB V8 heap and never
// releases it, so ten destinations exhaust one preview. The sweep runs in
// groups, each against its own owned preview, and the groups are merged.
const scope = only.length
  ? destinations.filter((destination) => only.includes(destination.route))
  : destinations;
assert.equal(scope.length, only.length || destinations.length, 'Unknown destination requested');
const shot = (route, width) =>
  `${route === '/dashboard' ? 'capacity' : route.replace('/dashboard/', '')}-${width}.png`;

const browser = await chromium.launch({ headless: true });
const results = [];
const errors = [];
let guard, reducedMotion, keyboard;
try {
  const context = await browser.newContext({
    serviceWorkers: 'block',
    viewport: viewports[0],
    timezoneId: 'UTC',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  guard = await installRedesignBrowser(page, { baseUrl: runtime.url, runtimeReceipt: runtime });
  page.on('pageerror', (error) => errors.push({ url: page.url(), message: error.message }));
  // Local readbacks are tracked so a screenshot is taken after the controls
  // exist, not while the page still reads "Reading configured accounts...".
  // Streams are excluded because they never finish by design.
  const pending = new Set();
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      url.origin === runtime.url &&
      url.pathname.startsWith('/api/') &&
      !url.pathname.endsWith('/stream') &&
      request.resourceType() !== 'eventsource'
    )
      pending.add(request);
  });
  for (const event of ['requestfinished', 'requestfailed'])
    page.on(event, (request) => pending.delete(request));
  await authenticateRedesign(context, root);

  async function settle() {
    const deadline = Date.now() + 45000;
    // Requests started before this navigation belong to the previous page.

    while (pending.size && Date.now() < deadline) await page.waitForTimeout(100);
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    // Charts and tables lay out one frame after their data lands.
    await page.waitForTimeout(400);
    // A background poll that never resolves is named rather than asserted to
    // zero, so the receipt says exactly what was still open at capture.
    return {
      pendingReadsAtCapture: pending.size,
      pendingPaths: [...pending].map((request) => new URL(request.url()).pathname),
    };
  }
  async function open(route, heading, level) {
    pending.clear();
    const response = await page.goto(`${runtime.url}${route}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: heading, exact: true, level }).first().waitFor();
    await page.locator('#main').waitFor();
    // A destination renders its own role="status" placeholder until its data
    // arrives, so wait for every one of them to clear rather than naming one.
    // The wait is bounded; a placeholder that survives it fails the assertion
    // at capture rather than being quietly tolerated.
    await page
      .waitForFunction(
        () =>
          ![...document.querySelectorAll('[role="status"]')].some((node) =>
            /^(Loading|Reading)\b/.test(node.textContent.trim())
          ),
        undefined,
        { timeout: 60000 }
      )
      .catch(() => {});
    return response;
  }
  for (const destination of scope) {
    // The dev server compiles a route on its first visit, so that visit races
    // its own readbacks and captures a "Reading configured accounts..." frame.
    // One discarded warm-up per destination removes the compile from the
    // measured passes; it asserts nothing and produces no evidence.
    await page.setViewportSize(viewports[0]);
    await open(destination.route, destination.heading, destination.level);
    await settle();
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      const response = await open(destination.route, destination.heading, destination.level);
      assert.equal(response.status(), 200, `${destination.route} did not load`);
      const settled = await settle();
      const layout = await page.evaluate(() => ({
        innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        fits: document.documentElement.scrollWidth <= innerWidth,
        headingOne: [...document.querySelectorAll('h1')].map((node) => node.textContent.trim()),
        // A background poll can stay open forever, so "loaded" is judged on what
        // the page shows rather than on the request count: any visible status
        // line still reading Loading/Reading means the capture is premature.
        loadingPlaceholders: [...document.querySelectorAll('[role="status"]')]
          .map((node) => node.textContent.trim())
          .filter(
            (text) =>
              /^(Loading|Reading)\b/.test(text) ||
              /(Loading|Reading)[^.]*(\u2026|\.\.\.)$/.test(text)
          ),
        interactiveControls: document.querySelectorAll(
          '#main button, #main a[href], #main input, #main select, #main [role="button"]'
        ).length,
      }));
      assert.deepEqual(
        layout.loadingPlaceholders,
        [],
        `Capture on ${destination.route} at ${viewport.width} still shows a loading placeholder`
      );
      assert.ok(
        layout.interactiveControls > 0,
        `No interactive control inside main on ${destination.route} at ${viewport.width}`
      );
      assert.equal(
        layout.fits,
        true,
        `Horizontal document overflow on ${destination.route} at ${viewport.width}: scrollWidth ${layout.scrollWidth} > innerWidth ${layout.innerWidth}`
      );
      const scan = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      const violations = scan.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        helpUrl: violation.helpUrl,
        targets: violation.nodes.map((node) => node.target.join(' ')),
        // The failure summary carries the measured contrast ratio and the
        // colours axe sampled, which is what a source fix needs.
        nodes: violation.nodes.map((node) => ({
          target: node.target.join(' '),
          html: node.html,
          summary: node.failureSummary,
        })),
      }));
      const impacts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
      for (const violation of violations)
        for (const _ of violation.targets) impacts[violation.impact ?? 'minor'] += 1;
      const screenshot = shot(destination.route, viewport.width);
      await page.screenshot({ path: join(artifacts, screenshot), fullPage: true });
      // Tab once from the document body: the first stop must be visible and
      // must either sit inside the main or navigation landmark, or be the
      // bypass-blocks link that moves focus into main (WCAG 2.4.1). A fresh
      // navigation already leaves the body focused, so no synthetic reset is
      // needed; a click or blur would move the sequential origin instead.
      assert.equal(
        await page.evaluate(() => document.activeElement === document.body),
        true,
        `Focus did not start on the body for ${destination.route} at ${viewport.width}`
      );
      await page.keyboard.press('Tab');
      const focus = await page.evaluate(() => {
        const node = document.activeElement;
        if (!node || node === document.body) return null;
        const bounds = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          tag: node.tagName.toLowerCase(),
          text: (node.textContent || '').trim().slice(0, 60),
          href: node.getAttribute('href'),
          inMain: Boolean(node.closest('#main, main, [role="main"]')),
          inNav: Boolean(node.closest('nav, [role="navigation"]')),
          rendered:
            bounds.width > 0 &&
            bounds.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            Number(style.opacity) > 0,
          onScreen: bounds.top >= 0 && bounds.left >= 0 && bounds.bottom <= innerHeight + 1,
        };
      });
      assert.ok(focus, `Tab from body reached nothing on ${destination.route}`);
      assert.equal(focus.rendered, true, `First tab stop is not visible on ${destination.route}`);
      assert.equal(
        focus.onScreen,
        true,
        `First tab stop is off-screen on ${destination.route} at ${viewport.width}`
      );
      const bypass = focus.href === '#main';
      assert.ok(
        focus.inMain || focus.inNav || bypass,
        `First tab stop on ${destination.route} is outside main and nav and is not a bypass link: ${JSON.stringify(focus)}`
      );
      if (bypass) {
        await page.keyboard.press('Enter');
        const landed = await page.evaluate(
          () => document.activeElement?.id === 'main' || location.hash === '#main'
        );
        assert.equal(landed, true, `Bypass link did not reach main on ${destination.route}`);
      }
      results.push({
        route: destination.route,
        label: destination.label,
        viewport,
        layout,
        settled,
        impacts,
        violations,
        screenshot,
        firstTabStop: { ...focus, bypassLink: bypass },
      });
    }
  }
  // Reduced motion is compared against the default context on one destination.
  if (wantsReducedMotion) {
    await page.setViewportSize(viewports[0]);
    await open('/dashboard', 'Capacity', 1);
    await settle();
    const readAnimations = (target) =>
      target.evaluate(() =>
        document.getAnimations().map((animation) => ({
          state: animation.playState,
          name: animation.animationName ?? animation.transitionProperty ?? null,
        }))
      );
    const defaultAnimations = await readAnimations(page);
    const reduced = await browser.newContext({
      serviceWorkers: 'block',
      viewport: viewports[0],
      timezoneId: 'UTC',
      reducedMotion: 'reduce',
    });
    const reducedPage = await reduced.newPage();
    reducedPage.setDefaultTimeout(60000);
    const reducedGuard = await installRedesignBrowser(reducedPage, {
      baseUrl: runtime.url,
      runtimeReceipt: runtime,
    });
    reducedPage.on('pageerror', (error) =>
      errors.push({ url: reducedPage.url(), message: error.message })
    );
    await authenticateRedesign(reduced, root);
    await reducedPage.goto(`${runtime.url}/dashboard`, { waitUntil: 'domcontentloaded' });
    await reducedPage.getByRole('heading', { name: 'Capacity', exact: true, level: 1 }).waitFor();
    await reducedPage.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const reducedQuery = await reducedPage.evaluate(
      () => matchMedia('(prefers-reduced-motion: reduce)').matches
    );
    assert.equal(
      reducedQuery,
      true,
      'The reduced-motion context must report the reduce preference'
    );
    const reducedAnimations = await readAnimations(reducedPage);
    const running = reducedAnimations.filter((animation) => animation.state === 'running');
    assert.deepEqual(
      running,
      [],
      `Reduced motion still has running animations: ${JSON.stringify(running)}`
    );
    await reducedPage.screenshot({
      path: join(artifacts, 'capacity-1440-reduced-motion.png'),
      fullPage: true,
    });
    assert.deepEqual(
      reducedGuard.outboundFailures,
      [],
      'Reduced-motion context attempted outbound requests'
    );
    reducedMotion = {
      route: '/dashboard',
      viewport: viewports[0],
      prefersReducedMotion: reducedQuery,
      defaultContextAnimations: defaultAnimations,
      reducedContextAnimations: reducedAnimations,
      runningUnderReduce: running.length,
      screenshot: 'capacity-1440-reduced-motion.png',
    };
  }
  keyboard = {
    checked: results.length,
    bypassLinkFirst: results.filter((result) => result.firstTabStop.bypassLink).length,
    insideLandmark: results.filter(
      (result) => result.firstTabStop.inMain || result.firstTabStop.inNav
    ).length,
  };
  assert.deepEqual(guard.outboundFailures, [], 'The audit attempted outbound requests');
  assert.deepEqual(errors, [], 'Page errors were collected');
} finally {
  const impacts = results.reduce(
    (total, result) => ({
      critical: total.critical + result.impacts.critical,
      serious: total.serious + result.impacts.serious,
      moderate: total.moderate + result.impacts.moderate,
      minor: total.minor + result.impacts.minor,
    }),
    { critical: 0, serious: 0, moderate: 0, minor: 0 }
  );
  const receipt = {
    runtime,
    destinations: scope.map((destination) => destination.route),
    viewports,
    results,
    impacts,
    keyboard: keyboard ?? null,
    reducedMotion: reducedMotion ?? null,
    errors,
    browserGuard: guard ?? null,
    source: await sourceManifest(),
    passed:
      results.length === scope.length * viewports.length &&
      errors.length === 0 &&
      impacts.critical === 0 &&
      impacts.serious === 0 &&
      (!wantsReducedMotion || Boolean(reducedMotion)) &&
      Boolean(keyboard) &&
      results.every((result) => result.layout.fits),
  };
  await writeFile(join(artifacts, receiptName), JSON.stringify(receipt, null, 2), {
    mode: 0o600,
  });
  await browser.close();
  console.log(
    JSON.stringify({
      passed: receipt.passed,
      checks: results.length,
      expected: scope.length * viewports.length,
      impacts,
      pageErrors: errors.length,
      outboundFailures: guard?.outboundFailures.length ?? null,
      runningAnimationsUnderReduce: reducedMotion?.runningUnderReduce ?? null,
    })
  );
  if (!receipt.passed) process.exitCode = 1;
}
