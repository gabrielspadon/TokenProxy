import net from "node:net";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";

it("uses only the runner-owned home, tmp and data roots", () => {
  const root = resolve(process.env.TOKENPROXY_TEST_RUN_ROOT);
  expect(process.env.NODE_ENV).toBe("test");
  expect(resolve(process.env.HOME).startsWith(`${root}/`)).toBe(true);
  expect(resolve(process.env.TMPDIR).startsWith(`${root}/`)).toBe(true);
  expect(resolve(process.env.DATA_DIR).startsWith(`${root}/`)).toBe(true);
  for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
    expect(resolve(process.env[key]).startsWith(`${root}/`), key).toBe(true);
  }
  expect(readFileSync(process.env.ISOLATION_CANARY_PATH, "utf8")).toBe("production-canary\n");
});

it("does not inherit provider or proxy credentials", () => {
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "HTTPS_PROXY", "TOKENPROXY_PEER_TOKEN"]) {
    expect(process.env[key], key).toBeUndefined();
  }
  expect(process.env.ARBITRARY_PROVIDER_ACCOUNT).toBeUndefined();
});

it("blocks raw sockets and child-process egress", async () => {
  expect(() => net.connect({ host: "1.1.1.1", port: 443 })).toThrow(/real-io-guard/);
  const child = spawnSync(process.execPath, [
    "-e",
    "fetch('https://1.1.1.1', {signal:AbortSignal.timeout(500)}).then(()=>process.exit(90)).catch(()=>process.exit(0))",
  ], { timeout: 2_000 });
  expect(child.status).toBe(0);

  await expect(new Promise((resolvePromise, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: 20128 });
    socket.setTimeout(500);
    socket.once("connect", () => reject(new Error("reached host loopback service")));
    socket.once("error", () => resolvePromise());
    socket.once("timeout", () => { socket.destroy(); resolvePromise(); });
  })).resolves.toBeUndefined();
});

it("allows only runner-owned filesystem Unix sockets", async () => {
  const runRoot = resolve(process.env.TOKENPROXY_TEST_RUN_ROOT);
  const outside = mkdtempSync(join(dirname(runRoot), "tokenproxy-outside-socket-"));
  const outsidePath = join(outside, "listener.sock");
  const outsideServer = net.createServer();
  await new Promise((resolvePromise, reject) => {
    outsideServer.once("error", reject);
    outsideServer.listen(outsidePath, resolvePromise);
  });

  try {
    let escapedSocket;
    expect(() => {
      escapedSocket = net.connect({ path: outsidePath });
      escapedSocket.destroy();
    }).toThrow(/real-io-guard.*outside the runner-owned root/);
  } finally {
    await new Promise((resolvePromise) => outsideServer.close(resolvePromise));
    rmSync(outside, { recursive: true, force: true });
  }

  const ownedPath = join(runRoot, "tmp", "owned-listener.sock");
  const ownedServer = net.createServer((socket) => socket.end());
  await new Promise((resolvePromise, reject) => {
    ownedServer.once("error", reject);
    ownedServer.listen(ownedPath, resolvePromise);
  });
  try {
    await expect(new Promise((resolvePromise, reject) => {
      const socket = net.connect({ path: ownedPath });
      socket.once("connect", () => { socket.destroy(); resolvePromise(); });
      socket.once("error", reject);
    })).resolves.toBeUndefined();
  } finally {
    await new Promise((resolvePromise) => ownedServer.close(resolvePromise));
  }
});
