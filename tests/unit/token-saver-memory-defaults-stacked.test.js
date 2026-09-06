import { describe, it, expect } from "vitest";

import { applyMemoryEnhancements } from "../../open-sse/services/memory/index.js";
import { compressMessages as compressWithPolicy } from "../../open-sse/rtk/index.js";
// These fixtures validate the explicitly opted-in legacy filters.
const compressMessages = (body, enabled) => compressWithPolicy(body, enabled, { allowLossy: true });
import { mergeWithDefaults } from "../../src/lib/db/repos/settingsRepo.js";

// A silent default flip in settingsRepo (e.g. turning compaction on by
// default) would change what every routed request pays. These assertions
// force whoever flips one to touch this test in the same commit.
describe("token-saver defaults sync (settingsRepo.mergeWithDefaults)", () => {
  it("memory saver defaults match the shipped contract", () => {
    const s = mergeWithDefaults({});
    expect(s.memoryToolPruningEnabled).toBe(true);
    expect(s.memoryMediaPruningEnabled).toBe(true);
    expect(s.memoryCompactionEnabled).toBe(false);
    expect(s.memoryHandoffEnabled).toBe(false);
    expect(s.memoryMaxToolTurnsKeepFull).toBe(2); // the settings key feeding pruneHistoricalTools keepRecentTurns
    expect(s.memoryMaxHistoricalToolChars).toBe(800);
    expect(s.memoryCompactionThresholdTokens).toBe(32000);
    expect(s.memoryRecentTurnsToKeep).toBe(8);
  });
});

const NOTICE_RE =
  /\[\.\.\. Tool output truncated by tokenproxy memory optimizer: \d+ lines \/ \d+ chars omitted \.\.\.\]/;

function gitDiffText(tag, lines = 400) {
  const body = [];
  for (let i = 0; i < lines; i++) body.push(`-old line ${tag} ${i} ` + "o".repeat(40));
  for (let i = 0; i < lines; i++) body.push(`+new line ${tag} ${i} ` + "n".repeat(40));
  return [
    `diff --git a/src/${tag}.js b/src/${tag}.js`,
    "index 0000000..1111111 100644",
    `--- a/src/${tag}.js`,
    `+++ b/src/${tag}.js`,
    "@@ -1," + lines + " +1," + lines + " @@",
    ...body,
  ].join("\n");
}

function claudeStackedBody() {
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "run the diff" },
        { type: "tool_result", tool_use_id: "toolu_h1", content: gitDiffText("hist1") },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "analyzed" }, { type: "tool_use", id: "toolu_h1", name: "Bash", input: {} }] },
    {
      role: "user",
      content: [
        { type: "text", text: "and this one" },
        { type: "tool_result", tool_use_id: "toolu_h2", is_error: true, content: gitDiffText("hist2") },
      ],
    },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_h2", name: "Bash", input: {} }] },
    {
      role: "user",
      content: [
        { type: "text", text: "third one" },
        { type: "tool_result", tool_use_id: "toolu_h3", content: gitDiffText("hist3") },
      ],
    },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_h3", name: "Bash", input: {} }] },
    {
      role: "user",
      content: [
        { type: "text", text: "recent" },
        { type: "tool_result", tool_use_id: "toolu_r1", content: gitDiffText("recent1", 100) },
      ],
    },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_r1", name: "Bash", input: {} }] },
    {
      role: "user",
      content: [
        { type: "text", text: "current question" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "UVdF" } },
      ],
    },
  ];
  return { messages };
}

describe("token-saver stacked order: RTK compress -> applyMemoryEnhancements (compounding-loss check)", () => {
  it("body already through lossless structural compression still respects pruner bounds and keeps pairs", async () => {
    const body = claudeStackedBody();


    // chatCore order: compressMessages runs first, memory enhancements after
    const rtkStats = compressMessages(body, true);
    expect(rtkStats).not.toBeNull();
    // post-RTK snapshot: recent windows must survive the memory stage byte-identical
    const recentAfterRtk = JSON.stringify(body.messages[6]);
    const trailingAfterRtk = JSON.stringify(body.messages[body.messages.length - 1]);

    const { body: out, stats } = await applyMemoryEnhancements(body, {
      settings: {
        memoryToolPruningEnabled: true,
        memoryMediaPruningEnabled: true,
        memoryCompactionEnabled: false,
        memoryHandoffEnabled: false,
        memoryMaxToolTurnsKeepFull: 2,
        memoryMaxHistoricalToolChars: 800,
        // Pruning is demand-driven now (toolPruner.js): with no overflow the
        // history is left alone. A window this small puts the body over budget
        // so the pruner actually runs, which is what this test is about.
        memoryContextWindowOverride: 2000,
      },
      targetFormat: "claude",
    });

    expect(stats.toolPruning.applied).toBe(true);
    expect(stats.compaction.applied).toBe(false);

    // historical tool_results bounded: maxHistoricalChars + explanatory note
    const h1 = out.messages[0].content.find((b) => b.type === "tool_result");
    const h2 = out.messages[2].content.find((b) => b.type === "tool_result");
    // keepRecentTurns=2 keeps the last TWO tool turns (toolu_h3, toolu_r1)
    expect(typeof h1.content).toBe("string");
    expect(h1.content.length).toBeLessThanOrEqual(800 + (h1.content.match(NOTICE_RE)?.[0].length ?? 0) + 2);
    expect(h1.content).toMatch(NOTICE_RE);
    // is_error tool_results are evidence and exempt from pruning, same contract as rtk/index.js:8-13
    expect(typeof h2.content).toBe("string");
    expect(h2.content).toBe(gitDiffText("hist2"));
    expect(h2.content).not.toMatch(NOTICE_RE);

    // pairing intact after BOTH stages
    const uses = [];
    const results = [];
    for (const m of out.messages) {
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type === "tool_use") uses.push(b.id);
        if (b?.type === "tool_result") results.push(b.tool_use_id);
      }
    }
    for (const id of uses) expect(results).toContain(id);
    for (const id of results) expect(uses).toContain(id);
    expect(new Set(uses).size).toBe(uses.length);
    expect(new Set(results).size).toBe(results.length);

    // is_error evidence metadata survives both stages
    expect(h2.is_error).toBe(true);

    // recent tool turn untouched by pruning, trailing user turn untouched by both
    expect(JSON.stringify(out.messages[6])).toBe(recentAfterRtk);
    expect(JSON.stringify(out.messages[out.messages.length - 1])).toBe(trailingAfterRtk);

    // media pruner still ran on historical range (lastAssistantIndex boundary)
    expect(stats.mediaPruning.applied).toBe(false); // historical turns here carry no media; trailing image must NOT be pruned
  });

  it("trailing user media is never touched even after RTK compression", async () => {
    const body = claudeStackedBody();
    compressMessages(body, true);
    const { body: out, stats } = await applyMemoryEnhancements(body, {
      settings: { memoryToolPruningEnabled: true, memoryMediaPruningEnabled: true },
      targetFormat: "claude",
    });
    expect(stats.mediaPruning.applied).toBe(false);
    const trailing = out.messages[out.messages.length - 1];
    expect(trailing.content[1].type).toBe("image");
    expect(trailing.content[1].source.data).toBe("UVdF");
  });
});
