import { describe, expect, it } from "vitest";
import { isExpired } from "@/lib/db/repos/apiKeysRepo.js";
import { MIGRATIONS, latestVersion } from "@/lib/db/migrations/index.js";
import { TABLES } from "@/lib/db/schema.js";
import { readFileSync } from "node:fs";

const repo = readFileSync(
  new URL("../../src/lib/db/repos/apiKeysRepo.js", import.meta.url), "utf8");

// Every key issued so far is valid until someone pauses or deletes it by hand,
// which makes a key handed to a short-lived agent a standing credential (#2351).
const NOW = Date.parse("2026-08-31T12:00:00.000Z");
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

describe("an expired key stops working (#2351)", () => {
  it("a stamp in the past is expired", () => {
    expect(isExpired(iso(-1000), NOW)).toBe(true);
  });

  it("a stamp in the future is not", () => {
    expect(isExpired(iso(60_000), NOW)).toBe(false);
  });

  it("the boundary counts as expired, so a key never outlives its own stamp", () => {
    expect(isExpired(iso(0), NOW)).toBe(true);
  });

  it("no stamp means never expires, which is every key issued before this", () => {
    for (const empty of [null, undefined, ""]) expect(isExpired(empty, NOW)).toBe(false);
  });

  it("an unparseable stamp is NOT treated as expired", () => {
    // Refusing a key because its own metadata is malformed would lock an
    // operator out of their gateway over a bad write. It can still be paused.
    expect(isExpired("not-a-date", NOW)).toBe(false);
    expect(isExpired("2026-13-45T99:99:99Z", NOW)).toBe(false);
  });
});

describe("rejection happens at request-auth time", () => {
  it("validateApiKey reads the stamp and refuses before the active check", () => {
    expect(repo).toContain("SELECT isActive, expiresAt FROM apiKeys WHERE key = ?");
    const i = repo.indexOf("if (isExpired(row.expiresAt)) return false;");
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(repo.indexOf("return row.isActive === 1", i));
  });

  it("no sweep is required for a key to stop working", () => {
    // Nothing schedules an expiry job; the check is on the auth path itself.
    expect(repo).not.toMatch(/setInterval|cron|sweepExpired/);
  });
});

describe("a key with no stamp keeps working, and the column is there from install", () => {
  it("the column is declared nullable in the schema a clean install creates", () => {
    // It arrives with the initial schema rather than as an upgrade step: there
    // is no earlier install to alter the table on.
    expect(TABLES.apiKeys.columns.expiresAt).toBe("TEXT");
    expect(TABLES.apiKeys.columns.expiresAt).not.toMatch(/NOT NULL|DEFAULT/i);
  });

  it("no migration reaches back into apiKeys rows", () => {
    for (const m of MIGRATIONS) {
      expect(String(m.up)).not.toMatch(/(DROP TABLE|DELETE FROM|UPDATE)\s+(IF EXISTS\s+)?"?apiKeys\b/i);
    }
  });

  it("the versions stay ordered and unique as the chain grows", () => {
    expect(latestVersion()).toBeGreaterThanOrEqual(1);
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });
});

describe("the creation surface carries it without breaking older callers", () => {
  const route = readFileSync(
    new URL("../../src/app/api/keys/route.js", import.meta.url), "utf8");

  it("POST accepts an optional expiresAt", () => {
    expect(route).toContain("const { name, expiresAt = null } = body;");
    expect(route).toContain("createApiKey(name, machineId, expiresAt)");
  });

  it("a caller that does not send it keeps exactly the behaviour it had", () => {
    // The default is null, which the repo stores as never-expires.
    expect(route).toContain("expiresAt = null");
  });

  it("the created key reports its own expiry back", () => {
    expect(route).toContain("expiresAt: apiKey.expiresAt");
  });
});

describe("the stored shape is normalized", () => {
  it("creation and update both go through the normalizer", () => {
    expect(repo).toContain("expiresAt: normalizeExpiry(expiresAt)");
    expect(repo).toContain("normalizeExpiry(merged.expiresAt)");
  });

  it("a row is read back with both the stamp and a derived flag", () => {
    expect(repo).toContain("expiresAt: row.expiresAt || null");
    expect(repo).toContain("isExpired: isExpired(row.expiresAt)");
  });

  it("an unparseable input becomes never-expires rather than an arbitrary time", () => {
    expect(repo).toContain("return Number.isFinite(at) ? new Date(at).toISOString() : null;");
  });
});
