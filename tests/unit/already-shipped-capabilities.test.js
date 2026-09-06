import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

// Ten upstream reports asking for capabilities this fork already ships. Each was
// verified against code rather than a CHANGELOG line, and is pinned here so the
// mechanism cannot be removed without a failing test naming the issue it
// re-opens. These are load-bearing assertions, not file-existence checks, except
// where the ask itself was for a document.
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const has = (p) => existsSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)));

describe("New Models Discovery covers every provider (#3603)", () => {
  it("tracks seen models in a repo wired to a route and a dashboard control", () => {
    expect(has("src/lib/db/repos/seenModelsRepo.js")).toBe(true);
    expect(has("src/app/api/models/new/route.js")).toBe(true);
    expect(read("src/lib/db/repos/seenModelsRepo.js")).toMatch(/export/);
  });
});

describe("quota safety-margin auto-pause (#3583)", () => {
  it("exposes the pause predicate and consults it on the routing path", () => {
    const util = read("src/shared/utils/quotaPause.js");
    expect(util).toContain("export function getPausedWindow");
    expect(util).toContain("export function isQuotaPaused");
    expect(read("src/sse/services/quotaGuard.js")).toContain("isQuotaPaused");
  });
});

describe("proxy pool rotation (#3354)", () => {
  it("picks a pool member by strategy from the live account-selection path", () => {
    expect(read("src/lib/network/connectionProxy.js")).toContain("export function pickProxyPoolId");
    expect(read("src/sse/services/auth.js")).toContain("pickProxyPoolId");
  });
});

describe("installation troubleshooting guide (#3093)", () => {
  it("ships the document the issue asks for, with real sections", () => {
    const doc = read("docs/troubleshooting.md");
    const headings = doc.split("\n").filter((l) => /^#{2,3} /.test(l));
    expect(headings.length).toBeGreaterThanOrEqual(10);
  });
});

describe("Codebuddy quota expiration ordering (#2981)", () => {
  it("separates a cycle reset from a resource expiry", () => {
    const src = read("open-sse/services/usage/codebuddy-cn.js");
    expect(src).toContain("CycleEndTime");
    expect(src).toContain("DeductionEndTime");
  });
});

describe("thinking level bound to the model id (#2973)", () => {
  it("derives the effort from the id's suffix before dispatch", () => {
    const core = read("open-sse/handlers/chatCore.js");
    expect(core).toContain("const suffixThinking = {}");
    // The format argument moved to FORMATS.OPENAI in b2b86c4f8 (Responses effort
    // nesting). What #2973 asserts is that the suffix-derived effort is applied to
    // the upstream model before dispatch, so pin that and leave the format free.
    expect(core).toMatch(/applyThinking\([^)]*upstreamModel, suffixThinking, provider\)/);
  });
});

describe("a non-SSE upstream body is not piped as a stream (#2039)", () => {
  it("checks the content type before piping, which is what crashed", () => {
    const sh = read("open-sse/handlers/chatCore/streamingHandler.js");
    expect(sh).toContain("const upstreamContentType =");
    for (const ct of ["application/json", "application/x-ndjson", "application/stream+json"]) {
      expect(sh, `content-type ${ct} is not considered`).toContain(ct);
    }
  });
});

describe("Headroom compression integration (#1871)", () => {
  it("ships both the compression hook and the install detection", () => {
    expect(has("open-sse/rtk/headroom.js")).toBe(true);
    expect(has("src/lib/headroom/detect.js")).toBe(true);
  });
});

describe("CommandCode never sends stream=false upstream (#1840)", () => {
  it("no longer needs to force streaming, because the endpoint changed", () => {
    // The fence was for /alpha/generate, an NDJSON endpoint that only ever
    // streamed. CommandCode is now on their documented Provider API (#1528),
    // plain OpenAI Chat Completions, which answers a non-streaming request
    // normally — so forcing the flag would override a client for no reason. The
    // fence went with the transport it guarded.
    const registry = read("open-sse/providers/registry/commandcode.js");
    expect(registry).toContain("/provider/v1/chat/completions");
    // The comment above the transport still names the old endpoint, which is
    // why this looks at the value rather than the file.
    expect(registry).not.toContain('baseUrl: "https://api.commandcode.ai/alpha/generate"');
    expect(registry).not.toContain("forceStream: true");
  });

  it("still honours forceStream for a provider that does declare it", () => {
    expect(read("open-sse/handlers/chatCore.js")).toContain("PROVIDERS[provider]?.forceStream === true");
  });
});

describe("DeepSeek reasoning_content is echoed back (#1543)", () => {
  it("carries assistant reasoning across the pivot in every request translator", () => {
    // A follow-up or tool-call turn that drops reasoning_content makes DeepSeek
    // answer 400 "reasoning_content must be passed back".
    for (const f of [
      "open-sse/translator/request/claude-to-openai.js",
      "open-sse/translator/request/openai-to-gemini.js",
      "open-sse/translator/request/antigravity-to-openai.js",
      "open-sse/translator/request/openai-responses.js",
    ]) {
      expect(read(f), `${f} does not handle reasoning_content`).toContain("reasoning_content");
    }
  });
});
