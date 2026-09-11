/**
 * OAuth identity capture, and the naming that falls out of it.
 *
 * The defect: Claude OAuth connections stored no identity at all — every row on
 * the reference install carried a null email and no upstream account id, while
 * every other provider stored something. The typed name was therefore the ONLY
 * identity a Claude row had, so the dashboard could not tell two seats of one
 * login apart and the operator had to hand-type every label.
 *
 * The domain fact these tests defend: two connections sharing one login email
 * are frequently DIFFERENT upstream seats (a personal seat and an organisation
 * seat) with independent quota windows. Captured identity must keep them
 * distinguishable and must never merge them.
 *
 * NO REAL CREDENTIAL APPEARS HERE. The JWT-shaped strings below are built from
 * dummy claims by jwt() — base64url of a JSON object this file wrote, with a
 * literal "sig" where a signature would be. Nothing is decrypted and nothing is
 * read from the live database.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  deriveAccountDisplayName,
  extractClaudeAccountInfo,
  extractKimiAccountInfo,
  normalizeAccountIdentity,
} from '@/lib/oauth/providerHelpers.js';
import claude from '@/lib/oauth/providers/claude.js';
import kimi from '@/lib/oauth/providers/kimi.js';

/** A JWT-shaped string over dummy claims. Not a token; never was one. */
function jwt(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.sig`;
}

// The shape Anthropic's token endpoint answers with, filled with dummy values.
function claudeTokenResponse(overrides = {}) {
  return {
    token_type: 'Bearer',
    access_token: 'dummy-access-value',
    refresh_token: 'dummy-refresh-value',
    expires_in: 28800,
    scope: 'user:inference user:profile',
    account: { uuid: 'acct-personal-1', email_address: 'person@example.test' },
    organization: { uuid: 'org-1', name: 'Example Lab' },
    ...overrides,
  };
}

describe('extractClaudeAccountInfo', () => {
  it('captures the account and organisation the token response carries', () => {
    expect(extractClaudeAccountInfo(claudeTokenResponse())).toEqual({
      accountId: 'acct-personal-1',
      email: 'person@example.test',
      organizationId: 'org-1',
      organizationName: 'Example Lab',
    });
  });

  it('reads the camelCase spelling an exported Claude Code auth file uses', () => {
    const identity = extractClaudeAccountInfo({
      accountUuid: 'acct-2',
      emailAddress: 'other@example.test',
      organizationUuid: 'org-2',
      organizationName: 'Second Org',
      organizationRole: 'admin',
    });
    expect(identity.accountId).toBe('acct-2');
    expect(identity.email).toBe('other@example.test');
    expect(identity.organizationRole).toBe('admin');
  });

  it('returns an empty object rather than throwing on a response with no identity', () => {
    expect(extractClaudeAccountInfo({ access_token: 'dummy' })).toEqual({});
    expect(extractClaudeAccountInfo(null)).toEqual({});
    expect(extractClaudeAccountInfo('not-an-object')).toEqual({});
  });
});

describe('claude.mapTokens', () => {
  it('persists identity beside the credential instead of dropping it', () => {
    const mapped = claude.mapTokens(claudeTokenResponse());
    expect(mapped.email).toBe('person@example.test');
    expect(mapped.providerSpecificData).toMatchObject({
      accountId: 'acct-personal-1',
      organizationId: 'org-1',
      organizationName: 'Example Lab',
    });
  });

  it('still maps a response that carries no identity, leaving email unset', () => {
    const mapped = claude.mapTokens({ access_token: 'a', refresh_token: 'r', expires_in: 10 });
    expect(mapped.accessToken).toBe('a');
    expect(mapped).not.toHaveProperty('email');
    expect(mapped).not.toHaveProperty('providerSpecificData');
  });

  it('keeps two seats of one login distinguishable by account id', () => {
    const personal = claude.mapTokens(claudeTokenResponse());
    const org = claude.mapTokens(
      claudeTokenResponse({
        account: { uuid: 'acct-org-9', email_address: 'person@example.test' },
        organization: { uuid: 'org-9', name: 'MAPS Lab' },
      })
    );
    // Same login, genuinely different upstream seats.
    expect(org.email).toBe(personal.email);
    expect(org.providerSpecificData.accountId).not.toBe(personal.providerSpecificData.accountId);
  });
});

describe('extractKimiAccountInfo', () => {
  it('recovers the upstream subject from the access token claims', () => {
    const info = extractKimiAccountInfo(jwt({ user_id: 'kimi-user-7', sub: 'sub-7' }));
    expect(info.accountId).toBe('kimi-user-7');
  });

  it('falls back to sub, and yields nothing for a non-JWT token', () => {
    expect(extractKimiAccountInfo(jwt({ sub: 'sub-only' })).accountId).toBe('sub-only');
    expect(extractKimiAccountInfo('sk-ant-oat-style-opaque-string')).toEqual({});
    expect(extractKimiAccountInfo(undefined)).toEqual({});
  });
});

describe('kimi.mapTokens', () => {
  it('records the subject without inventing an email the flow never returns', () => {
    const mapped = kimi.mapTokens({
      access_token: jwt({ user_id: 'kimi-user-7' }),
      refresh_token: 'dummy-refresh',
      expires_in: 3600,
      _kimiDeviceId: 'device-1',
    });
    expect(mapped.providerSpecificData.accountId).toBe('kimi-user-7');
    expect(mapped.providerSpecificData.deviceId).toBe('device-1');
    expect(mapped.providerSpecificData).not.toHaveProperty('email');
  });
});

describe('normalizeAccountIdentity', () => {
  it('drops empty members so a caller can spread it without writing nulls', () => {
    expect(
      normalizeAccountIdentity({
        accountId: '  a  ',
        email: '',
        plan: null,
        organizationId: undefined,
      })
    ).toEqual({ accountId: 'a' });
  });

  it('keeps a numeric id as a string and ignores unknown keys', () => {
    expect(normalizeAccountIdentity({ accountId: 12345, secretish: 'nope' })).toEqual({
      accountId: '12345',
    });
  });
});

describe('deriveAccountDisplayName precedence', () => {
  const identity = { email: 'person@example.test', accountId: 'acct-1' };

  it('1. a user-set name always wins', () => {
    expect(
      deriveAccountDisplayName({ userName: 'My Work Seat', identity, providerLabel: 'claude' })
    ).toBe('My Work Seat');
  });

  it('1b. a whitespace-only name is not a user-set name', () => {
    expect(deriveAccountDisplayName({ userName: '   ', identity, providerLabel: 'claude' })).toBe(
      'person@example.test'
    );
  });

  it('2. the email fills in when nobody typed a name', () => {
    expect(deriveAccountDisplayName({ identity, providerLabel: 'claude' })).toBe(
      'person@example.test'
    );
  });

  it('2b. an organisation seat is qualified so it differs from the personal seat', () => {
    const personal = deriveAccountDisplayName({ identity, providerLabel: 'claude' });
    const org = deriveAccountDisplayName({
      identity: { ...identity, accountId: 'acct-2', organizationName: 'MAPS Lab' },
      providerLabel: 'claude',
    });
    expect(org).toBe('person@example.test (MAPS Lab)');
    expect(org).not.toBe(personal);
  });

  it('3. the organisation name carries a seat that has no email', () => {
    expect(
      deriveAccountDisplayName({
        identity: { organizationName: 'MAPS Lab' },
        providerLabel: 'claude',
      })
    ).toBe('MAPS Lab');
  });

  it('4. the account id, shortened, when that is all there is', () => {
    expect(
      deriveAccountDisplayName({
        identity: { accountId: 'abcdef0123456789' },
        providerLabel: 'claude',
      })
    ).toBe('claude abcdef01');
  });

  it('5. a stable fallback exists when the provider returns nothing', () => {
    expect(
      deriveAccountDisplayName({
        identity: {},
        providerLabel: 'claude',
        connectionId: 'uuid-1234-rest',
      })
    ).toBe('claude uuid-123');
    // Deterministic: the same inputs never produce a different label.
    expect(
      deriveAccountDisplayName({ providerLabel: 'claude', connectionId: 'uuid-1234-rest' })
    ).toBe('claude uuid-123');
  });
});

// ─── Persistence: identity reaches columns, and seats stay separate ──────────
describe('connection identity persistence', () => {
  const originalDataDir = process.env.DATA_DIR;
  let dataDir;
  let repo;
  let getAdapter;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'tokenproxy-oauth-identity-'));
    process.env.DATA_DIR = dataDir;
    global._dbAdapter = { instance: null, initPromise: null, logged: false };
    const dbMod = await import('@/lib/db/index.js');
    await dbMod.initDb();
    repo = await import('@/lib/db/repos/connectionsRepo.js');
    ({ getAdapter } = await import('@/lib/db/driver.js'));
  });

  afterAll(() => {
    delete global._dbAdapter;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  beforeEach(async () => {
    for (const conn of await repo.getProviderConnections()) {
      await repo.deleteProviderConnection(conn.id);
    }
  });

  const claudeLogin = (overrides = {}) => ({
    provider: 'claude',
    authType: 'oauth',
    accessToken: 'dummy-access',
    refreshToken: 'dummy-refresh',
    ...overrides,
  });

  it('writes identity into queryable columns, not only the encrypted blob', async () => {
    const conn = await repo.createProviderConnection(
      claudeLogin({
        email: 'person@example.test',
        providerSpecificData: { accountId: 'acct-1', organizationId: 'org-1', plan: 'max' },
      })
    );
    const db = await getAdapter();
    const row = db.get(
      'SELECT accountId, plan, organizationId FROM providerConnections WHERE id = ?',
      [conn.id]
    );
    expect(row).toEqual({ accountId: 'acct-1', plan: 'max', organizationId: 'org-1' });
  });

  it('names a new account from captured identity with nobody typing', async () => {
    const conn = await repo.createProviderConnection(
      claudeLogin({
        email: 'person@example.test',
        providerSpecificData: { accountId: 'acct-1', organizationName: 'MAPS Lab' },
      })
    );
    expect(conn.name).toBe('person@example.test (MAPS Lab)');
  });

  it('keeps a name the user set, and never recomputes it from identity', async () => {
    const conn = await repo.createProviderConnection(
      claudeLogin({
        name: 'My Work Seat',
        email: 'person@example.test',
        providerSpecificData: { accountId: 'acct-1', organizationName: 'MAPS Lab' },
      })
    );
    expect(conn.name).toBe('My Work Seat');
  });

  it('keeps a personal seat and an org seat of ONE login as two rows', async () => {
    const personal = await repo.createProviderConnection(
      claudeLogin({
        email: 'person@example.test',
        providerSpecificData: { accountId: 'acct-personal' },
      })
    );
    const org = await repo.createProviderConnection(
      claudeLogin({
        email: 'person@example.test',
        providerSpecificData: { accountId: 'acct-org', organizationName: 'MAPS Lab' },
      })
    );

    expect(org.id).not.toBe(personal.id);
    const all = await repo.getProviderConnections({ provider: 'claude' });
    expect(all).toHaveLength(2);
    // The thing that makes them addressable apart: distinct upstream ids, and
    // labels that differ even though the login email is identical.
    const db = await getAdapter();
    const ids = db
      .all('SELECT accountId FROM providerConnections WHERE provider = ? ORDER BY accountId', [
        'claude',
      ])
      .map((r) => r.accountId);
    expect(ids).toEqual(['acct-org', 'acct-personal']);
    expect(org.name).not.toBe(personal.name);
  });

  it('falls back to a stable label when the provider returned no identity', async () => {
    const conn = await repo.createProviderConnection(claudeLogin());
    expect(conn.name).toBeTruthy();
    // Re-reading gives the same label; it is stored, not recomputed per render.
    const read = await repo.getProviderConnectionById(conn.id);
    expect(read.name).toBe(conn.name);
  });
});
