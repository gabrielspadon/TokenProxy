// Ensure better-sqlite3 is installed in USER_DATA_DIR/runtime/node_modules
// (user-writable, avoids Windows EBUSY locks during npm i -g updates).
// sql.js is bundled in bin/app already; node:sqlite / bun:sqlite are built-in.
const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const BETTER_SQLITE3_VERSION = "12.10.1";
// Majors the pinned better-sqlite3 actually supports, transcribed from that
// package's own engines field ("20.x || 22.x || 23.x || 24.x || 25.x || 26.x").
// cli/package.json advertises node >=20.18.1, so a Node 21 user would otherwise
// spend the whole install timeout on a build that cannot succeed and then fall
// back anyway. Bump this in the same commit as the version pin.
const BETTER_SQLITE3_NODE_MAJORS = new Set([20, 22, 23, 24, 25, 26]);

function nodeMajorSupportsBetterSqlite() {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  return Number.isInteger(major) && BETTER_SQLITE3_NODE_MAJORS.has(major);
}
const BETTER_SQLITE3_INSTALL_TIMEOUT = 30000;
const BETTER_SQLITE3_LOAD_TIMEOUT = 5000;
const SQL_JS_VERSION = "1.14.1";

function getDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  return process.platform === "win32"
    ? path.join(process.env.APPDATA || os.homedir(), "tokenproxy")
    : path.join(os.homedir(), ".tokenproxy");
}

function getRuntimeDir() {
  return path.join(getDataDir(), "runtime");
}

function getRuntimeNodeModules() {
  return path.join(getRuntimeDir(), "node_modules");
}

function ensureRuntimeDir() {
  const dir = getRuntimeDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Minimal package.json so npm treats it as a project root
  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, JSON.stringify({
      name: "tokenproxy-runtime",
      version: "1.0.0",
      private: true,
      description: "User-writable runtime deps for tokenproxy (better-sqlite3 native binary)",
    }, null, 2));
  }
  return dir;
}

function hasModule(name) {
  return fs.existsSync(path.join(getRuntimeNodeModules(), name, "package.json"));
}

// Node ABI the runtime binary was built against, recorded beside it at install
// time. A .node built for a different ABI has a perfectly valid ELF, Mach-O or
// PE header, so the magic-byte check below passes it and the process then
// either throws ERR_DLOPEN_FAILED or, in the worst reported case, takes SIGSEGV
// on dlopen — which no try/catch in the adapter chain can catch.
function abiStampPath() {
  return path.join(getRuntimeNodeModules(), ".tokenproxy-better-sqlite3-abi.json");
}

function nativeBinaryPath() {
  return path.join(getRuntimeNodeModules(), "better-sqlite3", "build", "Release", "better_sqlite3.node");
}

function nativeBinarySha256(binary) {
  return crypto.createHash("sha256").update(fs.readFileSync(binary)).digest("hex");
}

function writeAbiStamp(binary) {
  try {
    fs.writeFileSync(abiStampPath(), JSON.stringify({
      modules: process.versions.modules,
      version: BETTER_SQLITE3_VERSION,
      validation: "child-memory-query-v1",
      binarySha256: nativeBinarySha256(binary),
    }));
  } catch { /* best effort: absence only costs us the check */ }
}

function removeAbiStamp() {
  try { fs.unlinkSync(abiStampPath()); } catch {}
}

function abiStampMatches(binary) {
  let stamp;
  try { stamp = JSON.parse(fs.readFileSync(abiStampPath(), "utf-8")); } catch { return false; }
  if (stamp?.validation !== "child-memory-query-v1"
      || String(stamp?.modules) !== String(process.versions.modules)
      || stamp?.version !== BETTER_SQLITE3_VERSION
      || typeof stamp?.binarySha256 !== "string") {
    return false;
  }
  try { return stamp.binarySha256 === nativeBinarySha256(binary); } catch { return false; }
}

function probeBetterSqliteLoad() {
  const moduleDir = path.join(getRuntimeNodeModules(), "better-sqlite3");
  const program = [
    "const Database = require(process.argv[1]);",
    "const db = new Database(':memory:');",
    "const row = db.prepare('select 1 as ok').get();",
    "db.close();",
    "if (row?.ok !== 1) process.exit(2);",
  ].join("");
  const result = spawnSync(process.execPath, ["-e", program, moduleDir], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: BETTER_SQLITE3_LOAD_TIMEOUT,
    encoding: "utf8",
  });
  return result.status === 0;
}

function isBetterSqliteBinaryValid({ forceProbe = false } = {}) {
  const binary = nativeBinaryPath();
  if (!fs.existsSync(binary)) return false;
  try {
    const fd = fs.openSync(binary, "r");
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    const magic = buf.toString("hex");
    const headerValid = process.platform === "linux" ? magic.startsWith("7f454c46")
      : process.platform === "darwin" ? magic.startsWith("cffaedfe") || magic.startsWith("cefaedfe")
        : process.platform === "win32" ? magic.startsWith("4d5a") : true;
    if (!headerValid) return false;
  } catch { return false; }
  if (!forceProbe && abiStampMatches(binary)) return true;
  if (!probeBetterSqliteLoad()) {
    removeAbiStamp();
    return false;
  }
  writeAbiStamp(binary);
  return true;
}

// Extract a short, user-friendly reason from npm stderr.
function summarizeNpmError(stderr = "") {
  const text = String(stderr);
  if (/ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network|getaddrinfo/i.test(text)) return "No internet connection or registry unreachable";
  if (/EACCES|EPERM|permission denied/i.test(text)) return "Permission denied (check folder permissions)";
  if (/ENOSPC|no space/i.test(text)) return "Not enough disk space";
  if (/node-gyp|gyp ERR|python|MSBuild|Visual Studio|Xcode/i.test(text)) return "Missing build tools (Xcode CLT / Python / VS Build Tools)";
  if (/ETARGET|version.*not found/i.test(text)) return "Package version not found on registry";
  const m = text.match(/npm ERR! (.+)/);
  if (m) return m[1].slice(0, 200);
  const lastLine = text.trim().split(/\r?\n/).filter(Boolean).pop();
  return lastLine ? lastLine.slice(0, 200) : "Unknown error";
}

function npmInvocation(args) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && fs.existsSync(npmExecPath)) {
    return { command: process.execPath, args: [npmExecPath, ...args], shell: false };
  }
  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args,
    shell: process.platform === "win32",
  };
}

function runNpmInstall({ cwd, pkgs, extraArgs = [], timeout = 180000 }) {
  const args = ["install", ...pkgs, "--no-audit", "--no-fund", "--prefer-online", ...extraArgs];
  const invocation = npmInvocation(args);
  const res = spawnSync(invocation.command, invocation.args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    shell: invocation.shell,
    encoding: "utf8",
  });
  return { ok: res.status === 0, code: res.status, stderr: res.stderr || "", stdout: res.stdout || "" };
}

function rebuildBetterSqlite({ silent = false } = {}) {
  const invocation = npmInvocation(["rebuild", "better-sqlite3"]);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: getRuntimeDir(),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: BETTER_SQLITE3_INSTALL_TIMEOUT,
    shell: invocation.shell,
    encoding: "utf8",
  });
  if (result.status !== 0 && !silent) {
    console.warn(`⚠️  SQLite engine rebuild failed: ${summarizeNpmError(result.stderr)}`);
  }
  return result.status === 0;
}

function npmInstall(pkgs, opts = {}) {
  const cwd = ensureRuntimeDir();
  if (!opts.silent) console.log("⏳ Installing SQLite engine (first run)...");
  // Always saved. The runtime package.json is the only record that these
  // packages are wanted, so installing with --no-save leaves them extraneous
  // and the next npm install in this directory prunes them away. Optionality
  // is expressed by the caller ignoring a false return, not by hiding the
  // dependency from npm.
  const res = runNpmInstall({ cwd, pkgs, timeout: opts.timeout || 180000 });
  if (!res.ok && !opts.silent) {
    const reason = summarizeNpmError(res.stderr);
    console.warn("⚠️  SQLite engine install failed — using fallback");
    console.warn(`   Reason: ${reason}`);
    console.warn(`   Retry:  cd "${cwd}" && npm install ${pkgs.join(" ")}`);
  }
  return res.ok;
}

// Public: ensure better-sqlite3 native module is installed in user-writable
// runtime dir. sql.js may be bundled in bin/app, but npm publish strips .wasm
// from nested node_modules — verify and reinstall if missing. node:sqlite is
// built-in. This is purely a *speed optimization* — app works without
// better-sqlite3 via fallbacks.
function isSqlJsWasmValid() {
  const bundledWasm = path.join(__dirname, "..", "app", "node_modules", "sql.js", "dist", "sql-wasm.wasm");
  if (fs.existsSync(bundledWasm)) return true;
  const runtimeWasm = path.join(getRuntimeNodeModules(), "sql.js", "dist", "sql-wasm.wasm");
  return fs.existsSync(runtimeWasm);
}

function ensureSqliteRuntime({ silent = false, installBetterSqlite = false } = {}) {
  ensureRuntimeDir();

  let sqlJsOk = isSqlJsWasmValid();
  if (!sqlJsOk) {
    sqlJsOk = npmInstall([`sql.js@${SQL_JS_VERSION}`], { silent });
    if (sqlJsOk) sqlJsOk = isSqlJsWasmValid();
  }

  // Postinstall always performs the child query. A stamp is a startup cache,
  // not evidence that the runtime executing this postinstall can load the
  // native binary now.
  const needBetterSqlite = !hasModule("better-sqlite3")
    || !isBetterSqliteBinaryValid({ forceProbe: installBetterSqlite });
  if (!needBetterSqlite) {
    if (!silent) console.log("✅ SQLite engine ready");
    return { betterSqlite: true, sqlJs: sqlJsOk };
  }

  // Native SQLite is an optional accelerator. Normal CLI startup must never block
  // on npm/node-gyp; only postinstall explicitly opts into this bounded warm-up.
  if (!installBetterSqlite) {
    return { betterSqlite: false, sqlJs: sqlJsOk };
  }

  if (!nodeMajorSupportsBetterSqlite()) {
    // Not an error: better-sqlite3 is an accelerator, and the adapter chain
    // falls through to node:sqlite or sql.js. Saying so beats a build failure
    // the user has to interpret.
    if (!silent) {
      console.log(`ℹ️  Skipping the native SQLite engine: better-sqlite3@${BETTER_SQLITE3_VERSION} does not support Node ${process.versions.node}. Using the bundled fallback.`);
    }
    return { betterSqlite: false, sqlJs: sqlJsOk };
  }

  const ok = npmInstall([`better-sqlite3@${BETTER_SQLITE3_VERSION}`], {
    silent,
    timeout: BETTER_SQLITE3_INSTALL_TIMEOUT,
  });
  let valid = ok && hasModule("better-sqlite3")
    && isBetterSqliteBinaryValid({ forceProbe: true });
  if (ok && !valid && rebuildBetterSqlite({ silent })) {
    valid = hasModule("better-sqlite3")
      && isBetterSqliteBinaryValid({ forceProbe: true });
  }
  return {
    betterSqlite: valid,
    sqlJs: sqlJsOk,
  };
}

// Inject runtime + bundled node_modules into NODE_PATH so child Node processes
// resolve sql.js (bundled in bin/app/node_modules) and better-sqlite3 (runtime).
function buildEnvWithRuntime(baseEnv = process.env) {
  const runtimeNm = getRuntimeNodeModules();
  const bundledNm = path.join(__dirname, "..", "app", "node_modules");
  const existing = baseEnv.NODE_PATH || "";
  const NODE_PATH = [runtimeNm, bundledNm, existing].filter(Boolean).join(path.delimiter);
  return { ...baseEnv, NODE_PATH };
}

module.exports = {
  ensureSqliteRuntime,
  buildEnvWithRuntime,
  getRuntimeDir,
  getRuntimeNodeModules,
  runNpmInstall,
  summarizeNpmError,
};
