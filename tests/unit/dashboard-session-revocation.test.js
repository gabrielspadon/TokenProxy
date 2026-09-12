import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.JWT_SECRET = "dashboard-session-revocation-fixture-key-0123456789";
});

const { SignJWT } = await import("jose");
const { getAdapter } = await import("@/lib/db/driver.js");
const { getSettings, updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
const dashboardSession = await import("@/lib/auth/dashboardSession.js");

const db = await getAdapter();
const secret = new TextEncoder().encode(process.env.JWT_SECRET);

beforeEach(() => {
  db.run("DELETE FROM _meta WHERE key = ?", ["dashboardSessionGeneration"]);
});

describe("persisted dashboard session revocation", () => {
  it("invalidates every prior token only after the critical generation write is acknowledged", async () => {
    const first = await dashboardSession.createDashboardAuthToken({ sub: "first" });
    const second = await dashboardSession.createDashboardAuthToken({ sub: "second" });
    expect(await dashboardSession.verifyDashboardAuthToken(first)).toBe(true);
    expect(await dashboardSession.verifyDashboardAuthToken(second)).toBe(true);

    await updateSettings(
      { authMode: "sso" },
      { durability: "critical", dashboardSessionGeneration: "generation-after-change" },
    );

    expect(db.get("SELECT value FROM _meta WHERE key = ?", ["dashboardSessionGeneration"]).value)
      .toBe("generation-after-change");
    expect((await getSettings()).authMode).toBe("sso");
    expect(await Promise.all([
      dashboardSession.verifyDashboardAuthToken(first),
      dashboardSession.verifyDashboardAuthToken(second),
    ])).toEqual([false, false]);
    expect(await dashboardSession.verifyDashboardAuthToken(
      await dashboardSession.createDashboardAuthToken({ sub: "replacement" }),
    )).toBe(true);
  });

  it("persists the revocation verdict across a module restart", async () => {
    const stale = await dashboardSession.createDashboardAuthToken();
    await updateSettings(
      {},
      { durability: "critical", dashboardSessionGeneration: "persisted-generation" },
    );

    vi.resetModules();
    const restarted = await import("@/lib/auth/dashboardSession.js");
    expect(await restarted.verifyDashboardAuthToken(stale)).toBe(false);
    expect(await restarted.verifyDashboardAuthToken(
      await restarted.createDashboardAuthToken(),
    )).toBe(true);
  });

  it("accepts a legacy signed token only until the first persisted revocation", async () => {
    const legacy = await new SignJWT({ authenticated: true })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("24h")
      .sign(secret);
    expect(await dashboardSession.verifyDashboardAuthToken(legacy)).toBe(true);

    await updateSettings(
      {},
      { durability: "critical", dashboardSessionGeneration: "first-generation" },
    );
    expect(await dashboardSession.verifyDashboardAuthToken(legacy)).toBe(false);
  });

  it("rejects non-critical generation changes before either row is written", async () => {
    const before = db.get("SELECT data FROM settings WHERE id = 1")?.data;
    await expect(updateSettings(
      { authMode: "password" },
      { dashboardSessionGeneration: "unsafe-generation" },
    )).rejects.toThrow("critical generation write");
    expect(db.get("SELECT data FROM settings WHERE id = 1")?.data).toEqual(before);
    expect(db.get("SELECT value FROM _meta WHERE key = ?", ["dashboardSessionGeneration"]))
      .toBeUndefined();
  });

  it("rolls back the settings row when the generation write fails", async () => {
    await updateSettings({ password: "before-fault" });
    const originalRun = db.run;
    db.run = (sql, params) => {
      if (sql.startsWith("INSERT INTO _meta") && params?.[0] === "dashboardSessionGeneration") {
        throw new Error("synthetic generation storage fault");
      }
      return originalRun(sql, params);
    };
    try {
      await expect(updateSettings(
        { password: "must-rollback" },
        { durability: "critical", dashboardSessionGeneration: "failed-generation" },
      )).rejects.toThrow("synthetic generation storage fault");
    } finally {
      db.run = originalRun;
    }

    expect((await getSettings()).password).toBe("before-fault");
    expect(db.get("SELECT value FROM _meta WHERE key = ?", ["dashboardSessionGeneration"]))
      .toBeUndefined();
  });
});
