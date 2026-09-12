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
    const server=http.createServer((req,res)=>{res.writeHead(200);res.end('ok')});
    server.listen(Number(process.env.PORT),'127.0.0.1');
    for (const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>server.close(()=>process.exit(0)));
  `);
  const env = {
    ...process.env,
    PORT: "20160",
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
    expect(up.stdout).toMatch(/DATA_DIR=.*tokenproxy-test-20160-/);
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

  it("uses curl with config disabled and bounded deadlines", () => {
    const source = readFileSync(helper, "utf8");
    expect(source).toContain("curl -q");
    expect(source).toContain("--connect-timeout");
    expect(source).toContain("--max-time");
  });
});
