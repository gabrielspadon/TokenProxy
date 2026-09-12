import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptSecretJson, decryptSecretJson } from "../../src/lib/db/helpers/secretCol.js";

describe("secretCol", () => {
  it("round-trips a JSON value through encryption", () => {
    const value = { apiKey: "sk-test-123", refreshToken: "rt-abc", nested: { n: 1 } };
    const stored = encryptSecretJson(value);
    expect(typeof stored).toBe("string");
    expect(stored.startsWith("enc1:")).toBe(true);
    expect(stored).not.toContain("sk-test-123");
    expect(decryptSecretJson(stored)).toEqual(value);
  });

  it("reads legacy plaintext JSON without the enc1: prefix", () => {
    const value = { apiKey: "legacy-key" };
    const legacy = JSON.stringify(value);
    expect(decryptSecretJson(legacy)).toEqual(value);
  });

  it("returns the fallback for null/invalid input", () => {
    expect(decryptSecretJson(null, { a: 1 })).toEqual({ a: 1 });
    expect(decryptSecretJson("not json", { a: 1 })).toEqual({ a: 1 });
    expect(decryptSecretJson("enc1:garbage", { a: 1 })).toEqual({ a: 1 });
  });
});

const originalDataDir = process.env.DATA_DIR;
const nodeMachineId = require("node-machine-id");
let installDirs = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  for (const dir of installDirs) fs.rmSync(dir, { recursive: true, force: true });
  installDirs = [];
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function failedMachineInstall() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-secret-install-"));
  installDirs.push(dir);
  process.env.DATA_DIR = dir;
  vi.resetModules();
  vi.spyOn(nodeMachineId, "machineIdSync").mockImplementation(() => { throw new Error("machine id unavailable"); });
  return { dir, secret: await import("../../src/lib/db/helpers/secretCol.js") };
}

function legacyFallbackCiphertext(value) {
  const key = crypto.createHash("sha256").update("tokenproxy-conn-secret").digest();
  const iv = Buffer.alloc(12, 7);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `enc1:${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${data.toString("hex")}`;
}

describe("installation-local fallback encryption key", () => {
  it("uses distinct persisted keys and ciphertext domains when machine identity fails on two installations", async () => {
    const first = await failedMachineInstall();
    const firstCiphertext = first.secret.encryptSecretJson({ token: "first" });
    const firstKey = fs.readFileSync(path.join(first.dir, "db", "secret.key"), "utf8");
    vi.restoreAllMocks();

    const second = await failedMachineInstall();
    const secondCiphertext = second.secret.encryptSecretJson({ token: "second" });
    const secondKey = fs.readFileSync(path.join(second.dir, "db", "secret.key"), "utf8");

    expect(firstKey).toMatch(/^[a-f0-9]{64}$/);
    expect(secondKey).toMatch(/^[a-f0-9]{64}$/);
    expect(secondKey).not.toBe(firstKey);
    expect(second.secret.decryptSecretJson(firstCiphertext, "unavailable")).toBe("unavailable");
    expect(second.secret.decryptSecretJson(secondCiphertext)).toEqual({ token: "second" });
    if (process.platform !== "win32") expect(fs.statSync(path.join(second.dir, "db", "secret.key")).mode & 0o777).toBe(0o600);
  });

  it("recovers ciphertext written by the legacy deterministic failure key", async () => {
    const install = await failedMachineInstall();
    const legacy = legacyFallbackCiphertext({ refreshToken: "recover-me" });
    expect(install.secret.decryptSecretJson(legacy)).toEqual({ refreshToken: "recover-me" });
    expect(install.secret.decryptSecretJson(install.secret.encryptSecretJson({ migrated: true }))).toEqual({ migrated: true });
  });
});
