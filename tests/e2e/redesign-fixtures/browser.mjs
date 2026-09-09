import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CLOCK, VERSION, BROWSER_FAULTS } from './catalog.mjs';
import { installOperatorFixture, NOW as OPERATOR_CLOCK } from '../operator-fixture.mjs';

// Call before the first navigation. The caller creates a context with
// serviceWorkers:'block', and records/asserts the returned outboundFailures.
export async function installRedesignBrowser(page, { baseUrl, operator = false, runtimeReceipt = null, fault = null }) {
  const origin = new URL(baseUrl).origin;
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('A launcher loopback URL is required');
  if (runtimeReceipt && new URL(runtimeReceipt.url).origin !== origin) throw new Error('Runtime receipt belongs to another preview');
  if (fault && !BROWSER_FAULTS[fault]) throw new Error('Unknown browser fault scenario');
  // Dev-mode previews compile a route on first hit, which outruns Playwright's 30s
  // navigation default. Raise only the NAVIGATION timeout, and only for dev receipts.
  // 120s does NOT sit under every caller's budget: playwright.config.mjs sets a 30s
  // per-test timeout and most spec callers never raise it, so in those the test budget
  // expires first and the failure reads as a test timeout rather than a named URL. The
  // callers that do set test.setTimeout (60s-180s) are the ones that get the named-URL
  // failure. 120s is still the right navigation ceiling, because it is under every
  // runner-level execFileSync budget (240s at the smallest), so a wedged compile is
  // reported by this preview rather than by the runner killing the whole child. The
  // action timeout is left alone: callers set their own before calling this, and
  // overriding it here would silently widen every subsequent locator wait.
  if (runtimeReceipt?.mode === 'dev') page.setDefaultNavigationTimeout(120000);
  const outboundFailures = [];
  // A route handler is not asked about the TARGET of a redirect: Chromium follows the hop
  // itself, so a same-origin URL answering 302 with an off-origin Location reaches that
  // third party with the handler never firing. Verified on playwright 1.62.1 against two
  // loopback servers: the handler saw only the first URL and the page landed on the other
  // origin at 200. The request listener DOES fire for the target, carrying redirectedFrom,
  // so the leak is at least recorded rather than silent.
  // ponytail: records, does not block. Blocking needs route.fetch({maxRedirects:20}) as a
  // pre-flight probe on every GET, which re-issues each navigation and would double a dev
  // preview's cold-compile work (measured 8-30s per start). Add it if a fixture ever needs
  // the redirect BLOCKED rather than reported.
  page.on('request', request => {
    const from = request.redirectedFrom();
    if (!from) return;
    const target = new URL(request.url());
    if (['data:', 'blob:'].includes(target.protocol) || target.origin === origin) return;
    outboundFailures.push({ origin: target.origin, resourceType: request.resourceType(), viaRedirectFrom: from.url(), blocked: false });
  });
  await page.route('**/*', async route => {
    const target = new URL(route.request().url());
    if (['data:', 'blob:'].includes(target.protocol) || target.origin === origin) return route.continue();
    outboundFailures.push({ origin: target.origin, resourceType: route.request().resourceType(), blocked: true });
    return route.abort('blockedbyclient');
  });
  await page.routeWebSocket('**/*', route => {
    const target = new URL(route.url());
    if (target.origin === origin.replace(/^http/, 'ws')) { route.connectToServer(); return; }
    outboundFailures.push({ origin: target.origin, resourceType: 'websocket' });
    route.close({ code: 1008, reason: 'Synthetic preview forbids outbound connections' });
  });
  const clock = operator ? OPERATOR_CLOCK : runtimeReceipt?.clock ?? null;
  // Date.parse of an unparseable clock is NaN, and the proxy below would then hand every
  // in-page `new Date()` a NaN timestamp instead of throwing. Fail here, where the bad
  // value is still visible, rather than in a screenshot full of "Invalid Date".
  if (clock !== null && Number.isNaN(Date.parse(clock))) throw new Error(`Fixture clock is not a parseable date: ${clock}`);
  if (operator || runtimeReceipt && runtimeReceipt.mode !== 'dev') await page.addInitScript(({ clock }) => {
    const NativeDate = Date;
    const timestamp = NativeDate.parse(clock);
    const started = performance.now();
    const now = () => timestamp + Math.max(0, performance.now() - started);
    globalThis.Date = new Proxy(NativeDate, {
      construct(target, args, receiver) { return Reflect.construct(target, args.length ? args : [now()], receiver); },
      apply() { return new NativeDate(now()).toString(); },
      get(target, key, receiver) { return key === 'now' ? now : Reflect.get(target, key, receiver); },
    });
  }, { clock });
  if (operator) await installOperatorFixture(page);
  const faults = [];
  if (fault === 'broken-logo') await page.route(`${origin}/providers/openai.png`, async route => { faults.push({ kind: fault }); await route.fulfill({ status: 404, body: '' }); });
  if (fault === 'version-conflict') await page.route(`${origin}/api/admin/configuration/drafts/*`, async route => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    faults.push({ kind: fault });
    return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic draft revision changed.', code: 'draft_revision_conflict', currentRevision: 2, source: 'synthetic-browser-fault' }) });
  });
  if (fault === 'interrupted-activation') await page.route(`${origin}/api/admin/configuration/drafts/*/activate`, async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const response = await route.fetch();
    faults.push({ kind: fault, gatewayStatus: response.status(), result: 'Local handler completed but browser response deliberately lost; inspect retained receipt before any retry.' });
    return route.abort('connectionreset');
  });
  if (fault === 'stream-interruption') {
    // addInitScript runs in the page, so it cannot touch this Node-side array. Without a
    // binding back, `faults` stays empty for this scenario alone and a caller asserting on
    // it reads a fired fault as one that never happened.
    await page.exposeFunction('__redesignRecordFault', record => { faults.push(record); });
    await page.addInitScript(() => {
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = function(input, init) {
        const target = new URL(typeof input === 'string' ? input : input.url, location.origin);
        // `new Request(url, {method:'post'})` normalizes the method, a bare init object does
        // not, so a caller passing lowercase would otherwise slip past the fault unmodified.
        const method = (init?.method ?? input.method ?? 'GET').toUpperCase();
        if (target.origin !== location.origin || target.pathname !== '/v1/chat/completions' || method !== 'POST') return nativeFetch.apply(this, arguments);
        const encoder = new TextEncoder();
        const stream = new ReadableStream({ start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Synthetic interrupted event. '.repeat(24) } }] })}\n\n`));
          setTimeout(() => controller.error(new Error('Synthetic browser stream interruption; no gateway request was sent.')), 25);
        } });
        // Reporting the fault must never be what breaks the page: a navigation racing this
        // call rejects the binding, and an unhandled rejection here would fail the test for
        // a reason that has nothing to do with the fault under test.
        globalThis.__redesignRecordFault({ kind: 'stream-interruption', result: 'One synthetic event delivered, then the stream errored; no gateway request was sent.' }).catch(() => {});
        return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream', 'x-tokenproxy-preview-kind': 'synthetic-browser-fault' } }));
      };
    });
  }
  return { fixtureVersion: operator ? 'operator-presentation-v1' : runtimeReceipt?.fixtureVersion ?? null, browserFixtureVersion: VERSION, runtimeAttribution: runtimeReceipt ? 'supplied owned runtime receipt' : 'runtime fixture version unknown; supply process.json receipt', clock, browserClock: operator || runtimeReceipt && runtimeReceipt.mode !== 'dev' ? 'anchored advancing synthetic' : 'real', persistence: !operator && !fault, outboundFailures, fault, faults };
}

export async function authenticateRedesign(context, root) {
  const process = JSON.parse(await readFile(join(root, 'process.json'), 'utf8'));
  const auth = JSON.parse(await readFile(join(root, 'preview-auth.json'), 'utf8'));
  const response = await context.request.post(`${process.url}/api/auth/login`, { data: { password: auth.initialPassword } });
  if (!response.ok()) throw new Error('Synthetic preview login failed');
  return { authenticated: true, synthetic: true };
}
