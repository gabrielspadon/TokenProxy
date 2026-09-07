import { getAdapter } from '../driver.js';
import { createApiKey, getApiKeyById, updateApiKey } from './apiKeysRepo.js';
import { AccessProfileError, GOVERNED_FIELDS, adoptedVersion } from './accessProfilesRepo.js';

/**
 * Copy a profile's current version onto a key.
 *
 * A COPY, deliberately, not a reference. The gateway's auth path stays one
 * indexed read on apiKeys, and editing a profile can never retroactively widen
 * or narrow a key that is already in a client's configuration file. The price
 * is drift, which profileComplianceFor() surfaces rather than hides.
 */
export async function adoptAccessProfile(keyId, profileId) {
  const db = await getAdapter();
  let adopted = null;
  const profile = db.get('SELECT id, name, version FROM accessProfiles WHERE id = ?', [profileId]);
  if (!profile) throw new AccessProfileError('Profile not found.', 404);
  const settings = adoptedVersion(db, profile.id, profile.version);
  if (!settings) throw new AccessProfileError('Profile version is unavailable.', 409);
  const existing = await getApiKeyById(keyId);
  if (!existing) throw new AccessProfileError('Key not found.', 404);

  const patch = Object.fromEntries(
    GOVERNED_FIELDS.map((field) => [field, settings[field] ?? null])
  );
  // The profile carries a LIFETIME in days; the key carries a DATE. Computing
  // it here rather than storing a date on the profile is what lets one bundle
  // be adopted repeatedly over months without handing out an already-past
  // expiry. A profile with no expiry policy leaves the key's own expiry alone,
  // because "this bundle does not require an expiry" is not "this key has none".
  if (settings.expiryDays !== null) {
    patch.expiresAt = new Date(Date.now() + settings.expiryDays * 86400000).toISOString();
  }
  adopted = await updateApiKey(keyId, {
    ...patch,
    accessProfileId: profile.id,
    accessProfileVersion: profile.version,
  });
  return adopted;
}

export async function releaseAccessProfile(keyId) {
  // The key keeps every setting it adopted; only the claim to be following a
  // bundle goes. Dropping the settings too would revoke access an operator
  // never asked to revoke.
  return updateApiKey(keyId, { accessProfileId: null, accessProfileVersion: null });
}

export class RotationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const MAX_OVERLAP_HOURS = 24 * 90;

export function normalizeOverlapHours(value) {
  const n = Number(value);
  // Zero is a real, and dangerous, choice: it ends the old secret immediately.
  // It is allowed because an operator responding to a leak needs it, but it is
  // never the default, and nothing here reaches it by omission.
  if (!Number.isFinite(n) || n < 0 || n > MAX_OVERLAP_HOURS) {
    throw new RotationError(`overlapHours must be between 0 and ${MAX_OVERLAP_HOURS}.`);
  }
  return Math.floor(n);
}

/**
 * Issue a successor secret while the predecessor keeps working for a chosen
 * overlap window.
 *
 * NEVER A SILENT INVALIDATION. The old key is not deleted, not deactivated and
 * not stripped of its settings: it is given an expiry, which the existing
 * validateApiKey check already enforces on the next request. A client that has
 * not been reconfigured keeps running until that stamp, and the operator can
 * see both secrets and the deadline in between.
 *
 * The successor is a real, separate key row. Its usage, budget account and
 * device counts start clean, which is exactly what makes "traffic has moved to
 * the new secret" legible before the window closes.
 */
export async function rotateApiKey(keyId, { overlapHours, name } = {}) {
  const hours = normalizeOverlapHours(overlapHours);
  const previous = await getApiKeyById(keyId);
  if (!previous) throw new RotationError('Key not found.', 404);
  if (previous.supersededAt) throw new RotationError('This key has already been rotated.', 409);
  if (!previous.machineId)
    throw new RotationError('This key cannot be rotated without a machine identity.', 409);

  const rotatedAt = new Date();
  const overlapEndsAt = new Date(rotatedAt.getTime() + hours * 3600000).toISOString();
  // An overlap that would outlive the predecessor's own expiry does not extend
  // it. Rotating a key must never be a way to quietly buy a credential more
  // life than the operator originally granted it.
  const effectiveEnd =
    previous.expiresAt && previous.expiresAt < overlapEndsAt ? previous.expiresAt : overlapEndsAt;

  const successor = await createApiKey(
    name || `${previous.name || 'Key'} (rotated)`,
    previous.machineId,
    previous.expiresAt
  );
  const carried = Object.fromEntries(
    GOVERNED_FIELDS.map((field) => [field, previous[field] ?? null])
  );
  await updateApiKey(successor.id, {
    ...carried,
    // The successor inherits the profile linkage as adopted, not re-adopted: it
    // is the same access under a new secret, so a predecessor that had drifted
    // stays drifted rather than being quietly brought back into compliance.
    accessProfileId: previous.accessProfileId,
    accessProfileVersion: previous.accessProfileVersion,
    accessProfileAdoptedAt: previous.accessProfileAdoptedAt,
  });
  await updateApiKey(keyId, { expiresAt: effectiveEnd });

  const db = await getAdapter();
  db.run(
    `INSERT INTO apiKeyRotations(successorKeyId, predecessorKeyId, rotatedAt, overlapEndsAt, overlapHours)
     VALUES(?, ?, ?, ?, ?)`,
    [successor.id, keyId, rotatedAt.toISOString(), effectiveEnd, hours]
  );
  db.run('UPDATE apiKeys SET supersededAt = ? WHERE id = ?', [rotatedAt.toISOString(), keyId]);

  return {
    // The one and only time the successor's material is returned, matching how
    // a freshly created key is handled.
    successor: { id: successor.id, name: successor.name, key: successor.key },
    predecessorKeyId: keyId,
    rotatedAt: rotatedAt.toISOString(),
    overlapHours: hours,
    overlapEndsAt: effectiveEnd,
    overlapTruncatedByExistingExpiry: effectiveEnd !== overlapEndsAt,
  };
}

/** { [keyId]: rotation } for both sides of every rotation, for the keys list. */
export async function getRotationSummaries() {
  const db = await getAdapter();
  const out = {};
  for (const row of db.all('SELECT * FROM apiKeyRotations ORDER BY rotatedAt ASC')) {
    out[row.predecessorKeyId] = {
      role: 'superseded',
      counterpartKeyId: row.successorKeyId,
      rotatedAt: row.rotatedAt,
      overlapEndsAt: row.overlapEndsAt,
      overlapHours: row.overlapHours,
    };
    out[row.successorKeyId] = {
      role: 'successor',
      counterpartKeyId: row.predecessorKeyId,
      rotatedAt: row.rotatedAt,
      overlapEndsAt: row.overlapEndsAt,
      overlapHours: row.overlapHours,
    };
  }
  return out;
}
