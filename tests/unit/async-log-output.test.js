import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

it('actual asynchronous stdout preserves line order and redacts before admission', () => {
  const modulePath = path.resolve(import.meta.dirname, '../../open-sse/utils/asyncLogOutput.js');
  const source = `import {logOutput, flushLogOutput, logOutputStatus} from ${JSON.stringify(modulePath)};
    logOutput('first Bearer abcdefghijklmnop');
    logOutput('second');
    if (logOutputStatus().written !== 0) throw Error('synchronous sink');
    await flushLogOutput();
    if (logOutputStatus().written !== 2) throw Error('undrained');`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 10000 });
  expect(output).toBe('first Bearer [redacted]\nsecond\n');
});

it('a closed output descriptor is counted without an unhandled rejection', () => {
  const modulePath = path.resolve(import.meta.dirname, '../../open-sse/utils/asyncLogOutput.js');
  const source = `import {closeSync} from 'node:fs';
    import {logOutput, flushLogOutput, logOutputStatus} from ${JSON.stringify(modulePath)};
    closeSync(1); logOutput('safe'); await flushLogOutput();
    if (logOutputStatus().failed !== 1) throw Error('failure was not counted');`;
  expect(() => execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', source], { encoding: 'utf8', timeout: 10000 })).not.toThrow();
});

it('a genuinely unread stdout pipe keeps the event loop responsive and shutdown bounded', async () => {
  const { spawn } = await import('node:child_process');
  const modulePath = path.resolve(import.meta.dirname, '../../open-sse/utils/asyncLogOutput.js');
  const source = `import {logOutput, logOutputStatus} from ${JSON.stringify(modulePath)};
    for (let n = 0; n < 100000; n++) logOutput('x'.repeat(500));
    setTimeout(() => { process.stderr.write(JSON.stringify({eventLoopAlive:true, ...logOutputStatus()}) + '\\n'); process.kill(process.pid, 'SIGTERM'); }, 20);`;
  const start = performance.now();
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  let receipt = '';
  child.stderr.on('data', chunk => { receipt += chunk; });
  // Intentionally never resume stdout: its pipe is the controlled slow sink.
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('unbounded logging shutdown')); }, 10000);
    child.once('error', reject);
    child.once('exit', value => { clearTimeout(timer); resolve(value); });
  });
  child.stdout.destroy();
  expect(code).toBe(0);
  const status = JSON.parse(receipt.trim());
  expect(status.eventLoopAlive).toBe(true);
  expect(status.peakBytes).toBeLessThanOrEqual(1024 * 1024);
  expect(status.peakRecords).toBeLessThanOrEqual(1024);
  expect(status.dropped).toBeGreaterThan(0);
  expect(performance.now() - start).toBeLessThan(10000);
});
