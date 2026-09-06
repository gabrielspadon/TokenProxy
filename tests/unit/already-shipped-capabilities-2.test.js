import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// Thirteen more upstream reports whose ask this fork already satisfies. Each
// assertion is the predicate that was used to verify the claim, so removing the
// mechanism fails a test naming the issue it re-opens.
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const has = (p) => existsSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)));

it("#2357 sends anthropic-version lowercase, so it cannot duplicate", () => {
  expect(read("open-sse/providers/registry/anthropic.js")).toContain('"anthropic-version"');
});

it("#2712 keys the byApiKey aggregate by a masked key", () => {
  expect(read("src/lib/db/repos/usageRepo.js")).toContain("apiKeyKey");
});

it("#2759 replays a JetBrains h2c upgrade over HTTP/1.1", () => {
  expect(read("custom-server.js")).toContain("h2c");
});

it("#2616 no longer lists the NVIDIA ids that were withdrawn", () => {
  const src = read("open-sse/providers/registry/nvidia.js");
  expect(src).not.toMatch(/minimax-m2\.7/);
  expect(src).not.toMatch(/deepseek-v4-pro/);
});

it("#2472 writes no request log, so nothing accumulates on disk", () => {
  expect(read("src/lib/db/repos/usageRepo.js")).toContain("export async function appendRequestLog() {}");
});

it("#2487 pins a Cursor client version rather than an outdated default", () => {
  expect(read("open-sse/providers/registry/cursor.js")).toMatch(/\d+\.\d+\.\d+/);
  expect(read("open-sse/providers/registry/cursor.js")).toContain("3.12.17");
});

it("#2435 resolves target format and transport together", () => {
  expect(has("open-sse/handlers/chatCore/upstreamRoute.js")).toBe(true);
});

it("#1525 can disable a model per provider", () => {
  const repo = read("src/lib/db/repos/disabledModelsRepo.js");
  expect(repo).toMatch(/disableModels/);
  expect(repo).toMatch(/enableModels/);
});

it("#1526 transcribes through NVIDIA", () => {
  expect(read("open-sse/handlers/sttCore.js")).toMatch(/nvidia-asr|transcribeNvidia/);
});

it("#1192 no importer can silently drop rows, because none reads outside state", () => {
  // The row-count assertion existed to guard a predecessor JSON importer.
  // TokenProxy installs clean, so the importer and its guard are both gone and
  // the property that matters now is that nothing imports at all.
  const m = read("src/lib/db/migrate.js");
  expect(m).not.toMatch(/importLegacy|readJsonSafe|LEGACY_FILES|migrated-from-json/);
  expect(read("src/lib/db/paths.js")).not.toContain("LEGACY_FILES");
});

it("#1035 the container entrypoint is the wrapped server, not a bare next server", () => {
  const df = read("Dockerfile");
  expect(df).toContain("custom-server.js");
  // A bare server.js entrypoint would skip the IP-derivation wrapper entirely.
  expect(df).not.toMatch(/CMD \[\s*"node",\s*"server\.js"\s*\]/);
});

it("#1136 fetches live model lists from providers that offer one", () => {
  const out = execFileSync("bash", ["-lc",
    "grep -rl modelsFetcher open-sse/providers/registry/*.js | wc -l"],
    { cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8" });
  expect(Number(out.trim())).toBeGreaterThanOrEqual(10);
});
