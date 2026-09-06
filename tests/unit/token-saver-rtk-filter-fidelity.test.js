// Filter-fidelity spot checks beyond tests/unit/rtk.test.js:
// unicode + CRLF git diffs, ANSI-coloured grep output, prose that merely
// mentions "commit", a 1 MiB single-line blob, and the dedup-log 2000-line cap.
import { describe, it, expect } from "vitest";
import { compressMessages as compressWithPolicy } from "../../open-sse/rtk/index.js";
// These fixtures validate the explicitly opted-in legacy filters.
const compressMessages = (body, enabled) => compressWithPolicy(body, enabled, { allowLossy: true });
import { DEDUP_LINE_MAX, GIT_DIFF_HUNK_MAX_LINES } from "../../open-sse/rtk/constants.js";

const wrapTool = (t) => ({ messages: [{ role: "tool", tool_call_id: "c1", content: t }] });

describe("git-diff filter: unicode filenames + CRLF line endings", () => {
  // One file with a unicode name, one plain; hunk of 150 lines exceeds the
  // per-hunk cap so truncation must engage; every line ends CRLF.
  const input = (() => {
    const L = [];
    L.push("diff --git a/src/f\u00fc\u00dfe.ts b/src/f\u00fc\u00dfe.ts\r");
    L.push("index 1111111..2222222 100644\r", "--- a/src/f\u00fc\u00dfe.ts\r", "+++ b/src/f\u00fc\u00dfe.ts\r", "@@ -1,150 +1,150 @@\r");
    for (let i = 0; i < 50; i++) {
      L.push(` context ${i}\r`, `-old ${i}\r`, `+new ${i}\r`);
    }
    return L.join("\n");
  })();

  it("detects git-diff, compresses, and keeps unicode names and CRLF intact", () => {
    const body = wrapTool(input);
    const stats = compressMessages(body, true);
    expect(stats.hits.map((h) => h.filter)).toEqual(["git-diff"]);

    const out = body.messages[0].content;
    expect(out.length).toBeLessThan(input.length);
    // unicode filename survives in the emitted file header
    expect(out).toContain("f\u00fc\u00dfe.ts");
    // CRLF encoding preserved on lines that came from the input (synthesized
    // summary/truncation markers carry no line ending by design)
    expect(out).toContain("\r");
    for (const line of out.split("\n")) {
      if (/ (context|old|new) \d/.test(line)) expect(line.endsWith("\r")).toBe(true);
    }
  });

  it("per-hunk cap and +/- counts survive the CRLF rewrite", () => {
    const body = wrapTool(input);
    compressMessages(body, true);
    const out = body.messages[0].content;
    // 150 hunk lines, cap 100 -> truncation marker engages
    expect(out).toMatch(/\(\d+ lines truncated\)/);
    // added/removed tallies: 50 removed, 50 added (minus hunk-cap drops)
    expect(out).toMatch(/\+\d+ -\d+/);
    // no hunk body line beyond the cap leaks through
    const shown = out.split("\n").filter((l) => l.includes("old ")).length;
    expect(shown).toBeLessThanOrEqual(GIT_DIFF_HUNK_MAX_LINES);
  });
});

describe("grep filter: ANSI colour codes", () => {
  const input = Array.from({ length: 30 }, (_, i) =>
    `src/app.js:${i + 1}:\x1b[32mmatch number ${i}\x1b[0m ${"pad".repeat(20)}`
  ).join("\n");

  it("detects grep, compresses, and preserves ANSI escapes verbatim", () => {
    const body = wrapTool(input);
    const stats = compressMessages(body, true);
    expect(stats.hits.map((h) => h.filter)).toEqual(["grep"]);
    const out = body.messages[0].content;
    expect(out.length).toBeLessThan(input.length);
    expect(out).toContain("\x1b[32m");
    expect(out).toContain("\x1b[0m");
    expect(out).toContain("src/app.js");
    expect(out.length).toBeGreaterThanOrEqual(1);
  });
});

describe("prose containing the word 'commit' is not git-log", () => {
  const input = Array.from({ length: 12 }, (_, i) =>
    `When we commit the changes for module ${i}, the commit history will show it because every commit matters and this commit is like the others.`
  ).join("\n");

  it("stays byte-identical and records no git-log hit", () => {
    const body = wrapTool(input);
    const before = structuredClone(body);
    const stats = compressMessages(body, true);
    expect(stats.hits.filter((h) => h.filter === "git-log")).toHaveLength(0);
    expect(stats.hits.length).toBe(0);
    expect(JSON.stringify(body)).toBe(JSON.stringify(before));
  });
});

describe("smart-truncate: single-line 1 MiB blob", () => {
  const input = "Z".repeat(1_000_000);

  it("matches no structured filter, so the size-based elide catch-all fires: head+tail kept with an integrity marker", () => {
    const body = wrapTool(input);
    const stats = compressMessages(body, true);
    expect(stats.hits.map((h) => h.filter)).toEqual(["elide"]);
    const out = body.messages[0].content;
    expect(out).toContain("[elided ");
    expect(out).toContain("head+tail preserved by tokenproxy");
    expect(out.slice(0, 1500)).toBe(input.slice(0, 1500)); // head verbatim
    expect(out.slice(-1000)).toBe(input.slice(-1000));     // tail verbatim
    expect(out.length).toBeLessThan(input.length);
  });
});

describe("dedup-log filter: 3000-line input vs DEDUP_LINE_MAX=2000", () => {
  // Mostly-unique lines so the dedup output actually grows past the cap.
  const input = Array.from({ length: 3000 }, (_, i) =>
    i % 50 === 0 ? "repeated pattern line" : `line ${i} with unique content ${"x".repeat(10)}`
  ).join("\n");

  it("truncates at the line cap with an explicit marker", () => {
    const body = wrapTool(input);
    const stats = compressMessages(body, true);
    expect(stats.hits.map((h) => h.filter)).toEqual(["dedup-log"]);
    const out = body.messages[0].content;
    expect(out).toContain(`(truncated at ${DEDUP_LINE_MAX} lines)`);
    expect(out.split("\n").length).toBe(DEDUP_LINE_MAX + 1); // cap + marker
    expect(out.length).toBeLessThan(input.length);
  });

  it("no-grow guard: an inflating dedup rewrite is discarded, content unchanged", () => {
    // short duplicate lines: dedupLog's "... (N duplicate lines)" markers are
    // longer than the runs they replace, so the filter output grows the input
    const heavy = Array.from({ length: 500 }, (_, i) => (i % 5 === 0 ? `u${i}` : "same")).join("\n");
    const body = wrapTool(heavy);
    const before = structuredClone(body);
    const stats = compressMessages(body, true);
    expect(stats.hits.length).toBe(0);
    expect(JSON.stringify(body)).toBe(JSON.stringify(before));
  });
});

// DEFECT D-min-1: git with default core.quotePath=true quotes non-ASCII
// paths ("a/src/f\u00fc\u00dfe.ts"), and gitDiff extracts the filename with
// line.split(" b/") (open-sse/rtk/filters/gitDiff.js:28-29), which does not
// match ' "b/...' — currentFile falls back to "unknown" and the real filename
// is lost from the compressed output.
describe("DEFECT D-min-1: quoted (non-ASCII) git-diff path becomes 'unknown'", () => {
  // DEFECT D-min-1: line.split(" b/") misses quoted ' "b/' prefixes
  it("quoted unicode filename is preserved in the compacted header", () => {
    const quoted = [
      'diff --git "a/src/f\u00fc\u00dfe.ts" "b/src/f\u00fc\u00dfe.ts"',
      "index 1111111..2222222 100644",
      '--- "a/src/f\u00fc\u00dfe.ts"',
      '+++ "b/src/f\u00fc\u00dfe.ts"',
      "@@ -1,150 +1,150 @@",
      ...Array.from({ length: 50 }, (_, i) => [` context ${i}`, `-old ${i}`, `+new ${i}`]).flat(),
    ].join("\n");
    const body = wrapTool(quoted);
    compressMessages(body, true);
    expect(body.messages[0].content).toContain("f\u00fc\u00dfe.ts");
    expect(body.messages[0].content).not.toContain("unknown");
  });
});

// R-F4: the quote-strip in gitDiff mangled C-quoted diff --git lines: stray
// backslashes from \" and \\ escapes survived, an embedded ' b/' in a name
// shifted the split, and the header relied on luck. The filter now parses the
// quoted pair explicitly and keeps octal escapes verbatim.
describe("R-F4: quoted diff --git pairs", () => {
  // Fat hunk: compressText skips blobs under MIN_COMPRESS_SIZE (500), and a
  // too-small input would make the assertions vacuous.
  const hunk = (n = 60) =>
    [
      "index 1111111..2222222 100644",
      "@@ -1,60 +1,60 @@",
      ...Array.from({ length: n }, (_, i) => [` context ${i}`, `-old ${i}`, `+new ${i}`]).flat(),
    ].join("\n");

  it("unescapes \\\" and \\\\ inside a quoted pair and keeps an embedded ' b/' in the name", () => {
    const name = 'src/weird "quoted" b/name.ts';
    const input = `diff --git "a/${name.replace(/"/g, '\\"')}" "b/${name.replace(/"/g, '\\"')}"\n${hunk()}`;
    expect(input.length).toBeGreaterThan(500);
    const body = wrapTool(input);
    const stats = compressMessages(body, true);
    expect(stats.hits.map((h) => h.filter)).toEqual(["git-diff"]);
    expect(body.messages[0].content).toContain(name);
    expect(body.messages[0].content).not.toContain("unknown");
    expect(body.messages[0].content).not.toMatch(/\\"/); // no stray backslash escapes left
  });

  it("keeps octal-escaped (core.quotePath) names verbatim, including the escapes", () => {
    const input = 'diff --git "a/src/f\\303\\274.ts" "b/src/f\\303\\274.ts"\n' + hunk();
    expect(input.length).toBeGreaterThan(500);
    const body = wrapTool(input);
    const stats = compressMessages(body, true);
    expect(stats.hits.map((h) => h.filter)).toEqual(["git-diff"]);
    expect(body.messages[0].content).toContain("src/f\\303\\274.ts");
    expect(body.messages[0].content).not.toContain("unknown");
  });

  it("unquoted common case is unchanged", () => {
    const input = "diff --git a/src/plain.ts b/src/plain.ts\n" + hunk();
    expect(input.length).toBeGreaterThan(500);
    const body = wrapTool(input);
    const stats = compressMessages(body, true);
    expect(stats.hits.map((h) => h.filter)).toEqual(["git-diff"]);
    expect(body.messages[0].content).toContain("src/plain.ts");
  });
});
