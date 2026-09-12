import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir";
import { getSettings } from "@/lib/localDb";
import { getAdapter } from "@/lib/db/driver.js";

const DEFAULT_PASSWORD = "123456";
const DASHBOARD_SESSION_GENERATION_KEY = "dashboardSessionGeneration";
const INITIAL_SESSION_GENERATION = "initial";

// Read the secret where it is USED, never at module scope. Encoding it into a
// module-level const turned "import this module" into "require a JWT secret", so
// once the settings route began importing this module, importing that route threw
// for every caller without a secret, the offline test runner sanitized child
// environment among them. The documented startup contract is unaffected:
// custom-server.js refuses to boot without JWT_SECRET, before any of this loads.
//
// Deliberately not memoised. The encode costs far less than the HMAC it feeds,
// and a cache is exactly what would let a rotated secret keep signing with the
// old value, or let an unset one keep verifying tokens it should now reject.
function loadJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET environment variable is required. Set a strong random secret (min 32 chars) in your .env file.");
  }
  return new TextEncoder().encode(secret);
}

async function readDashboardSessionGeneration() {
  const db = await getAdapter();
  return db.get(
    "SELECT value FROM _meta WHERE key = ?",
    [DASHBOARD_SESSION_GENERATION_KEY],
  )?.value ?? null;
}

export function createDashboardSessionGeneration() {
  return randomUUID();
}

export function shouldUseSecureCookie(request) {
  const forceSecureCookie = process.env.AUTH_COOKIE_SECURE === "true";
  const forwardedProto = request?.headers?.get?.("x-forwarded-proto");
  const isHttpsRequest = forwardedProto === "https";
  return forceSecureCookie || isHttpsRequest;
}

export async function createDashboardAuthToken(claims = {}) {
  const generation = await readDashboardSessionGeneration();
  return new SignJWT({
    ...claims,
    authenticated: true,
    sessionGeneration: generation ?? INITIAL_SESSION_GENERATION,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(loadJwtSecret());
}

export async function verifyDashboardAuthToken(token) {
  return !!(await getDashboardAuthSession(token));
}

export async function getDashboardAuthSession(token) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, loadJwtSecret());
    const generation = await readDashboardSessionGeneration();
    const issuedGeneration = payload.sessionGeneration;
    if (generation === null) {
      // Preserve tokens issued before this persisted revocation mechanism was
      // introduced. The first acknowledged revocation creates the meta row and
      // invalidates every such legacy token.
      if (issuedGeneration !== undefined && issuedGeneration !== INITIAL_SESSION_GENERATION) {
        return null;
      }
    } else if (issuedGeneration !== generation) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export async function setDashboardAuthCookie(cookieStore, request, claims = {}) {
  const token = await createDashboardAuthToken(claims);
  cookieStore.set("auth_token", token, {
    httpOnly: true,
    secure: shouldUseSecureCookie(request),
    sameSite: "lax",
    path: "/",
  });
}

export function clearDashboardAuthCookie(cookieStore) {
  cookieStore.delete("auth_token");
}

// Verify the current dashboard password (re-auth for sensitive actions).
export async function verifyDashboardPassword(password) {
  if (typeof password !== "string" || !password) return false;
  const settings = await getSettings();
  const storedHash = settings?.password;
  if (storedHash) return bcrypt.compare(password, storedHash);
  const initialPassword = process.env.INITIAL_PASSWORD || DEFAULT_PASSWORD;
  return password === initialPassword;
}
