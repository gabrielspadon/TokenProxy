import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoDir = resolve(import.meta.dirname, "../..");
const helper = join(repoDir, "scripts", "dev-test-server.sh");
const scratch = [];
const children = new Set();
const serverEnvironments = [];
let nextPort = 20160;

afterEach(() => {
  for (const env of serverEnvironments.splice(0)) {
    spawnSync("bash", [helper, "down"], { cwd: repoDir, env, encoding: "utf8", timeout: 10_000 });
  }
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  children.clear();
  for (const dir of scratch.splice(0)) {
    spawnSync(process.execPath, ["-e", "require('fs').rmSync(process.argv[1],{recursive:true,force:true})", dir]);
  }
});

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "tokenproxy-dev-server-contract-"));
  scratch.push(dir);
  const server = join(dir, "server.mjs");
  writeFileSync(server, `
    import http from 'node:http';
    import { writeFileSync } from 'node:fs';
    writeFileSync(process.env.DATA_DIR + '/server-env.json', JSON.stringify(process.env));
    const server=http.createServer((req,res)=>{res.writeHead(200);res.end('ok')});
    server.listen(Number(process.env.PORT),'127.0.0.1');
    for (const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>server.close(()=>process.exit(0)));
  `);
  const env = {
    ...process.env,
    PORT: String(nextPort++),
    PID_FILE: join(dir, "server.pid"),
    LOG_FILE: join(dir, "server.log"),
    TMPDIR: dir,
    SERVER_ENTRY: server,
    SKIP_BUILD: "1",
  };
  delete env.DATA_DIR;
  serverEnvironments.push(env);
  return {
    dir,
    server,
    env,
  };
}

function run(command, env) {
  return spawnSync("bash", [helper, command], { cwd: repoDir, env, encoding: "utf8", timeout: 10_000 });
}

describe("dev test server process and data ownership", () => {
  it("allocates fresh state and only stops the process recorded with matching start time and command", () => {
    const work = workspace();
    const up = run("up", work.env);
    expect(up.status, `${up.stdout}\n${up.stderr}`).toBe(0);
    expect(up.stdout).toContain(`tokenproxy-test-${work.env.PORT}-`);
    const pid = Number(readFileSync(work.env.PID_FILE, "utf8").trim());
    expect(pid).toBeGreaterThan(1);

    const status = run("status", work.env);
    expect(status.status).toBe(0);
    expect(status.stdout).toContain(`running: pid ${pid}`);

    const down = run("down", work.env);
    expect(down.status, down.stderr).toBe(0);
    expect(down.stdout).toContain(`stopped pid ${pid}`);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("refuses to signal an unrelated live PID", () => {
    const work = workspace();
    const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    children.add(unrelated);
    writeFileSync(work.env.PID_FILE, `${unrelated.pid}\n`);
    writeFileSync(`${work.env.PID_FILE}.meta`, `${unrelated.pid}\t0\t${work.server}\t${repoDir}\n`);

    const down = run("down", work.env);
    expect(down.status).toBe(1);
    expect(down.stderr).toContain("ownership mismatch");
    expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
  });

  it("keeps credential cloning behind an explicit source and opt-in", () => {
    const work = workspace();
    const result = run("sync", work.env);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("ALLOW_CREDENTIAL_CLONE=1");
  });

  it("uses an allowlisted fake home and data directory for both build and server", () => {
    const work = workspace();
    const bin = join(work.dir, "bin");
    const inheritedHome = join(work.dir, "inherited-home");
    mkdirSync(bin, { mode: 0o700 });
    mkdirSync(join(inheritedHome, ".tokenproxy"), { recursive: true, mode: 0o700 });
    writeFileSync(join(inheritedHome, ".tokenproxy", "data.sqlite"), "production-canary\n");
    writeFileSync(join(bin, "npm"), `#!/bin/sh
printf '%s\\n%s\\n%s\\n' "$HOME" "$DATA_DIR" "\${INHERITED_TEST_SENTINEL-unset}" > "$DATA_DIR/build-env.txt"
`, { mode: 0o755 });
    work.env.PATH = `${bin}:${process.env.PATH}`;
    work.env.HOME = inheritedHome;
    work.env.INHERITED_TEST_SENTINEL = "must-not-cross";
    delete work.env.SKIP_BUILD;

    const up = run("up", work.env);
    expect(up.status, `${up.stdout}\n${up.stderr}`).toBe(0);
    const dataDir = up.stdout.match(/DATA_DIR=([^ )]+)/)?.[1];
    expect(dataDir).toBeTruthy();
    expect(readFileSync(join(dataDir, "build-env.txt"), "utf8").trim().split("\n")).toEqual([
      join(dataDir, "home"), dataDir, "unset",
    ]);
    const serverEnv = JSON.parse(readFileSync(join(dataDir, "server-env.json"), "utf8"));
    expect(serverEnv).toMatchObject({ HOME: join(dataDir, "home"), DATA_DIR: dataDir });
    expect(serverEnv.INHERITED_TEST_SENTINEL).toBeUndefined();
    expect(serverEnv.JWT_SECRET).toBe("tokenproxy-local-test-jwt-secret-000000000000");
    expect(readFileSync(join(inheritedHome, ".tokenproxy", "data.sqlite"), "utf8")).toBe("production-canary\n");
  });

  it("refuses an inherited DATA_DIR during normal startup", () => {
    const work = workspace();
    const inheritedData = join(work.dir, "tokenproxy-test-inherited");
    mkdirSync(inheritedData);
    writeFileSync(join(inheritedData, "canary"), "keep\n");

    const result = run("up", { ...work.env, DATA_DIR: inheritedData });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("normal startup always uses fresh state");
    expect(readFileSync(join(inheritedData, "canary"), "utf8")).toBe("keep\n");
  });

  it("does not accept another process's healthy listener", async () => {
    const work = workspace();
    const listener = spawn(process.execPath, ["-e", `
      require('node:http').createServer((_q,r)=>{r.writeHead(200);r.end('ok')})
        .listen(${Number(work.env.PORT)}, '127.0.0.1', ()=>process.stderr.write('ready\\n'));
    `], { stdio: ["ignore", "ignore", "pipe"] });
    children.add(listener);
    await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error("listener did not start")), 2_000);
      listener.stderr.once("data", () => { clearTimeout(timer); resolveReady(); });
      listener.once("exit", (code) => { clearTimeout(timer); reject(new Error(`listener exited ${code}`)); });
    });

    const result = run("up", work.env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("server process exited or changed identity");
    expect(() => process.kill(listener.pid, 0)).not.toThrow();
  });

  it("aborts credential sync when process ownership cannot be established", () => {
    const work = workspace();
    const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    children.add(unrelated);
    writeFileSync(work.env.PID_FILE, `${unrelated.pid}\n`);
    writeFileSync(`${work.env.PID_FILE}.meta`, `${unrelated.pid}\t0\t${work.server}\t${repoDir}\n`);
    const source = join(work.dir, "source");
    const target = join(work.dir, "tokenproxy-test-clone-target");
    mkdirSync(join(source, "db"), { recursive: true });
    writeFileSync(join(source, "db", "data.sqlite"), "fixture");

    const result = run("sync", {
      ...work.env,
      ALLOW_CREDENTIAL_CLONE: "1",
      CLONE_FROM_DATA_DIR: source,
      CLONE_TO_DATA_DIR: target,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("clone aborted");
    expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
  });

  it("rejects a credential clone target outside the isolated state namespace", () => {
    const work = workspace();
    const source = join(work.dir, "source");
    mkdirSync(join(source, "db"), { recursive: true });
    writeFileSync(join(source, "db", "data.sqlite"), "fixture");

    const result = run("sync", {
      ...work.env,
      ALLOW_CREDENTIAL_CLONE: "1",
      CLONE_FROM_DATA_DIR: source,
      CLONE_TO_DATA_DIR: join(work.dir, "unsafe-target"),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("tokenproxy-test- prefix");
  });

  it("uses curl with config disabled and bounded deadlines", () => {
    const source = readFileSync(helper, "utf8");
    expect(source).toContain("curl -q");
    expect(source).toContain("--connect-timeout");
    expect(source).toContain("--max-time");
  });
});
