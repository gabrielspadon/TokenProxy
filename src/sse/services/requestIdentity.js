import { randomUUID } from "node:crypto";

const identities = new WeakMap();

// A client header is not an accounting identity. Each accepted Request owns
// one server identity and counter, shared by its combo members and retries.
export function getRequestIdentity(request) {
  let identity = request && typeof request === "object" ? identities.get(request) : null;
  if (!identity) {
    const logicalRequestId = randomUUID();
    let attempt = 0;
    const spans = [];
    const openSpans = new Set();
    const startSpan = (stage) => {
      const started = performance.now();
      let closed = false;
      const end = (outcome = 'unknown', attemptRequestId = null) => {
        if (closed) return;
        closed = true;
        openSpans.delete(end);
        if (spans.length < 1024) spans.push({ stage, durationMs: Math.max(0, performance.now() - started), outcome, attemptRequestId, relation: 'overlap' });
      };
      openSpans.add(end);
      return end;
    };
    identity = Object.freeze({ logicalRequestId, nextAttempt: () => ++attempt, startSpan,
      finishSpans: () => { for (const end of openSpans) end(); return [...spans]; } });
    if (request && typeof request === "object") identities.set(request, identity);
  }
  return identity;
}
