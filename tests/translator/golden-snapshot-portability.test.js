/**
 * The GOLDEN url/header snapshot is committed, so anything machine-specific that
 * leaks into it is committed too — and then the file only matches on the machine
 * that produced it.
 *
 * Kimi stamps the hostname into its headers and carries the app version in
 * User-Agent and X-Msh-Version. Removed provider headers must not survive as
 * stale portability expectations.
 *
 * This guard is what keeps a future `vitest -u` from baking those back in.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const SNAP = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__snapshots__",
  "golden-url-header.test.js.snap"
);

const snapshot = fs.readFileSync(SNAP, "utf-8");

describe("golden-url-header snapshot portability", () => {
  it("does not embed the recording machine's hostname", () => {
    const host = os.hostname();
    expect(host.length).toBeGreaterThan(0);
    expect(snapshot).not.toContain(`"X-Msh-Device-Name": "${host}"`);
    expect(snapshot).toContain(`"X-Msh-Device-Name": "<HOST>"`);
  });

  it("does not embed the recording machine's platform or Node version", () => {
    expect(snapshot).not.toContain('"X-PLATFORM":');
    expect(snapshot).not.toContain('"X-PLATFORM-VERSION":');
  });

  it("does not embed the app version, which every release bumps", () => {
    const version = createRequire(import.meta.url)("../../package.json").version;
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    // Bounded, because a pinned third-party version can start with the app's own
    // (kimchi/0.1.01 against an app on 0.1.0) and is contract, not rot.
    const bare = new RegExp(`(?<![\\d.])${version.replace(/\./g, "\\.")}(?![\\d.])`);
    expect(snapshot).not.toMatch(bare);
  });

  it("keeps the app-version headers on the placeholder, not on a release number", () => {
    // Hardcoded third-party client versions are part of the contract and stay
    // pinned because they come from source rather than the machine.
    for (const header of ["X-Msh-Version"]) {
      const values = [...snapshot.matchAll(new RegExp(`"${header}": "([^"]*)"`, "g"))].map((m) => m[1]);
      expect(values.length).toBeGreaterThan(0);
      expect([...new Set(values)]).toEqual(["<VERSION>"]);
    }
  });
});
