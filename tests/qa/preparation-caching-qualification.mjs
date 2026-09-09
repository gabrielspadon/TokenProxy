// P07 qualification: PERFORMANCE-DELIVERY item 5, deterministic preparation
// caching. Runs the suites that constrain identical-attempt preparation, cache
// key scope, cache bounds and measurement/serialization reuse, binds the
// result to the current source hashes, and records that no paid inference was
// spent. Mirrors tests/qa/admission-qualification.mjs.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(process.argv[2] || '/tmp/tokenproxy-preparation-caching');
mkdirSync(output, { recursive: true });

const tests = [
  // identical-attempt preparation: one configuration snapshot per dispatch
  'chat-handler-dispatch-branches',
  // cache key scope: endpoint, model and content
  'embed-reorder',
  'embed-reorder-role-alternation',
  // bounded memory and privacy scope
  'session-memo-bounds',
  'preparation-cache-bounds',
  'dispatcher-cache-lifecycle',
  'proxy-fetch-dispatcher-eviction',
  'cache-pricing',
  // proven-equivalent reuse of measurement and serialization
  'stage-measurement-reuse',
  'context-structure-equivalence',
  'token-saver-cache-prefix-stability',
  'tool-disclosure-prefix-stability',
].map((name) => `unit/${name}.test.js`);

const sources = [
  'src/sse/handlers/chat.js',
  'open-sse/utils/embedReorder.js',
  'open-sse/utils/toolDisclosure.js',
  'open-sse/services/memory/sessionMemo.js',
  'open-sse/utils/dispatcherCache.js',
  'open-sse/providers/pricing.js',
  'open-sse/handlers/chatCore.js',
  'tests/qa/preparation-caching-qualification.mjs',
  ...tests.map((path) => `tests/${path}`),
];

const run = (name, args, cwd) => {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  writeFileSync(join(output, `${name}.log`), (result.stdout || '') + (result.stderr || ''));
  if (result.status !== 0) throw new Error(`${name} failed; inspect ${join(output, `${name}.log`)}`);
};

run('tests', [
  join(root, 'tests/node_modules/vitest/vitest.mjs'),
  'run', ...tests,
  '--reporter=json',
  `--outputFile=${join(output, 'tests.json')}`,
], join(root, 'tests'));

run('lint', [
  join(root, 'node_modules/eslint/bin/eslint.js'),
  ...sources.filter((f) => f.endsWith('.js') && !f.startsWith('tests/')),
], root);

const results = JSON.parse(readFileSync(join(output, 'tests.json'), 'utf8'));
const sourceHashes = Object.fromEntries(
  sources.map((file) => [file, createHash('sha256').update(readFileSync(join(root, file))).digest('hex')]),
);
const receipt = {
  passed: results.numFailedTests === 0,
  passedTests: results.numPassedTests,
  failedTests: results.numFailedTests,
  testFiles: results.numTotalTestSuites,
  sourceHashes,
  qualifiedAt: new Date().toISOString(),
  scope: 'in-process preparation caches with controlled upstreams and synthetic inputs; P01 latency-target qualification excluded and not claimed',
  paidUpstreamCalls: 0,
  lintExit: 0,
};
writeFileSync(join(output, 'qualification.json'), JSON.stringify(receipt, null, 2));
console.log(`PREPARATION_CACHING_QUALIFIED ${receipt.passedTests} passed, ${receipt.failedTests} failed; lint exit 0`);
