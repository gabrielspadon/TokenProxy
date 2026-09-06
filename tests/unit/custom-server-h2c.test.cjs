const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const { test, after } = require("node:test");

const originalCreateServer = http.createServer;
require("../../custom-server.js");
after(() => { http.createServer = originalCreateServer; });

async function withServer(handler, run, options) {
  const server = http.createServer(options, handler), sockets = new Set();
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    await run(server, sockets);
  } finally {
    // Expose the original failure instead of hanging on an upgraded socket.
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("owned server did not close")), 1000);
      server.close(error => { clearTimeout(timeout); error ? reject(error) : resolve(); });
    });
  }
}

function request(port, headers, body = "", { split = false, abandon = false } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
      const head = ["POST /v1/chat/completions HTTP/1.1", `Host: 127.0.0.1:${port}`, ...headers, "", ""].join("\r\n");
      socket.write(split ? head : head + body);
      if (split) setTimeout(() => { if (!socket.destroyed) socket.write(body); }, 10);
      if (abandon) socket.end();
    });
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error("h2c fallback response timed out")); });
    socket.on("data", chunk => chunks.push(chunk));
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
  });
}

const upgradeHeaders = ["Connection: Upgrade, HTTP2-Settings", "Upgrade: h2c", "HTTP2-Settings: AAEAAEAAAAIAAAAAAAMAAAAAAAQBAAAAAAUAAEAAAAYABgAA"];
async function expectSocketsClosed(sockets) {
  const deadline = Date.now() + 200;
  while (sockets.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(sockets.size, 0, "request must close its connection before fixture cleanup");
}

for (const split of [false, true]) {
  test(`serves ${split ? "split" : "coalesced"} h2c POST as HTTP/1.1 without changing its body`, async () => {
    const body = '{"model":"test","text":"ação 🌊","stream":true}';
    let calls = 0;
    await withServer(async (req, res) => {
      calls++;
      assert.equal(req.url, "/v1/chat/completions");
      assert.equal(req.headers.upgrade, undefined);
      assert.equal(req.headers["http2-settings"], undefined);
      assert.equal(req.headers.connection, "close");
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      assert.equal(Buffer.concat(chunks).toString("utf8"), body);
      res.setHeader("Content-Type", "text/event-stream");
      res.end("data: [DONE]\n\n");
    }, async (server, sockets) => {
      server.on("upgrade", (_req, socket) => socket.destroy());
      const response = await request(server.address().port, [...upgradeHeaders, `Content-Length: ${Buffer.byteLength(body)}`, "Content-Type: application/json"], body, { split });
      assert.match(response, /^HTTP\/1\.1 200 OK\r\n/);
      assert.match(response, /\r\nContent-Type: text\/event-stream\r\n/i);
      assert.match(response, /\r\nConnection: close\r\n/i);
      assert.match(response, /\r\n\r\ndata: \[DONE\]\n\n$/);
      assert.equal(calls, 1);
      await expectSocketsClosed(sockets);
    });
  });
}

test("abandoning a partial h2c body closes its socket without completing a request", async () => {
  let completed = 0;
  await withServer(async (req, res) => {
    for await (const _chunk of req) { /* Read the complete body before accepting work. */ }
    completed++; res.end("unexpected completion");
  }, async (server, sockets) => {
    server.on("upgrade", (_req, socket) => socket.destroy());
    const response = await request(server.address().port, [...upgradeHeaders, "Content-Length: 100"], "partial", { abandon: true });
    assert.doesNotMatch(response, /^HTTP\/1\.1 200/);
    assert.equal(completed, 0);
    await expectSocketsClosed(sockets);
  });
});

test("parses chunked h2c natively or refuses it explicitly on the legacy runtime", async () => {
  let calls = 0, received = "";
  await withServer(async (req, res) => {
    calls++;
    for await (const chunk of req) received += chunk.toString("utf8");
    res.end("accepted");
  }, async (server, sockets) => {
    server.on("upgrade", (_req, socket) => socket.destroy());
    const nativePolicy = typeof server.shouldUpgradeCallback === "function";
    const response = await request(server.address().port, [...upgradeHeaders, "Transfer-Encoding: chunked"], "4\r\ndata\r\n0\r\n\r\n");
    assert.match(response, nativePolicy ? /^HTTP\/1\.1 200/ : /^HTTP\/1\.1 400/);
    assert.equal(calls, nativePolicy ? 1 : 0);
    assert.equal(received, nativePolicy ? "data" : "");
    await expectSocketsClosed(sockets);
  });
});

test("retains ordinary WebSocket upgrade listener behavior", async () => {
  let upgrades = 0;
  await withServer((_req, res) => res.end("unexpected normal handler"), async (server, sockets) => {
    server.on("upgrade", (req, socket) => {
      assert.equal(req.headers.upgrade, "websocket"); upgrades++;
      socket.once("end", () => socket.destroy());
      socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    });
    const response = await request(server.address().port, ["Connection: Upgrade", "Upgrade: websocket", "Content-Length: 0"]);
    assert.match(response, /^HTTP\/1\.1 101/); assert.equal(upgrades, 1);
    await expectSocketsClosed(sockets);
  });
});

test("preserves configured native upgrade rejection without calling it for h2c", async () => {
  let calls = 0;
  await withServer((_req, res) => { res.shouldKeepAlive = false; res.end("ordinary response"); }, async (server, sockets) => {
    const nativePolicy = typeof server.shouldUpgradeCallback === "function";
    let upgrades = 0;
    server.on("upgrade", (_req, socket) => { upgrades++; socket.end("HTTP/1.1 101 Switching Protocols\r\n\r\n"); socket.once("end", () => socket.destroy()); });
    const h2c = await request(server.address().port, [...upgradeHeaders, "Content-Length: 0"]);
    assert.match(h2c, /^HTTP\/1\.1 200/); assert.equal(calls, 0);
    const websocket = await request(server.address().port, ["Connection: Upgrade", "Upgrade: websocket", "Content-Length: 0"]);
    assert.match(websocket, nativePolicy ? /^HTTP\/1\.1 200/ : /^HTTP\/1\.1 101/);
    assert.equal(calls, nativePolicy ? 1 : 0); assert.equal(upgrades, nativePolicy ? 0 : 1);
    await expectSocketsClosed(sockets);
  }, { shouldUpgradeCallback() { calls++; return false; } });
});

test("refuses oversized legacy h2c before waiting for a body", async () => {
  let calls = 0;
  await withServer((_req, res) => { calls++; res.end("native admission remains with the application"); }, async (server, sockets) => {
    server.on("upgrade", (_req, socket) => socket.destroy());
    const nativePolicy = typeof server.shouldUpgradeCallback === "function";
    const response = await request(server.address().port, [...upgradeHeaders, `Content-Length: ${129 * 1024 * 1024}`]);
    assert.match(response, nativePolicy ? /^HTTP\/1\.1 200/ : /^HTTP\/1\.1 413/);
    assert.equal(calls, nativePolicy ? 1 : 0);
    await expectSocketsClosed(sockets);
  });
});

for (const size of [64, 65]) {
  for (const split of [false, true]) {
    test(`honors configured legacy ceiling at ${size} bytes with ${split ? "split" : "coalesced"} input`, async () => {
      const previous = process.env.TOKENPROXY_PROXY_CLIENT_MAX_BODY_SIZE;
      process.env.TOKENPROXY_PROXY_CLIENT_MAX_BODY_SIZE = "64b";
      let calls = 0, received = "";
      try {
        await withServer(async (req, res) => {
          calls++;
          for await (const chunk of req) received += chunk.toString();
          res.end("received");
        }, async (server, sockets) => {
          server.on("upgrade", (_req, socket) => socket.destroy());
          const accepted = typeof server.shouldUpgradeCallback === "function" || size === 64;
          const body = "x".repeat(size);
          const response = await request(server.address().port, [...upgradeHeaders, `Content-Length: ${size}`], body, { split });
          assert.match(response, accepted ? /^HTTP\/1\.1 200/ : /^HTTP\/1\.1 413/);
          assert.equal(calls, accepted ? 1 : 0);
          assert.equal(received, accepted ? body : "");
          await expectSocketsClosed(sockets);
        });
      } finally {
        if (previous === undefined) delete process.env.TOKENPROXY_PROXY_CLIENT_MAX_BODY_SIZE;
        else process.env.TOKENPROXY_PROXY_CLIENT_MAX_BODY_SIZE = previous;
      }
    });
  }
}
