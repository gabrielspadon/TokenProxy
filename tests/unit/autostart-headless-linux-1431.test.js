import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const MODULE_PATH = fileURLToPath(new URL("../../cli/src/cli/tray/autostart.js", import.meta.url));

// #1431: on a headless Ubuntu 22.04 server (no desktop environment, no
// DISPLAY), Hide to Tray wrote ~/.config/autostart/tokenproxy.desktop and
// reported success, but that directory is only ever read by a graphical
// session manager starting up -- nothing on a headless server ever runs it,
// so the entry did nothing and tokenproxy never came back after a reboot.
//
// autostart.js is loaded through node's own require() (see
// autostart-opt-out-3628.test.js), which sits outside Vite's module graph,
// so vi.mock cannot intercept its `require("child_process")`. The
// child_process module object is a singleton in node's own require cache
// though, so patching its execSync property directly -- before re-requiring
// autostart.js so the fresh copy destructures the patched value -- gives the
// same determinism vi.mock would, without depending on this host's actual
// systemd --user session (present here, but not guaranteed in CI).
const childProcess = require_("child_process");

describe("autostart falls back to a systemd --user unit when headless (#1431)", () => {
  let appData;
  let cliPath;
  let dataDir;
  let home;
  let mod;
  let originalPlatform;
  let root;
  let systemdEnabled;
  const originalEnv = {};

  function desktopEntry() {
    return join(home, ".config", "autostart", "tokenproxy.desktop");
  }

  function unitEntry() {
    return join(home, ".config", "systemd", "user", "tokenproxy.service");
  }

  function load() {
    delete require_.cache[MODULE_PATH];
    return require_(MODULE_PATH);
  }

  function loadWithExecSync(execSync) {
    const previous = childProcess.execSync;
    childProcess.execSync = execSync;
    try {
      return load();
    } finally {
      childProcess.execSync = previous;
    }
  }

  function fakeSystemctl(cmd) {
    if (typeof cmd !== "string") throw new Error("unexpected non-string command");
    if (cmd.includes("systemctl --user daemon-reload")) return;
    if (cmd.includes("systemctl --user enable")) {
      systemdEnabled = true;
      return;
    }
    if (cmd.includes("systemctl --user disable")) {
      systemdEnabled = false;
      return;
    }
    if (cmd.includes("systemctl --user is-enabled")) {
      if (!systemdEnabled) throw new Error("disabled");
      return;
    }
    if (cmd.includes("loginctl enable-linger")) return;
    throw new Error(`unexpected command: ${cmd}`);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tokenproxy-autostart-1431-"));
    home = join(root, "home");
    dataDir = join(root, "data");
    appData = join(root, "appdata");
    cliPath = join(root, "cli.js");
    mkdirSync(join(home, ".config", "autostart"), { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(cliPath, "// test cli\n");

    for (const key of ["APPDATA", "DATA_DIR", "DISPLAY", "HOME", "USERPROFILE"]) {
      originalEnv[key] = process.env[key];
    }
    process.env.APPDATA = appData;
    process.env.DATA_DIR = dataDir;
    delete process.env.DISPLAY;
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    // Capture a deterministic command adapter before autostart.js destructures
    // execSync, without leaving the Node singleton patched for another file.
    systemdEnabled = false;

    originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    mod = loadWithExecSync(fakeSystemctl);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", originalPlatform);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { force: true, recursive: true });
  });

  it("writes a systemd user unit instead of the inert desktop-autostart file", () => {
    expect(mod.ensureAutoStart(cliPath)).toBe(true);
    expect(existsSync(desktopEntry())).toBe(false);
    expect(existsSync(unitEntry())).toBe(true);

    const unit = readFileSync(unitEntry(), "utf8");
    expect(unit).toContain("ExecStart=");
    expect(unit).toContain(cliPath);
    expect(unit).toContain("--tray");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("reports enabled via the systemd unit and removes it on disable", () => {
    expect(mod.ensureAutoStart(cliPath)).toBe(true);
    expect(mod.isAutoStartEnabled()).toBe(true);

    mod.disableAutoStart();
    expect(existsSync(unitEntry())).toBe(false);
    expect(mod.isAutoStartEnabled()).toBe(false);
  });

  it("does not report success, and cleans up the unit, when the manager cannot link it", () => {
    // A unit file sitting on disk but never linked into default.target is
    // the same "looks configured, never runs" failure #1431 reported --
    // reproduced here by making the enable command itself fail, the same
    // outcome a headless box with no systemd --user session at all would see.
    // Patched BEFORE load(): autostart.js destructures execSync out of the
    // child_process module object at require time, so the fresh copy must
    // see the patched function, not the original captured earlier.
    const failing = loadWithExecSync((cmd, opts) => {
      if (typeof cmd === "string" && cmd.includes("systemctl --user enable")) {
        throw new Error("Failed to connect to bus: No such file or directory");
      }
      return fakeSystemctl(cmd, opts);
    });

    expect(failing.ensureAutoStart(cliPath)).toBe(false);
    expect(existsSync(unitEntry())).toBe(false);
    expect(failing.isAutoStartEnabled()).toBe(false);
  });

  it("does not trust a leftover unit file without confirming the manager has it enabled", () => {
    expect(mod.ensureAutoStart(cliPath)).toBe(true);

    // Simulate a manager restart / lost enablement leaving only the file
    // behind -- isAutoStartEnabled must check reality, not disk state alone,
    // the same guard already applied to the darwin branch above it. Patched
    // and reloaded for the same reason as the previous test.
    const afterRestart = loadWithExecSync((cmd, opts) => {
      if (typeof cmd === "string" && cmd.includes("is-enabled")) {
        throw new Error("disabled");
      }
      return fakeSystemctl(cmd, opts);
    });
    expect(afterRestart.isAutoStartEnabled()).toBe(false);
  });

  it("still uses the desktop-autostart file on a graphical session (DISPLAY set)", () => {
    process.env.DISPLAY = ":0";
    const gui = load();
    expect(gui.ensureAutoStart(cliPath)).toBe(true);
    expect(existsSync(desktopEntry())).toBe(true);
    expect(existsSync(unitEntry())).toBe(false);
  });
});
