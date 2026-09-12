import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const STANDALONE_VERIFIER = join(REPO_ROOT, "scripts/qa/verify-standalone.mjs");
const CLI_VERIFIER = join(REPO_ROOT, "scripts/qa/verify-cli-package.mjs");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const VERSION = "7.8.9";
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(path, contents, mode) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, contents, mode ? { mode } : undefined);
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "tokenproxy-t09-verifier-"));
  roots.push(root);
  const standalone = join(root, "standalone");
  const contracts = join(root, "contracts");
  const artifacts = join(root, "artifacts");
  mkdirSync(standalone, { recursive: true });
  mkdirSync(contracts, { recursive: true });

  write(join(standalone, "package.json"), `${JSON.stringify({ name: "fixture-app", version: VERSION, type: "module" })}\n`);
  write(join(standalone, "BUILD_SHA"), `${SHA}\n`);
  write(join(standalone, "custom-server.js"), `
    import http from "node:http";
    import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
    import { DatabaseSync } from "node:sqlite";
    import { join, resolve } from "node:path";
    const dataDir = process.env.DATA_DIR;
    const dbDir = join(dataDir, "db");
    mkdirSync(dbDir, { recursive: true });
    const stateFile = join(dbDir, "fixture-state.json");
    let state = { boots: 0, seeded: false };
    try { state = JSON.parse(readFileSync(stateFile, "utf8")); } catch {}
    state.boots += 1;
    writeFileSync(stateFile, JSON.stringify(state));
    const db = new DatabaseSync(join(dbDir, "data.sqlite"));
    db.prepare("UPDATE _meta SET value=? WHERE key='schemaVersion'").run(process.env.TOKENPROXY_EXPECTED_SCHEMA_VERSION);
    db.prepare("UPDATE _meta SET value=? WHERE key='backupSchemaVersion'").run(process.env.TOKENPROXY_EXPECTED_LAYOUT_VERSION);
    db.close();
    const shaPath = process.env.TOKENPROXY_FIXTURE_SHA_PATH || resolve(process.cwd(), "BUILD_SHA");
    const buildSha = readFileSync(shaPath, "utf8").trim();
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
    const currentVersion = process.env.TOKENPROXY_CLI_VERSION || pkg.version;
    const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const server = http.createServer((req, res) => {
      if (req.url === "/api/health") return json(res, 200, { ok: true });
      if (req.url === "/api/ready") return json(res, 200, { ready: true, buildSha, catalog: { freshness: "fixture" } });
      if (req.url === "/api/version") return json(res, 200, { currentVersion, buildSha, latestVersion: null, hasUpdate: false });
      if (req.url === "/fixture-capabilities") return json(res, 200, { authorized: req.headers.authorization === process.env.CAPABILITY_GATEWAY_AUTH });
      return json(res, 404, { error: "not-found" });
    });
    server.listen(Number(process.env.PORT), "127.0.0.1");
    process.on("SIGTERM", () => server.close(() => process.exit(0)));
  `);

  const manifest = {
    schemaVersion: 1,
    cells: Array.from({ length: 121 }, (_, index) => ({ id: `cell-${index}` })),
    primaryEndpoints: Array.from({ length: 36 }, (_, index) => ({ id: `primary-${index}` })),
    binaryProtocols: [],
    modalityRoutes: [],
  };
  write(join(contracts, "capabilities.json"), `${JSON.stringify(manifest)}\n`);
  write(join(contracts, "provider-stub.mjs"), `
    import http from "node:http";
    export async function startProviderStub({ host = "127.0.0.1", port }) {
      const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); });
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
      return { baseUrl: \`http://\${host}:\${port}\`, controlUrl: \`http://\${host}:\${port}/__control\`, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
    }
  `);
  write(join(contracts, "seed.mjs"), `
    import { mkdirSync, writeFileSync } from "node:fs";
    import { DatabaseSync } from "node:sqlite";
    import { join } from "node:path";
    mkdirSync(join(process.env.DATA_DIR, "db"), { recursive: true });
    const db = new DatabaseSync(join(process.env.DATA_DIR, "db", "data.sqlite"));
    db.exec("CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO _meta (key, value) VALUES ('schemaVersion', '0'), ('backupSchemaVersion', '0')");
    db.close();
    writeFileSync(join(process.env.DATA_DIR, "db", "fixture-state.json"), JSON.stringify({ boots: 0, seeded: true }));
    writeFileSync(process.env.CAPABILITY_AUTH_FILE, "Bearer fixture-secret\\n", { mode: 0o600 });
  `);
  write(join(contracts, "matrix.mjs"), `
    const value = name => process.argv.find(arg => arg.startsWith(name + "="))?.slice(name.length + 1);
    const authName = value("--authorization-env");
    const response = await fetch(value("--gateway-base-url") + "/fixture-capabilities", { headers: { authorization: process.env[authName] } });
    const body = await response.json();
    if (!body.authorized) throw new Error("artifact did not receive fixture authorization");
    process.stdout.write(JSON.stringify({ primary: { passed: 36, dispatched: 30, rejectedBeforeUpstream: 6 }, outcomes: { success: 1 }, receipts: { providerDispatch: { delta: 33 } } }) + "\\n");
  `);

  return {
    root,
    standalone,
    artifacts,
    manifest: join(contracts, "capabilities.json"),
    provider: join(contracts, "provider-stub.mjs"),
    seed: join(contracts, "seed.mjs"),
    matrix: join(contracts, "matrix.mjs"),
  };
}

function verifierArgs(fixture, artifacts, extra = []) {
  return [
    "--artifacts", artifacts,
    "--candidate-sha", SHA,
    "--candidate-version", VERSION,
    "--expected-schema-version", "9",
    "--expected-layout-version", "41",
    "--capability-manifest", fixture.manifest,
    "--provider-stub-module", fixture.provider,
    "--seed-script", fixture.seed,
    "--matrix-script", fixture.matrix,
    ...extra,
  ];
}

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("T09 standalone artifact verifier", () => {
  it("refuses a nonempty artifact directory without adding or replacing evidence", () => {
    const fixture = makeFixture();
    mkdirSync(fixture.artifacts);
    write(join(fixture.artifacts, "sentinel"), "owned\n");

    const result = run(STANDALONE_VERIFIER, verifierArgs(fixture, fixture.artifacts, ["--standalone-root", fixture.standalone]));

    expect(result.status).toBe(1);
    expect(readdirSync(fixture.artifacts)).toEqual(["sentinel"]);
    expect(readFileSync(join(fixture.artifacts, "sentinel"), "utf8")).toBe("owned\n");
  });

  it("starts the built artifact twice and binds readiness, persistence, capability, and cleanup evidence to its SHA", () => {
    const fixture = makeFixture();
    const result = run(STANDALONE_VERIFIER, verifierArgs(fixture, fixture.artifacts, ["--standalone-root", fixture.standalone]));

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const receipt = JSON.parse(readFileSync(join(fixture.artifacts, "standalone-evidence.json"), "utf8"));
    expect(receipt).toMatchObject({
      schema: "tokenproxy-standalone-qualification-v1",
      state: "passed",
      candidate: { sha: SHA, version: VERSION },
      capability: { manifestCells: 121, primaryCells: 36, binaryProtocolCells: 0, modalityRoutes: 0, modalityCases: 0, passed: 36 },
      persistence: { seeded: true, seedSchemaVersion: 0, migratedSchemaVersion: 9, reopenedSchemaVersion: 9, reopened: true },
    });
    expect(receipt.starts).toHaveLength(2);
    expect(receipt.persistence.migrationExercised).toBe(false);
    expect(receipt.persistence.seededSchemaSha256).toBe(receipt.persistence.reopenedSchemaSha256);
    expect(receipt.starts.every(runReceipt => runReceipt.health.ok && runReceipt.readiness.ready)).toBe(true);
    expect(receipt.starts.every(runReceipt => runReceipt.healthStatus === 200 && runReceipt.readinessStatus === 200 && runReceipt.versionStatus === 200)).toBe(true);
    expect(receipt.starts.every(runReceipt => runReceipt.version.buildSha === SHA)).toBe(true);
    expect(receipt.starts.every(runReceipt => runReceipt.cleanup.listenerGone === true && runReceipt.cleanup.graceful === true && runReceipt.cleanup.exitCode === 0)).toBe(true);
    expect(JSON.parse(readFileSync(join(fixture.artifacts, "run", "data", "db", "fixture-state.json"), "utf8"))).toEqual({ boots: 2, seeded: true });
  });

  it("rejects a stale served build SHA and still removes its owned listener", () => {
    const fixture = makeFixture();
    write(join(fixture.standalone, "BUILD_SHA"), `${"f".repeat(40)}\n`);
    const result = run(STANDALONE_VERIFIER, verifierArgs(fixture, fixture.artifacts, ["--standalone-root", fixture.standalone]));

    expect(result.status).toBe(1);
    const receipt = JSON.parse(readFileSync(join(fixture.artifacts, "standalone-evidence.json"), "utf8"));
    expect(receipt.state).toBe("failed");
    expect(receipt.reason).toContain("does not match candidate");
    expect(receipt.starts[0].cleanup.listenerGone).toBe(true);
  });
});

describe("T09 CLI package verifier", () => {
  it("packs from structured npm output, installs in private state, and qualifies the installed launcher twice", () => {
    const fixture = makeFixture();
    const cliDir = join(fixture.root, "cli-source");
    mkdirSync(join(cliDir, "app"), { recursive: true });
    write(join(cliDir, "package.json"), `${JSON.stringify({
      name: "tokenproxy-fixture-cli",
      version: VERSION,
      bin: { "tokenproxy-fixture": "cli.js" },
      files: ["cli.js", "app", "BUILD_SHA"],
    })}\n`);
    write(join(cliDir, "BUILD_SHA"), `${SHA}\n`);
    write(join(cliDir, "app", "package.json"), `${JSON.stringify({ name: "fixture-app", version: VERSION, type: "module" })}\n`);
    write(join(cliDir, "app", "custom-server.js"), readFileSync(join(fixture.standalone, "custom-server.js"), "utf8"));
    write(join(cliDir, "cli.js"), `#!/usr/bin/env node
      const { spawn } = require("node:child_process");
      const path = require("node:path");
      const pkg = require("./package.json");
      if (process.argv.includes("--version")) { console.log(pkg.version); process.exit(0); }
      const child = spawn(process.execPath, [path.join(__dirname, "app/custom-server.js")], {
        cwd: path.join(__dirname, "app"), stdio: "ignore",
        env: { ...process.env, TOKENPROXY_CLI_VERSION: pkg.version, TOKENPROXY_FIXTURE_SHA_PATH: path.join(__dirname, "BUILD_SHA") },
      });
      const stop = () => child.kill("SIGTERM");
      process.on("SIGTERM", stop);
      child.on("exit", code => process.exit(code || 0));
    `, 0o755);

    const result = run(CLI_VERIFIER, verifierArgs(fixture, fixture.artifacts, ["--cli-dir", cliDir]));

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const receipt = JSON.parse(readFileSync(join(fixture.artifacts, "cli-evidence.json"), "utf8"));
    expect(receipt).toMatchObject({
      schema: "tokenproxy-cli-package-qualification-v1",
      state: "passed",
      candidate: { sha: SHA, version: VERSION },
      pack: { packageName: "tokenproxy-fixture-cli", packageVersion: VERSION },
      install: { privateHome: true, version: VERSION },
      capability: { manifestCells: 121, primaryCells: 36, binaryProtocolCells: 0, modalityRoutes: 0, modalityCases: 0, passed: 36 },
      persistence: { seeded: true, seedSchemaVersion: 0, migratedSchemaVersion: 9, reopenedSchemaVersion: 9, reopened: true },
    });
    expect(receipt.pack.filename).toMatch(/tokenproxy-fixture-cli-7\.8\.9\.tgz$/);
    expect(receipt.pack.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.starts).toHaveLength(2);
    expect(receipt.starts.every(runReceipt => runReceipt.cleanup.listenerGone === true && runReceipt.cleanup.graceful === true && runReceipt.cleanup.exitCode === 0)).toBe(true);
  });
});
