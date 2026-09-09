// The in-memory stand-in for @/lib/db/helpers/kvStore.js, shared by every
// reconciliation suite.
//
// It lived as five byte-identical copies until a new store method (swap) had
// to be added to all of them, and three were missed. One copy means a method
// added to the real store is either present everywhere or absent everywhere,
// which is a failure the suites can actually see.
//
// The caller owns the Map so it can snapshot and reset around each test.
export function makeMemoryKv(store) {
  return (scope) => ({
    async get(key, fallback = null) {
      const v = store.get(`${scope}:${key}`);
      return v === undefined ? fallback : JSON.parse(v);
    },
    async getAll() {
      const out = {};
      for (const [k, v] of store) {
        if (k.startsWith(`${scope}:`)) out[k.slice(scope.length + 1)] = JSON.parse(v);
      }
      return out;
    },
    async set(key, value) {
      store.set(`${scope}:${key}`, JSON.stringify(value));
    },
    async setMany(obj) {
      for (const [k, v] of Object.entries(obj)) store.set(`${scope}:${k}`, JSON.stringify(v));
    },
    async remove(key) {
      store.delete(`${scope}:${key}`);
    },
    async clear() {
      for (const k of [...store.keys()]) if (k.startsWith(`${scope}:`)) store.delete(k);
    },
    // Same compare-and-set contract as the real store: the re-read and the
    // write are one step, so a value that moved since the caller's
    // precondition read loses rather than being silently overwritten.
    async swap(key, expected, next, versionOf) {
      const raw = store.get(`${scope}:${key}`);
      const current = raw === undefined ? null : JSON.parse(raw);
      if (versionOf(current) !== versionOf(expected)) return { written: false, current };
      store.set(`${scope}:${key}`, JSON.stringify(next));
      return { written: true, current: next };
    },
  });
}
