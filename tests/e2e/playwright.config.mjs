import { defineConfig } from "playwright/test";

// No webServer on purpose: the isolated instance on 20143 is started by
// scripts/dev-test-server.sh and owned by the session, never by a spec run.
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.mjs$/,
  // client-integration and compatibility-qualification are argv-driven node scripts that
  // happen to end in .spec.mjs. Neither imports playwright/test, so collecting them makes
  // a whole `playwright test` run fail before a single real spec starts. Their runners
  // (tests/e2e/*-run.mjs) invoke them directly with process.execPath.
  testIgnore: ['client-integration.spec.mjs', 'compatibility-qualification.spec.mjs'],
  timeout: 30000,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE || "http://localhost:20143",
    locale: "en-US",
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
