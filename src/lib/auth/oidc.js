import crypto from "node:crypto";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { getSettings } from "@/lib/localDb";
import { assertPublicUrl, fetchPublicUrl } from "@/shared/utils/ssrfGuard.js";

export const OIDC_COOKIE_NAMES = {
  state: "oidc_state",
  nonce: "oidc_nonce",
  verifier: "oidc_code_verifier",
};

const DEFAULT_SCOPES = "openid profile email";
const DEFAULT_LOGIN_LABEL = "Sign in with OIDC";

function trimTrailingSlashes(value) {
  return (value || "").trim().replace(/\/+$/, "");
}

function safeProviderMessage(message, secret, fallback) {
  const text = typeof message === "string" ? message : "";
  if (secret && text.includes(secret)) return `${fallback} [REDACTED]`;
  return text || fallback;
}

// OIDC Core 1.0 section 3.1.2.1 makes "openid" the value that marks an
// authorization request as an OIDC one. Drop it and a compliant provider runs a
// plain OAuth2 flow and issues no id_token, which the callback then rejects with
// "OIDC provider did not return an id_token" (#3642) after the user has already
// round-tripped through the IdP. The scope box in settings accepts any string,
// so an admin who trims it to "profile email" hits exactly that. This flow
// cannot work without an id_token, so put openid back instead of failing later.
export function normalizeScopes(value) {
  const scopes = ((value || "").trim() || DEFAULT_SCOPES).split(/\s+/).filter(Boolean);
  if (!scopes.includes("openid")) scopes.unshift("openid");
  return scopes.join(" ");
}

export function getPublicOrigin(request) {
  const configuredBaseUrl =
    process.env.BASE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    "";

  if (configuredBaseUrl) {
    return trimTrailingSlashes(configuredBaseUrl);
  }

  const forwardedProto = request?.headers?.get?.("x-forwarded-proto") || "";
  const forwardedHost = request?.headers?.get?.("x-forwarded-host") || "";
  const host = forwardedHost || request?.headers?.get?.("host") || "";
  if (host) {
    const protocol = (forwardedProto || new URL(request.url).protocol || "http:").replace(/:$/, "");
    return `${protocol}://${host}`.replace(/\/+$/, "");
  }

  return trimTrailingSlashes(new URL(request.url).origin);
}

export function isOidcConfigured(settings) {
  return !!(
    trimTrailingSlashes(settings?.oidcIssuerUrl) &&
    (settings?.oidcClientId || "").trim() &&
    (settings?.oidcClientSecret || "").trim()
  );
}

export function isOidcAuthMode(authMode) {
  return ["sso", "oidc", "both"].includes(authMode);
}

export async function getOidcRuntimeConfig() {
  const settings = await getSettings();
  if (!isOidcAuthMode(settings.authMode) || !isOidcConfigured(settings)) return null;

  const issuerUrl = trimTrailingSlashes(settings.oidcIssuerUrl);
  return {
    issuerUrl,
    clientId: settings.oidcClientId.trim(),
    clientSecret: settings.oidcClientSecret.trim(),
    scopes: normalizeScopes(settings.oidcScopes),
    loginLabel: (settings.oidcLoginLabel || DEFAULT_LOGIN_LABEL).trim() || DEFAULT_LOGIN_LABEL,
  };
}

export async function fetchOidcDiscovery(issuerUrl) {
  const trimmed = trimTrailingSlashes(issuerUrl);
  assertPublicUrl(trimmed);
  const discoveryUrl = `${trimmed}/.well-known/openid-configuration`;
  // Discovery is credential-free and may follow public redirects used by
  // enterprise IdP front doors. The dispatcher validates every resolved and
  // redirected socket address, so a DNS change cannot cross into a private net.
  const res = await fetchPublicUrl(discoveryUrl, { cache: "no-store", redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Failed to load OIDC discovery document from ${discoveryUrl}`);
  }
  return await res.json();
}

export function createPkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function createOidcState() {
  return crypto.randomBytes(16).toString("base64url");
}

export function createOidcNonce() {
  return crypto.randomBytes(16).toString("base64url");
}

export function buildOidcAuthorizationUrl({
  authorizationEndpoint,
  clientId,
  redirectUri,
  scopes = DEFAULT_SCOPES,
  state,
  nonce,
  codeChallenge,
}) {
  const url = new URL(authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", normalizeScopes(scopes));
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeOidcCode({
  tokenEndpoint,
  clientId,
  clientSecret,
  code,
  redirectUri,
  codeVerifier,
}) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }

  // The request body contains the client secret. Never replay it through a
  // 307/308 redirect. Administrators must configure the IdP's final public
  // token endpoint, while direct enterprise IdP endpoints remain supported.
  const res = await fetchPublicUrl(tokenEndpoint, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = safeProviderMessage(
      data?.error_description || data?.error,
      clientSecret,
      `OIDC token exchange failed (${res.status})`,
    );
    throw new Error(message);
  }

  return data;
}

export async function probeOidcClientSecret({
  tokenEndpoint,
  clientId,
  clientSecret,
  redirectUri,
}) {
  if (!clientSecret) {
    return {
      tested: false,
      valid: null,
      message: "No client secret was provided, so secret validation was skipped.",
    };
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code: "__oidc_test_invalid_code__",
    redirect_uri: redirectUri,
    code_verifier: "__oidc_test_invalid_verifier__",
  });

  const res = await fetchPublicUrl(tokenEndpoint, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await res.json().catch(() => ({}));
  const error = (data?.error || "").toLowerCase();
  const errorDescription = data?.error_description || data?.error || "";
  const safeDescription = safeProviderMessage(errorDescription, clientSecret, "OIDC token endpoint response contained credential material.");

  if (res.ok) {
    return {
      tested: true,
      valid: true,
      message: "Client secret was accepted by the token endpoint.",
    };
  }

  if (error === "invalid_client" || error === "unauthorized_client" || /client.*(invalid|failed|mismatch)/i.test(errorDescription)) {
    return {
      tested: true,
      valid: false,
      message: safeDescription || "Client secret is not valid.",
    };
  }

  if (error === "invalid_grant" || error === "invalid_code" || /grant|code/i.test(errorDescription)) {
    return {
      tested: true,
      valid: true,
      message: "Client secret was accepted; the token exchange failed only because the test authorization code is invalid.",
    };
  }

  return {
    tested: true,
    valid: null,
    message: safeDescription || `Token endpoint responded with ${res.status}`,
  };
}

export async function verifyOidcIdToken({
  idToken,
  issuer,
  audience,
  jwksUri,
  nonce,
}) {
  assertPublicUrl(jwksUri);
  // jose deliberately uses redirect:"manual" for remote JWKS. Its custom
  // fetch still needs our dispatcher so DNS rebinding cannot reach a private
  // address after the initial URL-string check.
  const jwks = createRemoteJWKSet(new URL(jwksUri), { [customFetch]: fetchPublicUrl });
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer,
    audience,
    nonce,
  });
  return payload;
}

export function pickOidcDisplayName(payload = {}) {
  return payload.preferred_username || payload.email || payload.name || payload.given_name || payload.sub || "OIDC user";
}

export function pickOidcEmail(payload = {}) {
  return payload.email || "";
}
