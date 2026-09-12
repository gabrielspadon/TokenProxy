import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoDir = resolve(import.meta.dirname, "../..");
const testsDir = join(repoDir, "tests");
const runner = join(repoDir, "scripts", "qa", "run-offline-tests.mjs");
const probe = "fixtures/offline-runner/environment-probe.test.js";
const scratch = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    spawnSync(process.execPath, ["-e", "require('fs').rmSync(process.argv[1],{recursive:true,force:true})", dir]);
  }
});

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "tokenproxy-runner-contract-"));
  scratch.push(dir);
  const fakeHome = join(dir, "fake-production-home");
  mkdirSync(join(fakeHome, ".tokenproxy"), { recursive: true, mode: 0o700 });
  const canary = join(fakeHome, ".tokenproxy", "data.sqlite");
  writeFileSync(canary, "production-canary\n", { mode: 0o600 });
  return { dir, fakeHome, canary, artifacts: join(dir, "artifacts") };
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [runner, ...args], {
    cwd: repoDir,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, TOKENPROXY_TEST_MAX_WORKERS: "1", ...env },
  });
}

describe("offline runner isolation", () => {
  it("refuses a nonempty artifact directory", () => {
    const work = workspace();
    mkdirSync(work.artifacts, { recursive: true });
    writeFileSync(join(work.artifacts, "existing"), "keep");
    const result = run(["--artifacts", work.artifacts, "--", probe]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("must be empty");
    expect(readFileSync(join(work.artifacts, "existing"), "utf8")).toBe("keep");
  });

  it.each(["RUN_REAL", "RUN_E2E", "RUN_LIVE_MIMO"])("refuses enabled live flag %s", (flag) => {
    const work = workspace();
    const result = run(["--artifacts", work.artifacts, "--", probe], { [flag]: "1" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(flag);
  });

  it("clears credentials, isolates paths and records a verified network boundary", () => {
    const work = workspace();
    const result = run(["--artifacts", work.artifacts, "--", probe], {
      HOME: work.fakeHome,
      ISOLATION_CANARY_PATH: work.canary,
      ANTHROPIC_API_KEY: "must-not-cross",
      OPENAI_API_KEY: "must-not-cross",
      HTTPS_PROXY: "http://127.0.0.1:9",
      TOKENPROXY_PEER_TOKEN: "must-not-cross",
    });
    expect(result.status, result.stderr).toBe(0);
    const evidence = JSON.parse(readFileSync(join(work.artifacts, "evidence.json"), "utf8"));
    expect(evidence).toMatchObject({ state: "passed", runnerExit: 0, gateExit: 0 });
    expect(evidence.networkBoundary.verified).toBe(true);
    expect(evidence.command).toContain("tests/node_modules/vitest/vitest.mjs");
    for (const name of ["", "home", "tmp", "data"]) {
      expect(statSync(join(work.artifacts, name)).mode & 0o777).toBe(0o700);
    }
    expect(readFileSync(work.canary, "utf8")).toBe("production-canary\n");
  });

  it.each([
    ["repository root", repoDir],
    ["tests package", testsDir],
  ])("executes the canonical runner from the %s npm test entry point", (_name, cwd) => {
    const work = workspace();
    const artifacts = join(work.dir, `npm-entry-${cwd === repoDir ? "root" : "tests"}`);
    const result = spawnSync("npm", [
      "test", "--", "--artifacts", artifacts, "--", probe,
    ], {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: work.fakeHome,
        ISOLATION_CANARY_PATH: work.canary,
        TOKENPROXY_TEST_MAX_WORKERS: "1",
      },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(readFileSync(join(artifacts, "evidence.json"), "utf8"))).toMatchObject({
      state: "passed",
      runnerExit: 0,
      gateExit: 0,
      maxWorkers: 1,
    });
    expect(readFileSync(work.canary, "utf8")).toBe("production-canary\n");
  });

  it("keeps the direct explicit-config path away from a fake production home", () => {
    const work = workspace();
    const result = spawnSync(process.execPath, [
      join(testsDir, "node_modules", "vitest", "vitest.mjs"), "run",
      "--config", join(testsDir, "vitest.config.js"), "--maxWorkers=1",
      "fixtures/offline-runner/config-canary.test.js",
    ], {
      cwd: repoDir,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        HOME: work.fakeHome,
        TMPDIR: work.dir,
        DATA_DIR: join(work.dir, "direct-data"),
        NODE_ENV: "test",
        ISOLATION_CANARY_PATH: work.canary,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(work.canary, "utf8")).toBe("production-canary\n");
  });
});
