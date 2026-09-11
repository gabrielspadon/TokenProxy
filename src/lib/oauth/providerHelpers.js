const BASE64_BLOCK_SIZE = 4;

function validateXaiOAuthEndpoint(rawUrl, field) {
  const value = String(rawUrl || "").trim();
  if (!value) throw new Error(`xai discovery ${field} is empty`);
  let parsed;
  try { parsed = new URL(value); } catch (err) {
    throw new Error(`xai discovery ${field} is invalid: ${err.message}`);
  }
  if (parsed.protocol !== "https:") throw new Error(`xai discovery ${field} must use https: ${value}`);
  const host = parsed.hostname.toLowerCase().trim();
  if (host !== "x.ai" && !host.endsWith(".x.ai")) {
    throw new Error(`xai discovery ${field} host ${host} is not on x.ai`);
  }
  return value;
}

function decodeXaiIdTokenEmail(idToken) {
  if (!idToken || typeof idToken !== "string") return undefined;
  const parts = idToken.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = (BASE64_BLOCK_SIZE - (base64.length % BASE64_BLOCK_SIZE)) % BASE64_BLOCK_SIZE;
    const json = Buffer.from(base64 + "=".repeat(padding), "base64").toString("utf8");
    const payload = JSON.parse(json);
    return payload.email || payload.preferred_username || payload.sub || undefined;
  } catch {
    return undefined;
  }
}

function decodeJwtPayload(jwt) {
  try {
    if (!jwt || typeof jwt !== "string") return null;
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const missingPadding = (BASE64_BLOCK_SIZE - (base64.length % BASE64_BLOCK_SIZE)) % BASE64_BLOCK_SIZE;
    const padded = base64 + "=".repeat(missingPadding);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function extractEmailFromAccessToken(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return undefined;
  return payload.email || payload.preferred_username || payload.sub || undefined;
}

export async function fetchKiroProfileArn(accessToken) {
  if (!accessToken) return null;
  try {
    const response = await fetch("https://codewhisperer.us-east-1.amazonaws.com/ListAvailableProfiles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ maxResults: 10 }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.profiles?.find((p) => p.arn?.trim())?.arn?.trim() || null;
  } catch {
    return null;
  }
}

export function extractCodexAccountInfo(idToken) {
  const payload = decodeJwtPayload(idToken);
  if (!payload) return {};
  const chatgpt = payload["https://api.openai.com/auth"] || {};
  return {
    email: payload.email,
    chatgptAccountId: chatgpt.chatgpt_account_id || payload.account_id,
    chatgptPlanType: chatgpt.chatgpt_plan_type || payload.plan_type,
  };
}

// -- Account identity --------------------------------------------------------
// Who a connection actually belongs to, as opposed to what someone typed into
// the name box. Every OAuth provider answers this in its own vocabulary, so the
// shape below is the one thing the rest of the app reads:
//
//   { accountId, email, plan, organizationId, organizationName, organizationRole }
//
// accountId is the UPSTREAM subject, and it is the field that matters most:
// two seats of one login (a personal seat and an organisation seat) share an
// email and hold independent quota windows, so email alone cannot tell them
// apart and must never be used to merge them.
//
// Everything here is non-secret identity. A token, an id_token and a refresh
// token are secrets, and none of them belongs in this object.
const IDENTITY_FIELDS = [
  "accountId", "email", "plan",
  "organizationId", "organizationName", "organizationRole",
];

function cleanIdentityValue(value) {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Drop empty members so a caller can spread the result without writing nulls. */
export function normalizeAccountIdentity(identity) {
  const out = {};
  for (const field of IDENTITY_FIELDS) {
    const value = cleanIdentityValue(identity?.[field]);
    if (value !== undefined) out[field] = value;
  }
  return out;
}

/**
 * Identity out of an Anthropic OAuth token response.
 *
 * The token endpoint answers with `account {uuid, email_address}` and
 * `organization {uuid, name}` beside the token, and mapTokens used to keep only
 * the four token fields and drop both objects - which is why every Claude row
 * on this install carries a null email and no upstream account id.
 *
 * The same values are what Claude Code itself persists as `oauthAccount`
 * (accountUuid / emailAddress / organizationUuid / organizationName /
 * organizationRole), so an auth file exported from that client folds in here
 * too. Both spellings are accepted: snake_case from the wire, camelCase from an
 * exported file.
 */
export function extractClaudeAccountInfo(tokens) {
  if (!tokens || typeof tokens !== "object") return {};
  const account = tokens.account || {};
  const organization = tokens.organization || {};
  return normalizeAccountIdentity({
    accountId: account.uuid || account.account_uuid || tokens.accountUuid,
    email: account.email_address || account.email || tokens.emailAddress,
    // The token response carries no plan field; the usage endpoint is what
    // knows it, so this stays undefined here rather than guessing one.
    organizationId: organization.uuid || tokens.organizationUuid,
    organizationName: organization.name || tokens.organizationName,
    organizationRole: organization.role || tokens.organizationRole,
  });
}

/**
 * Identity out of a Kimi access token.
 *
 * Kimi's device flow returns no id_token and exposes no profile endpoint, but
 * its access token is a JWT whose payload carries `user_id` and `sub`. That is
 * a stable upstream subject, so the row stops being anonymous even though no
 * email is available anywhere in the flow.
 */
export function extractKimiAccountInfo(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return {};
  return normalizeAccountIdentity({
    accountId: payload.user_id || payload.sub,
    email: payload.email,
  });
}

/**
 * The label a connection shows when nobody has typed one.
 *
 * PRECEDENCE, in order, and it is the whole point of this function:
 *   1. a name the USER set - always wins, and is never recomputed
 *   2. the account email
 *   3. the organisation name, for a seat that has one but no email
 *   4. the upstream account id, shortened
 *   5. "<provider> <id prefix>", which always exists
 *
 * Two seats of one login resolve to the same email at step 2, so an
 * organisation seat is qualified with its organisationName. That keeps a
 * personal seat and an org seat visibly different without merging them.
 */
export function deriveAccountDisplayName({ userName, identity, providerLabel = "Account", connectionId } = {}) {
  const typed = typeof userName === "string" ? userName.trim() : "";
  if (typed) return typed;

  const id = normalizeAccountIdentity(identity);
  if (id.email) return id.organizationName ? `${id.email} (${id.organizationName})` : id.email;
  if (id.organizationName) return id.organizationName;
  if (id.accountId) return `${providerLabel} ${id.accountId.slice(0, 8)}`;
  // A row with no identity at all still needs a label that is stable across
  // restarts and unique per connection, or the list shows several rows reading
  // "Account" with nothing to tell them apart.
  const suffix = typeof connectionId === "string" && connectionId ? connectionId.slice(0, 8) : "";
  return suffix ? `${providerLabel} ${suffix}` : providerLabel;
}

export {
  BASE64_BLOCK_SIZE,
  IDENTITY_FIELDS,
  validateXaiOAuthEndpoint,
  decodeXaiIdTokenEmail,
  decodeJwtPayload,
  extractEmailFromAccessToken,
};
