import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../../custom-server.js", import.meta.url), "utf8");

// A client that closes the socket mid-request makes Node abort the incoming
// message; the handler's promise then rejects with "Error: aborted at
// abortIncoming (node:_http_server)" and nothing awaited it, so it surfaced as
// an unhandled rejection in the log even though the request simply went away.
describe("a client disconnect is not reported as a server error (#3564)", () => {
  it("catches the handler rejection instead of leaving it unhandled", () => {
    expect(src).toContain("const result = handler(req, res);");
    expect(src).toContain("if (isClientDisconnect(err, req, res)) return;");
    // Anything that is NOT a disconnect must still surface.
    expect(src).toContain("throw err;");
  });

  it("recognises every shape Node reports an abandoned request as", () => {
    // The codes live in CLIENT_DISCONNECT_CODES beside the predicate, so check
    // the whole unit rather than the function body alone.
    const start = src.indexOf("const CLIENT_DISCONNECT_CODES");
    const fn = src.slice(start);
    const unit = fn.slice(0, fn.indexOf("// Wrap Next standalone HTTP server"));
    for (const marker of ["ECONNRESET", "EPIPE", "ERR_STREAM_PREMATURE_CLOSE", "'aborted'", "req?.aborted"]) {
      expect(unit, `isClientDisconnect ignores ${marker}`).toContain(marker);
    }
    expect(unit).toContain("CLIENT_DISCONNECT_CODES.has(err.code)");
  });

  it("handles clientError without leaving the socket open", () => {
    const h = src.slice(src.indexOf("server.on('clientError'"));
    const body = h.slice(0, h.indexOf("});"));
    expect(body).toContain("socket.destroy()");
    expect(body).toContain("400 Bad Request");
  });

  it("leaves the spoofable-header defence exactly as it was", () => {
    // custom-server.js derives the client IP from the TCP socket and strips
    // attacker-controlled forwarding headers. This change must not touch it.
    for (const line of [
      "delete req.headers['x-forwarded-for'];",
      "delete req.headers['x-tp-real-ip'];",
      "delete req.headers['x-tp-peer-token'];",
      "req.headers['x-tp-peer-token'] = PEER_TOKEN;",
      "const ip = isLoopbackProxy && proxyIp ? proxyIp : socketIp;",
    ]) {
      expect(src, `security line missing: ${line}`).toContain(line);
    }
  });

  it("parses as valid JavaScript", async () => {
    const { execFileSync } = await import("node:child_process");
    const path = fileURLToPath(new URL("../../custom-server.js", import.meta.url));
    expect(() => execFileSync(process.execPath, ["--check", path])).not.toThrow();
  });
});
