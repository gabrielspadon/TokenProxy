// Deliberate rotation. Issuing a new secret NEVER invalidates the old one on
// the spot: the old secret keeps working until an operator-chosen overlap
// window ends, so a client that has not been reconfigured yet keeps running
// rather than failing at the moment of rotation.
//
// The successor is a REAL KEY ROW, not a second column on the old one. It gets
// its own id, its own usage, its own budget account and its own device counts,
// which is what makes "the new one is live and the old one is quiet" readable
// before the window closes. The two are joined by a link row rather than by a
// column on either, so a key that has never rotated carries no rotation state
// at all.
export const KEY_ROTATION_COLUMNS = {
  // Set on the SUPERSEDED key when its successor is issued. The existing
  // expiresAt is what actually stops it (validateApiKey already enforces that
  // and needs no new branch); this column records that the expiry is a
  // rotation deadline rather than a lifetime the operator chose for its own
  // sake, so the UI can say why the date is there.
  supersededAt: 'TEXT',
};

export const KEY_ROTATION_TABLES = {
  apiKeyRotations: {
    columns: {
      // The successor. One row per rotation, keyed by the new key, so issuing a
      // second successor for the same predecessor is a second row rather than
      // an overwrite that would hide the first.
      successorKeyId: 'TEXT PRIMARY KEY',
      predecessorKeyId: 'TEXT NOT NULL',
      rotatedAt: 'TEXT NOT NULL',
      // The moment the old secret stops working, copied from the predecessor's
      // expiresAt at rotation time. Retained separately because an operator may
      // later shorten or extend that expiry by hand, and the difference between
      // "the window we agreed" and "the window in force" is worth seeing.
      overlapEndsAt: 'TEXT',
      overlapHours: 'INTEGER',
    },
    indexes: [
      'CREATE INDEX IF NOT EXISTS idx_akr_predecessor ON apiKeyRotations(predecessorKeyId)',
    ],
  },
};
