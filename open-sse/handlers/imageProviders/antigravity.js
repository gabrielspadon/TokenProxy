// Antigravity image adapter - delegates to the executor for correct request
// envelope (project, model, requestType, sessionId) and auth headers.
import { nowSec, sizeToAspectRatio } from "./_base.js";
import { getExecutor } from "../../executors/index.js";
import { HTTP_STATUS } from "../../config/runtimeConfig.js";

// Convert image input (data URI or raw base64) to Gemini inlineData part
function resolveImageInput(input) {
  if (!input || typeof input !== "string") return null;
  // data:image/png;base64,... format
  const dataUriMatch = input.match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (dataUriMatch) {
    return { inlineData: { mimeType: dataUriMatch[1], data: dataUriMatch[2] } };
  }
  // Raw base64 string (assume PNG)
  if (/^[A-Za-z0-9+/]/.test(input) && input.length > 100 && !input.startsWith("http")) {
    return { inlineData: { mimeType: "image/png", data: input } };
  }
  return null;
}

export default {
  // Delegate to executor instead of building URL/headers/body manually
  useExecutor: true,

  // Stubs - required by imageGenerationCore interface but unused with useExecutor
  buildUrl: () => "",
  buildHeaders: () => ({}),
  buildBody: () => ({}),

  async executeViaExecutor(model, body, credentials, log, connectTimeout = null, signal) {
    const executor = getExecutor("antigravity");
    if (!executor) throw new Error("Antigravity executor not found");

    // The public image endpoint requires an explicit model. Reject a chat
    // selection before dispatch instead of billing a different image model.
    const isImageModel = (m) => /image|imagen|image-generation/i.test(m || "");
    if (!isImageModel(model)) {
      const error = new Error(model
        ? `Model '${model}' does not support image generation`
        : 'Missing image model');
      error.status = HTTP_STATUS.BAD_REQUEST;
      error.failureMetadata = { safeToReplay: true };
      throw error;
    }
    let targetModel = model;

    // The executor reads the aspect ratio off a -WxH model suffix (parseImageConfig),
    // so body.size only reaches the upstream by being encoded into the model name.
    if (body.size && typeof body.size === "string") {
      const suffix = sizeToAspectRatio(body.size).replace(":", "x");
      if (!targetModel.endsWith(`-${suffix}`)) {
        targetModel = `${targetModel}-${suffix}`;
      }
    }

    // Build parts: text prompt + optional input image for editing
    const parts = [{ text: body.prompt }];
    const imageInput = body.image || (Array.isArray(body.images) && body.images[0]);
    if (imageInput) {
      const inlineData = resolveImageInput(imageInput);
      if (inlineData) parts.unshift(inlineData);
    }

    const chatBody = {
      contents: [{ role: "user", parts }],
    };

    const result = await executor.execute({
      model: targetModel,
      body: chatBody,
      stream: false,
      credentials,
      log,
      connectTimeout,
      signal,
    });

    if (!result.response.ok) {
      const text = await result.response.text();
      const error = new Error(text || `HTTP ${result.response.status}`);
      error.status = result.response.status;
      error.failureMetadata = { safeToReplay: true };
      throw error;
    }

    return result.response.json();
  },

  normalize: (responseBody, prompt) => {
    const candidates = responseBody.candidates || responseBody.response?.candidates || [];
    const parts = candidates[0]?.content?.parts || [];
    const images = parts.filter((p) => p.inlineData?.data).map((p) => ({
      b64_json: p.inlineData.data,
    }));
    return {
      created: nowSec(),
      data: images.length > 0 ? images : [{ b64_json: "", revised_prompt: prompt }],
    };
  },
};
