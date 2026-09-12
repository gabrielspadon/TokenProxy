import net from "node:net";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("uses only the runner-owned home, tmp and data roots", () => {
  const root = resolve(process.env.TOKENPROXY_TEST_RUN_ROOT);
  expect(process.env.NODE_ENV).toBe("test");
  expect(resolve(process.env.HOME).startsWith(`${root}/`)).toBe(true);
  expect(resolve(process.env.TMPDIR).startsWith(`${root}/`)).toBe(true);
  expect(resolve(process.env.DATA_DIR).startsWith(`${root}/`)).toBe(true);
  expect(readFileSync(process.env.ISOLATION_CANARY_PATH, "utf8")).toBe("production-canary\n");
});

it("does not inherit provider or proxy credentials", () => {
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "HTTPS_PROXY", "TOKENPROXY_PEER_TOKEN"]) {
    expect(process.env[key], key).toBeUndefined();
  }
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
