// Promote captured OAuth identity out of the encrypted blob and into columns.
//
// Until now the only identity a connection carried at COLUMN level was `email`,
// and for Claude even that was null on every row (17 of 17 on the install this
// was written against) because the provider dropped the identity the token
// response hands it. Everything else lived inside the AES-GCM `data` blob,
// which no SQL predicate can reach: the dashboard could not group two seats of
// one login, and no query could answer "which rows have no identity at all".
//
// The three columns below are NON-SECRET identity. A token, an id_token and a
// refresh token stay in the encrypted blob and never move here.
//
// accountId is the load-bearing one. Two connections sharing one login email
// are frequently DIFFERENT upstream seats (a personal seat and an organisation
// seat) with independent quota windows, so the account id is what tells them
// apart. It is deliberately NOT unique: making it so would merge exactly the
// rows that must stay separate.
import { decryptSecretJson } from '../helpers/secretCol.js';

const COLUMNS = {
  accountId: 'TEXT',
  plan: 'TEXT',
  organizationId: 'TEXT',
};

// Same fold as connectionsRepo.connectionIdentity: a codex row spells these
// chatgptAccountId / chatgptPlanType, everything newer uses the shared names.
function identityOf(data) {
  const psd =
    data?.providerSpecificData && typeof data.providerSpecificData === 'object'
      ? data.providerSpecificData
      : {};
  const pick = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  return {
    accountId: pick(psd.accountId) || pick(psd.chatgptAccountId),
    plan: pick(psd.plan) || pick(psd.chatgptPlanType),
    organizationId: pick(psd.organizationId),
  };
}

const migration = {
  version: 3,
  name: 'connection-identity',
  up(db) {
    // A database seeded at an older schemaVersion may not hold this table yet:
    // the runner skips migration 001 whenever _meta already names a version,
    // and the additive sync in migrate.js creates the table afterwards with
    // every column below already declared. Nothing to promote in that case, so
    // return rather than failing a migration that has no rows to touch.
    const existing = new Set(
      db.all('PRAGMA table_info(providerConnections)').map((row) => row.name)
    );
    if (!existing.size) return;

    for (const [name, type] of Object.entries(COLUMNS)) {
      if (!existing.has(name)) {
        db.exec(`ALTER TABLE providerConnections ADD COLUMN ${name} ${type}`);
      }
    }
    // Not unique, and that is the point: see the header. This index exists so
    // "find the row for this upstream account" is a lookup rather than a scan
    // over every decrypted blob.
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_pc_account ON providerConnections(provider, accountId)'
    );

    // Backfill from what is already stored. The blob is encrypted, so this goes
    // through the application's own decrypt helper rather than parsing JSON;
    // a row that cannot be decrypted is skipped, never failed on, because one
    // unreadable row must not block the schema change for every other row.
    for (const row of db.all('SELECT id, data FROM providerConnections')) {
      const data = decryptSecretJson(row.data, null);
      if (!data) continue;
      const { accountId, plan, organizationId } = identityOf(data);
      if (!accountId && !plan && !organizationId) continue;
      db.run(
        `UPDATE providerConnections
            SET accountId = COALESCE(accountId, ?),
                plan = COALESCE(plan, ?),
                organizationId = COALESCE(organizationId, ?)
          WHERE id = ?`,
        [accountId, plan, organizationId, row.id]
      );
    }
  },
};

export default migration;
