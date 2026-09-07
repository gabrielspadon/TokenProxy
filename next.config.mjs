import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import proxyBodyLimit from "./open-sse/config/proxyBodyLimit.cjs";
import { SHAPING_WORKER_FILES } from "./src/lib/shaping/runtimeFiles.mjs";

const projectRoot = dirname(fileURLToPath(import.meta.url));

// Bake the git build sha into every bundle so /api/version and the dashboard
// can answer "which build is this". The standalone ships no .git and
// cli/BUILD_SHA only exists after cli:pack, so at app-build time the sha is
// resolved here and inlined by webpack; runtime falls back to the real
// process env (dev servers, tests).
function resolveTpBuildSha() {
  if (process.env.TOKENPROXY_BUILD_SHA) return process.env.TOKENPROXY_BUILD_SHA.slice(0, 12);
  // A real checkout's git HEAD is authoritative and fresh. cli/BUILD_SHA is
  // the standalone/no-git fallback only: in long-lived worktrees it holds the
  // sha of whatever pack ran last, which can be commits behind HEAD.
  try {
    if (existsSync(join(projectRoot, ".git"))) {
      const sha = execSync("git rev-parse HEAD", { cwd: projectRoot, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      if (sha) return sha.slice(0, 12);
    }
  } catch { /* fall through to the stamp files */ }
  for (const candidate of [join(projectRoot, "cli", "BUILD_SHA"), join(projectRoot, "BUILD_SHA")]) {
    try {
      const text = readFileSync(candidate, "utf8").trim();
      if (text) return text.slice(0, 12);
    } catch { /* try the next candidate */ }
  }
  try {
    const sha = execSync("git rev-parse HEAD", { cwd: projectRoot, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (sha) return sha.slice(0, 12);
  } catch { /* not a git checkout */ }
  return "unknown";
}
const tpBuildSha = resolveTpBuildSha();
// CLI bundling needs workspace root so tracing includes hoisted node_modules (slim ~50MB).
// Docker / default uses projectRoot so server.js lands at /app/server.js (not nested).
const tracingRoot = process.env.NEXT_TRACING_ROOT_MODE === "workspace"
  ? join(projectRoot, "..")
  : projectRoot;
const proxyClientMaxBodySize = proxyBodyLimit.proxyClientMaxBodySize();

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.NEXT_DIST_DIR || ".next",
  output: "standalone",
  // `open` must stay external. It derives its own directory from `import.meta.url`, and
  // webpack replaces that with the absolute path of the BUILD machine as a string literal.
  // A release built on macOS therefore ships `file:///Users/.../open/index.js`, which
  // `fileURLToPath` rejects on Windows ("File URL path must be absolute" — no drive
  // letter). That throw happens at module scope, so every consumer of `open` dies on
  // import — including xAI/Grok token refresh, which loads the OAuth service that imports
  // it. Keeping it external preserves the real `import.meta.url` at runtime.
  serverExternalPackages: ["better-sqlite3", "sql.js", "node:sqlite", "bun:sqlite", "open"],
  turbopack: {
    root: tracingRoot
  },
  outputFileTracingRoot: tracingRoot,
  // sql.js is the last link in the database driver chain and the one that is
  // supposed to work everywhere, but it is WASM with a sidecar binary rather
  // than pure JS. Nothing statically requires that binary — the loader resolves
  // it at runtime — so the standalone trace shipped dist/sql-wasm.js without
  // dist/sql-wasm.wasm and the fallback could not load, which is how an install
  // reached "no SQLite driver available" with every link exhausted (#987).
  outputFileTracingIncludes: {
    // The bounded analytics worker is loaded by path at runtime, so Next
    // traces nothing it imports. notificationRuleQueries.mjs reaches into
    // src/lib/notifications, and a miss there kills the whole worker, which
    // also serves Capacity, Context and Economics.
    "**": ["./node_modules/sql.js/dist/sql-wasm.wasm", "./src/lib/db/analytics/*.mjs", "./src/lib/notifications/*.mjs", "./open-sse/config/proxyBodyLimit.cjs", "./node_modules/next/dist/compiled/bytes/**", ...SHAPING_WORKER_FILES],
    // /api/changelog reads CHANGELOG.md from the product tree at runtime.
    "/api/changelog": ["./CHANGELOG.md"],
  },
  images: {
    unoptimized: true
  },
  env: {
    TP_BUILD_SHA: tpBuildSha,
    NEXT_PUBLIC_TP_BUILD_SHA: tpBuildSha,
  },
  experimental: {
    // #1529/#1572: LLM clients can send long context or base64 image payloads through /v1 rewrites.
    proxyClientMaxBodySize,
    // Cache fetch responses across HMR refreshes for faster dev reloads.
    serverComponentsHmrCache: true,
    // Tree-shake heavy barrel imports to cut compile + bundle size
    optimizePackageImports: ["@xyflow/react", "@dnd-kit/core", "@dnd-kit/sortable", "material-symbols", "marked"],
  },
  webpack: (config, { isServer }) => {
    // Ignore fs/path modules in browser bundle
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
      };
    }
    // Exclude non-source dirs from watcher to reduce inotify load
    config.watchOptions = {
      ...config.watchOptions,
      aggregateTimeout: 300,
      ignored: /[\\/](node_modules|\.git|logs|\.next|\.next-cli-build|cli|open-sse\.old|tests|docs)[\\/]/,
    };
    return config;
  },
  async rewrites() {
    return [
      {
        source: "/v1/v1/:path*",
        destination: "/api/v1/:path*"
      },
      {
        source: "/v1/v1",
        destination: "/api/v1"
      },
      {
        source: "/codex/:path*",
        destination: "/api/v1/responses"
      },
      {
        source: "/responses",
        destination: "/api/v1/responses"
      },
      {
        source: "/v1beta/:path*",
        destination: "/api/v1beta/:path*"
      },
      {
        source: "/v1beta",
        destination: "/api/v1beta"
      },
      {
        source: "/v1/:path*",
        destination: "/api/v1/:path*"
      },
      {
        source: "/v1",
        destination: "/api/v1"
      }
    ];
  }
};

export default nextConfig;
