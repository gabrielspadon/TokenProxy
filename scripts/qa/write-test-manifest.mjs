#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const outputFlag = args.indexOf("--output");
if (outputFlag === -1 || !args[outputFlag + 1]) {
  console.error("usage: write-test-manifest.mjs <report.json> [...] --output <manifest.json>");
  process.exit(2);
}
const output = resolve(args[outputFlag + 1]);
args.splice(outputFlag, 2);
if (!args.length) {
  console.error("at least one Vitest JSON report is required");
  process.exit(2);
}

function testPath(name) {
  const normalized = String(name).replaceAll("\\", "/");
  const marker = "/tests/";
  const index = normalized.lastIndexOf(marker);
  if (index !== -1) return `tests/${normalized.slice(index + marker.length)}`;
  return normalized.startsWith("tests/") ? normalized : `tests/${normalized}`;
}

const files = new Map();
for (const reportPath of args) {
  const report = JSON.parse(readFileSync(resolve(reportPath), "utf8"));
  if (!Array.isArray(report.testResults)) throw new Error(`${reportPath} has no testResults array`);
  for (const result of report.testResults) {
    const file = testPath(result.name);
    const assertions = [];
    for (const assertion of result.assertionResults || []) {
      if (!assertion.fullName) throw new Error(`${file} has an assertion without fullName`);
      assertions.push(assertion.fullName);
    }
    files.set(file, assertions);
  }
}

const manifest = {
  schemaVersion: 1,
  files: Object.fromEntries(
    [...files].sort(([left], [right]) => left.localeCompare(right))
      .map(([file, assertions]) => [file, assertions.sort((left, right) => left.localeCompare(right))]),
  ),
};
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(`wrote ${files.size} files and ${Object.values(manifest.files).reduce((sum, names) => sum + names.length, 0)} assertions to ${output}`);
