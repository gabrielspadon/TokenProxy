import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { assessBrowserReport, assessScriptReport, browserInventory, reportTests, verifyBrowserBuild } from "../../scripts/qa/run-all-browser.mjs";
import { assertContainerRuntime, ownedContainer, publishedOrigin } from "../../scripts/qa/verify-container.mjs";
import { prepareArtifacts, readSchemaVersion, resolveExpectedLayoutVersion, resolveExpectedSchemaVersion, runCommand, startFixtureProvider } from "../../scripts/qa/verify-standalone.mjs";
import { SCHEMA_VERSION } from "../../src/lib/db/schema.js";
import { latestVersion } from "../../src/lib/db/migrations/index.js";
import { privateEnvironment } from "../../scripts/qa/verify-standalone.mjs";
import { browserWorkflowScenario, prepareBrowserWorkflow } from "../../scripts/qa/browser-workflow-fixtures.mjs";

const roots = [];
const temporary = () => { const root = mkdtempSync(join(tmpdir(), "tokenproxy-product-gates-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const digest = (value) => createHash("sha256").update(value).digest("hex");

describe("started artifact isolation and schema namespaces", () => {
  it("binds the real provider only within its allowlisted ports and retries occupancy only", async () => {
    const attempted = [];
    const provider = {};
    expect(await startFixtureProvider({ startProviderStub: async ({ host, port }) => {
      expect(host).toBe("127.0.0.1"); attempted.push(port);
      if (port === 20210) throw Object.assign(new Error("busy"), { code: "EADDRINUSE" });
      return provider;
    } })).toBe(provider);
    expect(attempted).toEqual([20210, 20211]);
    await expect(startFixtureProvider({ startProviderStub: async () => { throw new Error("bad fixture"); } })).rejects.toThrow("bad fixture");
    await expect(startFixtureProvider({ startProviderStub: async () => { throw Object.assign(new Error("busy"), { code: "EADDRINUSE" }); } })).rejects.toThrow("all reserved");
  });

  it("keeps ordered migrations separate from additive schema layout versions", async () => {
    expect(await resolveExpectedSchemaVersion()).toBe(latestVersion());
    expect(await resolveExpectedLayoutVersion()).toBe(SCHEMA_VERSION);
    expect(latestVersion()).not.toBe(SCHEMA_VERSION);
    const path = join(temporary(), "fixture.sqlite");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE _meta(key TEXT PRIMARY KEY,value TEXT)");
    db.prepare("INSERT INTO _meta VALUES(?,?)").run("schemaVersion", String(latestVersion()));
    db.prepare("INSERT INTO _meta VALUES(?,?)").run("backupSchemaVersion", String(SCHEMA_VERSION));
    db.close();
    expect(readSchemaVersion(path)).toBe(latestVersion());
    expect(readSchemaVersion(path, "backupSchemaVersion")).toBe(SCHEMA_VERSION);
    await expect(resolveExpectedLayoutVersion("3oops")).rejects.toThrow("invalid");
  });

  it("refuses an artifact-directory symlink without writing into its target", () => {
    const root = temporary(); const target = join(root, "target"); mkdirSync(target);
    symlinkSync(target, join(root, "link"));
    expect(() => prepareArtifacts(join(root, "link"))).toThrow("real directory");
  });
  it("reaps an owned command that ignores graceful timeout shutdown", async () => {
    const root = temporary(); const pidFile = join(root, "owned.pid");
    await expect(runCommand(process.execPath, ["--input-type=module", "-e", "import{writeFileSync}from'node:fs';process.on('SIGTERM',()=>{});writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)", pidFile], { cwd: root, env: { PATH: process.env.PATH }, timeoutMs: 200 })).rejects.toThrow("timed out");
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe("browser qualification completeness", () => {
  const report = (results = [{ status: "passed" }], status = "expected", expectedStatus = "passed") => ({ suites: [{ specs: [{ file: "one.spec.mjs", line: 3, title: "first", tests: [{ projectName: "", status, expectedStatus, results }] }] }], errors: [] });
  it("fails missing, skipped, expected failures, retries and collection errors", () => {
    const expected = reportTests(report([]));
    expect(assessBrowserReport(report(), expected).passed).toBe(true);
    for (const value of [report([{ status: "skipped" }]), report([{ status: "failed" }], "expected", "failed"), report([{ status: "failed" }, { status: "passed" }]), { suites: [], errors: [] }, { ...report(), errors: [{ message: "collection failed" }] }]) expect(assessBrowserReport(value, expected).passed).toBe(false);
    expect(assessBrowserReport({ suites: [] }, []).passed).toBe(false);
  });
  it("includes direct browser scripts outside spec files with explicit fixture dispositions", () => {
    const inventory = browserInventory();
    expect(inventory.playwright).toContain("tests/e2e/access.spec.mjs");
    expect(inventory.scripts).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: "tests/e2e/operator-accessibility.mjs", disposition: "execute" }),
      expect.objectContaining({ file: "tests/e2e/context-workspace-synthetic.mjs", disposition: "execute" }),
      expect.objectContaining({ file: "tests/e2e/investigation-records.mjs", disposition: "execute" }),
      expect.objectContaining({ file: "tests/e2e/client-integration.spec.mjs", disposition: "execute" }),
    ]));
    expect(inventory.scripts.every((entry) => entry.owner && entry.reason)).toBe(true);
  });
  it("rejects reported browser errors even when a script exits zero", () => {
    expect(assessScriptReport({ screenshots: 4, errors: [] })).toBe(true);
    for (const value of [undefined, [], {}, { passed: false }, { failure: "assertion failed" }, { errors: ["page crash"] }, { pageErrors: ["hydrate failed"] }, { pageErrors: 1 }, { outboundFailures: 2 }, [{ status: 500 }], [{ status: 200, overflow: 10 }]]) expect(assessScriptReport(value)).toBe(false);
  });
  it("binds browser evidence to every retained artifact byte", () => {
    const root = temporary(); const dist = join(root, "artifact");
    mkdirSync(join(dist, "standalone/.next"), { recursive: true });
    writeFileSync(join(dist, "BUILD_ID"), "abc\n");
    writeFileSync(join(dist, "standalone/.next/BUILD_ID"), "abc\n");
    const files = ["BUILD_ID", "standalone/.next/BUILD_ID"].map((file) => [file, digest(readFileSync(join(dist, file)))]);
    const candidate = { sha: "a".repeat(40) };
    const hash = digest(JSON.stringify(files));
    const build = join(root, "build.json"); const manifest = join(root, "manifest.json");
    writeFileSync(build, JSON.stringify({ base: candidate.sha, sourceStable: true, sourceManifest: "b".repeat(64), buildExit: 0, buildId: "abc", artifactManifestHash: hash }));
    writeFileSync(manifest, JSON.stringify({ artifactManifestHash: hash, files: Object.fromEntries(files) }));
    expect(verifyBrowserBuild(dist, build, manifest, candidate).artifactFiles).toBe(2);
    writeFileSync(join(dist, "injected.js"), "unexpected");
    expect(() => verifyBrowserBuild(dist, build, manifest, candidate)).toThrow("manifest");
  });
});

describe("dedicated browser history fixtures", () => {
  it("reproduces historical browser populations with synthetic old-shape rows", () => {
    const runRoot = prepareArtifacts(join(temporary(), "artifacts"));
    const env = privateEnvironment(runRoot);
    const project = new URL("../../", import.meta.url).pathname;
    const invoke = (args, extra = {}) => spawnSync(process.execPath, args, { cwd: project, env: { ...env, ...extra }, encoding: "utf8", timeout: 60_000 });
    const seeded = invoke([join(project, "scripts/redesign-preview.mjs"), "seed", "--mode", "production", "--scenario", "empty"]);
    expect(seeded.status, seeded.stderr).toBe(0);
    const fixture = JSON.parse(seeded.stdout);
    const auth = JSON.parse(readFileSync(join(fixture.root, "preview-auth.json"), "utf8"));
    const result = invoke([join(project, "scripts/qa/browser-fixture-seed.mjs"), fixture.root, "legacy-workspace"], { DATA_DIR: join(fixture.root, "runtime"), DB_ENCRYPTION_KEY: auth.dbEncryptionKey, JWT_SECRET: auth.jwtSecret, INITIAL_PASSWORD: auth.initialPassword });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(fixture.root, "browser-history-seed.json"), "utf8"))).toMatchObject({ accounts: 24, sessions: 0, requests: 77589, ledgerRows: 76015, recentLedgerRows: 76009, quotaWindows: 33, routingReceipts: 1, synthetic: true, upstreamCalls: 0 });
    const db = new DatabaseSync(join(fixture.root, "runtime/db/data.sqlite"), { readOnly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) AS n FROM contextSessions").get().n).toBe(0);
      expect(db.prepare("SELECT COUNT(*) AS n FROM providerConnections WHERE isActive<>0").get().n).toBe(0);
      expect(db.prepare("SELECT COUNT(*) AS n FROM providerConnections WHERE provider='codex'").get().n).toBe(2);
      expect(db.prepare("SELECT COUNT(*) AS n FROM accountSwitches s JOIN providerConnections c ON c.id=s.toConnectionId WHERE c.provider='codex'").get().n).toBe(1);
      expect(db.prepare("SELECT COUNT(*) AS n FROM quotaWindows q JOIN providerConnections c ON c.id=q.connectionId, json_each(c.data,'$.lastQuotaSnapshot.windows') w WHERE q.scope=json_extract(w.value,'$.key') AND q.remaining=json_extract(w.value,'$.remainingPercentage')").get().n).toBe(33);
      for (const row of db.prepare("SELECT data FROM providerConnections").all()) for (const key of ["apiKey", "accessToken", "refreshToken", "password"]) expect(JSON.parse(row.data)[key]).toBeUndefined();
    } finally { db.close(); }
  });
  it.each([["context-history", 62, 3, 868], ["operator-persistence", 3, 1, 6]])("seeds %s through retained request contracts without live credentials", (variant, requests, sessions, stages) => {
    const root = temporary();
    const runRoot = prepareArtifacts(join(root, "artifacts"));
    const env = privateEnvironment(runRoot);
    const project = new URL("../../", import.meta.url).pathname;
    const invoke = (args, extra = {}) => spawnSync(process.execPath, args, { cwd: project, env: { ...env, ...extra }, encoding: "utf8", timeout: 30_000 });
    const seeded = invoke([join(project, "scripts/redesign-preview.mjs"), "seed", "--mode", "production", "--scenario", "single"]);
    expect(seeded.status, seeded.stderr).toBe(0);
    const fixture = JSON.parse(seeded.stdout);
    const auth = JSON.parse(readFileSync(join(fixture.root, "preview-auth.json"), "utf8"));
    const extra = { DATA_DIR: join(fixture.root, "runtime"), DB_ENCRYPTION_KEY: auth.dbEncryptionKey, JWT_SECRET: auth.jwtSecret, INITIAL_PASSWORD: auth.initialPassword };
    const args = [join(project, "scripts/qa/browser-fixture-seed.mjs"), fixture.root, variant];
    const result = invoke(args, extra);
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(readFileSync(join(fixture.root, "browser-history-seed.json"), "utf8"));
    expect(receipt).toMatchObject({ variant, requests, sessions, stages, synthetic: true, upstreamCalls: 0 });
    const db = new DatabaseSync(join(fixture.root, "runtime/db/data.sqlite"), { readOnly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) AS n FROM requestStats WHERE contextSessionId IS NULL OR contextTelemetryError IS NOT NULL").get().n).toBe(0);
      expect(db.prepare("SELECT data FROM providerConnections").all().every((row) => !Object.values(JSON.parse(row.data)).some(Boolean))).toBe(true);
      if (variant === "operator-persistence") expect(db.prepare("SELECT SUM(promptTokens) AS input,SUM(bodyBeforeBytes-bodyAfterBytes) AS saved FROM requestStats").get()).toMatchObject({ input: 33000, saved: 3000 });
      else expect(db.prepare("SELECT COUNT(*) AS n FROM requestStats GROUP BY contextSessionId ORDER BY n DESC").all().map((row) => row.n)).toEqual([60, 1, 1]);
    } finally { db.close(); }
    const replay = invoke(args, extra);
    expect(replay.status).toBe(1);
    expect(replay.stderr).toContain("refuses existing retained requests");
  });
  it.each(["shaping-completion-acceptance.mjs", "configuration-domains-acceptance.mjs", "route-simulation-acceptance.mjs", "notification-automation-acceptance.mjs", "compatibility-qualification.spec.mjs"])("reuses the real %s preparation without starting a server", (file) => {
    const root = temporary();
    const runRoot = prepareArtifacts(join(root, "artifacts"));
    const env = privateEnvironment(runRoot);
    const project = new URL("../../", import.meta.url).pathname;
    const seed = spawnSync(process.execPath, [join(project, "scripts/redesign-preview.mjs"), "seed", "--mode", "production", "--scenario", browserWorkflowScenario(file)], { cwd: project, env, encoding: "utf8", timeout: 30_000 });
    expect(seed.status, seed.stderr).toBe(0);
    const fixture = JSON.parse(seed.stdout);
    const artifacts = join(root, "workflow"); mkdirSync(artifacts);
    const args = prepareBrowserWorkflow(file, fixture, artifacts);
    const db = new DatabaseSync(join(fixture.root, "runtime/db/data.sqlite"), { readOnly: true });
    try {
      if (file.startsWith("shaping-")) {
        const receipt = JSON.parse(readFileSync(join(artifacts, "synthetic-seed.json"), "utf8"));
        expect(receipt.eligibleHandoffSessions).toBe(2);
        expect(receipt.handoffSessions).toHaveLength(2);
        expect(JSON.parse(readFileSync(join(artifacts, "selected-cases.json"), "utf8"))).toHaveLength(3);
      } else if (file.startsWith("notification-")) {
        expect(args[0]).toBe("connection-fixture-alpha");
        expect(args[1].split(",")).toHaveLength(3);
        expect(db.prepare("SELECT COUNT(*) AS n FROM operationEvents WHERE source='synthetic-bounded-remediation-fixture'").get().n).toBe(3);
      } else if (file.startsWith("compatibility-")) {
        expect(db.prepare("SELECT id FROM providerConnections WHERE isActive=1").all()).toEqual([{ id: "connection-fixture-alpha" }]);
        expect(JSON.parse(readFileSync(join(fixture.root, "compatibility-gateway.json"), "utf8"))).toMatchObject({ root: fixture.root, runId: fixture.runId });
      } else {
        const rows = db.prepare("SELECT isActive,data FROM providerConnections WHERE id IN (?,?)").all("connection-fixture-alpha", "connection-fixture-beta");
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(row.isActive).toBe(file.startsWith("route-") ? 1 : 0);
          expect(JSON.parse(row.data).providerSpecificData.enabledModels).toEqual(["gpt-4o", "gpt-4o-mini"]);
        }
      }
    } finally { db.close(); }
    writeFileSync(join(fixture.root, "process.json"), "{}");
    expect(() => prepareBrowserWorkflow(file, fixture, artifacts)).toThrow("unstarted fixture");
  });
});

describe("container evidence ownership", () => {
  const owner = "run-uuid", image = `sha256:${"a".repeat(64)}`, network = "network-id", data = "/tmp/owned-data";
  const runtime = () => ({ Id: "b".repeat(64), Image: image, Config: { Labels: { "app.tokenproxy.qualification-owner": owner } }, State: { Running: true, Health: { Status: "healthy" } }, NetworkSettings: { Networks: { fixture: { NetworkID: network } }, Ports: { "20128/tcp": [{ HostIp: "127.0.0.1", HostPort: "43101" }] } }, Mounts: [{ Type: "bind", Source: data, Destination: "/app/data", RW: true }] });
  it("rejects another image, owner, listener exposure, mount, network and missing health proof", () => {
    expect(assertContainerRuntime(runtime(), owner, image, network, data)).toBe("http://127.0.0.1:43101");
    expect(() => ownedContainer(runtime(), "other", image)).toThrow("ownership");
    expect(() => ownedContainer(runtime(), owner, `sha256:${"c".repeat(64)}`)).toThrow("identity");
    for (const host of ["0.0.0.0", "::"]) { const value = runtime(); value.NetworkSettings.Ports["20128/tcp"][0].HostIp = host; expect(() => publishedOrigin(value, 20128)).toThrow("loopback"); }
    const wrongMount = runtime(); wrongMount.Mounts[0].Source = "/home/spadon/.tokenproxy";
    expect(() => assertContainerRuntime(wrongMount, owner, image, network, data)).toThrow("mount");
    const wrongNetwork = runtime(); wrongNetwork.NetworkSettings.Networks.other = { NetworkID: "host" };
    expect(() => assertContainerRuntime(wrongNetwork, owner, image, network, data)).toThrow("network");
    const unhealthy = runtime(); unhealthy.State.Health.Status = "starting";
    expect(() => assertContainerRuntime(unhealthy, owner, image, network, data)).toThrow("healthy");
  });
});
