// Antigravity image adapter ignored `body.size` (upstream 2a9213c5b).
//
// Both ends already existed: `sizeToAspectRatio` in imageProviders/_base.js and
// the `-(\d+)x(\d+)$` suffix parse in executors/antigravity.js, which reads a
// pair of numbers <= 16 as a literal aspect ratio. Nothing joined them, so an
// /v1/images request with a size got a 1:1 image back.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: () => ({ execute: mocks.execute }),
}));

const { default: adapter } = await import("open-sse/handlers/imageProviders/antigravity.js");

const okResponse = {
  response: {
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { data: "AAA" } }] } }] }),
  },
};

const call = (model, body) =>
  adapter.executeViaExecutor(model, body, { projectId: "p" }, null, null, undefined);

const modelSent = () => mocks.execute.mock.calls.at(-1)[0].model;

beforeEach(() => {
  mocks.execute.mockReset();
  mocks.execute.mockResolvedValue(okResponse);
});

describe("antigravity image adapter model resolution", () => {
  it("appends the aspect-ratio suffix the executor parses", async () => {
    await call("gemini-3.1-flash-image", { prompt: "a cat", size: "1792x1024" });
    expect(modelSent()).toBe("gemini-3.1-flash-image-16x9");
  });

  it("maps a portrait size to its own ratio", async () => {
    await call("gemini-3.1-flash-image", { prompt: "a cat", size: "1024x1792" });
    expect(modelSent()).toBe("gemini-3.1-flash-image-9x16");
  });

  it("keeps the plain model when no size is given", async () => {
    await call("gemini-3.1-flash-image", { prompt: "a cat" });
    expect(modelSent()).toBe("gemini-3.1-flash-image");
  });

  it("keeps the plain model when size is not a usable string", async () => {
    await call("gemini-3.1-flash-image", { prompt: "a cat", size: 1024 });
    expect(modelSent()).toBe("gemini-3.1-flash-image");
  });

  it("rejects a non-image selection before any provider dispatch", async () => {
    await expect(call("gemini-3.1-flash", { prompt: "a cat", size: "1792x1024" })).rejects.toMatchObject({ status: 400, failureMetadata: { safeToReplay: true } });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("does not double-append a suffix the model already carries", async () => {
    await call("gemini-3.1-flash-image-16x9", { prompt: "a cat", size: "1792x1024" });
    expect(modelSent()).toBe("gemini-3.1-flash-image-16x9");
  });

  it("still passes the prompt and input image through untouched", async () => {
    await call("gemini-3.1-flash-image", {
      prompt: "a cat",
      size: "1024x1024",
      image: "data:image/png;base64,ZZZ",
    });
    const { body } = mocks.execute.mock.calls.at(-1)[0];
    expect(body.contents[0].parts).toEqual([
      { inlineData: { mimeType: "image/png", data: "ZZZ" } },
      { text: "a cat" },
    ]);
  });
});
