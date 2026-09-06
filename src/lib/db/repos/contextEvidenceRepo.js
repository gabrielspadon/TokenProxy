import { createHmac, randomBytes } from "node:crypto";
import { getAdapter } from "../driver.js";
import { isExpired } from "./apiKeysRepo.js";
import { CONTEXT_IDENTITY_HEADERS } from "../../../../open-sse/config/contextEvidence.js";
import { measureContextStructure, normalizeContextStructure } from "../../../../open-sse/utils/contextStructure.js";

const SALT_KEY = "contextEvidenceSalt.v1";
const REF_PATTERN = /^ctx1_[a-f0-9]{64}$/;
const RAW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export class ContextEvidenceError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function contextEvidenceKey(db) {
  let stored = db.get("SELECT value FROM _meta WHERE key=?", [SALT_KEY])?.value;
  if (stored === undefined) {
    db.run("INSERT INTO _meta(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING", [SALT_KEY, randomBytes(32).toString("hex")]);
    stored = db.get("SELECT value FROM _meta WHERE key=?", [SALT_KEY])?.value;
  }
  if (typeof stored !== "string" || !/^[a-f0-9]{64}$/.test(stored)) throw new ContextEvidenceError("Context identity is unavailable", 503);
  return Buffer.from(stored, "hex");
}

export function contextClientKey(db, apiKey) {
  if (typeof apiKey !== "string" || !apiKey) return null;
  const row = db.get("SELECT id,isActive,expiresAt FROM apiKeys WHERE key=?", [apiKey]);
  return (row?.isActive === 1 || row?.isActive === true) && !isExpired(row.expiresAt) ? row.id : null;
}

export function rawContextId(value, required = false) {
  if (value === undefined || value === null) {
    if (required) throw new ContextEvidenceError("A client identity is required");
    return null;
  }
  if (typeof value !== "string" || !RAW_ID_PATTERN.test(value)) throw new ContextEvidenceError("Identity values must be opaque identifiers of at most 128 characters");
  return value;
}

export function contextRef(key, clientKeyId, clientId, field, value) {
  if (value === null || value === undefined) return null;
  return `ctx1_${createHmac("sha256", key).update(JSON.stringify(["identity-v1", clientKeyId, clientId, field, value])).digest("hex")}`;
}

function header(headers, name) {
  if (typeof headers?.get === "function") return headers.get(name);
  const found = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name);
  return found?.[1] ?? null;
}

export function explicitContextIdentity(headers, clientKeyId, key) {
  const raw = Object.fromEntries(Object.entries(CONTEXT_IDENTITY_HEADERS).map(([field, name]) => [field, header(headers, name)]));
  if (!Object.values(raw).some((value) => value !== null)) return { clientKeyId, clientIdentitySource: null };
  if (!clientKeyId) return { clientKeyId: null, clientIdentitySource: "unverified-client-report" };
  try {
    const clientId = rawContextId(raw.clientRef, true);
    const identity = { clientKeyId, clientIdentitySource: "client-reported" };
    for (const [field, value] of Object.entries(raw)) identity[field] = contextRef(key, clientKeyId, clientId, field, rawContextId(value));
    return identity;
  } catch {
    return { clientKeyId, clientIdentitySource: "rejected-client-report" };
  }
}

export function normalizeContextIdentity(identity) {
  if (!identity || typeof identity !== "object") return {};
  const clean = { clientKeyId: typeof identity.clientKeyId === "string" && RAW_ID_PATTERN.test(identity.clientKeyId) ? identity.clientKeyId : null,
    clientIdentitySource: ["client-reported", "unverified-client-report", "rejected-client-report"].includes(identity.clientIdentitySource) ? identity.clientIdentitySource : null };
  for (const field of Object.keys(CONTEXT_IDENTITY_HEADERS)) clean[field] = clean.clientKeyId && clean.clientIdentitySource === "client-reported" && REF_PATTERN.test(identity[field] || "") ? identity[field] : null;
  return clean;
}

export async function prepareContextCapture({ body, headers, apiKey, enabled = true }) {
  try {
    const db = await getAdapter(), clientKeyId = contextClientKey(db, apiKey);
    const hasIdentity = Object.values(CONTEXT_IDENTITY_HEADERS).some((name) => header(headers, name) !== null);
    const key = enabled || (clientKeyId && hasIdentity) ? contextEvidenceKey(db) : null;
    const identity = explicitContextIdentity(headers, clientKeyId, key);
    let lastSerialized, lastStructure;
    const capture = (value, boundary, serialized) => {
      if (!enabled) return null;
      try {
        const encoded = typeof serialized === "string" ? serialized : JSON.stringify(value);
        if (encoded === lastSerialized && lastStructure) return { ...lastStructure, boundary };
        const result = measureContextStructure(value, boundary, key, { serialized: encoded });
        lastSerialized = encoded; lastStructure = result;
        return result;
      } catch { return null; }
    };
    const initial = capture(body, "client-received");
    return { identity, initial, capture };
  } catch { return { identity: {}, initial: null, capture: () => null }; }
}

export function saveContextStructures(db, requestId, structures) {
  if (!Array.isArray(structures)) return;
  if (structures.length > 3) throw new ContextEvidenceError("Too many structural boundaries");
  const normalized = structures.filter(Boolean).map(normalizeContextStructure);
  if (new Set(normalized.map((value) => value.boundary)).size !== normalized.length) throw new ContextEvidenceError("Duplicate structural boundary");
  const existing = new Map(db.all(`SELECT boundary,version,data FROM contextStructures WHERE requestId=?`, [requestId])
    .map((row) => [row.boundary, row]));
  for (const structure of normalized) {
    const data = JSON.stringify(structure), stored = existing.get(structure.boundary);
    if (stored?.version === structure.version && stored.data === data) continue;
    db.run(`INSERT INTO contextStructures(requestId,boundary,version,data) VALUES(?,?,?,?)
      ON CONFLICT(requestId,boundary) DO UPDATE SET version=excluded.version,data=excluded.data`, [requestId, structure.boundary, structure.version, data]);
  }
}
