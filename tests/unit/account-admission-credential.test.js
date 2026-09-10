import { describe, expect, it } from 'vitest';
import { accountAdmissionReason, holdsCredential } from '@/sse/services/accountAdmissionPolicy.js';

const now = Date.parse('2026-09-10T12:00:00.000Z');
const base = { id: 'a', provider: 'claude', isActive: true };

describe('credential presence', () => {
  it('reads an OAuth account with neither an access token nor a refresh token as empty', () => {
    expect(holdsCredential({ ...base, authType: 'oauth' })).toBe(false);
    expect(holdsCredential({ ...base, authType: 'access_token' })).toBe(false);
  });
  it('reads a refreshable or presentable OAuth account and a keyed API-key account as held', () => {
    expect(holdsCredential({ ...base, authType: 'oauth', refreshToken: 'r' })).toBe(true);
    expect(holdsCredential({ ...base, authType: 'oauth', accessToken: 't' })).toBe(true);
    expect(holdsCredential({ ...base, authType: 'apikey', apiKey: 'k' })).toBe(true);
    expect(holdsCredential({ ...base, authType: 'api_key' })).toBe(false);
  });
  it('leaves cookie, public, credential-free and untyped accounts to their own gates', () => {
    expect(holdsCredential({ ...base, authType: 'cookie' })).toBe(true);
    expect(holdsCredential({ ...base, authType: 'none' })).toBe(true);
    expect(holdsCredential({ ...base })).toBe(true);
  });
  it('is a live-selection gate, not an admission reason the simulator would echo', () => {
    expect(accountAdmissionReason({ ...base, authType: 'oauth' }, { model: 'claude-opus-5', now })).toBeNull();
  });
});
