import { describe, it, expect } from "vitest";
import {
  createPrivacyFilter,
  createRestorer,
  redactOutbound,
  restoreResponseJson,
  restoreResponseStream,
} from "open-sse/utils/privacyFilter.js";
import { readFileSync } from "node:fs";

const chatCoreSrc = readFileSync(new URL("../../open-sse/handlers/chatCore.js", import.meta.url), "utf8");
const nonStreamSrc = readFileSync(new URL("../../open-sse/handlers/chatCore/nonStreamingHandler.js", import.meta.url), "utf8");
const streamSrc = readFileSync(new URL("../../open-sse/handlers/chatCore/streamingHandler.js", import.meta.url), "utf8");
const settingsSrc = readFileSync(new URL("../../src/lib/db/repos/settingsRepo.js", import.meta.url), "utf8");
const chatSrc = readFileSync(new URL("../../src/sse/handlers/chat.js", import.meta.url), "utf8");

async function drain(stream) {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of stream) out += decoder.decode(chunk, { stream: true });
  return out + decoder.decode();
}

function streamOf(...chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

describe("privacy filter (#2728)", () => {
  it("pseudonymises emails in message content and restores them verbatim", () => {
    const f = createPrivacyFilter();
    const body = {
      messages: [
        { role: "user", content: "who wrote this?" },
        {
          role: "tool",
          tool_call_id: "call_abc@x.com",
          content: "Author: Ada L <ada@example.com>\nCommit by ada@example.com",
        },
      ],
    };
    expect(f.redactBody(body)).toBe(1);
    const sent = body.messages[1].content;
    expect(sent).not.toContain("ada@example.com");
    expect(sent).toContain("p1@redacted.invalid");
    // Same address twice -> one stable alias, not two.
    expect(sent.match(/p1@redacted\.invalid/g)).toHaveLength(2);
    // Protocol fields are never rewritten.
    expect(body.messages[1].tool_call_id).toBe("call_abc@x.com");
    expect(f.restore(sent)).toBe("Author: Ada L <ada@example.com>\nCommit by ada@example.com");
  });

  it("redacts operator-supplied literal terms, longest match first", () => {
    const f = createPrivacyFilter({ emails: false, terms: ["acme", "acme-internal"] });
    const body = { messages: [{ role: "user", content: "acme-internal and acme" }] };
    f.redactBody(body);
    const sent = body.messages[0].content;
    expect(sent).toBe("[redacted-1] and [redacted-2]");
    expect(f.restore(sent)).toBe("acme-internal and acme");
  });

  it("walks Responses `input` and a Claude `system` block", () => {
    const f = createPrivacyFilter();
    const body = {
      system: [{ type: "text", text: "reply to bob@corp.io" }],
      input: [{ type: "function_call_output", output: [{ type: "input_text", text: "bob@corp.io" }] }],
    };
    f.redactBody(body);
    expect(f.size).toBe(1);
    expect(body.system[0].text).toBe("reply to p1@redacted.invalid");
    expect(body.input[0].output[0].text).toBe("p1@redacted.invalid");
  });

  it("restores an alias split across streaming chunks", () => {
    const f = createPrivacyFilter();
    f.redactBody({ messages: [{ role: "user", content: "ada@example.com" }] });
    const r = createRestorer(f);
    let out = "";
    for (const chunk of ["mail ", "p1@redac", "ted.inv", "alid ok"]) out += r.push(chunk);
    out += r.flush();
    expect(out).toBe("mail ada@example.com ok");
  });

  it("emits a chunk that cannot be mid-alias without holding it back", () => {
    const f = createPrivacyFilter();
    f.redactBody({ messages: [{ role: "user", content: "ada@example.com" }] });
    const r = createRestorer(f);
    expect(r.push("hello world")).toBe("hello world");
  });

  it("is a no-op with nothing to redact and never re-aliases its own output", () => {
    const f = createPrivacyFilter();
    expect(f.redactBody({ messages: [{ role: "user", content: "no pii here" }] })).toBeNull();
    expect(f.redactBody(null)).toBeNull();
    const body = { messages: [{ role: "user", content: "p1@redacted.invalid" }] };
    expect(f.redactBody(body)).toBeNull();
    expect(body.messages[0].content).toBe("p1@redacted.invalid");
  });
});

// The mechanism above is only worth having if both halves of the round trip are
// wired: a redaction the response path cannot undo hands the client
// `p1@redacted.invalid` instead of its own data, which is worse than no filter.
describe("the round trip a client actually sees (#2728)", () => {
  it("costs nothing and changes nothing when the filter is off", () => {
    const json = JSON.stringify({ choices: [{ message: { content: "mail ada@example.com" } }] });
    // Same string and same stream object back — the off path does no work at all.
    expect(restoreResponseJson(null, json)).toBe(json);
    expect(restoreResponseJson(undefined, json)).toBe(json);
    const s = streamOf("x");
    expect(restoreResponseStream(null, s)).toBe(s);
    // A filter that matched nothing is the off path too.
    expect(restoreResponseJson(createPrivacyFilter(), json)).toBe(json);

    // And with the gate on but nothing to pseudonymise, the body is byte-identical
    // and no filter is produced, so the response path stays on the off path too.
    const body = { messages: [{ role: "user", content: "no pii here" }], tools: [{ name: "send" }] };
    const before = JSON.stringify(body);
    expect(redactOutbound(body, [])).toBeNull();
    expect(JSON.stringify(body)).toBe(before);
  });

  it("an email leaves redacted and comes back verbatim, non-streaming", () => {
    const body = { messages: [{ role: "user", content: "write to ada@example.com" }] };
    const filter = redactOutbound(body, []);
    expect(filter).not.toBeNull();
    expect(body.messages[0].content).toBe("write to p1@redacted.invalid");

    const upstream = JSON.stringify({
      choices: [{ message: { role: "assistant", content: "sent to p1@redacted.invalid" } }],
    });
    const seen = JSON.parse(restoreResponseJson(filter, upstream));
    expect(seen.choices[0].message.content).toBe("sent to ada@example.com");
    expect(JSON.stringify(seen)).not.toContain("redacted.invalid");
  });

  it("restores a term carried inside a tool call's arguments", () => {
    const body = { messages: [{ role: "user", content: "email ada@example.com about acme" }] };
    const filter = redactOutbound(body, ["acme"]);
    // Whatever aliases the filter minted are what the provider echoes back.
    const [emailAlias, termAlias] = [/p\d+@redacted\.invalid/, /\[redacted-\d+\]/]
      .map((re) => body.messages[0].content.match(re)[0]);
    const args = JSON.stringify({ to: emailAlias, note: `${termAlias} Q3` });
    const upstream = JSON.stringify({
      choices: [{ message: { tool_calls: [{ id: "call_1", function: { name: "send", arguments: args } }] } }],
    });
    const restored = JSON.parse(restoreResponseJson(filter, upstream));
    // arguments is a JSON string, so it has to survive both as text and as JSON.
    const parsedArgs = JSON.parse(restored.choices[0].message.tool_calls[0].function.arguments);
    expect(parsedArgs).toEqual({ to: "ada@example.com", note: "acme Q3" });
  });

  it("keeps the document valid when the original carries JSON metacharacters", () => {
    const term = 'Ada "The Boss" \\ Lovelace';
    const body = { messages: [{ role: "user", content: `hi ${term}` }] };
    const filter = redactOutbound(body, [term]);
    const alias = body.messages[0].content.match(/\[redacted-\d+\]/)[0];
    const upstream = JSON.stringify({ choices: [{ message: { content: `hello ${alias}` } }] });
    expect(JSON.parse(restoreResponseJson(filter, upstream)).choices[0].message.content).toBe(`hello ${term}`);
  });

  it("restores a placeholder split across two stream chunks", async () => {
    const body = { messages: [{ role: "user", content: "ada@example.com" }] };
    const filter = redactOutbound(body, []);
    const out = await drain(restoreResponseStream(filter, streamOf(
      'data: {"choices":[{"delta":{"content":"mail p1@redac',
      'ted.invalid now"}}]}\n\n',
      "data: [DONE]\n\n",
    )));
    expect(out).not.toContain("redacted.invalid");
    expect(out).toContain("mail ada@example.com now");
    // Frames still parse: the restore ran inside the JSON, not over it.
    const frame = JSON.parse(out.split("\n")[0].slice("data: ".length));
    expect(frame.choices[0].delta.content).toBe("mail ada@example.com now");
  });

  it("leaves the payload untouched when the filter throws", async () => {
    const exploding = { size: 2, restore: () => { throw new Error("boom"); }, restoreJson: () => { throw new Error("boom"); }, aliases: () => { throw new Error("boom"); } };
    const json = '{"choices":[{"message":{"content":"p1@redacted.invalid"}}]}';
    expect(restoreResponseJson(exploding, json)).toBe(json);
    expect(await drain(restoreResponseStream(exploding, streamOf("a", "b")))).toBe("ab");
    // A body that throws while being walked is left as-is rather than failing the request.
    const hostile = { get messages() { throw new Error("boom"); } };
    expect(redactOutbound(hostile, ["x"])).toBeNull();
    expect(() => redactOutbound(hostile, ["x"])).not.toThrow();
  });
});

describe("the wiring that makes it reachable (#2728)", () => {
  it("is off by default in settings and passed in from the chat handler", () => {
    expect(settingsSrc).toContain("privacyFilterEnabled: false,");
    expect(chatSrc).toContain("privacyEnabled: !!chatSettings.privacyFilterEnabled,");
  });

  it("does the redaction work only when the gate is on", () => {
    const i = chatCoreSrc.indexOf("privacyFilter = redactOutbound(");
    expect(i).toBeGreaterThan(0);
    const guard = chatCoreSrc.slice(0, i).lastIndexOf('stageGuard.sync("privacy", () => {');
    expect(guard).toBeGreaterThan(0);
    const gate = chatCoreSrc.indexOf('}, privacyEnabled && !(providerRequiresStreaming && !clientRequestedStreaming));', i);
    expect(gate).toBeGreaterThan(i);
    // The redaction remains inside the guarded callback, with forced SSE excluded.
    expect(chatCoreSrc.slice(guard, i)).not.toContain('});');
    expect(chatCoreSrc.slice(i, gate)).not.toContain('measureSaverStage(');
  });

  it("hands the mapping to both response paths", () => {
    expect(chatCoreSrc.match(/^\s+privacyFilter,$/gm)?.length).toBe(2);
    expect(nonStreamSrc).toContain("restoreResponseJson(privacyFilter, JSON.stringify(translatedResponse))");
    expect(streamSrc).toContain("restoreResponseStream(privacyFilter, transformedBody)");
  });
});

// The content-walk must be KEY-AWARE: blocks under message.content include
// tool_use.id/name and tool_result.tool_call_id, and a privacy term that
// collides with a tool name must not rewrite them (the outbound call would
// desync from body.tools and the upstream 400s). Text-bearing keys inside a
// tool_use input still redact.
describe("protocol keys survive the content walk (audit finding 1)", () => {
  it("tool_use.id/name and tool_result.tool_call_id stay byte-identical when a term matches the tool name", () => {
    const f = createPrivacyFilter({ emails: false, terms: ["gmail"] });
    const body = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_gmail_1",
              name: "gmail_search",
              input: { query: "search gmail for the shipping label" },
            },
            { type: "tool_result", tool_use_id: "toolu_gmail_1", content: "found the label" },
          ],
        },
      ],
      tools: [{ name: "gmail_search", description: "search gmail" }],
    };
    expect(f.redactBody(body)).toBeGreaterThan(0);
    const toolUse = body.messages[0].content[0];
    expect(toolUse.name).toBe("gmail_search");
    expect(toolUse.id).toBe("toolu_gmail_1");
    expect(body.messages[0].content[1].tool_use_id).toBe("toolu_gmail_1");
    expect(body.tools[0].name).toBe("gmail_search");
    // The operator term inside the tool_use INPUT string still redacts.
    expect(JSON.stringify(toolUse.input)).toContain("[redacted-1]");
    expect(JSON.stringify(toolUse.input)).not.toContain("gmail");
  });

  it("redacts thinking text but never the Claude signature", () => {
    const f = createPrivacyFilter();
    const body = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "ada@example.com figured it out", signature: "sig-ada@example.com" },
          ],
        },
      ],
    };
    f.redactBody(body);
    const block = body.messages[0].content[0];
    expect(block.thinking).not.toContain("ada@example.com");
    expect(block.signature).toBe("sig-ada@example.com");
  });
});
