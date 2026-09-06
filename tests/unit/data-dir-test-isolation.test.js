import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  mkdirSync: vi.fn(),
  homedir: vi.fn(() => "/validation-home"),
}));

vi.mock("node:fs", () => ({ default: { mkdirSync: io.mkdirSync } }));
vi.mock("node:os", () => ({ default: { homedir: io.homedir } }));

const platform = Object.getOwnPropertyDescriptor(process, "platform");
const configuredByTestRecipe = process.env.DATA_DIR;
const load = () => import("../../src/lib/dataDir.js");

beforeEach(() => {
  vi.resetModules();
  io.mkdirSync.mockReset();
  io.homedir.mockClear();
  vi.stubEnv("NODE_ENV", "test");
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
});

describe("test database isolation before module initialization", () => {
  it.each([undefined, "", "   "])("rejects an unspecified test DATA_DIR (%s) without filesystem writes", async value => {
    vi.stubEnv("DATA_DIR", value);

    await expect(load()).rejects.toThrow(/NODE_ENV=test requires an explicit DATA_DIR/);

    expect(io.mkdirSync).not.toHaveBeenCalled();
    expect(io.homedir).not.toHaveBeenCalled();
  });

  it("accepts the explicit per-file directory supplied by the repository recipe", async () => {
    expect(configuredByTestRecipe).toMatch(/tokenproxy-test-file-/);
    vi.stubEnv("DATA_DIR", configuredByTestRecipe);

    expect((await load()).DATA_DIR).toBe(configuredByTestRecipe);

    expect(io.mkdirSync).toHaveBeenCalledExactlyOnceWith(configuredByTestRecipe, {
      recursive: true,
      mode: 0o700,
    });
    expect(io.homedir).not.toHaveBeenCalled();
  });

  it.each(["EACCES", "EPERM"])("never redirects a denied test directory to the home database (%s)", async code => {
    vi.stubEnv("DATA_DIR", "/isolated-test-data");
    const denied = Object.assign(new Error("permission denied"), { code });
    io.mkdirSync.mockImplementation(() => { throw denied; });

    await expect(load()).rejects.toBe(denied);

    expect(io.mkdirSync).toHaveBeenCalledTimes(1);
    expect(io.homedir).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("rejects a Unix-only test path on Windows before selecting the default directory", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    vi.stubEnv("DATA_DIR", "/var/lib/test-data");

    await expect(load()).rejects.toThrow(/test.*Windows-compatible DATA_DIR/);

    expect(io.mkdirSync).not.toHaveBeenCalled();
    expect(io.homedir).not.toHaveBeenCalled();
  });
});

describe("ordinary application startup retains its existing directory contract", () => {
  it.each(["production", "development"])("preserves the default path in %s", async environment => {
    vi.stubEnv("NODE_ENV", environment);
    vi.stubEnv("DATA_DIR", undefined);

    expect((await load()).DATA_DIR).toBe("/validation-home/.tokenproxy");

    expect(io.mkdirSync).not.toHaveBeenCalled();
  });

  it.each(["EACCES", "EPERM"])("preserves production permission fallback (%s)", async code => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATA_DIR", "/configured-app-data");
    io.mkdirSync.mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), { code });
    });

    expect((await load()).DATA_DIR).toBe("/validation-home/.tokenproxy");
    expect(console.warn).toHaveBeenCalledOnce();
  });
});
