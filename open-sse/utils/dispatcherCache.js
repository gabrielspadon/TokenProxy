const localRefusals = new WeakSet();
const REFUSAL_MESSAGES = {
  transport_pool_capacity: "All transport pool slots are active; retry after capacity is available",
  transport_pools_closed: "Transport pools are closing",
  transport_pool_cleanup: "An idle transport pool could not be closed",
};

export class LocalTransportPoolRefusal extends Error {
  constructor(code) {
    if (!Object.hasOwn(REFUSAL_MESSAGES, code)) throw new TypeError("Unknown local transport refusal");
    super(REFUSAL_MESSAGES[code]);
    this.name = "LocalTransportPoolRefusal";
    this.code = code;
    this.statusCode = 503;
    localRefusals.add(this);
  }
}

export const isLocalTransportPoolRefusal = error => localRefusals.has(error);
export const revokeLocalTransportRefusalProof = error => localRefusals.delete(error);

// Reserve the slot before asynchronous construction starts. A reservation lasts
// through fetch headers; the resource's own idle predicate covers the body.
export function createDispatcherCache(maxSize) {
  const entries = new Map();
  let closed = false;

  async function dispose(resource) {
    try { await resource.dispatcher.close?.(); }
    catch (error) {
      // No new work can enter an evicted resource. Destroy is safe only after
      // its authoritative transport counters also report no queued/running work.
      if (!resource.isIdle() || !resource.dispatcher.destroy) throw error;
      await resource.dispatcher.destroy();
    }
  }

  return {
    reserve(key, create) {
      if (closed) throw new LocalTransportPoolRefusal("transport_pools_closed");
      let entry = entries.get(key);
      if (entry) {
        entries.delete(key);
        entries.set(key, entry);
      } else {
        let previous = null;
        if (entries.size >= maxSize) {
          for (const [oldKey, candidate] of entries) {
            if (candidate.resource && candidate.reservations === 0 && candidate.resource.isIdle()) {
              previous = candidate.resource;
              entries.delete(oldKey);
              break;
            }
          }
          if (!previous) throw new LocalTransportPoolRefusal("transport_pool_capacity");
        }
        entry = { resource: null, previous, reservations: 0, promise: null };
        entries.set(key, entry);
        entry.promise = Promise.resolve().then(async () => {
          if (entry.previous) {
            await dispose(entry.previous);
            entry.previous = null;
          }
          const resource = await create();
          entry.resource = resource;
          return resource.dispatcher;
        }).catch(error => {
          // A failed construction frees its reservation. A resource whose close
          // AND idle destroy failed remains owned and counts against capacity.
          if (!entry.previous && entries.get(key) === entry) entries.delete(key);
          if (entry.previous) {
            throw new LocalTransportPoolRefusal("transport_pool_cleanup");
          }
          throw error;
        });
      }
      entry.reservations++;
      let released = false;
      return {
        dispatcher: entry.promise,
        release() {
          if (released) return;
          released = true;
          entry.reservations--;
        },
      };
    },
    async close() {
      closed = true;
      const results = await Promise.allSettled([...entries.values()].map(async entry => {
        try { await entry.promise; } catch { /* A failed construction has no dispatcher. */ }
        const resource = entry.resource || entry.previous;
        if (resource) await dispose(resource);
      }));
      const failures = results.filter(result => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Transport pool cleanup failed");
      entries.clear();
    },
  };
}
