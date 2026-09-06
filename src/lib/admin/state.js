import { createHash } from "node:crypto";
import { makeKv } from "@/lib/db/helpers/kvStore.js";
import { getAppVersion } from "@/lib/db/version.js";

/**
 * Drain, activation and release state for the admin ABI.
 *
 * WHY THE kv TABLE AND NOT NEW TABLES. All three are singleton documents: one
 * drain record per connection, one active release, one bounded history list.
 * Nothing here is queried by anything but id, nothing is joined, and nothing is
 * aggregated, so a table would buy an index no query uses and a migration every
 * install has to run. kv already stores exactly this shape.
 *
 * WHY THE VERSION IS A CONTENT HASH. The ABI's optimistic-concurrency tokens
 * (DrainState.version, Release.concurrencyVersion) have to answer one question:
 * "did this change since the caller read it". A stored counter answers it only
 * if every writer remembers to bump it, and a writer that forgets fails OPEN —
 * a stale ifMatch silently succeeds. A hash of the document cannot be forgotten,
 * and it makes the ABI's byte-identical-on-rejection clause directly checkable:
 * same state, same version, always.
 */

const drainKv = makeKv("admin.drain");
const activationKv = makeKv("admin.activation");
const qualificationKv = makeKv("admin.qualification");

const HISTORY_KEY = "history";
const CURRENT_KEY = "current";

// Enough history for an operator to see what the last few activations did and
// which one to roll back to. Unbounded growth in a kv row that is rewritten in
// full on every activation is the failure this cap exists to avoid.
const HISTORY_LIMIT = 50;

export function versionOf(doc) {
  // Sorted keys: the token must not change because a writer built the same
  // object with its properties in a different order.
  const canonical = JSON.stringify(doc, doc === null ? undefined : Object.keys(doc || {}).sort());
  return createHash("sha256").update(canonical ?? "null").digest("hex").slice(0, 16);
}

/* ------------------------------------------------------------------ drain */

// The stored document, or null when a connection has never been drained. Kept
// distinct from "not draining" so a first-time drain can be told from a
// completed one, which is what makes an absent ifMatch defensible exactly once.
export async function readDrainDoc(connectionId) {
  return await drainKv.get(connectionId, null);
}

export async function readAllDrainDocs() {
  return await drainKv.getAll();
}

export async function writeDrainDoc(connectionId, doc) {
  await drainKv.set(connectionId, doc);
}

/**
 * In-flight streams for one connection, from the counters usageRepo keeps.
 *
 * NOT getActiveRequests(): that resolves connection ids to account display
 * names for the dashboard, and a name is not an id — two accounts can share
 * one. This reads the same global by id and sums its per-model buckets.
 */
export function activeStreams(connectionId) {
  const byAccount = globalThis._pendingRequests?.byAccount?.[connectionId];
  if (!byAccount) return 0;
  let total = 0;
  for (const count of Object.values(byAccount)) {
    if (Number.isFinite(count) && count > 0) total += count;
  }
  return total;
}

export function toDrainState(connectionId, doc) {
  const draining = Boolean(doc?.isDraining);
  return {
    connectionId,
    isDraining: draining,
    requestedAt: doc?.requestedAt ?? null,
    activeStreams: activeStreams(connectionId),
    completedAt: doc?.completedAt ?? null,
    // Over the STORED document only. activeStreams moves with live traffic, so
    // including it would make every read hand back a different token and turn
    // every ifMatch into a 412.
    version: versionOf(doc),
  };
}

/* --------------------------------------------------- qualification */

/**
 * The last provider-specific credential check's result, per connection.
 *
 * A SEPARATE SCOPE, NOT THE CONNECTION ROW. updateProviderConnection merges
 * into the encrypted `data` blob that also holds accessToken and apiKey, so
 * writing probe telemetry there would put admin bookkeeping inside the
 * credential envelope and make every read of it a decrypt. This is admin
 * state, so it lives with the rest of the admin state.
 */
export async function readQualification(connectionId) {
  return await qualificationKv.get(connectionId, null);
}

export async function readAllQualifications() {
  return await qualificationKv.getAll();
}

export async function writeQualification(connectionId, doc) {
  await qualificationKv.set(connectionId, doc);
}

/* ------------------------------------------------------- activation */

export async function readActivation() {
  return await activationKv.get(CURRENT_KEY, null);
}

/**
 * The release currently serving traffic.
 *
 * A fresh install has activated nothing, but it is still RUNNING something, and
 * an `active` of null would be a lie about that. The running build is therefore
 * synthesized from the app version — derived, never written, so a GET stays a
 * pure read and the first real activation records the truth over it.
 */
export async function activeRelease() {
  const stored = await readActivation();
  if (stored) return stored;
  const version = getAppVersion();
  return {
    releaseId: `build-${version}`,
    version,
    status: "active",
    activatedAt: null,
    previousReleaseId: null,
  };
}

export async function readHistory() {
  const list = await activationKv.get(HISTORY_KEY, []);
  return Array.isArray(list) ? list : [];
}

/**
 * Every release this instance knows about, newest first.
 *
 * HISTORY IS THE CATALOG. The frozen ABI has no create-release operation, so a
 * release becomes known by being activated or recorded and an unknown
 * releaseId is a 404, never an implicit create. An operator cannot typo a
 * release into existence and cut traffic to it.
 *
 * The running build is appended when history does not already carry it, so a
 * fresh install can still name what it is running — and so a rollback has
 * somewhere to land on an instance that has activated nothing.
 */
export async function releaseCatalog() {
  const history = await readHistory();
  const running = await activeRelease();
  return history.some((r) => r?.releaseId === running.releaseId) ? history : [...history, running];
}

export async function findRelease(releaseId) {
  return (await releaseCatalog()).find((r) => r?.releaseId === releaseId) ?? null;
}

export function toRelease(doc, current) {
  if (!doc) return null;
  return {
    releaseId: doc.releaseId,
    version: doc.version ?? doc.releaseId,
    status: doc.status ?? "pending",
    activatedAt: doc.activatedAt ?? null,
    previousReleaseId: doc.previousReleaseId ?? null,
    concurrencyVersion: versionOf(current ?? doc),
  };
}

/**
 * Persist a new active release, its history entry, and the outgoing release's
 * new status, in ONE write.
 *
 * setMany is a single transaction, which is the whole reason activation and
 * history live in the same kv scope: a reader never observes `current` pointing
 * at a release history does not carry, and a crash between the two writes
 * cannot leave the instance claiming to run something it has no record of.
 *
 * @param {object} next the release becoming active.
 * @param {"activate"|"rollback"} action how it became active.
 * @param {object|null} outgoing the release being replaced. On a rollback it is
 *   marked rolled_back, so a later GET shows WHY it stopped serving rather than
 *   leaving it indistinguishable from an ordinary past activation.
 */
export async function commitActivation(next, action, outgoing = null) {
  const history = await readHistory();
  const entry = {
    releaseId: next.releaseId,
    version: next.version ?? next.releaseId,
    status: next.status,
    activatedAt: next.activatedAt ?? null,
    previousReleaseId: next.previousReleaseId ?? null,
    action,
  };

  const supersededId =
    action === "rollback" && outgoing?.releaseId && outgoing.releaseId !== next.releaseId
      ? outgoing.releaseId
      : null;
  const carried = history
    .filter((r) => r?.releaseId !== next.releaseId)
    .map((r) => (r?.releaseId === supersededId ? { ...r, status: "rolled_back" } : r));

  // The superseded release may not be in history yet (the running build on an
  // instance that has activated nothing), so it is added rather than assumed.
  if (supersededId && !carried.some((r) => r?.releaseId === supersededId)) {
    carried.unshift({
      releaseId: outgoing.releaseId,
      version: outgoing.version ?? outgoing.releaseId,
      status: "rolled_back",
      activatedAt: outgoing.activatedAt ?? null,
      previousReleaseId: outgoing.previousReleaseId ?? null,
      action: "activate",
    });
  }

  // Newest first, and a release's own row is replaced rather than appended so
  // rolling back to a release seen before does not duplicate it.
  const trimmed = [entry, ...carried].slice(0, HISTORY_LIMIT);
  await activationKv.setMany({ [CURRENT_KEY]: next, [HISTORY_KEY]: trimmed });
  return trimmed;
}

/* ------------------------------------------------------------- recheck */

/**
 * Connections with a generation probe in flight.
 *
 * Process-local on purpose. This exists to stop one operator's double-click
 * from spending two real generations, and both requests land in the same Next
 * process; a persisted flag would instead need a lease and an expiry to survive
 * a crash, and a stale row would then block rechecks until someone cleared it.
 * Losing the flag on restart fails in the harmless direction.
 */
const inFlight = (globalThis._adminRecheckInFlight ??= new Set());

export function beginRecheck(connectionId) {
  if (inFlight.has(connectionId)) return false;
  inFlight.add(connectionId);
  return true;
}

export function endRecheck(connectionId) {
  inFlight.delete(connectionId);
}
