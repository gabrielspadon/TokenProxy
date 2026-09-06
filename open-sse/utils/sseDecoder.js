import { createParser } from "eventsource-parser";

// Framing only. Callers own provider payloads, aggregate byte budgets, reader
// lifetime and backpressure. A synchronous callback creates no event queue.
export function createSseDecoder(onEvent) {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const parser = createParser({ onEvent });
  let released = false;
  return {
    feed(bytes) {
      if (!released && bytes?.byteLength) parser.feed(decoder.decode(bytes, { stream: true }));
    },
    finish() {
      if (released) return;
      // These collectors historically accept a complete JSON payload at EOF
      // without the final SSE blank line. Do not synthesize payload or terminal
      // content; merely let the existing JSON/terminal validators inspect it.
      parser.feed(decoder.decode() + "\n\n");
    },
    release() {
      released = true;
      parser.reset();
    },
  };
}
