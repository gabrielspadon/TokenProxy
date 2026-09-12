import { describe, expect, it } from "vitest";

import "./registerAll.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { translateRequest } from "../../open-sse/translator/index.js";

// A malformed null content part must be dropped before any translator walks
// `part.type`, independently of the optional media strip.
//
// The contract is about what reaches the PROVIDER, so it is read off the
// returned body. translateRequest works on its own isolated copy, so the
// caller's body stays exactly as it was sent — routing probes, logs and
// fallback policy all still inspect the original request after a successful
// conversion — and asserting the input was rewritten would assert the opposite.
const bodyWithNullPart = () => ({
  messages: [{
    role: "user",
    content: [
      null,
      { type: "text", text: "keep this text" },
    ],
  }],
});

// Each target carries user text in its own envelope: OpenAI and Claude keep a
// messages[] with a content array, Kiro packs the turn into conversationState
// as a single string.
const userContentOf = {
  [FORMATS.OPENAI]: (out) => out.messages[0].content,
  [FORMATS.CLAUDE]: (out) => out.messages[0].content,
  [FORMATS.KIRO]: (out) => out.conversationState.currentMessage.userInputMessage.content,
};

describe("null content parts", () => {
  it.each([
    ["OpenAI", FORMATS.OPENAI, null],
    ["Claude", FORMATS.CLAUDE, "claude"],
    ["Kiro", FORMATS.KIRO, "kiro"],
  ])("drops null parts without media stripping before the %s translator", (_name, targetFormat, provider) => {
    const body = bodyWithNullPart();
    const sent = structuredClone(body);

    let out;
    expect(() => {
      out = translateRequest(FORMATS.OPENAI, targetFormat, "m", body, true, null, provider);
    }).not.toThrow();

    const content = userContentOf[targetFormat](out);
    if (Array.isArray(content)) {
      expect(content, "a null part reached the provider").not.toContain(null);
      expect(content.map((part) => part.text)).toContain("keep this text");
    } else {
      // Kiro's flattened string: the text survives and nothing serialized a null.
      expect(content).toContain("keep this text");
      expect(content).not.toContain("null");
    }

    expect(body, "the caller's request was rewritten").toEqual(sent);
  });

  it("drops null content parts before OpenAI strip handling", () => {
    const body = {
      messages: [{
        role: "user",
        content: [
          null,
          { type: "text", text: "keep this text" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      }],
    };
    const sent = structuredClone(body);

    const result = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      "m",
      body,
      true,
      null,
      null,
      null,
      ["image"],
    );

    expect(result.messages[0].content).toEqual([{ type: "text", text: "keep this text" }]);
    expect(body, "the caller's request was rewritten").toEqual(sent);
  });
});
