import { describe, expect, it } from "vitest";

import { projectClientModelStatus } from "../../open-sse/config/modelErrorClassifier.js";
import { createErrorResult } from "../../open-sse/utils/error.js";

describe("client model error status projection", () => {
  it.each([
    [
      "a verified Gemini unknown-model payload",
      {
        provider: "gemini",
        requestedModel: "gemini-missing",
        status: 404,
        payload: {
          error: {
            code: 404,
            status: "NOT_FOUND",
            message: "models/gemini-missing is not found for API version v1beta",
          },
        },
      },
      { clientErrorStatus: 404, unknownModelVerified: true },
    ],
    [
      "generic ModelError prose",
      {
        provider: "gemini",
        requestedModel: "gemini-missing",
        status: 502,
        payload: { error: { message: "ModelError: model not supported" } },
      },
      { clientErrorStatus: 502, unknownModelVerified: false },
    ],
    [
      "a non-model authentication failure",
      {
        provider: "gemini",
        requestedModel: "gemini-missing",
        status: 401,
        payload: { error: { code: 401, status: "UNAUTHENTICATED", message: "API key not valid" } },
      },
      { clientErrorStatus: 401, unknownModelVerified: false },
    ],
    [
      "a request parameter failure",
      {
        provider: "gemini",
        requestedModel: "gemini-missing",
        status: 400,
        payload: { error: { code: 400, status: "INVALID_ARGUMENT", message: "temperature must be non-negative" } },
      },
      { clientErrorStatus: 400, unknownModelVerified: false },
    ],
    [
      "an absent payload",
      { provider: "gemini", requestedModel: "gemini-missing", status: 503, payload: null },
      { clientErrorStatus: 503, unknownModelVerified: false },
    ],
    [
      "a verified Anthropic not_found_error naming the model",
      {
        provider: "claude",
        requestedModel: "claude-fable-5-1",
        status: 404,
        payload: { type: "error", error: { type: "not_found_error", message: "model: claude-fable-5-1" } },
      },
      { clientErrorStatus: 404, unknownModelVerified: true },
    ],
    [
      "an Anthropic not_found_error naming a DIFFERENT model",
      {
        provider: "claude",
        requestedModel: "claude-fable-5-1",
        status: 404,
        payload: { type: "error", error: { type: "not_found_error", message: "model: claude-other" } },
      },
      { clientErrorStatus: 404, unknownModelVerified: false },
    ],
    [
      "the anthropic api-key twin via the claude predicate",
      {
        provider: "anthropic",
        requestedModel: "claude-fable-5-1",
        status: 404,
        payload: { type: "error", error: { type: "not_found_error", message: "model: claude-fable-5-1" } },
      },
      { clientErrorStatus: 404, unknownModelVerified: true },
    ],
    [
      "a verified OpenAI model_not_found code",
      {
        provider: "codex",
        requestedModel: "gpt-6-pro",
        status: 404,
        payload: { error: { message: "The model `gpt-6-pro` does not exist or you do not have access to it.", type: "invalid_request_error", code: "model_not_found", param: null } },
      },
      { clientErrorStatus: 404, unknownModelVerified: true },
    ],
    [
      "a verified OpenAI invalid_request_error with param=model on 400",
      {
        provider: "codex",
        requestedModel: "gpt-6-pro",
        status: 400,
        payload: { error: { message: "Unsupported model gpt-6-pro when using Codex with a ChatGPT account.", type: "invalid_request_error", code: null, param: "model" } },
      },
      { clientErrorStatus: 404, unknownModelVerified: true },
    ],
    [
      "an OpenAI 400 that does not name the requested model",
      {
        provider: "codex",
        requestedModel: "gpt-6-pro",
        status: 400,
        payload: { error: { message: "Invalid value for temperature.", type: "invalid_request_error", code: null, param: "temperature" } },
      },
      { clientErrorStatus: 400, unknownModelVerified: false },
    ],
    [
      "the openai api-key twin via the codex predicate",
      {
        provider: "openai",
        requestedModel: "gpt-6-pro",
        status: 404,
        payload: { error: { message: "The model `gpt-6-pro` does not exist.", type: "invalid_request_error", code: "model_not_found", param: "model" } },
      },
      { clientErrorStatus: 404, unknownModelVerified: true },
    ],
  ])("projects %s only from a verified structured model signature", (_name, input, expected) => {
    expect(projectClientModelStatus(input)).toEqual(expected);
  });

  it("keeps failure metadata internal to the result and client error body", async () => {
    const failureMetadata = { clientErrorStatus: 404, unknownModelVerified: true };
    const result = createErrorResult(502, "upstream unavailable", undefined, failureMetadata);

    expect(result).toMatchObject({ status: 502, failureMetadata });
    await expect(result.response.json()).resolves.toMatchObject({ error: { message: "upstream unavailable" } });
  });
});
