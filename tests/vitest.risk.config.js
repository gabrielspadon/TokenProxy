import base from "./vitest.config.js";
import { resolve } from "node:path";
import { loadRiskScope, ROOT } from "../scripts/qa/risk-scope.mjs";

const scope = loadRiskScope(process.env.TOKENPROXY_RISK_SCOPE);
if (!process.env.TOKENPROXY_RISK_ARTIFACTS) throw new Error("TOKENPROXY_RISK_ARTIFACTS is required");

const config = {
  ...base,
  test: {
    ...base.test,
    maxWorkers: 1,
    allowOnly: false,
    passWithNoTests: false,
    coverage: {
      enabled: true,
      provider: "v8",
      allowExternal: true,
      include: scope.files.map(({ path }) => resolve(ROOT, path).replaceAll("[", "[[]")),
      reporter: ["json", "json-summary", "text-summary"],
      reportsDirectory: resolve(process.env.TOKENPROXY_RISK_ARTIFACTS, "coverage"),
      clean: false,
      reportOnFailure: true,
      // The release assembler applies the 90% threshold to branch locations
      // intersecting the frozen Git changes. Whole-file totals stay report-only.
    },
  },
};
export default config;
