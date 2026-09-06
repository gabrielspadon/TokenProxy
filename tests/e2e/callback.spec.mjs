import { test, expect } from "playwright/test";

test("code is relayed through localStorage with a timestamp", async ({ page }) => {
  await page.goto("/callback?code=abc123&state=st-1");
  await expect(page.getByText("Signed in.")).toBeVisible();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("oauth_callback")));
  expect(stored.code).toBe("abc123");
  expect(stored.state).toBe("st-1");
  expect(typeof stored.timestamp).toBe("number");
  expect(stored.expiresAt - stored.timestamp).toBe(30000);
});

test("a provider error outranks a present code", async ({ page }) => {
  await page.goto("/callback?code=abc123&error=access_denied");
  await expect(page.getByText("The provider refused the sign-in.")).toBeVisible();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("oauth_callback")));
  expect(stored.error).toBe("access_denied");
  expect(stored.code).toBeUndefined();
});

test("the relay reaches the opener on the same origin only", async ({ page, context }) => {
  const opener = page;
  await opener.goto("/login");
  const got = opener.evaluate(() => new Promise((resolve) => {
    window.addEventListener("message", (e) => { if (e.data?.type === "oauth_callback") resolve({ origin: e.origin, data: e.data.data }); });
  }));
  const [popup] = await Promise.all([
    context.waitForEvent("page"),
    opener.evaluate(() => { window.open("/callback?token=tok-1&state=s2", "oauth"); }),
  ]);
  await popup.waitForLoadState();
  const msg = await got;
  expect(msg.origin).toBe(new URL(opener.url()).origin);
  expect(msg.data).toEqual({ token: "tok-1", state: "s2" });
});

test("nothing to relay is said plainly", async ({ page }) => {
  await page.goto("/callback");
  await expect(page.getByText("This window received nothing to relay.")).toBeVisible();
});
