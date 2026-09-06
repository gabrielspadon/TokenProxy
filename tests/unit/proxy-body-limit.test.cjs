const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdtempSync, mkdirSync, cpSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { resolve, join, dirname } = require("node:path");
const { spawnSync } = require("node:child_process");
const { proxyClientMaxBodySize, proxyClientMaxBodyBytes } = require("../../open-sse/config/proxyBodyLimit.cjs");

test("shares the original default and Next's binary unit parser without coercing invalid values", () => {
  assert.equal(proxyClientMaxBodySize({}), "128mb");
  assert.equal(proxyClientMaxBodyBytes({}), 128 * 1024 * 1024);
  for (const [value, expected] of [["64", 64], ["1KB", 1024], ["1.5mb", 1572864], ["256mb", 268435456]]) {
    assert.equal(proxyClientMaxBodyBytes({ TOKENPROXY_PROXY_CLIENT_MAX_BODY_SIZE: value }), expected);
  }
  for (const value of ["0", "-1", "garbage", "Infinity"]) {
    assert.throws(() => proxyClientMaxBodyBytes({ TOKENPROXY_PROXY_CLIENT_MAX_BODY_SIZE: value }), /larger than 0/);
  }
});

test("Next traces the helper and bytes dependency and a relocated runtime resolves both", async () => {
  const root = resolve(__dirname, "../.."), helper = "open-sse/config/proxyBodyLimit.cjs";
  const { nodeFileTrace } = require("next/dist/compiled/@vercel/nft");
  const { fileList } = await nodeFileTrace([resolve(root, helper)], { base: dirname(root), processCwd: root });
  assert.ok([...fileList].some(file => file.endsWith(helper)));
  assert.ok([...fileList].some(file => file.endsWith("next/dist/compiled/bytes/index.js")));
  const { default: config } = await import("../../next.config.mjs");
  assert.ok(config.outputFileTracingIncludes["**"].includes(`./${helper}`));
  assert.ok(config.outputFileTracingIncludes["**"].includes("./node_modules/next/dist/compiled/bytes/**"));
  const relocated = mkdtempSync(join(tmpdir(), "tokenproxy-body-limit-standalone-"));
  try {
    mkdirSync(join(relocated, dirname(helper)), { recursive: true });
    cpSync(join(root, helper), join(relocated, helper));
    const parser = "node_modules/next/dist/compiled/bytes";
    mkdirSync(join(relocated, dirname(parser)), { recursive: true });
    cpSync(dirname(require.resolve("next/dist/compiled/bytes")), join(relocated, parser), { recursive: true });
    const child = spawnSync(process.execPath, ["-e", `process.stdout.write(String(require('./${helper}').proxyClientMaxBodyBytes()))`], {
      cwd: relocated, env: { ...process.env, TOKENPROXY_PROXY_CLIENT_MAX_BODY_SIZE: "129mb", NODE_PATH: "" }, encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, String(129 * 1024 * 1024));
  } finally { rmSync(relocated, { recursive: true, force: true }); }
});
