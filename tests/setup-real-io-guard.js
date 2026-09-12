// Hard guard against real network access and real `sudo` in the test process.
// tests/README.md and the #1809/#1462 MITM incidents both trace back to a
// module (for example dnsConfig.js) that destructures
// spawn/exec/execSync from node:child_process at import time, which a
// vi.mock("child_process") factory never reaches. A test that gets the mock
// wiring wrong is caught here instead of shelling out to a real `sudo tee
// /etc/hosts` or a real DNS lookup.
import net from "node:net";
import cp from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const LOOPBACK = /^(127\.|::1$|::ffff:127\.|localhost$|0\.0\.0\.0$)/i;

const realConnect = net.Socket.prototype.connect;
function isWithin(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

function assertAllowedUnixSocket(path) {
  const runRoot = process.env.TOKENPROXY_TEST_RUN_ROOT;
  let owned = false;
  if (typeof path === "string" && path && !path.includes("\0") && isAbsolute(path) && runRoot) {
    try {
      const canonicalRoot = realpathSync(resolve(runRoot));
      const canonicalPath = existsSync(path)
        ? realpathSync(path)
        : join(realpathSync(dirname(path)), basename(path));
      owned = isWithin(canonicalRoot, canonicalPath);
    } catch {
      owned = false;
    }
  }
  if (!owned) {
    throw new Error(
      `[real-io-guard] blocked a filesystem Unix socket outside the runner-owned root: ${JSON.stringify(path)}. ` +
        `Create test listeners below TOKENPROXY_TEST_RUN_ROOT.`,
    );
  }
}

function assertAllowedConnection(args) {
  const opts = typeof args[0] === "object" && args[0] !== null ? args[0] : {};
  if (opts.path !== undefined) {
    assertAllowedUnixSocket(opts.path);
    return;
  }
  if (typeof args[0] === "string") {
    assertAllowedUnixSocket(args[0]);
    return;
  }
  const host = opts.host ?? args[1];
  // A host-less connect is an existing file-descriptor reuse, not network egress.
  if (host !== undefined && !LOOPBACK.test(String(host))) {
    throw new Error(
      `[real-io-guard] blocked a real network connection to "${host}". ` +
        `Mock fetch/http/net for this test instead of reaching the network.`,
    );
  }
}

function guardedConnect(...args) {
  assertAllowedConnection(args);
  return realConnect.apply(this, args);
}
net.Socket.prototype.connect = guardedConnect;

// node:net's convenience factories can retain a direct reference to the
// original implementation. Guard those exports as well so `net.connect()` is
// not an escape around the prototype hook.
for (const name of ["connect", "createConnection"]) {
  const realFactory = net[name];
  net[name] = function guardedConnectionFactory(...args) {
    assertAllowedConnection(args);
    return realFactory.apply(this, args);
  };
}

function isSudo(command) {
  return typeof command === "string" && /(^|\/)sudo(\s|$)/.test(command.trim());
}

for (const name of ["exec", "execSync", "spawn", "spawnSync", "execFile", "execFileSync"]) {
  const real = cp[name];
  if (typeof real !== "function") continue;
  cp[name] = function guarded(command, ...rest) {
    if (isSudo(command) || (name.startsWith("spawn") && Array.isArray(command) === false && isSudo(String(command)))) {
      throw new Error(
        `[real-io-guard] blocked a real "sudo" invocation via child_process.${name}(). ` +
          `Mock child_process for this test instead of shelling out.`,
      );
    }
    return real.call(this, command, ...rest);
  };
}

// Keep named ESM imports aligned with the guarded CommonJS-compatible builtin
// objects. Otherwise `import { connect } from "node:net"` can retain the
// pre-guard function even though `import net from "node:net"` is protected.
syncBuiltinESMExports();
