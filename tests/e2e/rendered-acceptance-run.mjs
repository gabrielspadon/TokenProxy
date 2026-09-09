import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts = resolve(process.argv[2] || '/tmp/rendered-acceptance-evidence');
mkdirSync(artifacts, { recursive: true });
const launch = (...args) =>
  JSON.parse(
    execFileSync(process.execPath, [join(project, 'scripts/redesign-preview.mjs'), ...args], {
      cwd: project,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    })
  );

// A Next dev server compiles every visited route into one 4 GB V8 heap and
// never gives it back, which killed a single-preview sweep of ten destinations
// with an OOM. Each group therefore gets its own OWNED preview, seeded and
// stopped by this run. No group ever reuses another lane's root.
const groups = [
  {
    name: 'core',
    receipt: 'browser-receipt-core.json',
    reducedMotion: true,
    routes: [
      '/dashboard',
      '/dashboard/context',
      '/dashboard/usage',
      '/dashboard/connections',
      '/dashboard/models',
    ],
  },
  {
    name: 'supporting',
    receipt: 'browser-receipt-supporting.json',
    reducedMotion: false,
    routes: [
      '/dashboard/shaping',
      '/dashboard/keys',
      '/dashboard/tools',
      '/dashboard/notifications',
      '/dashboard/system',
    ],
  },
];
const seeds = [];
const stops = [];
const groupFailures = [];
for (const group of groups) {
  const seeded = launch('seed', '--mode', 'dev', '--scenario', 'representative');
  const marker = JSON.parse(readFileSync(join(seeded.root, 'owner.json'), 'utf8'));
  assert.equal(marker.kind, 'tokenproxy-redesign-preview-v1');
  assert.equal(marker.root, seeded.root);
  assert.equal(marker.runId, seeded.runId);
  seeds.push({ group: group.name, ...seeded, upstreamCalls: 0 });
  let started = false;
  try {
    launch('start', '--mode', 'dev', '--run', seeded.root);
    started = true;
    // A group that finds a defect must not hide the next group's state, so a
    // non-zero child exit is recorded and the sweep continues. Its receipt is
    // still written by the child and is still read into the merge below.
    try {
      execFileSync(
        process.execPath,
        [
          join(project, 'tests/e2e/rendered-acceptance.mjs'),
          seeded.root,
          artifacts,
          group.routes.join(','),
          group.receipt,
          group.reducedMotion ? 'reduced-motion' : 'skip-reduced-motion',
        ],
        { cwd: project, stdio: 'inherit', timeout: 1200000 }
      );
    } catch (error) {
      groupFailures.push({ group: group.name, status: error.status ?? null });
    }
  } finally {
    if (started) stops.push({ group: group.name, ...launch('stop', '--run', seeded.root) });
  }
}
writeFileSync(join(artifacts, 'synthetic-seed.json'), JSON.stringify(seeds, null, 2));
writeFileSync(join(artifacts, 'stopped.json'), JSON.stringify(stops, null, 2));

// One merged receipt: the union of both groups' checks, so the gate reads a
// single artifact rather than reasoning about a split.
const parts = groups.map((group) =>
  JSON.parse(readFileSync(join(artifacts, group.receipt), 'utf8'))
);
const results = parts.flatMap((part) => part.results);
const impacts = results.reduce(
  (total, result) => ({
    critical: total.critical + result.impacts.critical,
    serious: total.serious + result.impacts.serious,
    moderate: total.moderate + result.impacts.moderate,
    minor: total.minor + result.impacts.minor,
  }),
  { critical: 0, serious: 0, moderate: 0, minor: 0 }
);
const reducedMotion = parts.map((part) => part.reducedMotion).find(Boolean) ?? null;
const merged = {
  groups: groups.map((group, index) => ({
    name: group.name,
    routes: group.routes,
    receipt: group.receipt,
    runtime: parts[index].runtime,
    passed: parts[index].passed,
  })),
  destinations: parts.flatMap((part) => part.destinations),
  viewports: parts[0].viewports,
  results,
  impacts,
  keyboard: {
    checked: results.length,
    bypassLinkFirst: results.filter((result) => result.firstTabStop.bypassLink).length,
    insideLandmark: results.filter(
      (result) => result.firstTabStop.inMain || result.firstTabStop.inNav
    ).length,
  },
  reducedMotion,
  errors: parts.flatMap((part) => part.errors),
  outboundFailures: parts.flatMap((part) => part.browserGuard?.outboundFailures ?? []),
  source: parts[0].source,
  stopped: stops,
  groupFailures,
  passed:
    parts.every((part) => part.passed) &&
    results.length === groups.reduce((sum, group) => sum + group.routes.length, 0) * 3 &&
    impacts.critical === 0 &&
    impacts.serious === 0 &&
    Boolean(reducedMotion),
};
writeFileSync(join(artifacts, 'browser-receipt.json'), JSON.stringify(merged, null, 2), {
  mode: 0o600,
});
console.log(
  JSON.stringify({
    passed: merged.passed,
    checks: results.length,
    impacts,
    pageErrors: merged.errors.length,
    outboundFailures: merged.outboundFailures.length,
    previewsStopped: stops.length,
    groupFailures,
  })
);
if (!merged.passed) process.exitCode = 1;
