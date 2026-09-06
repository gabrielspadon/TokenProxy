// Size-based catch-all, NOT content-sniffed: for oversized blobs that match no
// structured filter, keep head+tail verbatim, elide the middle, and record an
// integrity marker (char count + HMAC of the elided span). This is lossy;
// the marker cannot recover the removed content. Explicit opt-in only.
// Contract: returns null on no-match (len <= ELIDE_MIN_CHARS, degenerate
// overlap, or would-grow), same convention as the autodetect chain's no-match.
import { createHmac, randomBytes } from "crypto";
import fs from "node:fs";
import path from "node:path";
// RELATIVE, not '@/': the open-sse rtk chain is imported under plain node,
// where the alias does not resolve (same rule as decide.js). dataDir.js
// imports only node builtins, so the chain stays dependency-free.
import { DATA_DIR } from "../../../src/lib/dataDir.js";
import {
  ELIDE_MIN_CHARS,
  ELIDE_HEAD_CHARS,
  ELIDE_TAIL_CHARS,
  ELIDE_NEWLINE_WINDOW,
} from "../constants.js";

// The integrity marker shape, shared with every consumer that must recognize
// an elided span (qac must never compress one, toolPruner/compactor must not
// re-truncate one). Matches both the current hmac markers and sha-era markers
// written by earlier processes.
export const ELIDE_MARKER_RE =
  /\[elided \d+ chars · (?:sha|hmac) [0-9a-f]{8} · head\+tail preserved by tokenproxy\]/;

// SEC-1: a bare sha256 of the middle was a brute-force oracle for low-entropy
// elided content (probe recovered a 5-char middle in 2.6s, and the marker
// ships in provider-visible prompts). HMAC-SHA256 under a host-local key kills
// the offline probe. The key persists at DATA_DIR/elide.key (mode 600, same
// discipline as tokenSaver/events.js) so a gateway restart does NOT re-elide
// history under a new marker: a fresh marker would rewrite the cached prefix
// of every elide-bearing conversation once per restart. Falls back to a
// per-process random key only when the file cannot be written, and says so.
function loadElideIntegrityKey() {
  const file = path.join(DATA_DIR, "elide.key");
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  } catch {
    /* absent or unreadable: (re)create below */
  }
  const key = randomBytes(32);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, key.toString("hex"), { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600); // correct a pre-existing loose file
    } catch { /* best-effort */ }
  } catch {
    console.log("[ELIDE] integrity key not persistable (DATA_DIR read-only); per-process key in use, elide markers will change on restart");
  }
  return key;
}

const ELIDE_INTEGRITY_KEY = loadElideIntegrityKey();

export function elide(input) {
  if (typeof input !== "string" || input.length <= ELIDE_MIN_CHARS) return null;

  const len = input.length;

  // Head boundary: nearest newline within the window around the cut so the
  // head never ends mid-line. The boundary newline itself is elided; the
  // marker's leading "\n" supplies the line break. Only ever shrinks the head.
  let headEnd = ELIDE_HEAD_CHARS;
  const headNl = input.indexOf("\n", Math.max(0, ELIDE_HEAD_CHARS - ELIDE_NEWLINE_WINDOW));
  if (headNl !== -1 && headNl <= ELIDE_HEAD_CHARS + ELIDE_NEWLINE_WINDOW - 1) {
    headEnd = headNl;
  }

  // Tail boundary: same preference at the tail's start. The tail only ever
  // starts later, never grows.
  let tailStart = len - ELIDE_TAIL_CHARS;
  const tailNl = input.indexOf("\n", tailStart);
  if (tailNl !== -1 && tailNl <= tailStart + ELIDE_NEWLINE_WINDOW - 1) {
    tailStart = tailNl + 1;
  }
  // Never split a UTF-16 surrogate pair at either boundary.
  if (headEnd > 0 && headEnd < len &&
      input.charCodeAt(headEnd - 1) >= 0xd800 && input.charCodeAt(headEnd - 1) <= 0xdbff &&
      input.charCodeAt(headEnd) >= 0xdc00 && input.charCodeAt(headEnd) <= 0xdfff) {
    headEnd--;
  }
  // If the tail starts on a low
  // surrogate, the boundary landed between the pair's halves, so advance past
  // the whole pair. The omitted pair remains part of the lossy middle.
  if (
    tailStart > 0 &&
    tailStart < len &&
    input.charCodeAt(tailStart) >= 0xdc00 &&
    input.charCodeAt(tailStart) <= 0xdfff
  ) {
    tailStart += 1;
  }

  if (headEnd >= tailStart) return null; // degenerate overlap, never split

  const middle = input.slice(headEnd, tailStart);
  // SEC-1: HMAC under the persisted host key, not a bare hash — see above.
  const hmac = createHmac("sha256", ELIDE_INTEGRITY_KEY).update(middle, "utf8").digest("hex").slice(0, 8);
  const marker = `\n[elided ${middle.length} chars · hmac ${hmac} · head+tail preserved by tokenproxy]\n`;

  // Never grow the input (defensive: unreachable at ELIDE_MIN_CHARS=4000
  // with a ~60-char marker, kept as the floor if the constants ever shrink)
  if (headEnd + (len - tailStart) + marker.length >= len) return null;

  return input.slice(0, headEnd) + marker + input.slice(tailStart);
}

elide.filterName = "elide";
