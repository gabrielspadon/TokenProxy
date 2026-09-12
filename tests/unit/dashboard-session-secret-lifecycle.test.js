// The JWT secret is read where it is USED, not at module scope, so this file
// pins the three properties that change makes possible and the two it must not
// weaken. Importing the module with no secret has to work, because the settings
// route imports it and the offline runner deliberately supplies no secret; but
// issuing a session without one still has to throw, verification still has to
// fail closed, and a rotated or removed secret has to take effect on the very
// next call rather than being held alive by a cache.
import { afterEach, describe, expect, it } from "vitest";

const MODULE = "@/lib/auth/dashboardSession.js";
const ALPHA = "secret-lifecycle-fixture-alpha-0123456789abcd";
const BRAVO = "secret-lifecycle-fixture-bravo-0123456789abcd";

const savedSecret = process.env.JWT_SECRET;
afterEach(() => {
  if (savedSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = savedSecret;
});

describe("dashboard session secret lifecycle", () => {
  it("imports without a secret, then refuses to issue and refuses to verify", async () => {
    delete process.env.JWT_SECRET;
    const session = await import(MODULE);

    await expect(session.createDashboardAuthToken({ sub: "operator" }))
      .rejects.toThrow("JWT_SECRET environment variable is required");
    await expect(session.getDashboardAuthSession("not.a.token")).resolves.toBeNull();
    await expect(session.verifyDashboardAuthToken("not.a.token")).resolves.toBe(false);
  });

  it("stops honouring a token the moment its signing secret is rotated away", async () => {
    const session = await import(MODULE);

    process.env.JWT_SECRET = ALPHA;
    const underAlpha = await session.createDashboardAuthToken({ sub: "operator" });
    expect(await session.verifyDashboardAuthToken(underAlpha)).toBe(true);

    // A memoised secret would keep this token valid across the rotation, which
    // is the failure this test exists to catch.
    process.env.JWT_SECRET = BRAVO;
    expect(await session.verifyDashboardAuthToken(underAlpha)).toBe(false);

    const underBravo = await session.createDashboardAuthToken({ sub: "operator" });
    expect(await session.verifyDashboardAuthToken(underBravo)).toBe(true);
  });

  it("treats a removed secret as missing rather than falling back to the last one", async () => {
    const session = await import(MODULE);

    process.env.JWT_SECRET = ALPHA;
    const issued = await session.createDashboardAuthToken({ sub: "operator" });

    delete process.env.JWT_SECRET;
    expect(await session.verifyDashboardAuthToken(issued)).toBe(false);
    await expect(session.createDashboardAuthToken({ sub: "operator" }))
      .rejects.toThrow("JWT_SECRET environment variable is required");
  });

  it("rejects only an absent secret, applying no length policy of its own", async () => {
    // Length is the operator's call, stated in the error text and enforced at the
    // boundary that sets the variable. Silently rejecting a short secret here
    // would lock out an existing install on an unrelated code change.
    const session = await import(MODULE);

    process.env.JWT_SECRET = "x";
    const issued = await session.createDashboardAuthToken({ sub: "operator" });
    expect(await session.verifyDashboardAuthToken(issued)).toBe(true);

    process.env.JWT_SECRET = "";
    await expect(session.createDashboardAuthToken({ sub: "operator" }))
      .rejects.toThrow("JWT_SECRET environment variable is required");
  });
});
