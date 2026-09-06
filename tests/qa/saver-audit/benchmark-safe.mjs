#!/usr/bin/env node
// Offline module timings. Fixture construction, input cloning, and receipt
// serialization are outside the timed interval; module-internal work is inside.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "tokenproxy-saver-bench-"));
await import("../../setup-real-io-guard.js");
const { compressMessages } = await import("../../../open-sse/rtk/index.js");
const { jsonCompact } = await import("../../../open-sse/rtk/filters/jsonCompact.js");
const { compressWithHeadroom } = await import("../../../open-sse/rtk/headroom.js");
const out = process.argv[2] || process.env.DATA_DIR;
mkdirSync(out, { recursive: true });

let mockedRequests = 0;
globalThis.fetch = async (_url, init) => {
  mockedRequests++;
  const { messages } = JSON.parse(init.body);
  const before = Buffer.byteLength(JSON.stringify(messages));
  for (const message of messages) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === "tool_result") block.content = jsonCompact(block.content) ?? block.content;
    }
  }
  const after = Buffer.byteLength(JSON.stringify(messages));
  return Response.json({ messages, tokens_before: before, tokens_after: after, tokens_saved: before - after });
};

function fixture(targetBytes) {
  const row = JSON.stringify({ id: "sample-42", path: "src/ação.py", citation: "https://example.test/paper#42",
    code: 'if authorized:\n    return "two  spaces"', value: -0.0001, note: "日本語 🧭" }, null, 4);
  const count = Math.max(1, Math.floor(targetBytes / Buffer.byteLength(row)));
  const payload = '{\n "number": 900719925474099312345, "number": -0, "exp": 1e+400,\n "rows": [\n' +
    Array.from({ length: count }, () => row).join(",\n") + "\n ]\n}";
  return { model: "offline", system: "Preserve every number, citation, identifier and code string.", messages: [
    { role: "user", content: [{ type: "text", text: "Inspect the tool evidence." }] },
    { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "read", input: { path: "fixture.json" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: payload }] },
  ] };
}

const rows = [];
const repeats = 25;
for (const targetBytes of [32 * 1024, 256 * 1024, 1024 * 1024, 4 * 1024 * 1024]) {
  const source = fixture(targetBytes);
  const bytesBefore = Buffer.byteLength(JSON.stringify(source));
  for (const method of ["rtk-safe", "rtk-lossy-opt-in", "headroom-wrapper-mocked"]) {
    const timings = [];
    let applied = 0;
    let bytesAfter = bytesBefore;
    for (let i = -3; i < repeats; i++) {
      const body = structuredClone(source);
      const start = performance.now();
      const stats = method === "headroom-wrapper-mocked"
        ? await compressWithHeadroom(body, { enabled: true, format: "claude", model: "offline", url: "http://offline.invalid", contextPressure: { over: true }, diagnostics: {} })
        : compressMessages(body, true, { allowLossy: method === "rtk-lossy-opt-in" });
      const elapsed = performance.now() - start;
      if (i >= 0) {
        timings.push(elapsed);
        if (stats && (stats.hits?.length || stats.tokens_saved > 0)) applied++;
        bytesAfter = Buffer.byteLength(JSON.stringify(body));
      }
    }
    timings.sort((a, b) => a - b);
    rows.push({ method, bytesBefore, bytesAfter, savedBytes: bytesBefore - bytesAfter, applied, repeats,
      medianMs: timings[Math.floor(timings.length / 2)], p95Ms: timings[Math.ceil(timings.length * 0.95) - 1] });
  }
}
const receipt = { node: process.version, platform: process.platform, cpu: cpus()[0]?.model, repeats,
  warmup: 3, upstreamModelCalls: 0, mockedRequests,
  scope: "Module call only, including internal allocations. Bytes are observed UTF-8 JSON request lengths. Synthetic upstream token fields are gate inputs only, not token measurements. External Headroom computation and provider cache behavior are unmeasured.", rows };
writeFileSync(join(out, "runtime.json"), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));
