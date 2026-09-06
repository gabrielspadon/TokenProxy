import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import tseslint from "typescript-eslint";

const eslintConfig = defineConfig([
  ...nextVitals,
  // The JS tree carries a disable directive for a typescript-eslint rule; the plugin must be known to resolve it.
  { files: ["**/*.js", "**/*.mjs", "**/*.cjs"], plugins: { "@typescript-eslint": tseslint.plugin } },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
