// Additive access-profile state. A profile is a NAMED, VERSIONED bundle of the
// access settings a key can already carry one at a time. Adopting one copies
// its values onto the key; it does not make the key read through the profile at
// request time. That is deliberate: the gateway's auth path stays a single
// indexed row read on apiKeys, and revoking or editing a profile can never
// silently widen or narrow what an already-issued key may do.
//
// The cost of copying is drift, so drift is made VISIBLE rather than prevented.
// Every version a key could be following is retained, so "this key no longer
// matches the profile it follows" is answered against the exact version it
// adopted rather than against whatever the profile says today.
export const ACCESS_PROFILE_KEY_COLUMNS = {
  accessProfileId: 'TEXT',
  // The version adopted, NOT the profile's current version. A profile that has
  // moved on since is a separate, weaker signal than a key someone edited by
  // hand, and collapsing the two would hide the edit.
  accessProfileVersion: 'INTEGER',
  accessProfileAdoptedAt: 'TEXT',
};

export const ACCESS_PROFILE_TABLES = {
  accessProfiles: {
    columns: {
      id: 'TEXT PRIMARY KEY',
      name: 'TEXT NOT NULL',
      // Monotonic per profile. Bumped by any edit that changes a governed
      // value, and left alone by a rename, so a key does not read as outdated
      // because someone fixed a typo in the label.
      version: 'INTEGER NOT NULL DEFAULT 1',
      createdAt: 'TEXT NOT NULL',
      updatedAt: 'TEXT NOT NULL',
    },
    indexes: ['CREATE UNIQUE INDEX IF NOT EXISTS idx_ap_name ON accessProfiles(name)'],
  },
  // One row per version, including the current one, so a key pinned to v2 is
  // still comparable after the profile reaches v7. Values live here rather than
  // on accessProfiles precisely so history cannot be overwritten by an edit.
  accessProfileVersions: {
    columns: {
      profileId: 'TEXT NOT NULL',
      version: 'INTEGER NOT NULL',
      // NULL means every model, matching the key column it is copied onto.
      allowedModels: 'TEXT',
      // NULL in any of these means no ceiling, again matching the key.
      maxPromptTokens: 'INTEGER',
      maxCompletionTokens: 'INTEGER',
      maxCostUsd: 'REAL',
      budgetPolicy: 'TEXT',
      // Expiry is a POLICY, not a stamp: a bundle cannot carry an absolute date
      // that would already be past for the next key to adopt it. NULL means the
      // profile does not require an expiry, which is not the same as requiring
      // that there is none.
      expiryDays: 'INTEGER',
      capturedAt: 'TEXT NOT NULL',
    },
    primaryKey: 'PRIMARY KEY (profileId, version)',
  },
};
