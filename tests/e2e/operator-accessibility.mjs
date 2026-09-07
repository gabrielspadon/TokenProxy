import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { credentiallessDatabase } from './capacity-economics-fixture-guard.mjs';

// Run against the isolated runtime after the mutation suites have finished.
// The only write request is sign-in. Response data is never replaced.
for (const variable of ['E2E_BASE', 'TOKENPROXY_PRIVATE_PREVIEW', 'EVIDENCE_DIR']) {
  assert(process.env[variable], `Set ${variable} explicitly for the private fixture audit`);
}
const base = new URL(process.env.E2E_BASE);
assert(['http:', 'https:'].includes(base.protocol), 'The preview must use HTTP or HTTPS');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'The audit is loopback-only');
assert(!base.username && !base.password && !base.search && !base.hash && base.pathname === '/',
  'E2E_BASE must contain only the loopback origin');
const root = await realpath(process.env.TOKENPROXY_PRIVATE_PREVIEW);
assert.equal(path.resolve(process.env.TOKENPROXY_PRIVATE_PREVIEW), root,
  'The private fixture root must be canonical');
const authPath = path.join(root, 'preview-auth.json');
assert.equal(await realpath(authPath), authPath, 'The private auth file cannot be a symlink');
const auth = JSON.parse(await readFile(authPath, 'utf8'));
assert(typeof auth.initialPassword === 'string' && auth.initialPassword, 'Private sign-in is missing');
assert(typeof auth.dbEncryptionKey === 'string' && auth.dbEncryptionKey, 'Private fixture key is missing');
const fixtureDatabase = () => credentiallessDatabase({
  dataDir: path.join(root, 'runtime', 'db'), fixtureRoot: root, key: auth.dbEncryptionKey,
});
function accountIdentities() {
  const db = fixtureDatabase();
  try {
    return db.prepare('SELECT id, provider FROM providerConnections ORDER BY id').all()
      .map(({ id, provider }) => ({ id, provider }));
  } finally { db.close(); }
}
const identities = accountIdentities();
const output = path.resolve(process.env.EVIDENCE_DIR);
const runtimeRoot = path.join(root, 'runtime');
assert(output.startsWith(`${root}${path.sep}`) && output !== runtimeRoot && !output.startsWith(`${runtimeRoot}${path.sep}`),
  'Evidence must be in a dedicated directory under the private fixture root');
process.umask(0o077);
await mkdir(output, { recursive: true, mode: 0o700 });
assert.equal(await realpath(output), output, 'Evidence must not escape through a symlink');

const viewports = [{ width: 1440, height: 1000 }, { width: 1920, height: 1080 }, { width: 390, height: 844 }];
const routes = [
  ['/dashboard', 'Capacity book'],
  ['/dashboard/context', 'Context trace'],
  ['/dashboard/usage', 'Economics'],
  ['/dashboard/connections', 'Connections'],
  ['/dashboard/connections/capacity-fixture-a', 'Synthetic research account'],
  ['/dashboard/models', 'Models'],
  ['/dashboard/sessions', 'Sessions'],
  ['/dashboard/keys', 'Keys'],
  ['/dashboard/network', 'Network'],
  ['/dashboard/shaping', 'Optimization'],
  ['/dashboard/model-context', 'Context windows'],
  ['/dashboard/compatibility', 'Compatibility'],
  ['/dashboard/translation', 'Translation'],
  ['/dashboard/notifications', 'Notifications'],
  ['/dashboard/access', 'Access'],
  ['/dashboard/tools', 'Tools'],
  ['/dashboard/remote', 'Remote'],
  ['/dashboard/system', 'System'],
];
// These GET handlers can inspect host processes or contact a registry. Their
// unavailable state is audited; those capabilities are outside this run.
const excludedReads = new Set(['/api/tunnel/tailscale-check', '/api/version']);
const unsafeRead = /\/(?:test|probe|send|refresh|install|start|stop|restart|reset|reveal|database)(?:\/|$)/;
const report = {
  fixture: 'operator-workspace-v2', accountCount: identities.length,
  responseDataReplaced: false, reducedMotion: 'reduce',
  excludedReads: [...excludedReads], checks: [], pageErrors: [], blockedRequests: [], httpErrors: [],
};
const redact = value => [auth.initialPassword, auth.dbEncryptionKey]
  .reduce((text, secret) => text.split(secret).join('[redacted]'), String(value));
let active = null;
let browser;
let page;
const pending = new Set();

function assertSynthetic(response) {
  assert(response, 'The isolated preview did not return a response');
  assert.equal(response.headers()['x-tokenproxy-preview-kind'], 'synthetic-fixture',
    'The response is outside the synthetic fixture preview');
}
async function readJson(context, resource) {
  const response = await context.request.get(new URL(resource, base).href, { maxRedirects: 0 });
  assertSynthetic(response);
  assert.equal(response.status(), 200, `Fixture read failed for ${resource}`);
  return response.json();
}
async function settle() {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const deadline = Date.now() + 10000;
  while (pending.size && Date.now() < deadline) await page.waitForTimeout(50);
  assert.equal(pending.size, 0, 'Initial local reads did not settle within 10 seconds');
  await page.waitForTimeout(200); // Finish layout and chart rendering after the readbacks.
}
async function capture(check, suffix = '') {
  const filename = `${check.route.replace(/^\/dashboard/, 'workspace').replaceAll('/', '-')}-${check.viewport.width}x${check.viewport.height}${suffix}.png`;
  await page.screenshot({ path: path.join(output, filename), fullPage: true, timeout: 15000 });
  check.screenshot = filename;
}
async function inspectLayout(check) {
  await settle();
  check.layout = await page.evaluate(() => {
    const heading = document.querySelector('h1')?.getBoundingClientRect();
    const inspector = document.querySelector('aside[aria-label="Selection details"]')?.getBoundingClientRect();
    return {
      viewportWidth: innerWidth, viewportHeight: innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      scrollX, scrollY, headingTop: heading?.top ?? null, headingBottom: heading?.bottom ?? null,
      inspectorBounds: inspector ? { x: inspector.x, y: inspector.y, width: inspector.width,
        height: inspector.height, top: inspector.top, bottom: inspector.bottom } : null,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      verticalOverflow: document.documentElement.scrollHeight > innerHeight + 1,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      direction: getComputedStyle(document.documentElement).direction,
    };
  });
  if (check.viewport.width >= 1440 && ['/dashboard', '/dashboard/context', '/dashboard/usage'].includes(check.route)) {
    const layout = check.layout;
    const inspector = layout.inspectorBounds;
    check.desktopLensFits = !layout.verticalOverflow && Math.abs(layout.scrollY) <= 1
      && layout.headingTop >= 0 && layout.headingBottom <= layout.viewportHeight
      && (!inspector || (inspector.top >= 0 && inspector.bottom <= layout.viewportHeight + 1));
  }
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  check.violations = axe.violations.map(violation => ({
    id: violation.id, impact: violation.impact,
    nodes: violation.nodes.map(node => ({ target: node.target, summary: redact(node.failureSummary) })),
  }));
  await capture(check, check.state ? `-${check.state}` : '');
}

try {
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: viewports[0], reducedMotion: 'reduce', locale: 'en-US', serviceWorkers: 'block',
  });
  const gate = await context.request.get(new URL('/api/admin/health', base).href, { maxRedirects: 0 });
  assertSynthetic(gate); // Verify isolation before transmitting the private password.
  const login = await context.request.post(new URL('/api/auth/login', base).href, {
    data: { password: auth.initialPassword }, maxRedirects: 0,
  });
  assertSynthetic(login);
  assert.equal(login.status(), 200, 'Private preview sign-in failed');
  const providers = await readJson(context, '/api/providers');
  assert.deepEqual(providers.connections.map(({ id, provider }) => ({ id, provider }))
    .sort((a, b) => a.id.localeCompare(b.id)), identities,
  'The runtime must expose exactly the verified credentialless fixture accounts');
  report.isolationVerified = true;

  // Abort disallowed requests without fulfilling or altering any response.
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const excluded = url.origin === base.origin && excludedReads.has(url.pathname);
    const forbidden = url.origin !== base.origin || !['GET', 'HEAD'].includes(request.method())
      || url.pathname.startsWith('/v1/') || unsafeRead.test(url.pathname) || url.pathname === '/api/pxpipe/health';
    if (excluded || forbidden) {
      report.blockedRequests.push({ route: active?.route, viewport: active?.viewport,
        method: request.method(), path: url.origin === base.origin ? url.pathname : '[external origin]', expected: excluded });
      await route.abort('blockedbyclient');
    } else await route.continue();
  });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.pageErrors.push({ route: active?.route,
    viewport: active?.viewport, message: redact(error.message) }));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === base.origin && url.pathname.startsWith('/api/')
      && !url.pathname.endsWith('/stream') && request.resourceType() !== 'eventsource') pending.add(request);
  });
  page.on('requestfinished', request => pending.delete(request));
  page.on('requestfailed', request => pending.delete(request));
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === base.origin && response.status() >= 400) report.httpErrors.push({
      route: active?.route, viewport: active?.viewport, path: url.pathname, status: response.status(),
    });
  });

  // Core lenses finish at all three sizes before the supporting routes begin.
  for (const [route, heading] of routes) {
    for (const viewport of viewports) {
      const check = { route, viewport };
      active = check;
      report.checks.push(check);
      try {
        await page.setViewportSize(viewport);
        const response = await page.goto(new URL(route, base).href, { waitUntil: 'domcontentloaded' });
        assertSynthetic(response);
        assert.equal(response.status(), 200, 'The dashboard route did not load');
        await page.getByRole('heading', { name: heading, exact: true, level: 1 }).waitFor();
        await inspectLayout(check);
        if (route === '/dashboard') {
          const book = page.getByRole('table', { name: 'Configured account capacity' });
          await book.waitFor();
          const account = book.getByRole('button', { name: 'Synthetic research account', exact: true });
          await account.focus();
          assert(await account.evaluate(element => document.activeElement === element), 'Account must receive keyboard focus');
          await page.keyboard.press('Enter');
          await page.getByRole('complementary', { name: 'Selection details' }).waitFor();
          assert.equal(await book.locator('tbody tr[aria-current="true"]').count(), 1,
            'Keyboard inspection must identify exactly one selected account');
          const selected = { route, viewport, state: 'keyboard-inspector' };
          active = selected;
          report.checks.push(selected);
          const dock = page.getByRole('complementary', { name: 'Selection details' });
          const separator = page.getByRole('separator', { name: 'Resize detail panel', exact: true });
          await separator.focus();
          assert(await separator.evaluate(element => document.activeElement === element),
            'The resize separator must receive keyboard focus');
          const before = await dock.boundingBox();
          assert(before && before.height > 0, 'The selected detail panel must have visible bounds');
          await page.keyboard.press('ArrowUp');
          await page.waitForFunction(height =>
            document.querySelector('aside[aria-label="Selection details"]').getBoundingClientRect().height > height + 1,
          before.height);
          const after = await dock.boundingBox();
          assert(after.height > before.height + 1, 'ArrowUp must enlarge the selected detail panel');
          selected.keyboardResize = { key: 'ArrowUp', beforeHeight: before.height, afterHeight: after.height };
          await inspectLayout(selected);
          await page.getByRole('button', { name: 'Close selection details', exact: true }).click();
          await page.getByRole('complementary', { name: 'Selection details' }).waitFor({ state: 'hidden' });
          if (viewport.width === 390) {
            // Direction-only layout coverage, not a translated locale claim.
            await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
            const rtl = { route, viewport, state: 'rtl-layout' };
            active = rtl;
            report.checks.push(rtl);
            await inspectLayout(rtl);
          }
        }
      } catch (error) {
        active.failure = redact(error.message);
        await capture(active, '-failure').catch(() => { active.screenshotUnavailable = true; });
      }
    }
  }
  assert.deepEqual(accountIdentities(), identities, 'Fixture account identities changed during the read-only audit');
} catch (error) {
  report.failure = redact(error.message);
} finally {
  await browser?.close();
  report.summary = {
    routeViewports: report.checks.filter(check => !check.state).length,
    expectedRouteViewports: routes.length * viewports.length,
    extraStates: report.checks.filter(check => check.state).length,
    failures: report.checks.filter(check => check.failure).length,
    violations: report.checks.reduce((sum, check) => sum + (check.violations?.length || 0), 0),
    overflowingStates: report.checks.filter(check => check.layout?.overflow).length,
    desktopLensOverflowingStates: report.checks.filter(check => check.desktopLensFits === false).length,
    pageErrors: report.pageErrors.length, httpErrors: report.httpErrors.length,
    unexpectedRequestsBlocked: report.blockedRequests.filter(request => !request.expected).length,
  };
  report.passed = !report.failure && report.summary.routeViewports === report.summary.expectedRouteViewports
    && report.summary.extraStates === 4 && report.checks.every(check => check.layout?.reducedMotion)
    && ['failures', 'violations', 'overflowingStates', 'desktopLensOverflowingStates', 'pageErrors', 'httpErrors', 'unexpectedRequestsBlocked']
      .every(key => report.summary[key] === 0);
  await writeFile(path.join(output, 'accessibility-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, ...report.summary }));
  if (!report.passed) process.exitCode = 1;
}
