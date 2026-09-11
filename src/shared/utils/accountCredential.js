/**
 * Does this connection hold a credential it could authenticate with?
 *
 * One rule, two readers. The gateway asks before it spends a cascade slot on an
 * upstream 401 (src/sse/services/auth.js:527), and the dashboard API asks so
 * the board can say "no credential" about a row that cannot answer instead of
 * "Paused", which claims an operator decision that never happened.
 *
 * The board never sees the secret: /api/providers strips apiKey, accessToken,
 * refreshToken and idToken before the response leaves (redactConnectionSecrets
 * in src/lib/providerNormalization.js). So the ANSWER travels to the client as
 * a derived boolean and the token does not travel at all, which is also why
 * this predicate must not be re-implemented against a redacted row: every OAuth
 * account would read as credential-less.
 *
 * Cookie, public and credential-free providers keep their access elsewhere, so
 * only the two credential-bearing auth types are judged.
 */
export function holdsCredential(connection) {
  const type = connection.authType;
  if (type === 'apikey' || type === 'api_key') return Boolean(connection.apiKey);
  if (type === 'oauth' || type === 'access_token')
    return Boolean(connection.accessToken || connection.refreshToken);
  return true;
}
