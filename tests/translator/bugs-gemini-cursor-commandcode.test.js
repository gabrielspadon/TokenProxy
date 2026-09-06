// OpenAI → Gemini / Cursor / CommandCode request translation.
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const O2G = (body) => translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, "m", body, true, null, "gemini");
const O2C = (body) => translateRequest(FORMATS.OPENAI, FORMATS.CURSOR, "m", body, true, null, "cursor");
const O2CC = (body) => translateRequest(FORMATS.OPENAI, FORMATS.COMMANDCODE, "m", body, true, null, "commandcode");

describe("OpenAI → Gemini", () => {
  it("multiple system messages are all kept in order", () => {
    const out = O2G({
      messages: [
        { role: "system", content: "RULE_ONE" },
        { role: "system", content: "RULE_TWO" },
        { role: "user", content: "hi" },
      ],
    });
    expect(out.systemInstruction.parts).toEqual([{ text: "RULE_ONE" }, { text: "RULE_TWO" }]);
  });

  it("retains system and developer text bytes including identity and Unicode", () => {
    const texts = ["You are Hermes Agent, an intelligent AI assistant created by Nous Research.", "\n规则 α 🧪\t-0 1e-09 9007199254740993\n"];
    const out = O2G({ messages: [
      { role: "system", content: texts[0] }, { role: "developer", content: texts[1] }, { role: "user", content: "hi" },
    ] });
    expect(out.systemInstruction.parts).toEqual(texts.map((text) => ({ text })));
  });
});

describe("OpenAI → Cursor", () => {
  it("rejects images unsupported by the implemented Cursor transport", () => {
    expect(() => O2C({
      messages: [{ role: "user", content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ] }],
    })).toThrow(/messages\[0\].content\[1\].*Cursor transport accepts text only/);
  });

  it("respects client max_tokens", () => {
    const out = O2C({ max_tokens: 200, messages: [{ role: "user", content: "hi" }] });
    expect(out.max_tokens).toBe(200);
  });
});

describe("OpenAI → CommandCode", () => {
  it("rejects malformed tool arguments without substituting an empty object", () => {
    expect(() => O2CC({
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "", tool_calls: [
          { id: "c1", type: "function", function: { name: "f", arguments: "{bad" } },
        ] },
        { role: "tool", tool_call_id: "c1", content: "r" },
      ],
    })).toThrow(/messages\[1\].tool_calls\[0\].function.arguments.*valid JSON/);
  });

  it("image content is preserved", () => {
    const out = O2CC({
      messages: [{ role: "user", content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
      ] }],
    });
    expect(JSON.stringify(out), "image omitted").toContain("BBBB");
  });
});
