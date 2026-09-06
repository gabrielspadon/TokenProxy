import { randomUUID } from "node:crypto";

const identities = new WeakMap();

// A client header is not an accounting identity. Each accepted Request owns
// one server identity and counter, shared by its combo members and retries.
export function getRequestIdentity(request) {
  let identity = request && typeof request === "object" ? identities.get(request) : null;
  if (!identity) {
    const logicalRequestId = randomUUID();
    let attempt = 0;
    identity = Object.freeze({ logicalRequestId, nextAttempt: () => ++attempt });
    if (request && typeof request === "object") identities.set(request, identity);
  }
  return identity;
}
