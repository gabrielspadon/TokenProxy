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
  const outboundFailures = [];
  await page.route('**/*', async route => {
    const target = new URL(route.request().url());
    if (['data:', 'blob:'].includes(target.protocol) || target.origin === origin) return route.continue();
    outboundFailures.push({ origin: target.origin, resourceType: route.request().resourceType() });
    return route.abort('blockedbyclient');
  });
  await page.routeWebSocket('**/*', route => {
    const target = new URL(route.url());
    if (target.origin === origin.replace(/^http/, 'ws')) { route.connectToServer(); return; }
    outboundFailures.push({ origin: target.origin, resourceType: 'websocket' });
    route.close({ code: 1008, reason: 'Synthetic preview forbids outbound connections' });
  });
  const clock = operator ? OPERATOR_CLOCK : runtimeReceipt?.clock ?? null;
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
  if (fault === 'stream-interruption') await page.addInitScript(() => {
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = function(input, init) {
      const target = new URL(typeof input === 'string' ? input : input.url, location.origin);
      if (target.origin !== location.origin || target.pathname !== '/v1/chat/completions' || (init?.method || input.method || 'GET') !== 'POST') return nativeFetch.apply(this, arguments);
      const encoder = new TextEncoder();
      const stream = new ReadableStream({ start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Synthetic interrupted event. '.repeat(24) } }] })}\n\n`));
        setTimeout(() => controller.error(new Error('Synthetic browser stream interruption; no gateway request was sent.')), 25);
      } });
      return Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream', 'x-tokenproxy-preview-kind': 'synthetic-browser-fault' } }));
    };
  });
  return { fixtureVersion: operator ? 'operator-presentation-v1' : runtimeReceipt?.fixtureVersion ?? null, browserFixtureVersion: VERSION, runtimeAttribution: runtimeReceipt ? 'supplied owned runtime receipt' : 'runtime fixture version unknown; supply process.json receipt', clock, browserClock: operator || runtimeReceipt && runtimeReceipt.mode !== 'dev' ? 'anchored advancing synthetic' : 'real', persistence: !operator && !fault, outboundFailures, fault, faults };
}

export async function authenticateRedesign(context, root) {
  const process = JSON.parse(await readFile(join(root, 'process.json'), 'utf8'));
  const auth = JSON.parse(await readFile(join(root, 'preview-auth.json'), 'utf8'));
  const response = await context.request.post(`${process.url}/api/auth/login`, { data: { password: auth.initialPassword } });
  if (!response.ok()) throw new Error('Synthetic preview login failed');
  return { authenticated: true, synthetic: true };
}
