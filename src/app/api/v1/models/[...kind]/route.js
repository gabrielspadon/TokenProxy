import { buildModelsList } from "../route.js";
import { isRequiredProxyUnavailableError } from "@/lib/network/connectionProxy";

// URL slug → service kind(s). `web` covers both webSearch and webFetch.
const KIND_SLUG_MAP = {
  "image": ["image"],
  "tts": ["tts"],
  "stt": ["stt"],
  "embedding": ["embedding"],
  "ocr": ["ocr"],
  "moderation": ["moderation"],
  "image-to-text": ["imageToText"],
  "web": ["webSearch", "webFetch"],
};

// Every kind a model can have, for the single-model lookup below.
// buildModelsList requires an explicit list; there is no "all" sentinel.
const ALL_KINDS = ["llm", ...new Set(Object.values(KIND_SLUG_MAP).flat())];

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * GET /v1/models/{kind} - OpenAI-compatible models list filtered by capability.
 * Supported kinds: image, tts, stt, embedding, ocr, moderation, image-to-text, web.
 * GET /v1/models/{id} - the single model, where the id may be provider-prefixed.
 *
 * Catch-all rather than [kind]: a single segment could not match the ids this
 * gateway actually publishes, which all carry a provider prefix, so the lookup
 * #3588 added 404'd at the router for "cc/claude-sonnet-5" (#3649).
 */
export async function GET(_request, { params }) {
  try {
    const { kind } = await params;
    const segments = Array.isArray(kind) ? kind : [kind];
    const slug = segments.join("/");
    // A kind is one segment, so a longer path is always a model id and can never
    // fall back to the list for the slug it happens to start with.
    const kindFilter = segments.length === 1 ? KIND_SLUG_MAP[slug] : undefined;

    // OpenAI's own GET /v1/models/{model} returns a single model object, and this
    // route claimed the same path for kind filters, so a client following the
    // spec got 404 "Unknown model kind" for a model that exists (#3588). A slug
    // that is not a kind is now looked up as a model id before giving up. A kind
    // slug still wins, which is why "image" cannot address a model of that name;
    // the alternative would break every existing caller of these eight slugs.
    if (!kindFilter) {
      const all = await buildModelsList(ALL_KINDS, { localOnly: true });
      const match = all.find((m) => m.id === slug || m.id.split("/").pop() === slug);
      if (match) {
        return Response.json(match, {
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }
      return Response.json(
        {
          error: {
            message: `Unknown model or kind: ${slug}. Supported kinds: ${Object.keys(KIND_SLUG_MAP).join(", ")}`,
            type: "invalid_request_error",
          },
        },
        { status: 404, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }

    const data = await buildModelsList(kindFilter, { localOnly: true });
    return Response.json({ object: "list", data }, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  } catch (error) {
    if (isRequiredProxyUnavailableError(error)) {
      return Response.json(
        { error: "Required proxy is unavailable", code: error.code },
        { status: error.status, headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }
    console.log("Error fetching models by kind:", error);
    return Response.json(
      { error: { message: error.message, type: "server_error" } },
      { status: 500 }
    );
  }
}
