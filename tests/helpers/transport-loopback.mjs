import http from "node:http";
import net from "node:net";
import { once } from "node:events";

// Both endpoints bind literal loopback. CONNECT targets are synthetic identities
// and are routed only to this fixture's origin, never resolved or contacted.
export async function createTransportLoopback() {
  const sockets = new Set(), active = new Set();
  const stats = { connects: 0, requests: 0, closedBodies: 0, bulkWritten: 0, authorities: [], proxyAuth: [] };
  const bulkBytes = 64 * 1024 * 1024, block = Buffer.alloc(64 * 1024, 120);
  const track = socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); };
  const origin = http.createServer((req, res) => {
    stats.requests++; active.add(res); res.once("close", () => { active.delete(res); stats.closedBodies++; });
    res.setHeader("x-fixture-host", req.headers.host);
    if (req.url === "/long") { res.writeHead(200); res.write("anchor"); return; }
    if (req.url === "/bulk") {
      res.writeHead(200); let sent = 0;
      const pump = () => {
        while (!res.destroyed && !res.writableEnded && sent < bulkBytes) {
          sent += block.length; stats.bulkWritten += block.length;
          if (!res.write(block)) { res.once("drain", pump); return; }
        }
        if (!res.destroyed && !res.writableEnded) res.end();
      };
      pump(); return;
    }
    res.end("verified response");
  });
  origin.on("connection", track); origin.listen(0, "127.0.0.1"); await once(origin, "listening");
  const proxy = http.createServer((_req, res) => res.writeHead(405).end());
  proxy.on("connection", track);
  proxy.on("connect", (req, socket, head) => {
    stats.connects++; stats.authorities.push(req.url); stats.proxyAuth.push(req.headers["proxy-authorization"] ?? null);
    const target = net.connect({ host: "127.0.0.1", port: origin.address().port }); track(target);
    target.once("connect", () => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) target.write(head); socket.pipe(target); target.pipe(socket); });
    socket.on("error", () => target.destroy()); target.on("error", () => socket.destroy());
    socket.once("close", () => target.destroy()); target.once("close", () => socket.destroy());
  });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  return {
    stats, bulkBytes,
    originUrl: `http://127.0.0.1:${origin.address().port}`,
    proxyUrl: `http://127.0.0.1:${proxy.address().port}`,
    finish() { for (const response of active) if (!response.destroyed && !response.writableEnded) response.end("finished"); },
    async close() { for (const socket of sockets) socket.destroy(); await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => origin.close(resolve))]); },
  };
}
