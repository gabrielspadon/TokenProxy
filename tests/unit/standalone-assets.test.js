import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { copyStandaloneAssets } from "../../scripts/copy-standalone-assets.mjs";
import buildIdentity from '../../scripts/build-identity.cjs';

function createBuildFixture(distDir) {
  const projectRoot = mkdtempSync(join(tmpdir(), "tokenproxy-standalone-assets-"));
  const buildRoot = join(projectRoot, distDir);
  mkdirSync(join(buildRoot, "standalone"), { recursive: true });
  mkdirSync(join(buildRoot, "static", "chunks"), { recursive: true });
  mkdirSync(join(projectRoot, "public"), { recursive: true });
  writeFileSync(join(buildRoot, "static", "chunks", "app.js"), "static asset");
  writeFileSync(join(projectRoot, "public", "favicon.svg"), "public asset");
  writeFileSync(join(projectRoot, "live-safety-runtime.cjs"), "passive runtime");
  writeFileSync(join(buildRoot, 'required-server-files.json'), JSON.stringify({ config: { env: { TP_BUILD_SHA: 'a'.repeat(40) } } }));
  return projectRoot;
}

describe("standalone build assets", () => {
  it("copies static and public assets into the default standalone layout", () => {
    const projectRoot = createBuildFixture(".next");

    copyStandaloneAssets({ projectRoot, distDir: ".next" });

    expect(readFileSync(join(projectRoot, ".next", "standalone", ".next", "static", "chunks", "app.js"), "utf8"))
      .toBe("static asset");
    expect(readFileSync(join(projectRoot, ".next", "standalone", "public", "favicon.svg"), "utf8"))
      .toBe("public asset");
    expect(readFileSync(join(projectRoot, '.next', 'standalone', 'BUILD_SHA'), 'utf8')).toBe(`${'a'.repeat(40)}\n`);
  });

  it('copies the baked identity into CLI output and removes a stale stamp when provenance is unknown', () => {
    const projectRoot = createBuildFixture('.next-cli-build');
    const buildRoot = join(projectRoot, '.next-cli-build'), output = join(buildRoot, 'standalone');
    writeFileSync(join(output, 'BUILD_SHA'), `${'b'.repeat(40)}\n`);
    expect(buildIdentity.copyBuildIdentity(buildRoot, output)).toBe('a'.repeat(40));
    expect(readFileSync(join(output, 'BUILD_SHA'), 'utf8')).toBe(`${'a'.repeat(40)}\n`);
    writeFileSync(join(buildRoot, 'required-server-files.json'), JSON.stringify({ config: { env: { TP_BUILD_SHA: 'unknown' } } }));
    expect(buildIdentity.copyBuildIdentity(buildRoot, output)).toBeNull();
    expect(existsSync(join(output, 'BUILD_SHA'))).toBe(false);
  });

  it("uses a custom Next dist directory", () => {
    const projectRoot = createBuildFixture(".next-cli-build");

    copyStandaloneAssets({ projectRoot, distDir: ".next-cli-build" });

    expect(readFileSync(join(projectRoot, ".next-cli-build", "standalone", ".next-cli-build", "static", "chunks", "app.js"), "utf8"))
      .toBe("static asset");
  });

  // Without the wrapper beside server.js nothing can prove a request is local.
  it("copies the request-sanitizing server wrapper into the standalone output", () => {
    const projectRoot = createBuildFixture(".next");
    writeFileSync(join(projectRoot, "custom-server.js"), "wrapper");

    copyStandaloneAssets({ projectRoot, distDir: ".next" });

    expect(readFileSync(join(projectRoot, ".next", "standalone", "custom-server.js"), "utf8"))
      .toBe("wrapper");
    expect(readFileSync(join(projectRoot, '.next', 'standalone', 'live-safety-runtime.cjs'), 'utf8')).toBe('passive runtime');
  });

  it("does not modify workspace-traced CLI builds", () => {
    const projectRoot = createBuildFixture(".next-cli-build");
    const previousMode = process.env.NEXT_TRACING_ROOT_MODE;
    process.env.NEXT_TRACING_ROOT_MODE = "workspace";

    try {
      copyStandaloneAssets({ projectRoot, distDir: ".next-cli-build" });
    } finally {
      if (previousMode === undefined) delete process.env.NEXT_TRACING_ROOT_MODE;
      else process.env.NEXT_TRACING_ROOT_MODE = previousMode;
    }

    expect(() => readFileSync(join(projectRoot, ".next-cli-build", "standalone", ".next-cli-build", "static", "chunks", "app.js")))
      .toThrow();
  });
});
