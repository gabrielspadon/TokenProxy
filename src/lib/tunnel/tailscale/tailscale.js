import fs from "fs";
import path from "path";
import os from "os";
import { execSync, exec, spawn } from "child_process";
import { promisify } from "util";
import { execWithPassword } from "@/mitm/dns/dnsConfig";
import { DATA_DIR } from "@/lib/dataDir.js";

const execAsync = promisify(exec);

const BIN_DIR = path.join(DATA_DIR, "bin");
const IS_MAC = os.platform() === "darwin";
const IS_LINUX = os.platform() === "linux";
const IS_WINDOWS = os.platform() === "win32";
const TAILSCALE_BIN = path.join(BIN_DIR, IS_WINDOWS ? "tailscale.exe" : "tailscale");

// Custom socket for userspace-networking mode (no root required)
const TAILSCALE_DIR = path.join(DATA_DIR, "tailscale");
export const TAILSCALE_SOCKET = path.join(TAILSCALE_DIR, "tailscaled.sock");
const SOCKET_FLAG = IS_WINDOWS ? [] : ["--socket", TAILSCALE_SOCKET];

// System daemon socket (sudo install: apt/snap/systemd) — read-only status detection
const SYSTEM_TAILSCALE_SOCKET = IS_WINDOWS ? null : "/var/run/tailscale/tailscaled.sock";
const SYSTEM_SOCKET_FLAG = SYSTEM_TAILSCALE_SOCKET ? ["--socket", SYSTEM_TAILSCALE_SOCKET] : [];

// Well-known Windows install path
const WINDOWS_TAILSCALE_BIN = "C:\\Program Files\\Tailscale\\tailscale.exe";

// Common Unix install paths to probe synchronously (system tailscale)
const UNIX_TAILSCALE_CANDIDATES = [
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/sbin/tailscale",   // apt package on Debian/Ubuntu
  "/usr/bin/tailscale",
  "/snap/bin/tailscale",   // Snap package
];

// tailscaled daemon candidates, parallel to the CLI. Covers Apple Silicon
// (/opt/homebrew) and Intel (/usr/local) Homebrew plus Linux package paths —
// the previous code hardcoded only the Intel path, so on Apple Silicon the
// userspace daemon spawn failed (ENOENT) and `tailscale up` timed out.
const UNIX_TAILSCALED_CANDIDATES = [
  "/opt/homebrew/bin/tailscaled",
  "/usr/local/bin/tailscaled",
  "/usr/sbin/tailscaled",
  "/usr/bin/tailscaled",
];

// ─── Cache + background refresh (avoid blocking event loop on dead daemon) ──
const PROBE_TTL_MS = 10000;
const PROBE_TIMEOUT_MS = 1500;

const binCache = { value: undefined, fetchedAt: 0, refreshing: false };
const runningCache = { value: false, fetchedAt: 0, refreshing: false };
const loggedInCache = { value: false, fetchedAt: 0, refreshing: false };
const funnelUrlCache = { value: null, port: null, fetchedAt: 0, refreshing: false };

function fallbackBin() {
  if (fs.existsSync(TAILSCALE_BIN)) return TAILSCALE_BIN;
  if (IS_WINDOWS && fs.existsSync(WINDOWS_TAILSCALE_BIN)) return WINDOWS_TAILSCALE_BIN;
  if (!IS_WINDOWS) return UNIX_TAILSCALE_CANDIDATES.find((p) => fs.existsSync(p)) || null;
  return null;
}

function bgRefreshBin() {
  if (binCache.refreshing) return;
  binCache.refreshing = true;
  const cmd = IS_WINDOWS ? "where tailscale 2>nul" : "which tailscale 2>/dev/null";
  execAsync(cmd, { windowsHide: true, timeout: PROBE_TIMEOUT_MS, env: { ...process.env, PATH: EXTENDED_PATH } })
    .then(({ stdout }) => {
      const sys = stdout.trim();
      binCache.value = sys || fallbackBin();
    })
    .catch(() => { binCache.value = fallbackBin(); })
    .finally(() => {
      binCache.fetchedAt = Date.now();
      binCache.refreshing = false;
    });
}

// Sync getter: returns cached value, triggers background refresh if stale
export function getTailscaleBin() {
  if (Date.now() - binCache.fetchedAt > PROBE_TTL_MS) bgRefreshBin();
  // First call: synchronously probe common install paths (no exec, no event-loop block)
  if (binCache.value === undefined) {
    if (fs.existsSync(TAILSCALE_BIN)) binCache.value = TAILSCALE_BIN;
    else if (IS_WINDOWS && fs.existsSync(WINDOWS_TAILSCALE_BIN)) binCache.value = WINDOWS_TAILSCALE_BIN;
    else if (!IS_WINDOWS) {
      const found = UNIX_TAILSCALE_CANDIDATES.find((p) => fs.existsSync(p));
      binCache.value = found || null;
    } else binCache.value = null;
  }
  return binCache.value;
}

export function isTailscaleInstalled() {
  return getTailscaleBin() !== null;
}

/**
 * Resolve the tailscaled daemon binary. Prefer the daemon sitting next to the
 * resolved `tailscale` CLI (so Homebrew Apple Silicon/Intel both work), then
 * known candidate paths, then bare "tailscaled" from PATH as a last resort.
 */
export function getTailscaledBin() {
  const cli = getTailscaleBin();
  if (cli && !IS_WINDOWS) {
    const sibling = cli.replace(/tailscale$/, "tailscaled");
    if (sibling !== cli && fs.existsSync(sibling)) return sibling;
  }
  const found = UNIX_TAILSCALED_CANDIDATES.find((p) => fs.existsSync(p));
  return found || "tailscaled";
}

/** Build tailscale CLI args with custom socket (no root needed) */
function tsArgs(...args) {
  return [...SOCKET_FLAG, ...args];
}

export function getTailscaleAuthKey(env = process.env) {
  const authKey = env.TAILSCALE_AUTHKEY;
  return typeof authKey === "string" ? authKey.trim() : "";
}

export function buildTailscaleUpArgs(hostname, env = process.env) {
  const args = tsArgs("up", "--accept-routes");
  if (hostname) args.push(`--hostname=${hostname}`);
  const authKey = getTailscaleAuthKey(env);
  if (authKey) args.push(`--auth-key=${authKey}`);
  return args;
}

// Async strict probe: authoritative, awaitable (never blocks event loop). Updates cache.
export async function isTailscaleLoggedInStrict() {
  const bin = getTailscaleBin();
  if (!bin) return false;
  try {
    const { stdout } = await execAsync(`"${bin}" ${SOCKET_FLAG.join(" ")} status --json`, {
      windowsHide: true,
      env: { ...process.env, PATH: EXTENDED_PATH },
      timeout: 5000
    });
    const json = JSON.parse(stdout);
    // BackendState=Running + Self.Online=true → device still exists in tailnet
    const loggedIn = json.BackendState === "Running" && json.Self?.Online === true;
    loggedInCache.value = loggedIn;
    loggedInCache.fetchedAt = Date.now();
    return loggedIn;
  } catch {
    return false;
  }
}

function bgRefreshLoggedIn() {
  if (loggedInCache.refreshing) return;
  const bin = getTailscaleBin();
  if (!bin) {
    loggedInCache.value = false;
    loggedInCache.fetchedAt = Date.now();
    return;
  }
  loggedInCache.refreshing = true;
  // Dual-socket aware: probe custom socket first, then system socket
  probeStatusAsync(bin)
    .then((json) => {
      loggedInCache.value = !!json && json.BackendState === "Running" && json.Self?.Online === true;
    })
    .catch(() => { loggedInCache.value = false; })
    .finally(() => {
      loggedInCache.fetchedAt = Date.now();
      loggedInCache.refreshing = false;
    });
}

// Probe `status --json` over custom then system socket. Resolves parsed JSON or null. Never blocks event loop.
async function probeStatusAsync(bin) {
  for (const socketArgs of [SOCKET_FLAG, SYSTEM_SOCKET_FLAG]) {
    try {
      const { stdout } = await execAsync(`"${bin}" ${socketArgs.join(" ")} status --json`, {
        windowsHide: true, env: { ...process.env, PATH: EXTENDED_PATH }, timeout: PROBE_TIMEOUT_MS,
      });
      return JSON.parse(stdout);
    } catch { /* try next socket */ }
  }
  return null;
}

// Sync getter: never blocks; returns last known state, refreshes in background
export function isTailscaleLoggedIn() {
  if (Date.now() - loggedInCache.fetchedAt > PROBE_TTL_MS) bgRefreshLoggedIn();
  return loggedInCache.value;
}

function bgRefreshRunning() {
  if (runningCache.refreshing) return;
  const bin = getTailscaleBin();
  if (!bin) {
    runningCache.value = false;
    runningCache.fetchedAt = Date.now();
    return;
  }
  runningCache.refreshing = true;
  execAsync(`"${bin}" ${SOCKET_FLAG.join(" ")} funnel status --json`, { windowsHide: true, timeout: PROBE_TIMEOUT_MS })
    .then(({ stdout }) => {
      try {
        const json = JSON.parse(stdout);
        runningCache.value = Object.keys(json.AllowFunnel || {}).length > 0;
      } catch { runningCache.value = false; }
    })
    .catch(() => { runningCache.value = false; })
    .finally(() => {
      runningCache.fetchedAt = Date.now();
      runningCache.refreshing = false;
    });
}

// Sync getter: never blocks; returns last known state, refreshes in background
export function isTailscaleRunning() {
  if (Date.now() - runningCache.fetchedAt > PROBE_TTL_MS) bgRefreshRunning();
  return runningCache.value;
}

// Async strict probe for hot user-initiated paths (enable/connect flow).
// Awaitable, never blocks event loop; updates cache as a side effect.
export async function isTailscaleRunningStrict() {
  const bin = getTailscaleBin();
  if (!bin) return false;
  try {
    const { stdout } = await execAsync(`"${bin}" ${SOCKET_FLAG.join(" ")} funnel status --json`, {
      windowsHide: true,
      timeout: PROBE_TIMEOUT_MS,
    });
    const json = JSON.parse(stdout);
    const running = Object.keys(json.AllowFunnel || {}).length > 0;
    runningCache.value = running;
    runningCache.fetchedAt = Date.now();
    return running;
  } catch {
    return false;
  }
}

// Check if a system-level tailscaled is running (uses system socket, not TokenProxy's custom one).
export function isSystemDaemonRunning() {
  if (IS_WINDOWS || !SYSTEM_TAILSCALE_SOCKET || !fs.existsSync(SYSTEM_TAILSCALE_SOCKET)) return false;
  const bin = getTailscaleBin();
  if (!bin) return false;
  try {
    const out = execSync(`"${bin}" ${SYSTEM_SOCKET_FLAG.join(" ")} status --json`, {
      encoding: "utf8", windowsHide: true, env: { ...process.env, PATH: EXTENDED_PATH }, timeout: PROBE_TIMEOUT_MS,
    });
    return JSON.parse(out).BackendState === "Running";
  } catch {
    return false;
  }
}

function bgRefreshFunnelUrl(port) {
  if (funnelUrlCache.refreshing) return;
  const bin = getTailscaleBin();
  if (!bin) return;
  funnelUrlCache.refreshing = true;
  execAsync(`"${bin}" ${SOCKET_FLAG.join(" ")} status --json`, { windowsHide: true, timeout: PROBE_TIMEOUT_MS })
    .then(({ stdout }) => {
      try {
        const json = JSON.parse(stdout);
        const dnsName = json.Self?.DNSName?.replace(/\.$/, "");
        funnelUrlCache.value = dnsName ? `https://${dnsName}` : null;
      } catch { /* keep prev */ }
    })
    .catch(() => { /* keep prev */ })
    .finally(() => {
      funnelUrlCache.port = port;
      funnelUrlCache.fetchedAt = Date.now();
      funnelUrlCache.refreshing = false;
    });
}

/** Get actual funnel URL from Self.DNSName (sync, authoritative — avoids hostname-conflict suffix). */
function getActualFunnelUrl() {
  const bin = getTailscaleBin();
  if (!bin) return null;
  try {
    const out = execSync(`"${bin}" ${SOCKET_FLAG.join(" ")} status --json`, {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, PATH: EXTENDED_PATH },
      timeout: 5000,
    });
    const json = JSON.parse(out);
    const dnsName = json.Self?.DNSName?.replace(/\.$/, "");
    return dnsName ? `https://${dnsName}` : null;
  } catch { return null; }
}

/** Get funnel URL from tailscale status (cached, non-blocking) */
export function getTailscaleFunnelUrl(port) {
  if (Date.now() - funnelUrlCache.fetchedAt > PROBE_TTL_MS || funnelUrlCache.port !== port) {
    bgRefreshFunnelUrl(port);
  }
  return funnelUrlCache.value;
}

const EXTENDED_PATH = `/usr/local/bin:/opt/homebrew/bin:/usr/sbin:/usr/bin:/bin:/snap/bin:${process.env.PATH || ""}`;

// Self-heal: if state dir/files were previously created by root (e.g. legacy sudo daemon),
// reclaim ownership recursively so the user-mode daemon can read/write state files.
async function ensureUserOwnedDir(dir) {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      return;
    }
    const uid = process.getuid();
    const gid = process.getgid();

    // Walk dir + all entries to find any non-user-owned items
    const needsChown = (() => {
      const stack = [dir];
      while (stack.length) {
        const cur = stack.pop();
        try {
          const st = fs.statSync(cur);
          if (st.uid !== uid) return true;
          if (st.isDirectory()) {
            for (const name of fs.readdirSync(cur)) stack.push(path.join(cur, name));
          }
        } catch { /* ignore */ }
      }
      return false;
    })();

    if (!needsChown) return;

    // Try direct chown first (works if already owned). Fallback to passwordless sudo.
    try {
      execSync(`chown -R ${uid}:${gid} "${dir}"`, { stdio: "ignore", timeout: 3000 });
    } catch {
      try { execSync(`sudo -n chown -R ${uid}:${gid} "${dir}"`, { stdio: "ignore", timeout: 3000 }); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/** Check if running daemon uses TUN mode (Funnel TLS requires TUN). */
function isDaemonTunMode() {
  try {
    const ps = execSync(`pgrep -af "tailscaled.*${TAILSCALE_SOCKET}"`, { encoding: "utf8", timeout: 2000 }).trim();
    if (!ps) return null;
    return !ps.includes("--tun=userspace-networking");
  } catch { return null; }
}

/** Daemon process alive (independent of funnel state) — mirrors cloudflared PID check semantic. */
export function isDaemonAlive() {
  return isDaemonTunMode() !== null;
}

/**
 * Start tailscaled.
 * - With sudoPassword: TUN mode (root) → Funnel TLS works
 * - Without: userspace-networking fallback (no sudo, but Funnel TLS unstable)
 * State always lives in ~/.tokenproxy/tailscale/ via --statedir.
 */
export async function startDaemonWithPassword(sudoPassword) {
  if (IS_WINDOWS) {
    // Windows: tailscale runs as a Windows Service. Start it then poll BackendState
    // until daemon finishes init (avoids "NoState" errors when calling funnel/up too early).
    const bin = getTailscaleBin();
    console.log("[Tailscale] win: net start Tailscale");
    try { execSync("net start Tailscale", { stdio: "ignore", windowsHide: true, timeout: 10000 }); }
    catch { /* may need admin, or already running */ }
    if (!bin) return;
    // Poll up to ~10s for backend to leave NoState
    for (let i = 0; i < 20; i++) {
      try {
        const out = execSync(`"${bin}" status --json`, { encoding: "utf8", windowsHide: true, timeout: 2000 });
        const j = JSON.parse(out);
        if (j.BackendState && j.BackendState !== "NoState") {
          console.log(`[Tailscale] win: BackendState=${j.BackendState} after ${i*500}ms`);
          return;
        }
      } catch { /* daemon not ready */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log("[Tailscale] win: BackendState still NoState after poll");
    return;
  }

  const currentMode = isDaemonTunMode(); // true=TUN, false=userspace, null=not running
  // No password but a healthy TUN daemon already runs → keep TUN, never downgrade-kill it.
  const wantTun = sudoPassword ? true : currentMode === true;

  // Daemon already running in correct mode → reuse
  if (currentMode !== null && currentMode === wantTun) {
    try {
      const bin = getTailscaleBin() || "tailscale";
      execSync(`"${bin}" ${SOCKET_FLAG.join(" ")} status --json`, {
        stdio: "ignore", windowsHide: true,
        env: { ...process.env, PATH: EXTENDED_PATH }, timeout: 3000
      });
      return;
    } catch { /* unresponsive, restart below */ }
  }

  // Mode mismatch or unresponsive → kill all daemons on our socket
  try { execSync(`pkill -9 -f "tailscaled.*${TAILSCALE_SOCKET}"`, { stdio: "ignore", timeout: 3000 }); } catch { /* ignore */ }
  if (sudoPassword) {
    try { await execWithPassword(`pkill -9 -f "tailscaled.*${TAILSCALE_SOCKET}"`, sudoPassword); } catch { /* ignore */ }
  } else {
    try { execSync(`sudo -n pkill -9 -f "tailscaled.*${TAILSCALE_SOCKET}"`, { stdio: "ignore", timeout: 3000 }); } catch { /* ignore */ }
  }
  await new Promise((r) => setTimeout(r, 1500));

  // Reclaim folder ownership (previous root daemon may have locked it)
  await ensureUserOwnedDir(TAILSCALE_DIR);

  const tailscaledBin = IS_WINDOWS ? "tailscaled" : getTailscaledBin();
  const daemonArgs = [
    `--socket=${TAILSCALE_SOCKET}`,
    `--statedir=${TAILSCALE_DIR}`,
  ];
  if (!wantTun) daemonArgs.push("--tun=userspace-networking");

  if (wantTun) {
    // TUN mode: spawn via sudo, password via stdin. Detached so it survives parent exit.
    const child = spawn("sudo", ["-S", tailscaledBin, ...daemonArgs], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      cwd: os.tmpdir(),
      env: { ...process.env, PATH: EXTENDED_PATH },
    });
    child.stdin.write(`${sudoPassword}\n`);
    child.stdin.end();
    child.unref();
  } else {
    const child = spawn(tailscaledBin, daemonArgs, {
      detached: true,
      stdio: "ignore",
      cwd: os.tmpdir(),
      env: { ...process.env, PATH: EXTENDED_PATH },
    });
    child.unref();
  }

  // Wait for socket ready
  await new Promise((r) => setTimeout(r, 3000));
}

/**
 * Say why `tailscale up` produced no auth URL.
 *
 * The child's stdout and stderr were collected into `output` and then dropped,
 * so a daemon that was not reachable, a socket that could not be opened and a
 * rejected auth key all arrived at the user as the same sentence (#896).
 */
export function describeLoginFailure(output = "") {
  const tail = String(output).trim();
  const excerpt = tail ? ` tailscale said: ${tail.slice(-500)}` : "";
  if (/failed to connect to local (tailscaled|backend)|is tailscaled running|no such file or directory/i.test(tail)) {
    return `The tailscaled daemon is not reachable on TokenProxy's socket, so no login could be started.${excerpt}`;
  }
  if (/permission denied|operation not permitted/i.test(tail)) {
    return `tailscale could not open its socket or network interface (permission denied). Start it with a sudo password, or install Tailscale system-wide.${excerpt}`;
  }
  if (/invalid.*key|auth ?key|expired/i.test(tail)) {
    return `The TAILSCALE_AUTHKEY was rejected.${excerpt}`;
  }
  if (!tail) {
    return "tailscale up produced no auth URL and printed nothing within 15s. The daemon may still be starting — try again, or check `tailscale status` for the state it is in.";
  }
  return `tailscale up produced no auth URL within 15s.${excerpt}`;
}

// The `tailscale up` started for a login runs detached so it can outlive this
// request and finish the handshake once the user returns from the browser. It is
// tracked so a NEW login attempt can retire it first: a second `up` against the
// same daemon is refused by the CLI, which is what turned "stuck waiting for
// login" into an error on the retry (#896).
let loginChild = null;

/** Best-effort: ensure daemon running (used for login flow) */
function ensureDaemon() {
  startDaemonWithPassword("").catch(() => {});
}

/** Read AuthURL from `tailscale status --json` (Win exposes it there, not stdout). */
function getAuthUrlFromStatus() {
  const bin = getTailscaleBin();
  if (!bin) return null;
  try {
    const out = execSync(`"${bin}" ${SOCKET_FLAG.join(" ")} status --json`, {
      encoding: "utf8", windowsHide: true, timeout: 2000
    });
    const j = JSON.parse(out);
    if (j.AuthURL) return j.AuthURL;
    return null;
  } catch { return null; }
}

/**
 * Run `tailscale up` and capture the auth URL for browser login.
 * Resolves with { authUrl } or { alreadyLoggedIn: true }.
 * On Windows, AuthURL comes from `status --json` (not stdout) — must poll status.
 */
export async function startLogin(hostname) {
  const bin = getTailscaleBin();
  if (!bin) return Promise.reject(new Error("Tailscale not installed"));

  // Ensure daemon is running (best-effort, no sudo).
  ensureDaemon();

  // The custom socket is the daemon that `tailscale up` below configures.
  // A system daemon may be logged in to a different tailnet, so it cannot
  // prove this login flow completed.
  if (await isTailscaleLoggedInStrict()) return { alreadyLoggedIn: true };

  // Retire a superseded login attempt before starting another one.
  if (loginChild && !loginChild.killed) {
    console.log("[Tailscale] retiring the previous, unfinished `tailscale up`");
    try { loginChild.kill(); } catch { /* already gone */ }
  }
  loginChild = null;

  return new Promise((resolve, reject) => {
    const args = buildTailscaleUpArgs(hostname);
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      windowsHide: true
    });
    loginChild = child;

    let resolved = false;
    let output = "";
    let loginStatusProbe = null;

    const parseAuthUrl = (text) => {
      const match = text.match(/https:\/\/login\.tailscale\.com\/a\/[a-zA-Z0-9]+/);
      return match ? match[0] : null;
    };

    const finishWithUrl = (url, source) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      clearInterval(statusPoll);
      console.log(`[Tailscale] login authUrl detected (${source})`);
      child.unref();
      resolve({ authUrl: url });
    };

    const finishAlreadyLoggedIn = (source) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      clearInterval(statusPoll);
      console.log(`[Tailscale] login completed (${source})`);
      child.unref();
      resolve({ alreadyLoggedIn: true });
    };

    const customSocketLoggedIn = () => {
      if (!loginStatusProbe) {
        loginStatusProbe = isTailscaleLoggedInStrict()
          .finally(() => { loginStatusProbe = null; });
      }
      return loginStatusProbe;
    };

    const finishIfCustomSocketLoggedIn = async (source) => {
      if (resolved || !(await customSocketLoggedIn())) return false;
      finishAlreadyLoggedIn(source);
      return true;
    };

    // Poll status --json every 500ms — Windows exposes AuthURL only there
    const statusPoll = setInterval(() => {
      if (resolved) return;
      void finishIfCustomSocketLoggedIn("status");
      const url = getAuthUrlFromStatus();
      if (url) finishWithUrl(url, "status");
    }, 500);

    const timeout = setTimeout(() => {
      if (resolved) return;
      const url = parseAuthUrl(output) || getAuthUrlFromStatus();
      if (url) {
        finishWithUrl(url, "timeout");
        return;
      }
      void finishIfCustomSocketLoggedIn("timeout").then((completed) => {
        if (completed || resolved) return;
        resolved = true;
        clearInterval(statusPoll);
        child.unref();
        reject(new Error(describeLoginFailure(output)));
      });
    }, 15000);

    const handleData = (data) => {
      output += data.toString();
      const url = parseAuthUrl(output);
      if (url) finishWithUrl(url, "stdout");
    };

    child.stdout.on("data", handleData);
    child.stderr.on("data", handleData);

    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      clearInterval(statusPoll);
      console.error(`[Tailscale] login spawn error: ${err.message}`);
      reject(err);
    });

    child.on("exit", (code) => {
      if (loginChild === child) loginChild = null;
      if (resolved) return;
      console.log(`[Tailscale] login exit code=${code}`);
      // Don't trust exit code alone — Win `tailscale up` exits 0 even when not logged in.
      // Let status poll continue until AuthURL appears or timeout.
      const url = parseAuthUrl(output) || getAuthUrlFromStatus();
      if (url) {
        finishWithUrl(url, "exit");
        return;
      }
      // Only the custom socket can prove this login flow completed.
      void finishIfCustomSocketLoggedIn("exit");
      // Otherwise keep polling — daemon may publish AuthURL shortly after exit
    });
  });
}

/** Start tailscale funnel for the given port */
export async function startFunnel(port) {
  const bin = getTailscaleBin();
  if (!bin) throw new Error("Tailscale not installed");

  // Reset any existing funnel
  try { execSync(`"${bin}" ${SOCKET_FLAG.join(" ")} funnel --bg reset`, { stdio: "ignore", windowsHide: true }); } catch (e) { /* ignore */ }

  return new Promise((resolve, reject) => {
    const child = spawn(bin, tsArgs("funnel", "--bg", `${port}`), {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    let resolved = false;
    let output = "";

    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      // --bg exits after setup, read actual hostname from status
      const url = getActualFunnelUrl() || getTailscaleFunnelUrl(port);
      if (url) resolve({ tunnelUrl: url });
      else reject(new Error(`Tailscale funnel timed out: ${output.trim() || "no output"}`));
    }, 30000);

    // Always resolve via Self.DNSName to get the real hostname (avoids -1 suffix from conflicts)
    const parseFunnelUrl = () => getActualFunnelUrl();

    let funnelNotEnabled = false;

    const handleData = (data) => {
      output += data.toString();

      if (output.includes("Funnel is not enabled")) funnelNotEnabled = true;

      // Wait for the enable URL to arrive in a later chunk
      if (funnelNotEnabled && !resolved) {
        const enableMatch = output.match(/https:\/\/login\.tailscale\.com\/[^\s]+/);
        if (enableMatch) {
          resolved = true;
          clearTimeout(timeout);
          child.kill();
          resolve({ funnelNotEnabled: true, enableUrl: enableMatch[0] });
          return;
        }
      }

      const url = parseFunnelUrl();
      if (url && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ tunnelUrl: url });
      }
    };

    child.stdout.on("data", handleData);
    child.stderr.on("data", handleData);

    child.on("exit", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      console.log(`[Tailscale] funnel exit code=${code} output="${output.trim().slice(0, 200)}"`);
      const url = parseFunnelUrl() || getTailscaleFunnelUrl(port);
      if (url) resolve({ tunnelUrl: url });
      else reject(new Error(`tailscale funnel failed (code ${code}): ${output.trim()}`));
    });

    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/** Provision TLS cert for funnel domain (required before Funnel serves HTTPS). Best-effort. */
export async function provisionCert(hostname) {
  const bin = getTailscaleBin();
  if (!bin || !hostname) return;
  const certsDir = path.join(TAILSCALE_DIR, "certs");
  fs.mkdirSync(certsDir, { recursive: true });
  const certFile = path.join(certsDir, `${hostname}.crt`);
  const keyFile = path.join(certsDir, `${hostname}.key`);
  try {
    await execAsync(
      `"${bin}" ${SOCKET_FLAG.join(" ")} cert --cert-file "${certFile}" --key-file "${keyFile}" "${hostname}"`,
      { windowsHide: true, env: { ...process.env, PATH: EXTENDED_PATH }, timeout: 30000 }
    );
    console.log(`[Tailscale] cert provisioned for ${hostname}`);
  } catch (e) {
    console.warn(`[Tailscale] cert provision failed (non-fatal): ${e.message}`);
  }
}

/** Stop tailscale funnel */
export function stopFunnel() {
  const bin = getTailscaleBin();
  if (!bin) return;
  try { execSync(`"${bin}" ${SOCKET_FLAG.join(" ")} funnel --bg reset`, { stdio: "ignore", windowsHide: true }); } catch (e) { /* ignore */ }
}

/** Kill tailscaled daemon (runs as root, needs sudo) */
export async function stopDaemon(sudoPassword) {
  // Try non-sudo first
  try { execSync("pkill -x tailscaled", { stdio: "ignore", windowsHide: true, timeout: 3000 }); } catch { /* ignore */ }

  // Still alive? Escalate. Either way the stale socket gets cleaned up.
  let alive = true;
  try { execSync("pgrep -x tailscaled", { stdio: "ignore", windowsHide: true, timeout: 2000 }); } catch { alive = false; }

  if (alive && !IS_WINDOWS) {
    try { await execWithPassword("pkill -x tailscaled", sudoPassword || ""); } catch { /* ignore */ }
  }

  try { if (fs.existsSync(TAILSCALE_SOCKET)) fs.unlinkSync(TAILSCALE_SOCKET); } catch { /* ignore */ }
}
