import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { createMockBridge } from "../helpers/mcpBridgeHarness.js";

const state = vi.hoisted(() => ({ api: null }));
vi.mock("@/dashboardGuard", () => ({ isLocalRequest: () => true, hasValidCliToken: async () => false }));
vi.mock("@/lib/mcp/stdioSseBridge", () => ({
  findPlugin: (...args) => state.api.findPlugin(...args),
  registerSession: (...args) => state.api.registerSession(...args),
  unregisterSession: (...args) => state.api.unregisterSession(...args),
  sendToChild: (...args) => state.api.sendToChild(...args),
}));
const { GET } = await import("../../src/app/api/mcp/[plugin]/sse/route.js");
const { POST } = await import("../../src/app/api/mcp/[plugin]/message/route.js");
const params = (plugin) => ({ params: Promise.resolve({ plugin }) });
const decoder = new TextDecoder();
let fixture;
beforeEach(() => { fixture = createMockBridge({ register: false }); state.api = fixture.api; });
afterEach(() => { fixture.api.killAllBridges(); fixture.children.forEach((child) => child.emit("close", 0)); });

async function connect(plugin = "fixture", signal) {
  const response = await GET(new Request(`http://localhost/api/mcp/${plugin}/sse`, { signal }), params(plugin));
  if (response.status !== 200) return { response };
  const reader = response.body.getReader();
  const handshake = decoder.decode((await reader.read()).value);
  const endpoint = handshake.match(/data: (.+)\n/)[1];
  return { response, reader, endpoint, plugin };
}
const post = (client, raw) => POST(new Request(`http://localhost${client.endpoint}`, {
  method: "POST", body: raw, headers: { "Content-Type": "application/json" },
}), params(client.plugin));

describe("MCP session routes with actual bridge and mocked child processes", () => {
  it("routes colliding IDs through the advertised sessions without cross-delivery", async () => {
    const alice = await connect(), bob = await connect();
    const raw = '{ "jsonrpc": "2.0", "id": 900719925474099312345, "method": "tools/call", "params": { "amount": 1.2300e+09, "text": "keep  spaces" } }';
    expect((await post(alice, raw)).status).toBe(202);
    expect((await post(bob, raw)).status).toBe(202);
    expect(fixture.children).toHaveLength(2);
    for (const child of fixture.children) {
      const line = child.stdin.write.mock.calls[0][0];
      expect(line).toContain('"id":900719925474099312345');
      expect(line).toContain('"amount":1.2300e+09');
      expect(line).toContain('"text":"keep  spaces"');
    }
    const a = '{"jsonrpc":"2.0","id":900719925474099312345,"result":{"private":"Alice"}}';
    const b = '{"jsonrpc":"2.0","id":900719925474099312345,"result":{"private":"Bob"}}';
    fixture.children[0].stdout.emit("data", Buffer.from(`${a}\n`));
    fixture.children[1].stdout.emit("data", Buffer.from(`${b}\n`));
    expect(decoder.decode((await alice.reader.read()).value)).toBe(`event: message\ndata: ${a}\n\n`);
    expect(decoder.decode((await bob.reader.read()).value)).toBe(`event: message\ndata: ${b}\n\n`);
    await alice.reader.cancel(); await bob.reader.cancel();
  });

  it("missing and stale sessions return 404 and never create a child", async () => {
    const body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
    expect((await post({ plugin: "fixture", endpoint: "/api/mcp/fixture/message" }, body)).status).toBe(404);
    expect((await post({ plugin: "fixture", endpoint: "/api/mcp/fixture/message?sessionId=unknown" }, body)).status).toBe(404);
    expect(fixture.spawn).not.toHaveBeenCalled();
    const client = await connect();
    await client.reader.cancel();
    expect((await post(client, body)).status).toBe(404);
    expect(fixture.children[0].stdin.write).not.toHaveBeenCalled();
  });

  it("closes the owning child on abort before any POST and rejects pre-aborted GET", async () => {
    const controller = new AbortController();
    const client = await connect("fixture", controller.signal);
    controller.abort();
    expect(fixture.children[0].kill).toHaveBeenCalledWith("SIGTERM");
    expect((await client.reader.read()).done).toBe(true);
    expect((await post(client, '{"jsonrpc":"2.0","method":"notifications/initialized"}')).status).toBe(404);
    const other = await connect("fixture", AbortSignal.abort());
    expect(other.response.status).toBe(499);
    expect(fixture.spawn).toHaveBeenCalledTimes(1);
  });

  it("returns 409 for an occupied Browser controller, releases it only after child close", async () => {
    const first = await connect("browsermcp");
    expect((await connect("browsermcp")).response.status).toBe(409);
    await first.reader.cancel();
    expect((await connect("browsermcp")).response.status).toBe(409);
    fixture.children[0].emit("close", 0);
    const replacement = await connect("browsermcp");
    expect(replacement.response.status).toBe(200);
    expect(fixture.spawn).toHaveBeenCalledTimes(2);
    await replacement.reader.cancel();
  });

  it("closes the SSE stream on child failure without leaking error text or replaying", async () => {
    const client = await connect();
    fixture.children[0].emit("error", new Error("SECRET PATH /private/credential"));
    expect((await client.reader.read()).done).toBe(true);
    expect(fixture.spawn).toHaveBeenCalledTimes(1);
    expect((await post(client, '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')).status).toBe(404);
  });
});
