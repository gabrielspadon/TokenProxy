import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The NDJSON sink half of the decision log: D-2 (64MB default, three rotation
// generations), D-9 (a dead sink re-probes every 5 minutes instead of staying
// dead forever) and SEC-5b (chmod-on-open to 0600). Unlike
// decision-log.test.js these tests exercise the REAL fs against a scratch
// DATA_DIR, so each describe re-imports the module fresh with its own env.

const T0 = Date.parse('2026-09-03T00:00:00.000Z');
const FIVE_MIN = 5 * 60 * 1000;

let tempDir;
let lines;
let spy;
const originalDataDir = process.env.DATA_DIR;
const originalMaxBytes = process.env.TOKENPROXY_LOG_DECISIONS_MAX_BYTES;

async function loadDecide() {
  vi.resetModules();
  process.env.DATA_DIR = tempDir;
  const mod = await import('@/shared/observability/decide.js');
  mod.__decide.resetState();
  return mod;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-sink-'));
  lines = [];
  spy = vi.spyOn(console, 'log').mockImplementation((l) => lines.push(String(l)));
});

afterEach(() => {
  spy.mockRestore();
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalMaxBytes === undefined) delete process.env.TOKENPROXY_LOG_DECISIONS_MAX_BYTES;
  else process.env.TOKENPROXY_LOG_DECISIONS_MAX_BYTES = originalMaxBytes;
  // A failed assertion can leave the logs dir read-only; make rmSync possible.
  try { fs.chmodSync(path.join(tempDir, 'logs'), 0o700); } catch { /* not created yet */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('sink rotation (D-2)', () => {
  it('keeps three generations .1/.2/.3 and never a .4', async () => {
    process.env.TOKENPROXY_LOG_DECISIONS_MAX_BYTES = '400';
    const { decide, __decide } = await loadDecide();
    // Each record is ~150 bytes, so every 2-3 emissions rotate the file.
    for (let n = 0; n < 40; n++) {
      decide('UP', 'failover', { conn: `c${n}`, why: 'x', pad: 'y'.repeat(120) }, T0 + n * 1000);
    await __decide.flush();
    }
    await __decide.flush();
    const dir = path.join(tempDir, 'logs');
    expect(fs.existsSync(path.join(dir, 'decisions.ndjson.1'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'decisions.ndjson.2'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'decisions.ndjson.3'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'decisions.ndjson.4'))).toBe(false);
    // The active file stays under the cap.
    expect(fs.statSync(path.join(dir, 'decisions.ndjson')).size).toBeLessThan(400);
  });
});

describe('sink failure and recovery (D-9, SEC-5b)', () => {
  it('fails soft once, re-probes only after 5 minutes, and emits LOG.resumed on recovery', async () => {
    const { decide, __decide } = await loadDecide();
    const logDir = path.join(tempDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });

    // SEC-5b: a file already present with loose permissions is chmod'ed 0600
    // on the next open.
    decide('UP', 'failover', { conn: 'c0', why: 'x' }, T0);
    await __decide.flush();
    expect(fs.statSync(path.join(logDir, 'decisions.ndjson')).mode & 0o777).toBe(0o600);

    // Kill the sink: with the file gone, a read-only directory blocks the
    // create. (Appending to an existing file would need no dir write.)
    fs.rmSync(path.join(logDir, 'decisions.ndjson'));
    fs.chmodSync(logDir, 0o500);
    decide('UP', 'failover', { conn: 'c1', why: 'x' }, T0 + 1000);
    await __decide.flush();
    expect(lines.filter((l) => l.includes('LOG.sink-failed'))).toHaveLength(1);
    decide('UP', 'failover', { conn: 'c2', why: 'x' }, T0 + 2000);
    await __decide.flush();
    expect(lines.filter((l) => l.includes('LOG.sink-failed'))).toHaveLength(1); // dead, no re-probe

    // Past the retry interval the probe runs again and fails again.
    decide('UP', 'failover', { conn: 'c3', why: 'x' }, T0 + FIVE_MIN + 1000);
    await __decide.flush();
    expect(lines.filter((l) => l.includes('LOG.sink-failed'))).toHaveLength(2);

    // Recovery: the re-probe append succeeds and says so.
    fs.chmodSync(logDir, 0o700);
    decide('UP', 'failover', { conn: 'c4', why: 'x' }, T0 + 2 * FIVE_MIN + 1000);
    await __decide.flush();
    expect(lines.some((l) => l.includes('LOG.resumed why=sink-recovered'))).toBe(true);
    expect(lines.filter((l) => l.includes('LOG.sink-failed'))).toHaveLength(2); // no new failure
    const file = path.join(logDir, 'decisions.ndjson');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toContain('"conn":"c4"');
  });
});

// Schema/folding tests capture admitted lines; bounded asynchronous transport has its own suite.
vi.mock('../../open-sse/utils/asyncLogOutput.js', () => ({
  logOutput: line => console.log(line), flushLogOutput: async () => {}, logOutputStatus: () => ({}),
}));
