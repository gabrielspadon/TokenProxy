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

function loadJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET environment variable is required. Set a strong random secret (min 32 chars) in your .env file.");
  }
  return secret;
}

const SECRET = new TextEncoder().encode(loadJwtSecret());

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
    .sign(SECRET);
}

export async function verifyDashboardAuthToken(token) {
  return !!(await getDashboardAuthSession(token));
}

export async function getDashboardAuthSession(token) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, SECRET);
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
