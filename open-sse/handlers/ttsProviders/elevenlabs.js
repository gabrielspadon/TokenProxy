import { requestFetch as fetch } from '../../utils/requestLifetime.js';
// ElevenLabs TTS — voice id with optional model_id prefix
import { Buffer } from "node:buffer";

const VOICES_TTL = 24 * 60 * 60 * 1000;
const _voicesCache = new Map(); // by API key

export async function fetchElevenLabsVoices(apiKey) {
  if (!apiKey) throw new Error("ElevenLabs API key required");
  const now = Date.now();
  const cached = _voicesCache.get(apiKey);
  if (cached && now - cached.time < VOICES_TTL) return cached.voices;

  const res = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`ElevenLabs voices fetch failed: ${res.status}`);
  const data = await res.json();
  // Normalize: derive lang from labels for grouping
  const voices = (data.voices || []).map((v) => ({ ...v, lang: v.labels?.language || "en" }));
  _voicesCache.set(apiKey, { voices, time: now });
  return voices;
}

export default {
  async synthesize(text, model, credentials, _responseFormat, opts = {}) {
    if (!credentials?.apiKey) throw new Error("ElevenLabs API key required");
    let modelId = "eleven_flash_v2_5";
    let voiceId = model;
    if (model && model.includes("/")) [modelId, voiceId] = model.split("/");

    // ElevenLabs reads output_format from the query string, not the body, so
    // spreading it in with the rest of the options would silently do nothing.
    const { output_format: outputFormat, ...bodyOptions } = opts.providerOptions || {};
    const query = outputFormat ? `?output_format=${encodeURIComponent(outputFormat)}` : "";

    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}${query}`, {
      method: "POST",
      headers: { "xi-api-key": credentials.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        // Caller-supplied settings first, so this vendor's own controls
        // (seed, previous_text, ...) survive the normalized shape (#2036).
        // text and model_id are applied AFTER and cannot be overridden from a
        // request: the text is the input and the model came from the id the
        // router resolved, so letting a request change either would synthesize
        // something nobody asked for. voice_settings merges per key, so a
        // caller who sets one knob keeps the defaults for the rest.
        ...bodyOptions,
        text,
        model_id: modelId,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          ...(bodyOptions.voice_settings || {}),
        },
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.detail?.message || `ElevenLabs TTS failed: ${res.status}`);
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 1024) throw new Error("ElevenLabs TTS returned empty audio");
    return { base64: Buffer.from(buf).toString("base64"), format: "mp3" };
  },
};
