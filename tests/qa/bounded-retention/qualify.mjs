import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const evidence = path.resolve(process.argv[2]);
await fs.mkdir(evidence, { recursive: true });
const tests = [
  'bounded-log-sink', 'bounded-log-retention', 'async-log-output', 'request-logger-masking',
  'decision-log-sink', 'decision-log', 'decision-log-req-summary', 'decision-log-up-lines',
  'decision-log-auth-emissions', 'decision-log-incident-replay', 'request-details-buffer-bound-1245',
  'request-details-shutdown', 'request-details-redaction', 'logger-surface', 'open-sse-plain-node-imports',
  'admin-decisions-endpoint', 'admin-authz-decision-log', 'drain-decision-log', 'cred-refresh-decisions',
  'decision-trace-scheduler', 'decision-trace-repin', 'decision-trace-ranking',
].map(name => `tests/unit/${name}.test.js`).concat(['tests/unit/reconciliation/redaction.test.js']);
const sources = [
  'open-sse/utils/boundedLogSink.js', 'open-sse/utils/boundedLogRecord.js', 'open-sse/utils/asyncLogOutput.js',
  'open-sse/utils/requestLogger.js', 'open-sse/handlers/chatCore.js', 'open-sse/handlers/chatCore/streamingHandler.js',
  'src/lib/db/repos/requestDetailsRepo.js', 'src/shared/observability/decide.js', 'src/sse/utils/logger.js', 'src/mitm/logger.js',
  ...tests.filter(value => !['request-details-redaction', 'logger-surface', 'open-sse-plain-node-imports', 'request-details-buffer-bound-1245'].some(name => value.endsWith(`/${name}.test.js`))),
  'tests/qa/bounded-retention/run.mjs', 'tests/qa/bounded-retention/qualify.mjs', 'tests/qa/bounded-retention/verify.mjs',
];
const commands = [];
function run(command, args) {
  const result = spawnSync(command, args, { cwd: repo, encoding: 'utf8', timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
  commands.push({ command, args, exitCode: result.status });
  if (result.status !== 0) { process.stderr.write(result.stdout + result.stderr); throw new Error(`Qualification failed: ${command}`); }
  return result;
}
const unit = run(path.join(repo, 'tests/node_modules/.bin/vitest'), ['run', '--config', 'tests/vitest.config.js', ...tests, '--reporter=dot', '--reporter=json', `--outputFile=${path.join(evidence, 'tests.json')}`]);
await fs.writeFile(path.join(evidence, 'tests.log'), unit.stdout + unit.stderr);
const lint = run(path.join(repo, 'node_modules/.bin/eslint'), sources);
await fs.writeFile(path.join(evidence, 'lint.log'), lint.stdout + lint.stderr || 'ESLint passed\n');
const runtime = run(process.execPath, ['--expose-gc', 'tests/qa/bounded-retention/run.mjs']);
await fs.writeFile(path.join(evidence, 'runtime.json'), runtime.stdout);
const hashes = {};
for (const source of sources) hashes[source] = createHash('sha256').update(await fs.readFile(path.join(repo, source))).digest('hex');
const results = JSON.parse(await fs.readFile(path.join(evidence, 'tests.json'), 'utf8'));
await fs.writeFile(path.join(evidence, 'qualification.json'), JSON.stringify({ at: new Date().toISOString(), repo, tests: results.numTotalTests, passed: results.numPassedTests, failed: results.numFailedTests, files: tests.length, commands, hashes }, null, 2));
console.log(`Bounded retention qualified: ${results.numPassedTests}/${results.numTotalTests} tests across ${tests.length} files; lint and native runtime passed.`);
