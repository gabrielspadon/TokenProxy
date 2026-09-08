import { requestFetch as fetch } from '../../utils/requestLifetime.js';
// Google Translate TTS (no auth) — scrape token + batchexecute RPC
import { UA } from "./_base.js";

const REFRESH_MS = 11 * 60 * 1000;
const cache = { token: null, tokenTime: 0 };
let _idx = 0;

async function getToken() {
  const now = Date.now();
  if (cache.token && now - cache.tokenTime < REFRESH_MS) return cache.token;
  const res = await fetch("https://translate.google.com/", { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Google translate fetch failed: ${res.status}`);
  const html = await res.text();
  const fSid = html.match(/"FdrFJe":"(.*?)"/)?.[1];
  const bl = html.match(/"cfb2h":"(.*?)"/)?.[1];
  if (!fSid || !bl) throw new Error("Failed to parse Google token");
  cache.token = { "f.sid": fSid, bl };
  cache.tokenTime = now;
  return cache.token;
}


// Google Translate TTS rejects long input: past roughly 200 characters the
// batchexecute reply comes back in a different shape and split[0][2] is null, so
// the JSON.parse below threw "unexpected token" instead of saying anything about
// length (#2287). Split the text and stitch the audio back together.
const MAX_CHARS = 200;

/**
 * Split into pieces of at most MAX_CHARS, preferring a sentence boundary, then a
 * word boundary, and only cutting mid-word when a single token is itself longer
 * than the cap.
 */
export function chunkForTts(text, limit = MAX_CHARS) {
  const out = [];
  let rest = String(text ?? "").trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1);
    let cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
    if (cut > 0) cut += 1;                       // keep the punctuation with its sentence
    else cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = limit;                   // one unbroken token longer than the cap
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export default {
  noAuth: true,
  async synthesize(text, model) {
    const lang = model || "en";
    const token = await getToken();
    const cleanText = text.replace(/[@^*()\\/\-_+=><"'\u201c\u201d\u3010\u3011]/g, " ").replaceAll(", ", ". ");

    // Longer input is synthesized in pieces and concatenated. MP3 is frame-based,
    // so joining the decoded segments produces a single playable stream.
    const pieces = chunkForTts(cleanText);
    if (pieces.length > 1) {
      const buffers = [];
      for (const piece of pieces) {
        const part = await synthesizeOne(piece, lang, token);
        buffers.push(Buffer.from(part, "base64"));
      }
      return { base64: Buffer.concat(buffers).toString("base64"), format: "mp3" };
    }
    return { base64: await synthesizeOne(pieces[0] ?? "", lang, token), format: "mp3" };
  },
};

async function synthesizeOne(cleanText, lang, token) {
  const rpcId = "jQ1olc";
  const reqId = (++_idx * 100000) + Math.floor(1000 + Math.random() * 9000);
  const query = new URLSearchParams({
    rpcids: rpcId,
    "f.sid": token["f.sid"],
    bl: token.bl,
    hl: lang,
    "soc-app": 1, "soc-platform": 1, "soc-device": 1,
    _reqid: reqId,
    rt: "c",
  });
  const payload = [cleanText, lang, null, "undefined", [0]];
  const body = new URLSearchParams();
  body.append("f.req", JSON.stringify([[[rpcId, JSON.stringify(payload), null, "generic"]]]));
  const res = await fetch(`https://translate.google.com/_/TranslateWebserverUi/data/batchexecute?${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Referer": "https://translate.google.com/" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Google TTS failed: ${res.status}`);
  const data = await res.text();
  const split = JSON.parse(data.split("\n")[3]);
  const base64 = JSON.parse(split[0][2])[0];
  if (!base64 || base64.length < 100) throw new Error("Google TTS returned empty audio");
  return base64;
}
