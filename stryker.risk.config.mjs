import { resolve } from "node:path";
import { loadRiskScope } from "./scripts/qa/risk-scope.mjs";

const scope = loadRiskScope(process.env.TOKENPROXY_RISK_SCOPE);
if (!process.env.TOKENPROXY_RISK_ARTIFACTS) throw new Error("TOKENPROXY_RISK_ARTIFACTS is required");

const config = {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "tests/vitest.config.js", dir: "tests", related: false },
  mutate: scope.files.map(({ path }) => path.replaceAll("[", "[[]")),
  coverageAnalysis: "perTest",
  concurrency: 1,
  timeoutMS: 30000,
  thresholds: { high: 90, low: 75, break: 60 },
  reporters: ["clear-text", "json"],
  jsonReporter: { fileName: resolve(process.env.TOKENPROXY_RISK_ARTIFACTS, "mutation.json") },
  allowEmpty: false,
  dryRunOnly: false,
  incremental: false,
  ignoreStatic: false,
  disableTypeChecks: false,
};
export default config;
