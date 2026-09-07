import { v4 as uuidv4 } from 'uuid';
import { getAdapter } from '../driver.js';
import { parseJson, stringifyJson } from '../helpers/jsonCol.js';

// The settings a profile governs, in the order the keys page shows them. Every
// one of these is a column or a kv entry that a key already carries on its own,
// so adopting a profile is a copy onto the key and never a lookup at request
// time. Anything outside this list is the key's own business: a name, a machine
// id and an issue date do not belong to a reusable bundle.
export const GOVERNED_FIELDS = [
  'allowedModels',
  'maxPromptTokens',
  'maxCompletionTokens',
  'maxCostUsd',
  'budgetPolicy',
];

export class AccessProfileError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function normalizeName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 80)
    throw new AccessProfileError('A profile name of at most 80 characters is required.');
  return name;
}

// A ceiling is a non-negative finite number or nothing at all, matching
// apiKeysRepo. Anything else is a caller error rather than a silent no-ceiling,
// because a profile that quietly means "unlimited" is the wrong thing to hand
// several keys at once.
function normalizeLimit(value, integer = true) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0)
    throw new AccessProfileError(
      'A ceiling must be a non-negative number, or null for no ceiling.'
    );
  return integer ? Math.floor(n) : n;
}

function normalizeModels(value) {
  if (value === null || value === undefined || value === '') return null;
  if (!Array.isArray(value))
    throw new AccessProfileError(
      'allowedModels must be an array of model ids, or null for every model.'
    );
  const list = [
    ...new Set(value.map((m) => (typeof m === 'string' ? m.trim() : '')).filter(Boolean)),
  ];
  return list.length ? list : null;
}

// Days rather than a date. A bundle several keys adopt over months cannot carry
// an absolute stamp; each key's own expiresAt is computed from this at adoption.
function normalizeExpiryDays(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0)
    throw new AccessProfileError(
      'expiryDays must be a positive whole number of days, or null for no required expiry.'
    );
  return Math.floor(n);
}

function checkExpectedVersion(profile, expectedVersion, expectedName) {
  if (expectedName !== undefined && expectedName !== profile.name)
    throw new AccessProfileError('This profile was renamed. Refresh it before applying another change.', 409);
  if (expectedVersion === undefined) return;
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
    throw new AccessProfileError('expectedVersion must be a positive integer.');
  if (profile.version !== expectedVersion)
    throw new AccessProfileError('This profile changed. Refresh it before applying another change.', 409);
}

export function normalizeProfileSettings(input) {
  const source = input && typeof input === 'object' ? input : {};
  if (
    source.budgetPolicy !== undefined &&
    source.budgetPolicy !== null &&
    !['strict', 'reserve-remaining'].includes(source.budgetPolicy)
  ) {
    throw new AccessProfileError("budgetPolicy must be 'strict' or 'reserve-remaining'.");
  }
  return {
    allowedModels: normalizeModels(source.allowedModels),
    maxPromptTokens: normalizeLimit(source.maxPromptTokens),
    maxCompletionTokens: normalizeLimit(source.maxCompletionTokens),
    maxCostUsd: normalizeLimit(source.maxCostUsd, false),
    budgetPolicy: source.budgetPolicy ?? 'strict',
    expiryDays: normalizeExpiryDays(source.expiryDays),
  };
}

function versionRow(row) {
  if (!row) return null;
  return {
    version: row.version,
    allowedModels: parseJson(row.allowedModels, null),
    maxPromptTokens: row.maxPromptTokens ?? null,
    maxCompletionTokens: row.maxCompletionTokens ?? null,
    maxCostUsd: row.maxCostUsd ?? null,
    budgetPolicy: row.budgetPolicy ?? null,
    expiryDays: row.expiryDays ?? null,
    capturedAt: row.capturedAt,
  };
}

function insertVersion(db, profileId, version, settings, at) {
  db.run(
    `INSERT INTO accessProfileVersions(profileId, version, allowedModels, maxPromptTokens,
       maxCompletionTokens, maxCostUsd, budgetPolicy, expiryDays, capturedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      profileId,
      version,
      settings.allowedModels ? stringifyJson(settings.allowedModels) : null,
      settings.maxPromptTokens,
      settings.maxCompletionTokens,
      settings.maxCostUsd,
      settings.budgetPolicy,
      settings.expiryDays,
      at,
    ]
  );
}

export async function createAccessProfile(input) {
  const name = normalizeName(input?.name);
  const settings = normalizeProfileSettings(input);
  const db = await getAdapter();
  const at = new Date().toISOString();
  const id = uuidv4();
  let created = null;
  db.transaction(() => {
    if (db.get('SELECT id FROM accessProfiles WHERE name = ?', [name])) {
      throw new AccessProfileError('A profile with that name already exists.', 409);
    }
    db.run(
      'INSERT INTO accessProfiles(id, name, version, createdAt, updatedAt) VALUES(?, ?, 1, ?, ?)',
      [id, name, at, at]
    );
    insertVersion(db, id, 1, settings, at);
    created = { id, name, version: 1, createdAt: at, updatedAt: at, ...settings };
  });
  return created;
}

/**
 * Edit a profile. A change to any governed value mints a NEW version and leaves
 * every prior one in place; a rename alone does not, so a key does not read as
 * outdated because someone fixed a label. Keys already following the profile
 * are NOT rewritten — they keep the version they adopted and start reporting as
 * behind, which is the whole point of versioning the bundle.
 */
export async function updateAccessProfile(id, input) {
  const db = await getAdapter();
  const at = new Date().toISOString();
  let updated = null;
  db.transaction(() => {
    const profile = db.get('SELECT * FROM accessProfiles WHERE id = ?', [id]);
    if (!profile) throw new AccessProfileError('Profile not found.', 404);
    checkExpectedVersion(profile, input?.expectedVersion, input?.expectedName);
    const current = versionRow(
      db.get('SELECT * FROM accessProfileVersions WHERE profileId = ? AND version = ?', [
        id,
        profile.version,
      ])
    );
    const name = input?.name === undefined ? profile.name : normalizeName(input.name);
    const merged = normalizeProfileSettings({
      ...current,
      ...Object.fromEntries(
        Object.entries(input || {}).filter(([field]) =>
          [...GOVERNED_FIELDS, 'expiryDays'].includes(field)
        )
      ),
    });
    const changed = [...GOVERNED_FIELDS, 'expiryDays'].some(
      (field) => stringifyJson(merged[field] ?? null) !== stringifyJson(current?.[field] ?? null)
    );
    const version = changed ? profile.version + 1 : profile.version;
    if (changed) insertVersion(db, id, version, merged, at);
    if (
      name !== profile.name &&
      db.get('SELECT id FROM accessProfiles WHERE name = ? AND id != ?', [name, id])
    ) {
      throw new AccessProfileError('A profile with that name already exists.', 409);
    }
    db.run('UPDATE accessProfiles SET name = ?, version = ?, updatedAt = ? WHERE id = ?', [
      name,
      version,
      at,
      id,
    ]);
    updated = { id, name, version, createdAt: profile.createdAt, updatedAt: at, ...merged };
  });
  return updated;
}

export async function getAccessProfiles() {
  const db = await getAdapter();
  return db
    .all(
      `SELECT p.*, v.allowedModels, v.maxPromptTokens, v.maxCompletionTokens, v.maxCostUsd,
       v.budgetPolicy, v.expiryDays, v.capturedAt,
       (SELECT COUNT(*) FROM apiKeys k WHERE k.accessProfileId = p.id) AS keyCount
     FROM accessProfiles p JOIN accessProfileVersions v ON v.profileId = p.id AND v.version = p.version
     ORDER BY p.name ASC`
    )
    .map((row) => ({
      id: row.id,
      name: row.name,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      keyCount: row.keyCount,
      ...versionRow(row),
    }));
}

export async function deleteAccessProfile(id, expectedVersion, expectedName) {
  const db = await getAdapter();
  let deleted = false;
  db.transaction(() => {
    const profile = db.get('SELECT version, name FROM accessProfiles WHERE id = ?', [id]);
    if (!profile) return;
    checkExpectedVersion(profile, expectedVersion, expectedName);
    // A key keeps the settings it adopted. Deleting the bundle removes the
    // bundle, never the access it granted: silently loosening or tightening a
    // live key because someone tidied a list is the failure mode this avoids.
    db.run(
      'UPDATE apiKeys SET accessProfileId = NULL, accessProfileVersion = NULL, accessProfileAdoptedAt = NULL WHERE accessProfileId = ?',
      [id]
    );
    deleted = (db.run('DELETE FROM accessProfiles WHERE id = ?', [id])?.changes ?? 0) > 0;
    db.run('DELETE FROM accessProfileVersions WHERE profileId = ?', [id]);
  });
  return deleted;
}

/** The exact version a key adopted, not the profile's current one. */
export function adoptedVersion(db, profileId, version) {
  return versionRow(
    db.get('SELECT * FROM accessProfileVersions WHERE profileId = ? AND version = ?', [
      profileId,
      version,
    ])
  );
}

/**
 * Whether a key still matches the profile version it adopted, and whether that
 * version is still the profile's current one.
 *
 * The two are reported separately and never collapsed. "Someone edited this key
 * away from its profile" and "the profile moved on since this key adopted it"
 * call for different actions, and a single boolean would hide which happened.
 *
 * @returns {null|{profileId, profileName, adoptedVersion, currentVersion,
 *   behind: boolean, drifted: boolean, driftedFields: string[]}}
 */
export function profileComplianceFor(db, key) {
  if (!key?.accessProfileId) return null;
  const profile = db.get('SELECT id, name, version FROM accessProfiles WHERE id = ?', [
    key.accessProfileId,
  ]);
  // The profile is gone but the key still names it. Reported as unknown rather
  // than as compliant: an absent baseline cannot vouch for anything.
  if (!profile) {
    return {
      profileId: key.accessProfileId,
      profileName: null,
      adoptedVersion: key.accessProfileVersion ?? null,
      currentVersion: null,
      behind: false,
      drifted: false,
      driftedFields: [],
      baseline: 'unavailable',
    };
  }
  const adopted = adoptedVersion(db, profile.id, key.accessProfileVersion);
  if (!adopted) {
    return {
      profileId: profile.id,
      profileName: profile.name,
      adoptedVersion: key.accessProfileVersion ?? null,
      currentVersion: profile.version,
      behind: false,
      drifted: false,
      driftedFields: [],
      baseline: 'unavailable',
    };
  }
  const driftedFields = GOVERNED_FIELDS.filter(
    (field) => stringifyJson(key[field] ?? null) !== stringifyJson(adopted[field] ?? null)
  );
  return {
    profileId: profile.id,
    profileName: profile.name,
    adoptedVersion: adopted.version,
    currentVersion: profile.version,
    behind: adopted.version < profile.version,
    drifted: driftedFields.length > 0,
    driftedFields,
    baseline: 'adopted-version',
  };
}
