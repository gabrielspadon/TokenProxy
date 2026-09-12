#!/usr/bin/env node
// Derives the analytics Worker's exact transitive local-import closure and either
// prints it or checks the committed list against it. The worker is loaded by path,
// so Next traces nothing it imports; a glob over *.mjs omitted the sibling .js
// schema files and the worker died on ERR_MODULE_NOT_FOUND before its first
// message. Parse the imports rather than copy a directory.
//
//   node scripts/analytics-worker-closure.mjs           # print the closure
//   node scripts/analytics-worker-closure.mjs --check   # exit 1 on drift
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = "./src/lib/db/analytics/worker.mjs";
const LIST = "./src/lib/db/analytics/runtimeFiles.mjs";
// Static import/export-from, bare side-effect import, and dynamic import() of a
// string literal. A computed specifier cannot be resolved statically and is
// reported rather than silently dropped.
const SPECIFIER = /^\s*(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gmu;
const CANDIDATE_SUFFIXES = ["", ".mjs", ".js", ".cjs", ".json", "/index.mjs", "/index.js"];

function resolveLocal(from, specifier) {
  let base;
  if (specifier.startsWith("@/")) base = join(ROOT, "src", specifier.slice(2));
  else if (specifier.startsWith("./") || specifier.startsWith("../")) base = resolve(dirname(from), specifier);
  else return null; // bare specifier: a real dependency, traced by Next itself
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`unresolved local import ${specifier} from ${relative(ROOT, from)}`);
}

export function analyticsWorkerClosure() {
  const seen = new Set();
  const pending = [resolve(ROOT, ENTRY)];
  while (pending.length > 0) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
      const specifier = match[1] || match[2] || match[3];
      if (!specifier) continue;
      const local = resolveLocal(file, specifier);
      if (local) pending.push(local);
    }
  }
  return [...seen].map((file) => `./${relative(ROOT, file)}`).sort();
}

// Importing this module must not print or exit, so the CLI runs only when it is
// the entry point. tests/unit/analytics-worker-closure.test.js imports it.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const derived = analyticsWorkerClosure();
  if (process.argv.includes("--check")) {
    const { ANALYTICS_WORKER_FILES } = await import(pathToFileURL(join(ROOT, LIST)).href);
    const committed = [...ANALYTICS_WORKER_FILES].sort();
    const missing = derived.filter((file) => !committed.includes(file));
    const extra = committed.filter((file) => !derived.includes(file));
    for (const file of missing) console.error(`missing from ${LIST}: ${file}`);
    for (const file of extra) console.error(`no longer imported, drop from ${LIST}: ${file}`);
    if (missing.length > 0 || extra.length > 0) {
      console.error(`analytics worker closure drifted: ${derived.length} derived, ${committed.length} committed`);
      process.exitCode = 1;
    } else {
      console.log(`analytics worker closure matches ${LIST}: ${derived.length} files`);
    }
  } else {
    console.log(JSON.stringify(derived, null, 2));
  }
}
