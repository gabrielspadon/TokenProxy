import { NextResponse } from "next/server";
import { getSettings, validateApiKey } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";
import { hasTrustedPeerHeaders } from "@/lib/auth/trustedPeer";
import { collectClientApiKeyCandidates, resolveClientApiKey } from "@/lib/auth/clientApiKey";
import {
  ADMIN_ERROR_SOURCE,
  adminAuthClass,
  adminDecision,
  isAdminMutation,
  isAdminPath,
} from "@/lib/admin/policy.js";
import { logAdminAuthz } from "@/lib/admin/authzLog.js";

// A 401 from the gateway itself and a 401 relayed from an upstream provider
// rendered identically in clients, so users could not tell whether to sign in
// to TokenProxy or to fix a provider credential (#1160). Tag the ones TokenProxy
// raises; an upstream body passes through untouched and carries no such field.
const GATEWAY_ERROR_SOURCE = "tokenproxy";


const CLI_TOKEN_HEADER = "x-tp-cli-token";
const CLI_TOKEN_SALT = "tp-cli-auth";

let cachedCliToken = null;
async function getCliToken() {
  if (!cachedCliToken)
    cachedCliToken = await getConsistentMachineId(CLI_TOKEN_SALT);
  return cachedCliToken;
}

export async function hasValidCliToken(request) {
  const token = request.headers.get(CLI_TOKEN_HEADER);
  if (!token) return false;
  return token === (await getCliToken());
}

// Public API paths — no auth required (LLM API has its own key auth inside handler).
const PUBLIC_API_PATHS = [
  "/api/health",
  "/api/init",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/status",
  "/api/auth/oidc",
  "/api/auth/saml",
  "/api/version",
  "/api/settings/require-login",
];

// Public top-level prefixes (LLM API endpoints with their own API key auth).
const PUBLIC_PREFIXES = ["/v1", "/v1beta", "/api/v1", "/api/v1beta", "/codex"];

// The frozen admin ABI (docs/reconciliation/admin-abi.json). Deliberately NOT
// in PUBLIC_API_PATHS or PUBLIC_PREFIXES: every operation under it is gated,
// and the two inference-class reads (/api/admin/health, /api/admin/models)
// still require an inference key or a loopback origin rather than being open.
//
// It gets its own gate rather than an ALWAYS_PROTECTED entry because that list
// is one verdict for one shape of route, and this prefix carries two auth
// classes and a loopback binding on mutations. What it DOES take from
// ALWAYS_PROTECTED is the part that matters: requireLogin=false is not identity
// here either, so an open dashboard never confers operator rights over drain,
// activation or rollback.
const ADMIN_API_PREFIX = "/api/admin";

// Fail closed at import rather than trusting review: an entry added to either
// public list that would expose the admin prefix takes the whole middleware
// down instead of silently opening 16 operator endpoints.
if (
  PUBLIC_API_PATHS.some((p) => p === ADMIN_API_PREFIX || p.startsWith(`${ADMIN_API_PREFIX}/`)) ||
  PUBLIC_PREFIXES.some((p) => ADMIN_API_PREFIX === p || ADMIN_API_PREFIX.startsWith(`${p}/`))
) {
  throw new Error("dashboardGuard: the admin ABI prefix must never be public.");
}


// Always require JWT token regardless of requireLogin setting
const ALWAYS_PROTECTED = [
  "/api/keys",
  "/api/shutdown",
  "/api/settings/database",
  "/api/version/shutdown",
  "/api/version/update",
];

// Require auth, but allow through if requireLogin is disabled
const PROTECTED_API_PATHS = [
  "/api/settings",
  "/api/providers",
  "/api/provider-nodes",
  "/api/proxy-pools",
  "/api/combos",
  "/api/models",
  "/api/usage",
  "/api/analytics",
  "/api/oauth",
  "/api/cloud",
  "/api/media-providers",
  "/api/pricing",
  "/api/tags",
  "/api/mcp",
  "/api/translator",
  "/api/tunnel",
];

// Routes that spawn child processes or read host secrets — restrict to localhost.
const LOCAL_ONLY_PATHS = [
  "/api/mcp/",
  "/api/tunnel/tailscale-enable",
  "/api/tunnel/tailscale-disable",
  "/api/tunnel/tailscale-check",
  "/api/tunnel/enable",
  "/api/tunnel/disable",
  "/api/oauth/cursor/auto-import",
  "/api/oauth/kiro/auto-import",
  "/api/auth/reset-password",
  "/api/headroom",
  "/api/headroom/proxy",
  "/api/headroom/status",
  "/api/token-saver/stats",
  // sibling telemetry plane: a requireLogin=false toggle must not expose it remotely
  "/api/context-status",
  "/api/pxpipe",
];

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

// Accepts a Host header, a URL hostname or a raw socket address. Splitting on the first
// colon only works for IPv4 and would reduce every IPv6 form to "", so a dual-stack
// listener handing back ::ffff:127.0.0.1 would not read as loopback.
function isLoopbackHostname(h) {
  if (!h) return false;
  let name = String(h).trim().toLowerCase();
  if (name.startsWith("[")) {
    const end = name.indexOf("]");
    if (end === -1) return false;
    name = name.slice(1, end);
  } else if (
    name.indexOf(":") !== -1 &&
    name.indexOf(":") === name.lastIndexOf(":")
  ) {
    name = name.slice(0, name.indexOf(":"));
  }
  if (name.startsWith("::ffff:")) name = name.slice(7);
  return LOOPBACK_HOSTS.has(name);
}

function isLoopbackPeer(request) {
  if (hasTrustedPeerHeaders(request)) {
    return isLoopbackHostname(request.headers.get("x-tp-real-ip"));
  }
  // Bare `next dev` forks its server, so the wrapper never loads and no peer address
  // reaches us. Host is spoofable, so this stays confined to development.
  if (process.env.NODE_ENV === "development") {
    return isLoopbackHostname(request.headers.get("host"));
  }
  return false;
}

export function isLocalRequest(request) {
  // Stamped by custom-server.js when forwarding headers exist: request came through
  // a reverse proxy, so the loopback socket is the proxy hop, not the end-user.
  if (request.headers.get("x-tp-via-proxy")) return false;
  if (!isLoopbackPeer(request)) return false;
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (!isLoopbackHostname(new URL(origin).hostname)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function isPublicLlmApi(pathname) {
  return PUBLIC_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

function extractApiKey(request) {
  return collectClientApiKeyCandidates(request)[0] || null;
}

async function hasValidApiKey(request) {
  return (await resolveClientApiKey(request, validateApiKey)).valid;
}

async function canAccessPublicLlmApi(request) {
  if (isLocalRequest(request)) return true;
  if (await hasValidCliToken(request)) return true;
  return await hasValidApiKey(request);
}

async function canAccessLocalOnlyRoute(request) {
  if (await hasValidCliToken(request)) return true;
  // Browser on host: loopback Host + Origin (blocks tunnel/CSRF) + auth (JWT or requireLogin=false)
  if (isLocalRequest(request) && (await isAuthenticated(request))) return true;
  return false;
}

async function hasValidToken(request) {
  const token = request.cookies.get("auth_token")?.value;
  return await verifyDashboardAuthToken(token);
}

// Read settings directly from DB to avoid self-fetch deadlock in proxy
async function loadSettings() {
  try {
    return await getSettings();
  } catch {
    return null;
  }
}

async function isAuthenticated(request) {
  if (await hasValidToken(request)) return true;
  const settings = await loadSettings();
  if (settings && settings.requireLogin === false) return true;
  return false;
}

/**
 * The admin ABI's gate, reaching the same verdict as src/lib/admin/guard.js
 * through the same pure decision function. Two layers, one rule: a matcher edit
 * or a directly-imported handler cannot open a hole the other layer would close.
 *
 * The refusal is returned BEFORE the request reaches a handler, which is what
 * the ABI's byte-identical-on-rejection clause requires: quota, drain,
 * activation and rollback state are never read or written on a rejected call.
 */
async function adminGateDenial(request, pathname) {
  const operator = (await hasValidCliToken(request)) || (await hasValidToken(request));
  // Only asked when it can still change the answer, since validating a key
  // is a database round trip on every admin request otherwise.
  const mutating = isAdminMutation(request.method);
  const inference = operator ? false : await hasValidApiKey(request);
  const loopback = isLocalRequest(request);
  const authClass = adminAuthClass(pathname);
  const decision = adminDecision({ authClass, mutating, operator, inference, loopback });
  logAdminAuthz(
    request,
    { authClass, mutating, operator, inference, loopback, pathname },
    decision
  );
  return decision;
}

function isPublicApi(pathname) {
  if (isPublicLlmApi(pathname)) return true;
  return PUBLIC_API_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

export const __test__ = {
  isLocalRequest,
  isPublicLlmApi,
  extractApiKey,
  canAccessPublicLlmApi,
  canAccessLocalOnlyRoute,
};

export async function proxy(request) {
  const { pathname } = request.nextUrl;

  // Local-only gate for spawn-capable / host-secret routes.
  if (LOCAL_ONLY_PATHS.some((p) => pathname.startsWith(p))) {
    if (!(await canAccessLocalOnlyRoute(request))) {
      return NextResponse.json(
        { error: "Local only: CLI token required" },
        { status: 403 },
      );
    }
  }

  // The admin ABI, gated before every other /api rule so no later branch can
  // reach it. ADMIN_API_PREFIX is the literal these paths are matched on.
  if (isAdminPath(pathname)) {
    const decision = await adminGateDenial(request, pathname);
    if (!decision || decision.allow) return NextResponse.next();
    return NextResponse.json(
      { error: decision.error, code: decision.code, source: ADMIN_ERROR_SOURCE },
      { status: decision.status },
    );
  }

  // Always protected - require valid JWT or local CLI token (machineId-based).
  // Deliberately does NOT honour requireLogin=false: these routes shut the server
  // down, export the credential database, or trigger an update, so an open
  // dashboard is not identity enough (GHSA-qvfm / upstream PR #3500).
  //
  // The consequence is that with login disabled these actions are unreachable
  // from the browser, and a bare "Unauthorized" made that look like a broken
  // feature rather than a deliberate gate — the reported "Download Backup ->
  // Unauthorized" (#933). Say which it is; the boundary itself is unchanged.
  if (ALWAYS_PROTECTED.some((p) => pathname.startsWith(p))) {
    if ((await hasValidCliToken(request)) || (await hasValidToken(request)))
      return NextResponse.next();
    return NextResponse.json({
      error: "Sign in required. This action needs a logged-in session even when login is otherwise disabled, because it can export credentials, update, or shut down the server.",
      source: GATEWAY_ERROR_SOURCE,
    }, { status: 401 });
  }

  // CORS preflight: browsers send OPTIONS without auth headers by design.
  // Short-circuit before the auth check so cross-origin browser/WebView clients
  // (e.g. extensions, Claude for Office) can reach /v1/* endpoints.
  // GET/POST auth is fully preserved — only OPTIONS is exempted. (#1381)
  if (request.method === "OPTIONS" && isPublicLlmApi(pathname)) {
    const reqHeaders = request.headers.get("access-control-request-headers");
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": reqHeaders || "*",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  if (isPublicLlmApi(pathname)) {
    if (await canAccessPublicLlmApi(request)) return NextResponse.next();
    return NextResponse.json(
      { error: "API key required for remote API access", source: GATEWAY_ERROR_SOURCE },
      { status: 401 },
    );
  }

  // Deny-by-default for /api/* — public allow-list bypasses, everything else requires auth.
  if (pathname.startsWith("/api/")) {
    // Settings writes configure SSO/proxy/tunnel for the whole instance; a remote
    // caller must never reach them just because requireLogin is off. Reads keep the
    // requireLogin=false dashboard-read behavior (upstream PR #3499).
    if (
      pathname === "/api/settings" &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method)
    ) {
      if (
        !(await hasValidCliToken(request)) &&
        !(await hasValidToken(request)) &&
        !isLocalRequest(request)
      ) {
        return NextResponse.json({ error: "Unauthorized", source: GATEWAY_ERROR_SOURCE }, { status: 401 });
      }
    }
    if (isPublicApi(pathname)) return NextResponse.next();
    if ((await hasValidCliToken(request)) || (await isAuthenticated(request)))
      return NextResponse.next();
    return NextResponse.json({ error: "Unauthorized", source: GATEWAY_ERROR_SOURCE }, { status: 401 });
  }

  // Protect all dashboard routes
  if (pathname.startsWith("/dashboard")) {
    let requireLogin = true;
    let tunnelDashboardAccess = true;

    try {
      const settings = await loadSettings();
      if (settings) {
        requireLogin = settings.requireLogin !== false;
        tunnelDashboardAccess = settings.tunnelDashboardAccess === true;

        // Block tunnel/tailscale access if disabled (redirect to login)
        if (!tunnelDashboardAccess) {
          const host = (request.headers.get("host") || "")
            .split(":")[0]
            .toLowerCase();
          const tunnelHost = settings.tunnelUrl
            ? new URL(settings.tunnelUrl).hostname.toLowerCase()
            : "";
          const tailscaleHost = settings.tailscaleUrl
            ? new URL(settings.tailscaleUrl).hostname.toLowerCase()
            : "";
          if (
            (tunnelHost && host === tunnelHost) ||
            (tailscaleHost && host === tailscaleHost)
          ) {
            return NextResponse.redirect(new URL("/login", request.url));
          }
        }
      }
    } catch {
      // On error, keep defaults (require login, block tunnel)
    }

    // If login not required, allow through
    if (!requireLogin) return NextResponse.next();

    // Verify JWT token
    const token = request.cookies.get("auth_token")?.value;
    if (token) {
      if (await verifyDashboardAuthToken(token)) {
        return NextResponse.next();
      } else {
        return NextResponse.redirect(new URL("/login", request.url));
      }
    }

    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Redirect / to /dashboard if logged in, or /dashboard if it's the root
  if (pathname === "/") {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}
