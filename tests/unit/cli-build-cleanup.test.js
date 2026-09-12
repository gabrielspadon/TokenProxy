import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const buildScript = path.join(rootDir, "cli/scripts/build-cli.js");
const require = createRequire(import.meta.url);
const { copyStandaloneBuild } = require("../../cli/scripts/build-cli.js");

describe("CLI build cleanup", () => {
  it("removes stale staged output before the compiler runs", () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenproxy-cli-build-cleanup-"));

    try {
      const cliDir = path.join(fixtureDir, "cli");
      const scriptsDir = path.join(cliDir, "scripts");
      const binDir = path.join(fixtureDir, "bin");
      const stagedOutputDir = path.join(fixtureDir, ".next-cli-build");
      const compilerObservation = path.join(fixtureDir, "compiler-observation.json");

      fs.mkdirSync(scriptsDir, { recursive: true });
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(stagedOutputDir, { recursive: true });
      fs.copyFileSync(buildScript, path.join(scriptsDir, "build-cli.js"));
      // build-cli.js requires ../../scripts/build-identity.cjs, which in this
      // layout is <fixtureDir>/scripts/. Without it the spawned build dies at
      // require time, before the compiler shim runs -- and MODULE_NOT_FOUND
      // also exits 1, so the status check passed while the observation file was
      // never written. Stage the real module rather than a stub so the fixture
      // keeps exercising the actual build entry point.
      const repoScriptsDir = path.join(fixtureDir, "scripts");
      fs.mkdirSync(repoScriptsDir, { recursive: true });
      fs.copyFileSync(
        path.join(rootDir, "scripts/build-identity.cjs"),
        path.join(repoScriptsDir, "build-identity.cjs"),
      );
      fs.writeFileSync(path.join(cliDir, "package.json"), '{"version":"0.0.0"}\n');
      fs.writeFileSync(path.join(fixtureDir, "package.json"), '{"version":"0.0.0"}\n');
      fs.writeFileSync(path.join(stagedOutputDir, "stale-client-artifact.js"), "stale\n");
      fs.writeFileSync(
        path.join(binDir, "npm"),
        `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const stagedOutput = path.join(process.cwd(), process.env.NEXT_DIST_DIR, "stale-client-artifact.js");
fs.writeFileSync(${JSON.stringify(compilerObservation)}, JSON.stringify({ staleArtifactPresent: fs.existsSync(stagedOutput) }));
`,
        { mode: 0o755 },
      );

      const result = spawnSync(process.execPath, [path.join(scriptsDir, "build-cli.js")], {
        cwd: fixtureDir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        },
      });

      expect(result.status).toBe(1);
      expect(JSON.parse(fs.readFileSync(compilerObservation, "utf8"))).toEqual({
        staleArtifactPresent: false,
      });
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("does not package the isolated build home from standalone output", () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenproxy-cli-build-home-"));

    try {
      const appDir = path.join(fixtureDir, "tokenproxy");
      const buildDistDir = path.join(appDir, ".next-cli-build");
      const standaloneDir = path.join(buildDistDir, "standalone");
      const cliAppDir = path.join(fixtureDir, "cli-app");

      fs.mkdirSync(path.join(standaloneDir, ".build-home"), { recursive: true });
      fs.writeFileSync(path.join(standaloneDir, "server.js"), "server");
      fs.writeFileSync(path.join(standaloneDir, ".build-home", "data.sqlite"), "build state");

      copyStandaloneBuild(appDir, buildDistDir, cliAppDir);

      expect(fs.existsSync(path.join(cliAppDir, ".build-home", "data.sqlite"))).toBe(false);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("stops recursive copies when a standalone dependency symlink points to an ancestor", () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenproxy-cli-build-symlink-"));

    try {
      const appDir = path.join(fixtureDir, "tokenproxy");
      const buildDistDir = path.join(appDir, ".next-cli-build");
      const standaloneDir = path.join(buildDistDir, "standalone");
      const sharedNodeModules = path.join(fixtureDir, "shared-node-modules");
      const cliAppDir = path.join(fixtureDir, "cli-app");

      fs.mkdirSync(standaloneDir, { recursive: true });
      fs.mkdirSync(sharedNodeModules, { recursive: true });
      fs.writeFileSync(path.join(standaloneDir, "server.js"), "server");
      fs.writeFileSync(path.join(sharedNodeModules, "dependency.js"), "dependency");
      fs.symlinkSync(sharedNodeModules, path.join(standaloneDir, "node_modules"), "dir");
      fs.symlinkSync(sharedNodeModules, path.join(sharedNodeModules, "node_modules"), "dir");

      copyStandaloneBuild(appDir, buildDistDir, cliAppDir);

      expect(fs.readFileSync(path.join(cliAppDir, "node_modules", "dependency.js"), "utf8"))
        .toBe("dependency");
      expect(fs.existsSync(path.join(cliAppDir, "node_modules", "node_modules"))).toBe(false);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
