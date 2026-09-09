import { describe, it, expect } from "vitest";

import { pruneHistoricalTools } from "../../open-sse/services/memory/toolPruner.js";
import { pruneHistoricalMedia } from "../../open-sse/services/memory/mediaPruner.js";
import { compactContextWindow } from "../../open-sse/services/memory/contextCompactor.js";
import { injectHandoffPackets } from "../../open-sse/services/memory/handoffStore.js";
import { applyMemoryEnhancements } from "../../open-sse/services/memory/index.js";

  it("Tool Pruner: preserves recent tool turns and truncates older ones", () => {
  const largeOutput1 = "Line 1: error in compilation\n".repeat(50);
  const largeOutput2 = "Line 2: git diff output\n".repeat(50);
  const recentOutput = "Line 3: active tool output with latest details\n".repeat(5);

  const body = {
    messages: [
      { role: "user", content: "Check code" },
      { role: "assistant", content: "Running check", tool_calls: [{ id: "c1", function: { name: "build" } }] },
      { role: "tool", tool_call_id: "c1", content: largeOutput1 },
      { role: "assistant", content: "Checking git diff", tool_calls: [{ id: "c2", function: { name: "git_diff" } }] },
      { role: "tool", tool_call_id: "c2", content: largeOutput2 },
      { role: "assistant", content: "Running latest check", tool_calls: [{ id: "c3", function: { name: "test" } }] },
      { role: "tool", tool_call_id: "c3", content: recentOutput },
      { role: "user", content: "What is next?" }
    ]
  };

  // Keep last 1 tool turn full, truncate older ones to 200 chars
  const res = pruneHistoricalTools(body, {
    enabled: true,
    keepRecentTurns: 1,
    maxHistoricalChars: 200
  });

  expect(res.pruned).toBe(true);
  expect(res.count).toBe(2);
  expect(res.savedChars > 500).toBeTruthy();

  // Older tools should contain the truncation notice
  expect(body.messages[2].content.includes("Tool output truncated by tokenproxy memory optimizer")).toBeTruthy();
  expect(body.messages[4].content.includes("Tool output truncated by tokenproxy memory optimizer")).toBeTruthy();

  // Recent tool (index 6) must remain completely intact
  expect(body.messages[6].content).toBe(recentOutput);
});

  it("Media Pruner: removes older base64 media while preserving trailing user media", () => {
  const oldBase64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const recentBase64 = "data:image/png;base64,RECENTIMAGE1234567890";

  const body = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Look at this initial diagram" },
          { type: "image_url", image_url: { url: oldBase64 } }
        ]
      },
      { role: "assistant", content: "I see the initial diagram architecture." },
      {
        role: "user",
        content: [
          { type: "text", text: "Now check this new screenshot" },
          { type: "image_url", image_url: { url: recentBase64 } }
        ]
      }
    ]
  };

  const res = pruneHistoricalMedia(body, { enabled: true });
  expect(res.pruned).toBe(true);
  expect(res.savedItems).toBe(1);

  // Turn 0 media replaced with placeholder
  expect(body.messages[0].content[1].type).toBe("text");
  expect(body.messages[0].content[1].text.includes("Historical image_url omitted")).toBeTruthy();

  // Turn 2 (trailing user turn) must keep the image_url intact
  expect(body.messages[2].content[1].type).toBe("image_url");
  expect(body.messages[2].content[1].image_url.url).toBe(recentBase64);
});

  it("Context Compactor: compresses long conversation history exceeding threshold", () => {
  const messages = [
    { role: "system", content: "You are a senior coding assistant." }
  ];

  // Generate 25 turns with large text
  for (let i = 1; i <= 25; i++) {
    messages.push({ role: "user", content: `Step ${i}: Detailed requirement explanations and background data `.repeat(10) });
    messages.push({ role: "assistant", content: `Step ${i}: Executed operations and generated module `.repeat(10) });
  }

  const body = { messages };

  const res = compactContextWindow(body, {
    enabled: true,
    thresholdTokens: 500, // Small threshold for testing
    recentTurnsToKeep: 4
  });

  expect(res.compacted).toBe(true);
  expect(res.savedTokens > 0).toBeTruthy();

  // System message preserved at index 0
  expect(body.messages[0].role).toBe("system");
  // Next message is the compacted summary
  expect(body.messages[1].content.includes("[Historical Context Summary by tokenproxy Memory Optimizer]")).toBeTruthy();
  // Recent turns kept at the end
  expect(body.messages.length).toBe(1 + 2 + 4);
});

  it("Handoff insertion preserves approved content and is stable on repeated preparation", () => {
    const packet = { id: "approved-packet", summary: "Migration completed. Add refresh tests." };
    const body = { messages: [{ role: "user", content: "Start work on test suite" }] };
    const result = injectHandoffPackets(body, [packet]);
    expect(result.injected).toBe(true);
    expect(body.messages[0].content).toContain("[Operator-approved handoff approved-packet]");
    expect(body.messages[0].content).toContain("Start work on test suite");
    const first = JSON.stringify(body);
    injectHandoffPackets(body, [packet]);
    expect(JSON.stringify(body)).toBe(first);
  });

  const conversation = () => ({
  messages: [
    { role: "user", content: "Check status" },
    { role: "assistant", content: "Checking", tool_calls: [{ id: "t1", function: { name: "status" } }] },
    { role: "tool", tool_call_id: "t1", content: "Status report: OK\n".repeat(60) },
    { role: "assistant", content: "Now running tests", tool_calls: [{ id: "t2", function: { name: "test" } }] },
    { role: "tool", tool_call_id: "t2", content: "Active test output" },
    { role: "user", content: "All done" }
  ]
});

const TOGGLES = {
  memoryToolPruningEnabled: true,
  memoryMaxToolTurnsKeepFull: 1,
  memoryMaxHistoricalToolChars: 200,
  memoryMediaPruningEnabled: true,
  memoryCompactionEnabled: false,
};

it("ApplyMemoryEnhancements: leaves a conversation that fits entirely alone", async () => {
  // The contract that changed. This body is about 300 tokens. It used to be
  // pruned anyway, because the pruner ran on every request and had no idea what
  // window it was shaping for. Against a 1,000,000-token model it now keeps
  // every byte, which is both the context the operator paid for and a prompt
  // prefix identical to the one the provider has cached.
  const body = conversation();
  const before = JSON.stringify(body);

  const { stats } = await applyMemoryEnhancements(body, {
    settings: TOGGLES,
    contextWindow: 1_000_000,
    targetFormat: "claude"
  });

  expect(stats.toolPruning.applied).toBe(false);
  expect(stats.mediaPruning.applied).toBe(false);
  expect(stats.compaction.applied).toBe(false);
  expect(JSON.stringify(body)).toBe(before);
  expect(stats.budget.over).toBe(false);
  expect(stats.budget.limit).toBe(1_000_000);
});

it("ApplyMemoryEnhancements: prunes progressively once the window is full", async () => {
  // Same body, a window it cannot fit in. Now history is cut — and only as far
  // as the overflow requires, oldest first. The generous tiers find nothing
  // here (the tool output is under 20,000 characters), so the escalation runs
  // through to a hard tier, which is what `tiersUsed` records.
  const body = conversation();
  const historicalBefore = body.messages[2].content.length;

  const { stats } = await applyMemoryEnhancements(body, {
    settings: { ...TOGGLES, memoryContextWindowOverride: 400 },
    contextWindow: 1_000_000,
    targetFormat: "claude"
  });

  expect(stats.budget.over).toBe(true);
  expect(stats.toolPruning.applied).toBe(true);
  expect(stats.toolPruning.tiersUsed).toBeGreaterThan(1);
  expect(body.messages[2].content.length).toBeLessThan(historicalBefore);
  // The protected recent tool turn is untouched: pressure never eats the
  // working set the model is still reasoning about.
  expect(body.messages[4].content).toBe("Active test output");
  expect(stats.compaction.applied).toBe(false);
});
