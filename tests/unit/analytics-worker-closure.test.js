import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { analyticsWorkerClosure } from "../../scripts/analytics-worker-closure.mjs";
import { ANALYTICS_WORKER_FILES } from "../../src/lib/db/analytics/runtimeFiles.mjs";
import nextConfig from "../../next.config.mjs";

const ROOT = resolve(import.meta.dirname, "../..");

describe("analytics worker runtime closure", () => {
  it("lists exactly the worker's transitive local imports", () => {
    expect([...ANALYTICS_WORKER_FILES].sort()).toEqual(analyticsWorkerClosure());
  });

  it("names only files that exist", () => {
    for (const file of ANALYTICS_WORKER_FILES) expect(existsSync(join(ROOT, file)), file).toBe(true);
  });

  // The defect: a *.mjs glob shipped the query modules without the sibling .js
  // schema files they import, so the worker threw ERR_MODULE_NOT_FOUND on
  // economicsProjectionSchema.js before its first message and /api/analytics
  // answered 503. These are the files a glob cannot reach.
  it("includes the sibling .js modules a directory glob omitted", () => {
    for (const file of [
      "./src/lib/db/economicsProjectionSchema.js",
      "./src/lib/db/driver.js",
      "./src/lib/db/paths.js",
      "./src/lib/db/schema.js",
      "./src/lib/db/migrations/index.js",
    ]) expect(ANALYTICS_WORKER_FILES, file).toContain(file);
  });

  it("is traced into the standalone output by next.config", () => {
    const traced = nextConfig.outputFileTracingIncludes["**"];
    for (const file of ANALYTICS_WORKER_FILES) expect(traced, file).toContain(file);
    expect(traced).not.toContain("./src/lib/db/analytics/*.mjs");
  });

  it("is closed: no listed file imports a local module outside the list", () => {
    expect(analyticsWorkerClosure().filter((file) => !ANALYTICS_WORKER_FILES.includes(file))).toEqual([]);
  });
});
