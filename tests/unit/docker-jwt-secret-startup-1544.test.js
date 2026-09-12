// #1544 — a container that reported Up, published its port and answered
// /api/health with 200, while the dashboard behind it failed every request and
// a reverse proxy in front of it showed 502 with nothing in `docker logs`.
//
// DOCKER.md and docs/deployment.md both promise the server does not start
// without JWT_SECRET. The only check lived at module scope in
// src/lib/auth/dashboardSession.js, so it ran on the first request that imported
// it and never at startup. The /v1 gateway does not import that module, which is
// why the install looks alive.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

// The copy lives under the repo so Node still resolves @next/env from
// repoRoot/node_modules, exactly as the standalone build does.
let dir;

// Standing in for the Next standalone build custom-server.js hands over to.
// Reaching it at all proves the startup check let the process through.
const STARTED = 'TOKENPROXY_TEST_HANDOVER';

function boot(env) {
  return spawnSync(process.execPath, [path.join(dir, 'custom-server.js')], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30000,
    killSignal: 'SIGKILL',
    // Built from nothing, so a JWT_SECRET in the runner's own environment
    // cannot decide the outcome.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: '20999', ...env },
  });
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(repoRoot, '.jwt-startup-test-'));
  fs.copyFileSync(path.join(repoRoot, 'custom-server.js'), path.join(dir, 'custom-server.js'));
  fs.copyFileSync(path.join(repoRoot, 'live-safety-runtime.cjs'), path.join(dir, 'live-safety-runtime.cjs'));
  fs.writeFileSync(path.join(dir, 'server.js'), `console.log(${JSON.stringify(STARTED)});\n`);
});

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('JWT_SECRET is checked at startup (#1544)', () => {
  it('refuses to start and says why, instead of serving a dashboard that 500s', () => {
    const run = boot({});

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('JWT_SECRET');
    // The reason has to survive to the operator, and `docker logs` reads fd 2.
    expect(run.stderr).toMatch(/DOCKER\.md|deployment\.md/);
    expect(run.stdout).not.toContain(STARTED);
  });

  it('starts when the secret is in the environment', () => {
    const run = boot({ JWT_SECRET: 'x'.repeat(48) });

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(STARTED);
  });

  it('starts when the secret is only in the .env beside the server', () => {
    // Next loads .env after custom-server.js has handed over, so the check has
    // to read it the same way rather than locking out `cp .env.example .env`.
    fs.writeFileSync(path.join(dir, '.env'), `JWT_SECRET=${'y'.repeat(48)}\n`);
    try {
      const run = boot({});
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain(STARTED);
    } finally {
      fs.rmSync(path.join(dir, '.env'), { force: true });
    }
  });
});
