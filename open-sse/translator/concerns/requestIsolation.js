// Own every JSON container of a request body before translation or shaping
// mutates it. Direct engine callers can also attach opaque signals, streams and
// functions; retain those handles without sharing their surrounding mutable
// request records.
//
// structuredClone() is the wrong tool here even though the wire payload is JSON:
// it throws DataCloneError on exactly those opaque handles, so a standalone
// open-sse caller that attaches an AbortSignal or a conversationState callback
// lost the whole request. Copy what is mutable, pass through what is not.
export function isolateRequestBody(value, copies = new WeakMap()) {
  if (!value || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return value;
  if (copies.has(value)) return copies.get(value);
  const copy = Array.isArray(value) ? new Array(value.length) : Object.create(prototype);
  copies.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(copy, key, {
      value: isolateRequestBody(item, copies), enumerable: true, writable: true, configurable: true,
    });
  }
  return copy;
}
