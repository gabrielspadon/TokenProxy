import net from "node:net";
import { describe, expect, it } from "vitest";

describe("real I/O guard loopback option classification", () => {
  it("treats a null path in TCP options as network metadata", async () => {
    const server = net.createServer((socket) => socket.end());
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const port = server.address().port;
      await expect(new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port, path: null }, resolve);
        socket.once("error", reject);
        socket.once("connect", () => socket.destroy());
      })).resolves.toBeUndefined();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
