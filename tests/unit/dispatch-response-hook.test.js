import { expect, it, vi } from "vitest";
import { notifyDispatchResponse } from "../../open-sse/utils/dispatchHooks.js";

it("passes the exact response and optional verified nonacceptance without consuming it", async () => {
  const response = new Response("model endpoint unsupported", { status: 400 });
  const after = vi.fn();
  await notifyDispatchResponse(after, response, "model-endpoint-unsupported");
  expect(after).toHaveBeenCalledWith({ response, nonacceptance: "model-endpoint-unsupported" });
  expect(await response.text()).toBe("model endpoint unsupported");
});

it("cancels unused output promptly while preserving the hook failure", async () => {
  const failure = new Error("persistence refused");
  const cancel = vi.fn(() => new Promise(() => {}));
  const response = new Response(new ReadableStream({ cancel }));
  await expect(notifyDispatchResponse(() => { throw failure; }, response)).rejects.toBe(failure);
  expect(cancel).toHaveBeenCalledOnce();
});

it("keeps a cancellation failure from replacing the accounting failure", async () => {
  const failure = new Error("accounting unavailable");
  const response = { body: { cancel: vi.fn().mockRejectedValue(new Error("cancel failed")) } };
  await expect(notifyDispatchResponse(async () => { throw failure; }, response)).rejects.toBe(failure);
});
