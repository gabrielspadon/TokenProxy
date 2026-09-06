import fs from "node:fs";
import path from "path";
import os from "os";

const APP_NAME = "tokenproxy";

function defaultDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  }
  return path.join(os.homedir(), `.${APP_NAME}`);
}

export function getDataDir() {
  const configured = process.env.DATA_DIR;
  const isTest = process.env.NODE_ENV === "test";
  if (isTest && !configured?.trim()) {
    throw new Error(
      "[DATA_DIR] NODE_ENV=test requires an explicit DATA_DIR; use the repository test configuration or an isolated temporary directory."
    );
  }
  if (!configured) return defaultDir();

  // On Windows, ignore Unix-style absolute paths (e.g. /var/lib/...) that come
  // from a Linux-targeted .env or Docker config — they are not valid here.
  if (process.platform === "win32" && /^\//.test(configured)) {
    if (isTest) throw new Error("[DATA_DIR] A test requires a Windows-compatible DATA_DIR; refusing the home database fallback.");
    console.warn(`[DATA_DIR] '${configured}' is a Unix path on Windows → fallback to default`);
    return defaultDir();
  }

  try {
    // 0o700: this directory holds the credential DB and the secret files.
    fs.mkdirSync(configured, { recursive: true, mode: 0o700 });
    return configured;
  } catch (e) {
    if (isTest) throw e;
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      console.warn(`[DATA_DIR] '${configured}' not writable → fallback ~/.${APP_NAME}`);
      return defaultDir();
    }
    throw e;
  }
}

export const DATA_DIR = getDataDir();
