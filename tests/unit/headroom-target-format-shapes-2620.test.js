// #2620: Headroom compression silently skipped for non-OpenAI/Claude target formats.
//
// compressWithHeadroom receives chatCore's `finalFormat`, i.e. the TARGET shape
// after translation. Only claude / openai-responses / kiro had a branch, and the
// fallback looked for a top-level messages[] or input[]. Gemini-family bodies
// (contents[]) and CommandCode bodies (params.messages) matched neither and were
// skipped as "unsupported <format> request shape"; Ollama DID match, and had its
// provider-only fields discarded by the wholesale message swap on commit.
import { describe, it, expect, vi, afterEach } from "vitest";
import { compressWithHeadroom as compressWithPolicy, resetHeadroomCircuitBreaker } from "../../open-sse/rtk/headroom.js";
// Legacy proxy-contract fixtures explicitly permit lossy text compression.
const compressWithHeadroom = (body, options) => compressWithPolicy(body, { ...options, allowLossy: true });

afterEach(() => {
  vi.restoreAllMocks();
  resetHeadroomCircuitBreaker();
});

const URL_ = "http://localhost:8787";
const PAD = " padding".repeat(80);

function respond(messages, extra = {}) {
  return vi.fn(async (_url, init) => {
    respond.lastPayload = JSON.parse(init.body);
    return new Response(JSON.stringify({
      messages,
      tokens_before: 1000,
      tokens_after: 100,
      tokens_saved: 900,
      ...extra,
    }), { status: 200 });
  });
}

describe("#2620 gemini-family contents[] projection", () => {
  it("preserves systemInstruction and compresses opted-in contents text parts", async () => {
    global.fetch = respond([
      { role: "system", content: `you are helpful${PAD}` },
      { role: "user", content: "u!" },
      { role: "assistant", content: "a!" },
    ]);
    const body = {
      systemInstruction: { parts: [{ text: `you are helpful${PAD}` }] },
      contents: [
        { role: "user", parts: [{ text: `question${PAD}` }] },
        { role: "model", parts: [{ text: `answer${PAD}` }] },
      ],
    };

    const stats = await compressWithHeadroom(body, {
      enabled: true, url: URL_, model: "gemini-2.5-pro", format: "gemini",
    });

    expect(stats.tokens_saved).toBe(900);
    // Gemini's "model" role is projected as assistant for the OpenAI-only proxy.
    expect(respond.lastPayload.messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    expect(body.systemInstruction.parts[0].text).toBe(`you are helpful${PAD}`);
    expect(body.contents[0].parts[0].text).toBe("u!");
    expect(body.contents[1].parts[0].text).toBe("a!");
    // Structure is preserved: roles are still Gemini's own.
    expect(body.contents.map((c) => c.role)).toEqual(["user", "model"]);
  });

  it("never rewrites functionCall / functionResponse / inlineData parts", async () => {
    global.fetch = respond([{ role: "user", content: "u!" }]);
    const fnCall = { functionCall: { name: "read_file", args: { path: "a.js" } } };
    const fnResp = { functionResponse: { name: "read_file", response: { error: "ENOENT" } } };
    const inline = { inlineData: { mimeType: "image/png", data: "AAAA" } };
    const body = {
      contents: [{ role: "user", parts: [{ text: `question${PAD}` }, fnCall, fnResp, inline] }],
    };

    await compressWithHeadroom(body, {
      enabled: true, url: URL_, model: "gemini-2.5-pro", format: "gemini",
    });

    expect(respond.lastPayload.messages).toHaveLength(1);
    expect(body.contents[0].parts[0].text).toBe("u!");
    expect(body.contents[0].parts[1]).toEqual(fnCall);
    expect(body.contents[0].parts[2]).toEqual(fnResp);
    expect(body.contents[0].parts[3]).toEqual(inline);
  });

  it("reads antigravity's nested body.request and vertex's snake_case system_instruction", async () => {
    global.fetch = respond([{ role: "system", content: `instructions${PAD}` }, { role: "user", content: "u!" }]);
    const body = {
      project: "p",
      request: {
        system_instruction: { parts: [{ text: `instructions${PAD}` }] },
        contents: [{ role: "user", parts: [{ text: `question${PAD}` }] }],
      },
    };

    const stats = await compressWithHeadroom(body, {
      enabled: true, url: URL_, model: "gemini-2.5-pro", format: "antigravity",
    });

    expect(stats.tokens_saved).toBe(900);
    expect(body.request.system_instruction.parts[0].text).toBe(`instructions${PAD}`);
    expect(body.request.contents[0].parts[0].text).toBe("u!");
    expect(body.project).toBe("p");
  });

  it("fails open when the proxy does not preserve the projected order", async () => {
    global.fetch = respond([{ role: "assistant", content: "x" }, { role: "user", content: "y" }]);
    const body = {
      contents: [
        { role: "user", parts: [{ text: `question${PAD}` }] },
        { role: "model", parts: [{ text: `answer${PAD}` }] },
      ],
    };
    const before = JSON.stringify(body);
    const diagnostics = {};

    const stats = await compressWithHeadroom(body, {
      enabled: true, url: URL_, model: "gemini-2.5-pro", format: "gemini", diagnostics,
    });

    expect(stats).toBeNull();
    expect(JSON.stringify(body)).toBe(before);
    expect(diagnostics.reason).toContain("protected content");
  });

  it("still skips a contents[] body when the format is not a Gemini one", async () => {
    global.fetch = vi.fn();
    const body = { contents: [{ role: "user", parts: [{ text: `question${PAD}` }] }] };
    const diagnostics = {};

    const stats = await compressWithHeadroom(body, {
      enabled: true, url: URL_, model: "m", format: "commandcode", diagnostics,
    });

    expect(stats).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(diagnostics.reason).toBe("unsupported commandcode request shape");
  });
});

describe("#2620 commandcode params.messages", () => {
  it("compresses the nested message list and leaves the envelope alone", async () => {
    global.fetch = respond([
      { role: "user", content: [{ type: "text", text: "q!" }] },
      { role: "tool", content: [{ type: "text", text: "r!" }] },
    ]);
    const body = {
      threadId: "t-1",
      memory: "",
      config: { workingDir: "/w" },
      params: {
        model: "cc-model",
        system: "sys prompt",
        messages: [
          { role: "user", content: [{ type: "text", text: `question${PAD}` }] },
          { role: "tool", content: [{ type: "text", text: `tool output${PAD}` }] },
        ],
        tools: [{ name: "read_file", input_schema: { type: "object" } }],
      },
    };

    const stats = await compressWithHeadroom(body, {
      enabled: true, url: URL_, model: "cc-model", format: "commandcode",
    });

    expect(stats.tokens_saved).toBe(900);
    expect(body.params.messages[0].content).toEqual([{ type: "text", text: "q!" }]);
    expect(body.params.messages[1].content).toEqual([{ type: "text", text: "r!" }]);
    expect(body.threadId).toBe("t-1");
    expect(body.params.system).toBe("sys prompt");
    expect(body.params.tools).toEqual([{ name: "read_file", input_schema: { type: "object" } }]);
  });

  it("preserves an error trace: is_error under params.messages skips before fetch", async () => {
    global.fetch = vi.fn();
    const body = {
      params: {
        messages: [
          { role: "user", content: [{ type: "text", text: `question${PAD}` }] },
          {
            role: "tool",
            content: [{ type: "tool_result", is_error: true, content: `stack trace${PAD}` }],
          },
        ],
      },
    };
    const before = JSON.stringify(body);
    const diagnostics = {};

    const stats = await compressWithHeadroom(body, {
      enabled: true, url: URL_, model: "cc-model", format: "commandcode", diagnostics,
    });

    expect(stats).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).toBe(before);
    expect(diagnostics.reason).toBe("skipped: error tool result present — headroom not applied");
  });
});

describe("#2620 commit preserves fields outside the OpenAI contract", () => {
  it("keeps Ollama tool_name / images / thinking that the proxy does not echo", async () => {
    global.fetch = respond([
      { role: "user", content: "u!" },
      { role: "assistant", content: "a!" },
      { role: "tool", content: "r!" },
    ]);
    const body = {
      model: "llama3.1",
      messages: [
        { role: "user", content: `question${PAD}`, images: ["QUJD"] },
        { role: "assistant", content: `answer${PAD}`, thinking: `reasoning${PAD}` },
        // Ollama pairs a tool result by tool_name; it carries no tool_call_id,
        // so validateOpenAIMessageShape never sees the loss.
        { role: "tool", tool_name: "read_file", content: `tool output${PAD}` },
      ],
    };

    const stats = await compressWithHeadroom(body, {
      enabled: true, url: URL_, model: "llama3.1", format: "ollama",
    });

    expect(stats.tokens_saved).toBe(900);
    expect(body.messages[0].content).toBe("u!");
    expect(body.messages[0].images).toEqual(["QUJD"]);
    expect(body.messages[1].thinking).toBe(`reasoning${PAD}`);
    expect(body.messages[2].tool_name).toBe("read_file");
    expect(body.messages[2].content).toBe("r!");
  });

  it("keeps an OpenAI message name and reverts cleanly when the byte guard trips", async () => {
    global.fetch = respond([{ role: "user", content: `question${PAD}` }]);
    const body = { messages: [{ role: "user", name: "alice", content: `question${PAD}` }] };
    const before = JSON.stringify(body);
    const diagnostics = {};

    const stats = await compressWithHeadroom(body, {
      enabled: true, url: URL_, model: "gpt-4o", format: "openai", diagnostics,
    });

    // No shrink: the merged candidate is written in to be measured, then rolled back.
    expect(stats).toBeNull();
    expect(JSON.stringify(body)).toBe(before);
    expect(diagnostics.reason).toBe("phantom savings — keeping original (>95% size)");
  });
});

describe("R-F1: Kiro/Gemini projections never write into caller-shared objects", () => {
  it("Kiro: the caller's conversationState object is untouched; the body carries the compressed copy", async () => {
    global.fetch = respond([{ role: "user", content: "u!" }, { role: "assistant", content: "a!" }]);
    const callerState = {
      history: [
        { userInputMessage: { content: `question${PAD}`, userInputMessageContext: { toolResults: [] } } },
        { assistantResponseMessage: { content: `answer${PAD}` } },
      ],
    };
    const stateBefore = structuredClone(callerState);
    const body = { conversationState: callerState };

    const stats = await compressWithHeadroom(body, {
      enabled: true, url: URL_, model: "m", format: "kiro",
    });

    expect(stats.tokens_saved).toBe(900);
    expect(callerState).toEqual(stateBefore); // caller's object not mutated
    expect(body.conversationState).not.toBe(callerState); // private copy committed
    expect(body.conversationState.history[0].userInputMessage.content).toBe("u!");
    expect(body.conversationState.history[1].assistantResponseMessage.content).toBe("a!");
  });

  it("Kiro: on proxy failure the caller's conversationState is still untouched", async () => {
    global.fetch = vi.fn(async () => new Response("boom", { status: 500 }));
    const callerState = {
      history: [{ userInputMessage: { content: `question${PAD}`, userInputMessageContext: { toolResults: [] } } }],
    };
    const stateBefore = structuredClone(callerState);
    const body = { conversationState: callerState };

    const stats = await compressWithHeadroom(body, {
      enabled: true, url: URL_, model: "m", format: "kiro",
    });

    expect(stats).toBeNull();
    expect(callerState).toEqual(stateBefore);
  });

  it("Gemini: the caller's contents array is untouched; the body carries the compressed copy", async () => {
    global.fetch = respond([{ role: "user", content: "u!" }]);
    const callerContents = [{ role: "user", parts: [{ text: `question${PAD}` }] }];
    const contentsBefore = structuredClone(callerContents);
    const body = { contents: callerContents };

    await compressWithHeadroom(body, {
      enabled: true, url: URL_, model: "gemini-2.5-pro", format: "gemini",
    });

    expect(callerContents).toEqual(contentsBefore);
    expect(body.contents).not.toBe(callerContents);
    expect(body.contents[0].parts[0].text).toBe("u!");
  });

  it("antigravity: the caller's nested request.contents is untouched", async () => {
    global.fetch = respond([{ role: "user", content: "u!" }]);
    const callerRequest = { contents: [{ role: "user", parts: [{ text: `question${PAD}` }] }] };
    const requestBefore = structuredClone(callerRequest);
    const body = { project: "p", request: callerRequest };

    await compressWithHeadroom(body, {
      enabled: true, url: URL_, model: "gemini-2.5-pro", format: "antigravity",
    });

    expect(callerRequest).toEqual(requestBefore);
    expect(body.request.contents).not.toBe(callerRequest.contents);
    expect(body.request.contents[0].parts[0].text).toBe("u!");
  });
});

// R-F3: hasErrorToolBlock checked part-level is_error/status but not the
// camelCase isError spelling rtk honours, letting a flagged trace through.
describe("R-F3: part-level isError is an error trace", () => {
  it("Claude tool_result part with isError:true skips before fetch", async () => {
    global.fetch = vi.fn();
    const body = {
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", isError: true, content: `stack${PAD}` }] },
      ],
    };
    const before = JSON.stringify(body);
    const diagnostics = {};

    const stats = await compressWithHeadroom(body, {
      enabled: true, url: URL_, model: "m", format: "claude", diagnostics,
    });

    expect(stats).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).toBe(before);
    expect(diagnostics.reason).toBe("skipped: error tool result present — headroom not applied");
  });
});
