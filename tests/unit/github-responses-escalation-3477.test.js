import { afterEach, describe, expect, it, vi } from "vitest";

import { BaseExecutor } from "../../open-sse/executors/base.js";
import { GithubExecutor } from "../../open-sse/executors/github.js";

// Copilot's generic rejection. It is returned both for a model that is only
// reachable through /responses AND for a model the account/integrator cannot use
// at all (#3477), so it cannot by itself justify pinning the model to /responses.
const MODEL_NOT_SUPPORTED = JSON.stringify({
  error: {
    message: "The requested model is not supported.",
    code: "model_not_supported",
    param: "model",
    type: "invalid_request_error",
  },
});

const options = (model) => ({
  model,
  body: { messages: [{ role: "user", content: "hi" }] },
  stream: false,
  credentials: { copilotToken: "t" },
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GitHub Copilot /responses escalation cache (#3477)", () => {
  it.each(['x-tokenproxy-replay-safe','x-should-retry'])('honors %s before changing the generation endpoint',async header=>{
    const executor=new GithubExecutor();
    const upstream=new Response(MODEL_NOT_SUPPORTED,{status:400,headers:{[header]:'false'}});
    vi.spyOn(BaseExecutor.prototype,'execute').mockResolvedValue({response:upstream});
    const responses=vi.spyOn(executor,'executeWithResponsesEndpoint');
    expect((await executor.execute(options('gpt-5.2'))).response).toBe(upstream);
    expect(responses).not.toHaveBeenCalled();
  });
  it("does not pin a model to /responses when the escalation also fails", async () => {
    const executor = new GithubExecutor();
    const chat = vi
      .spyOn(BaseExecutor.prototype, "execute")
      .mockImplementation(async () => ({
        response: new Response(MODEL_NOT_SUPPORTED, { status: 400 }),
      }));
    const responses = vi
      .spyOn(executor, "executeWithResponsesEndpoint")
      .mockImplementation(async () => ({
        response: new Response(MODEL_NOT_SUPPORTED, { status: 400 }),
      }));

    await executor.execute(options("gpt-5.2"));

    expect(executor.knownCodexModels.has("gpt-5.2")).toBe(false);

    // Second request must still start at /chat/completions rather than being
    // routed straight to the endpoint that already rejected it.
    await executor.execute(options("gpt-5.2"));

    expect(chat).toHaveBeenCalledTimes(2);
    expect(responses).toHaveBeenCalledTimes(2);
  });

  it("pins a model to /responses once that endpoint serves it", async () => {
    const executor = new GithubExecutor();
    const chat = vi
      .spyOn(BaseExecutor.prototype, "execute")
      .mockImplementation(async () => ({
        response: new Response(MODEL_NOT_SUPPORTED, { status: 400 }),
      }));
    const responses = vi
      .spyOn(executor, "executeWithResponsesEndpoint")
      .mockImplementation(async () => ({
        response: new Response("{}", { status: 200 }),
      }));

    await executor.execute(options("gpt-5.3-codex"));

    expect(executor.knownCodexModels.has("gpt-5.3-codex")).toBe(true);

    await executor.execute(options("gpt-5.3-codex"));

    expect(chat).toHaveBeenCalledTimes(1);
    expect(responses).toHaveBeenCalledTimes(2);
  });
});
