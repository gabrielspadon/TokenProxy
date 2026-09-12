import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const modulePath = require.resolve("../../cli/hooks/sqliteRuntime.js");
const repoDir = path.resolve(import.meta.dirname, "../..");

// Issue #2493: a better-sqlite3 binary built for a different Node ABI has a
// perfectly valid ELF, Mach-O or PE header, so the magic-byte check passed it
// and the adapter chain then took SIGSEGV on dlopen — which no try/catch can
// catch. Issue #1605: the runtime packages were installed with --no-save, so
// they were extraneous and the next npm install in that directory pruned them.

let dataDir;
let previousDataDir;

function load() {
  delete require.cache[modulePath];
  return require(modulePath);
}

function nodeModules() {
  return path.join(dataDir, "runtime", "node_modules");
}

function seedSqlJs() {
  const wasm = path.join(nodeModules(), "sql.js", "dist", "sql-wasm.wasm");
  fs.mkdirSync(path.dirname(wasm), { recursive: true });
  fs.writeFileSync(wasm, "wasm");
}

// A file whose first bytes are a valid native-module header for this platform,
// which is all the pre-existing check ever looked at.
function seedBetterSqlite(abi, { validated = false } = {}) {
  const dir = path.join(nodeModules(), "better-sqlite3", "build", "Release");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(nodeModules(), "better-sqlite3", "package.json"), "{}");
  const magic = process.platform === "linux" ? [0x7f, 0x45, 0x4c, 0x46]
    : process.platform === "darwin" ? [0xcf, 0xfa, 0xed, 0xfe]
      : [0x4d, 0x5a, 0x00, 0x00];
  fs.writeFileSync(path.join(dir, "better_sqlite3.node"), Buffer.from(magic));
  if (abi !== undefined) {
    const binary = path.join(dir, "better_sqlite3.node");
    fs.writeFileSync(
      path.join(nodeModules(), ".tokenproxy-better-sqlite3-abi.json"),
      JSON.stringify({
        modules: abi,
        version: "12.10.1",
        ...(validated ? {
          validation: "child-memory-query-v1",
          binarySha256: crypto.createHash("sha256").update(fs.readFileSync(binary)).digest("hex"),
        } : {}),
      }),
    );
  }
}

beforeEach(() => {
  previousDataDir = process.env.DATA_DIR;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenproxy-sqlite-abi-"));
  process.env.DATA_DIR = dataDir;
  seedSqlJs();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete require.cache[modulePath];
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("better-sqlite3 ABI stamp (#2493)", () => {
  it("rejects a binary stamped with a different Node ABI", () => {
    seedBetterSqlite("999");
    const spawn = vi.spyOn(childProcess, "spawnSync").mockReturnValue({ status: 1, stderr: "", stdout: "" });

    const result = load().ensureSqliteRuntime({ silent: true });

    expect(result.betterSqlite).toBe(false);
    spawn.mockRestore();
  });

  it("rejects a matching stamp when an actual child load fails", () => {
    seedBetterSqlite(process.versions.modules);
    const spawn = vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 1,
      signal: null,
      stderr: "was compiled against a different Node.js version using NODE_MODULE_VERSION 141",
      stdout: "",
    });

    expect(load().ensureSqliteRuntime({ silent: true }).betterSqlite).toBe(false);
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(["-e", expect.any(String)]),
      expect.objectContaining({ timeout: 5000 }),
    );
  });

  it("stamps an unstamped binary only after the child load succeeds", () => {
    seedBetterSqlite(undefined);
    vi.spyOn(childProcess, "spawnSync").mockReturnValue({ status: 0, signal: null, stderr: "", stdout: "" });

    expect(load().ensureSqliteRuntime({ silent: true }).betterSqlite).toBe(true);
    expect(JSON.parse(fs.readFileSync(
      path.join(nodeModules(), ".tokenproxy-better-sqlite3-abi.json"),
      "utf8",
    ))).toMatchObject({
      modules: process.versions.modules,
      version: "12.10.1",
      validation: "child-memory-query-v1",
      binarySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("does not rewrite the ABI stamp when npm exits zero but the installed binary cannot load", () => {
    seedBetterSqlite(process.versions.modules, { validated: true });
    const spawn = vi.spyOn(childProcess, "spawnSync").mockImplementation((_command, args) => (
      args?.[0] === "-e"
        ? { status: 1, signal: null, stderr: "ERR_DLOPEN_FAILED", stdout: "" }
        : { status: 0, signal: null, stderr: "", stdout: "" }
    ));

    const result = load().ensureSqliteRuntime({ silent: true, installBetterSqlite: true });

    expect(result.betterSqlite).toBe(false);
    const stamp = path.join(nodeModules(), ".tokenproxy-better-sqlite3-abi.json");
    expect(fs.existsSync(stamp)).toBe(false);
    expect(spawn.mock.calls.some(([command, args]) => command === process.execPath
      && args.includes("-e"))).toBe(true);
  });

  it("runs postinstall against explicit test state without touching a fake production home", () => {
    const fakeHome = path.join(dataDir, "fake-home");
    const canary = path.join(fakeHome, ".tokenproxy", "data.sqlite");
    fs.mkdirSync(path.dirname(canary), { recursive: true });
    fs.writeFileSync(canary, "production-canary\n");
    fs.symlinkSync(
      path.join(repoDir, "node_modules", "better-sqlite3"),
      path.join(nodeModules(), "better-sqlite3"),
      "dir",
    );
    const tray = path.join(nodeModules(), "systray2");
    fs.mkdirSync(tray, { recursive: true });
    fs.writeFileSync(path.join(tray, "package.json"), "{}");

    const result = childProcess.spawnSync(process.execPath, [path.join(repoDir, "cli", "hooks", "postinstall.js")], {
      cwd: path.join(repoDir, "cli"),
      env: { ...process.env, HOME: fakeHome, DATA_DIR: dataDir },
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(canary, "utf8")).toBe("production-canary\n");
    expect(JSON.parse(fs.readFileSync(
      path.join(nodeModules(), ".tokenproxy-better-sqlite3-abi.json"),
      "utf8",
    ))).toMatchObject({
      modules: process.versions.modules,
      validation: "child-memory-query-v1",
    });
  });
});

describe("runtime installs are saved, not extraneous (#1605)", () => {
  it("never passes --no-save, which would let the next install prune the engine", () => {
    const calls = [];
    const spawn = vi.spyOn(childProcess, "spawnSync").mockImplementation((cmd, args) => {
      calls.push(args || []);
      return { status: 1, stderr: "", stdout: "" };
    });

    load().ensureSqliteRuntime({ silent: true, installBetterSqlite: true });

    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) expect(args).not.toContain("--no-save");
    spawn.mockRestore();
  });
});

describe("the native install is skipped on an unsupported Node (#1657)", () => {
  it("does not attempt an install that the pin cannot satisfy", () => {
    const orig = Object.getOwnPropertyDescriptor(process.versions, "node");
    const calls = [];
    const spawn = vi.spyOn(childProcess, "spawnSync").mockImplementation((cmd, args) => {
      calls.push(args || []);
      return { status: 1, stderr: "", stdout: "" };
    });
    try {
      // Node 21 satisfies cli/package.json but is absent from the pinned
      // better-sqlite3's own engines field, so the build cannot succeed and the
      // install would just burn its timeout.
      Object.defineProperty(process.versions, "node", { value: "21.7.3", configurable: true });
      const result = load().ensureSqliteRuntime({ silent: true, installBetterSqlite: true });

      expect(result.betterSqlite).toBe(false);
      expect(calls.some((a) => a.some((x) => String(x).startsWith("better-sqlite3@")))).toBe(false);
    } finally {
      if (orig) Object.defineProperty(process.versions, "node", orig);
      spawn.mockRestore();
    }
  });

  it("still attempts the install on a supported Node major", () => {
    const orig = Object.getOwnPropertyDescriptor(process.versions, "node");
    const calls = [];
    const spawn = vi.spyOn(childProcess, "spawnSync").mockImplementation((cmd, args) => {
      calls.push(args || []);
      return { status: 1, stderr: "", stdout: "" };
    });
    try {
      Object.defineProperty(process.versions, "node", { value: "22.14.0", configurable: true });
      load().ensureSqliteRuntime({ silent: true, installBetterSqlite: true });

      expect(calls.some((a) => a.some((x) => String(x).startsWith("better-sqlite3@")))).toBe(true);
    } finally {
      if (orig) Object.defineProperty(process.versions, "node", orig);
      spawn.mockRestore();
    }
  });
});
