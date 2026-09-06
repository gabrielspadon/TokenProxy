import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import childProcess from "node:child_process";

const require_ = createRequire(import.meta.url);
const MODULE_PATH = fileURLToPath(new URL("../../cli/src/cli/tray/autostart.js", import.meta.url));
const cli = readFileSync(new URL("../../cli/cli.js", import.meta.url), "utf8");

describe("autostart preserves a user's choice across Hide to Tray (#3628)", () => {
  let appData;
  let cliPath;
  let dataDir;
  let home;
  let mod;
  let originalPlatform;
  let root;
  const originalEnv = {};

  function desktopEntry() {
    return join(home, ".config", "autostart", "tokenproxy.desktop");
  }

  function decisionMarker() {
    return join(dataDir, "autostart-decided");
  }

  function load() {
    delete require_.cache[MODULE_PATH];
    return require_(MODULE_PATH);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tokenproxy-autostart-3628-"));
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
    process.env.DISPLAY = ":0";
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    mod = load();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", originalPlatform);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { force: true, recursive: true });
  });

  it("writes the first automatic entry and records that automatic choice", () => {
    expect(mod.isAutoStartOptedOut()).toBe(false);
    expect(mod.ensureAutoStart(cliPath)).toBe(true);
    expect(existsSync(desktopEntry())).toBe(true);
    expect(existsSync(decisionMarker())).toBe(true);
  });

  it("does not recreate a startup entry manually removed after automatic setup", () => {
    expect(mod.ensureAutoStart(cliPath)).toBe(true);
    unlinkSync(desktopEntry());

    const nextLaunch = load();
    expect(nextLaunch.ensureAutoStart(cliPath)).toBe(false);
    expect(existsSync(desktopEntry())).toBe(false);
  });

  it("retries a failed automatic enable because no decision was recorded", () => {
    // The failure used to be forced by unsetting DISPLAY, on the assumption
    // that headless Linux simply cannot autostart. It can now: a headless
    // machine gets a systemd --user unit instead of the inert XDG desktop entry
    // (#1431), so that no longer fails and the trigger had to move. What this
    // test is actually about is unchanged — an enable that FAILED records no
    // decision, so the next launch is free to try again — so the failure is now
    // forced at the mechanism itself, by making the unit refuse to link.
    delete process.env.DISPLAY;
    const realExecSync = childProcess.execSync;
    childProcess.execSync = (cmd, opts) => {
      if (typeof cmd === "string" && cmd.includes("systemctl --user enable")) {
        throw new Error("no user systemd manager");
      }
      return realExecSync(cmd, opts);
    };
    try {
      const headless = load();
      expect(headless.ensureAutoStart(cliPath)).toBe(false);
      expect(existsSync(decisionMarker())).toBe(false);
    } finally {
      childProcess.execSync = realExecSync;
    }

    process.env.DISPLAY = ":0";
    const graphical = load();
    expect(graphical.ensureAutoStart(cliPath)).toBe(true);
    expect(existsSync(desktopEntry())).toBe(true);
    expect(existsSync(decisionMarker())).toBe(true);
  });

  it("treats the legacy explicit opt-out as a decided state", () => {
    mod.disableAutoStart();
    expect(mod.isAutoStartOptedOut()).toBe(true);

    expect(load().ensureAutoStart(cliPath)).toBe(false);
    expect(existsSync(desktopEntry())).toBe(false);
  });

  it("keeps an explicit re-enable across later automatic hides", () => {
    expect(mod.ensureAutoStart(cliPath)).toBe(true);
    mod.disableAutoStart();
    expect(existsSync(desktopEntry())).toBe(false);

    expect(mod.enableAutoStart(cliPath)).toBe(true);
    expect(mod.isAutoStartOptedOut()).toBe(false);
    expect(existsSync(desktopEntry())).toBe(true);
    expect(load().ensureAutoStart(cliPath)).toBe(false);
    expect(existsSync(desktopEntry())).toBe(true);
  });

  it("uses the CLI data-directory convention on Windows", () => {
    delete process.env.DATA_DIR;
    mkdirSync(join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup"), { recursive: true });
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });

    const windows = load();
    expect(windows.ensureAutoStart(cliPath)).toBe(true);
    expect(existsSync(join(appData, "tokenproxy", "autostart-decided"))).toBe(true);
  });

  it("routes Hide to Tray through the once-only automatic path", () => {
    const hide = cli.slice(cli.indexOf("Enable auto startup only"));
    const block = hide.slice(0, hide.indexOf("catch"));
    expect(block).toContain("ensureAutoStart(__filename)");
    expect(block).not.toContain("enableAutoStartUnlessOptedOut(__filename)");
  });
});
