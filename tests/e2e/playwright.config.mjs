import { defineConfig } from "playwright/test";

// No webServer on purpose: the isolated instance on 20143 is started by
// scripts/dev-test-server.sh and owned by the session, never by a spec run.
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.mjs$/,
  timeout: 30000,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE || "http://localhost:20143",
    locale: "en-US",
    viewport: { width: 1280, height: 900 },
  },
});
