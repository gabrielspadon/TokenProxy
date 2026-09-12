// Migration registry — append new entries when schema changes.
// Each migration: { version: number, name: string, up(db): void }
// Versions MUST be unique and monotonically increasing.
import m001 from "./001-initial.js";
import m002 from "./002-compatibility-scopes.js";
import m003 from "./003-connection-identity.js";
import m004 from "./004-economics-projection.js";
import m005 from "./005-economics-token-affinity.js";
import m006 from "./006-economics-visibility.js";
import m007 from "./007-economics-cache-presence.js";

export const MIGRATIONS = [m001, m002, m003, m004, m005, m006, m007].sort((a, b) => a.version - b.version);

export function latestVersion() {
  return MIGRATIONS.length ? MIGRATIONS[MIGRATIONS.length - 1].version : 0;
}
