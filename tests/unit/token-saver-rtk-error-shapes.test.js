// Error-shape skipping for compressMessages across all four formats.
// Contract (open-sse/rtk/index.js:8-13): failed tool results are traces and
// must never be compressed, in whichever of the three flag shapes they arrive:
// is_error, isError, status === "error".
import { describe, it, expect } from "vitest";
import { compressMessages as compressWithPolicy } from "../../open-sse/rtk/index.js";
// These fixtures validate the explicitly opted-in legacy filters.
const compressMessages = (body, enabled) => compressWithPolicy(body, enabled, { allowLossy: true });

const PAD = "x".repeat(90);

// Compressible git-log output (fat bodies the git-log filter drops).
function makeGitLog() {
  return Array.from({ length: 40 }, (_, i) =>
    `commit abc123${i}def\nAuthor: Dev ${i} <dev${i}@example.com>\nDate:   Sun Jul 6 10:00:0${i % 10} 2026 +0700\n\n    subject line number ${i}\n\n${PAD}\n${PAD}\n${PAD}\n`
  ).join("\n");
}

// One body per format carrying the same three error-flagged payloads, one of
// each shape: is_error, isError, status:"error" — all as string content.
function makeBodies() {
  const log = makeGitLog();
  return {
    claude: {
      body: {
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t_err1", is_error: true, content: log },
              { type: "tool_result", tool_use_id: "t_err2", isError: true, content: log },
              { type: "tool_result", tool_use_id: "t_err3", status: "error", content: log },
              { type: "tool_result", tool_use_id: "t_ok", content: log },
            ],
          },
        ],
      },
      getResults: (b) => b.messages[0].content,
      getText: (r) => (typeof r.content === "string" ? r.content : r.content.map((p) => p.text).join("")),
    },
    openai: {
      body: {
        messages: [
          { role: "tool", tool_call_id: "c_err1", is_error: true, content: log },
          { role: "tool", tool_call_id: "c_err2", isError: true, content: log },
          { role: "tool", tool_call_id: "c_err3", status: "error", content: log },
          { role: "tool", tool_call_id: "c_ok", content: log },
        ],
      },
      getResults: (b) => b.messages,
      getText: (r) => (typeof r.content === "string" ? r.content : r.content.map((p) => p.text).join("")),
    },
    responses: {
      body: {
        input: [
          { type: "function_call_output", call_id: "c_err1", is_error: true, output: log },
          { type: "function_call_output", call_id: "c_err2", isError: true, output: log },
          { type: "function_call_output", call_id: "c_err3", status: "error", output: log },
          { type: "function_call_output", call_id: "c_ok", output: log },
        ],
      },
      getResults: (b) => b.input,
      getText: (r) => (typeof r.output === "string" ? r.output : r.output.map((p) => p.text).join("")),
    },
    kiro: {
      body: {
        conversationState: {
          history: [
            {
              userInputMessage: {
                userInputMessageContext: {
                  toolResults: [
                    { status: "error", content: [{ text: log }] },
                    { content: [{ text: log }] },
                  ],
                },
              },
            },
          ],
        },
      },
      getResults: (b) =>
        b.conversationState.history[0].userInputMessage.userInputMessageContext.toolResults,
      getText: (r) => r.content.map((p) => p.text).join(""),
    },
  };
}

describe("error shapes are skipped: all three flags, all four formats", () => {
  const cases = makeBodies();

  for (const [format, { body, getResults, getText }] of Object.entries(cases)) {
    it(`${format}: error-flagged results stay byte-identical, healthy result compresses`, () => {
      const before = structuredClone(body);
      const stats = compressMessages(body, true);

      const results = getResults(body);
      const beforeResults = getResults(before);

      // the healthy control block must actually compress — proves the
      // skip on the flagged siblings is selective, not a global no-op
      expect(stats.hits.length).toBeGreaterThanOrEqual(1);
      const okIdx = beforeResults.length - 1;
      expect(getText(results[okIdx])).not.toBe(getText(beforeResults[okIdx]));

      // every flagged result is byte-identical
      for (let i = 0; i < okIdx; i++) {
        expect(getText(results[i])).toBe(getText(beforeResults[i]));
      }
      // and exactly one hit: only the healthy block was rewritten
      expect(stats.hits.length).toBe(1);
    });
  }

  it("array-content variants: flags on the enclosing block are honoured (Claude + OpenAI + Responses)", () => {
    const log = makeGitLog();
    const bodies = [
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "a1", is_error: true, content: [{ type: "text", text: log }] },
              { type: "tool_result", tool_use_id: "a2", isError: true, content: [{ type: "text", text: log }] },
              { type: "tool_result", tool_use_id: "a3", status: "error", content: [{ type: "text", text: log }] },
            ],
          },
        ],
      },
      {
        messages: [
          { role: "tool", tool_call_id: "b1", is_error: true, content: [{ type: "text", text: log }] },
          { role: "tool", tool_call_id: "b2", isError: true, content: [{ type: "text", text: log }] },
          { role: "tool", tool_call_id: "b3", status: "error", content: [{ type: "text", text: log }] },
        ],
      },
      {
        input: [
          { type: "function_call_output", call_id: "d1", is_error: true, output: [{ type: "input_text", text: log }] },
          { type: "function_call_output", call_id: "d2", isError: true, output: [{ type: "input_text", text: log }] },
          { type: "function_call_output", call_id: "d3", status: "error", output: [{ type: "input_text", text: log }] },
        ],
      },
    ];
    for (const body of bodies) {
      const before = structuredClone(body);
      const stats = compressMessages(body, true);
      expect(stats.hits.length).toBe(0);
      expect(JSON.stringify(body)).toBe(JSON.stringify(before));
    }
  });
});

// DEFECT D-err-4: is_error nested INSIDE a content-array item is not honoured.
// isErrorToolResult (open-sse/rtk/index.js:15-18) inspects only the enclosing
// block/message node; the per-item loops at index.js:46-53 (Responses),
// index.js:67-74 (OpenAI tool array) and index.js:84-93 (Claude array) compress
// items carrying their own is_error/isError/status flag. The error trace is
// destroyed, violating the module contract (index.js:8-13).
describe("DEFECT D-err-4: error flag nested inside a content-array item", () => {
  const log = makeGitLog();

  // DEFECT D-err-4: is_error on the content-array ITEM is not honoured; the item is compressed
  it("Claude: tool_result content item carrying is_error must be skipped", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "nested_1", content: [{ type: "text", text: log, is_error: true }] },
          ],
        },
      ],
    };
    const before = structuredClone(body);
    compressMessages(body, true);
    expect(JSON.stringify(body)).toBe(JSON.stringify(before));
  });

  // DEFECT D-err-4: same root cause, OpenAI tool content array (index.js:67-74)
  it("OpenAI: tool content item carrying is_error must be skipped", () => {
    const body = {
      messages: [
        { role: "tool", tool_call_id: "nested_2", content: [{ type: "text", text: log, is_error: true }] },
      ],
    };
    const before = structuredClone(body);
    compressMessages(body, true);
    expect(JSON.stringify(body)).toBe(JSON.stringify(before));
  });

  // DEFECT D-err-4: same root cause, Responses output array (index.js:46-53)
  it("Responses: function_call_output item carrying is_error must be skipped", () => {
    const body = {
      input: [
        { type: "function_call_output", call_id: "nested_3", output: [{ type: "input_text", text: log, is_error: true }] },
      ],
    };
    const before = structuredClone(body);
    compressMessages(body, true);
    expect(JSON.stringify(body)).toBe(JSON.stringify(before));
  });
});

// DEFECT D-err-5: the Kiro path (open-sse/rtk/index.js:118) checks only
// tr.status === "error" and ignores is_error/isError on toolResults, despite
// the module header (index.js:10-13) stating all three shapes are recognised.
// A Kiro tool result flagged is_error:true is compressed and its trace lost.
describe("DEFECT D-err-5: Kiro toolResults ignore is_error / isError flags", () => {
  const log = makeGitLog();
  const kiroBody = (flag) => ({
    conversationState: {
      history: [
        {
          userInputMessage: {
            userInputMessageContext: { toolResults: [{ ...flag, content: [{ text: log }] }] },
          },
        },
      ],
    },
  });
  const textOf = (b) =>
    b.conversationState.history[0].userInputMessage.userInputMessageContext.toolResults[0].content[0].text;

  // DEFECT D-err-5: Kiro path checks only tr.status (index.js:118)
  it("Kiro toolResult with is_error:true must be skipped", () => {
    const body = kiroBody({ is_error: true });
    const before = structuredClone(body);
    compressMessages(body, true);
    expect(textOf(body)).toBe(textOf(before));
  });

  // DEFECT D-err-5: same, isError flavour
  it("Kiro toolResult with isError:true must be skipped", () => {
    const body = kiroBody({ isError: true });
    const before = structuredClone(body);
    compressMessages(body, true);
    expect(textOf(body)).toBe(textOf(before));
  });
});

// R-F2: error:true (strict boolean) and status:'failed' were absent from the
// error-guard vocabulary in both isErrorItem and isErrorToolResult, so those
// failure traces were compressed like healthy output.
describe("R-F2: error:true and status:'failed' join the error vocabulary", () => {
  const log = makeGitLog();

  it("OpenAI tool msg with error:true stays byte-identical", () => {
    const body = { messages: [{ role: "tool", tool_call_id: "e1", error: true, content: log }] };
    const before = structuredClone(body);
    const stats = compressMessages(body, true);
    expect(stats.hits.length).toBe(0);
    expect(JSON.stringify(body)).toBe(JSON.stringify(before));
  });

  it("OpenAI tool msg with status:'failed' stays byte-identical", () => {
    const body = { messages: [{ role: "tool", tool_call_id: "e2", status: "failed", content: log }] };
    const before = structuredClone(body);
    const stats = compressMessages(body, true);
    expect(stats.hits.length).toBe(0);
    expect(JSON.stringify(body)).toBe(JSON.stringify(before));
  });

  it("Claude tool_result block with status:'failed' stays byte-identical", () => {
    const body = {
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "e3", status: "failed", content: log }] },
      ],
    };
    const before = structuredClone(body);
    const stats = compressMessages(body, true);
    expect(stats.hits.length).toBe(0);
    expect(JSON.stringify(body)).toBe(JSON.stringify(before));
  });

  it("Responses function_call_output with error:true stays byte-identical", () => {
    const body = { input: [{ type: "function_call_output", call_id: "e4", error: true, output: log }] };
    const before = structuredClone(body);
    const stats = compressMessages(body, true);
    expect(stats.hits.length).toBe(0);
    expect(JSON.stringify(body)).toBe(JSON.stringify(before));
  });

  it("Kiro toolResult with status:'failed' stays byte-identical", () => {
    const body = {
      conversationState: {
        history: [
          {
            userInputMessage: {
              userInputMessageContext: { toolResults: [{ status: "failed", content: [{ text: log }] }] },
            },
          },
        ],
      },
    };
    const before = structuredClone(body);
    const stats = compressMessages(body, true);
    expect(stats.hits.length).toBe(0);
    expect(JSON.stringify(body)).toBe(JSON.stringify(before));
  });

  it("item-level error:true inside a content array is honoured, healthy sibling still compresses", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "e5", content: [{ type: "text", text: log, error: true }] },
            { type: "tool_result", tool_use_id: "ok", content: [{ type: "text", text: log }] },
          ],
        },
      ],
    };
    const before = structuredClone(body);
    const stats = compressMessages(body, true);
    expect(stats.hits.length).toBe(1); // only the healthy sibling
    expect(body.messages[0].content[0].content[0].text).toBe(before.messages[0].content[0].content[0].text);
    expect(body.messages[0].content[1].content[0].text).not.toBe(before.messages[0].content[1].content[0].text);
  });
});
