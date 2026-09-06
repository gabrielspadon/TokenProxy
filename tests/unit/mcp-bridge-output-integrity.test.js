import { describe, it, expect, vi } from "vitest";
import { createMockBridge as bridge } from "../helpers/mcpBridgeHarness.js";

const frame = (text, extra = {}) => JSON.stringify({
  jsonrpc: "2.0", id: "call-17", result: { content: [{ type: "text", text }], ...extra },
});

describe("MCP session isolation", () => {
  it("isolates identical wire IDs, capabilities, private responses and notifications", () => {
    const { api, children } = bridge({ register: false });
    const alice = vi.fn(), bob = vi.fn();
    const a = api.registerSession("fixture", alice);
    const b = api.registerSession("fixture", bob);
    api.sendToChild("fixture", { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: { roots: {} } } }, a);
    api.sendToChild("fixture", { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: { sampling: {} } } }, b);
    children[0].stdout.emit("data", Buffer.from(`${frame("Alice's private output")}\n`));
    expect(alice).toHaveBeenCalledTimes(1);
    expect(bob).not.toHaveBeenCalled();
    expect(children).toHaveLength(2);
    expect(children[0].stdin.write.mock.calls[0][0]).toContain('"roots"');
    expect(children[1].stdin.write.mock.calls[0][0]).toContain('"sampling"');
    const notification = '{"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":"bob-only"}}';
    children[1].stdout.emit("data", Buffer.from(`${notification}\n`));
    expect(bob.mock.calls).toEqual([[asEvent(notification)]]);
    expect(alice).toHaveBeenCalledTimes(1);
  });

  it("refuses missing, unknown, cross-plugin and closed session IDs without spawning", () => {
    const { api, children, spawn, sid } = bridge();
    const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    for (const session of [undefined, "unknown"]) expect(() => api.sendToChild("fixture", body, session)).toThrow();
    expect(() => api.sendToChild("browsermcp", body, sid)).toThrow();
    api.unregisterSession("fixture", sid);
    expect(() => api.sendToChild("fixture", body, sid)).toThrow();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(children[0].stdin.write).not.toHaveBeenCalled();
  });

  it("refuses a second browser controller and never disturbs the first", () => {
    const { api, spawn, children } = bridge({ register: false });
    api.registerSession("browsermcp", vi.fn());
    expect(() => api.registerSession("browsermcp", vi.fn())).toThrow(/already has an active session/);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(children[0].kill).not.toHaveBeenCalled();
  });

  it("cancellation kills only the owner, and late output cannot reach a replacement", () => {
    const { api, children, sid, send } = bridge();
    const other = vi.fn();
    const otherSid = api.registerSession("fixture", other);
    api.unregisterSession("fixture", sid);
    children[0].stdout.emit("data", Buffer.from(`${frame("stale")}\n`));
    children[0].emit("close", 0);
    expect(send).not.toHaveBeenCalled();
    expect(children[0].kill).toHaveBeenCalledTimes(1);
    expect(children[1].kill).not.toHaveBeenCalled();
    api.sendToChild("fixture", { jsonrpc: "2.0", id: 1, method: "tools/list" }, otherSid);
    expect(children[1].stdin.write).toHaveBeenCalledTimes(1);
  });

  it("bounds process count and rejects capacity before spawning", () => {
    const { api, spawn, children } = bridge({ register: false });
    for (let i = 0; i < 16; i++) api.registerSession("fixture", vi.fn());
    expect(() => api.registerSession("fixture", vi.fn())).toThrow(/capacity reached/);
    expect(spawn).toHaveBeenCalledTimes(16);
    api.killAllBridges();
    children.forEach((child) => child.emit("close", 0));
  });

  it("rejects a full input queue before dispatch and never resends accepted data", () => {
    const { api, children, sid } = bridge();
    const child = children[0];
    child.stdin.write.mockReturnValue(false);
    const message = { jsonrpc: "2.0", id: 1, method: "tools/call" };
    api.sendToChild("fixture", message, sid);
    expect(child.stdin.write).toHaveBeenCalledTimes(1);
    child.stdin.writableLength = 16 * 1024 * 1024;
    expect(() => api.sendToChild("fixture", message, sid)).toThrow(/queue is full/);
    expect(child.stdin.write).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("closes oversized output atomically (terminated=%s)", (terminated) => {
    const { api, children, send, sid, emit } = bridge();
    const data = Buffer.alloc(16 * 1024 * 1024 + 1, "x");
    emit(terminated ? Buffer.concat([data, Buffer.from("\n")]) : data);
    expect(send).not.toHaveBeenCalled();
    expect(children[0].kill).toHaveBeenCalledWith("SIGTERM");
    expect(() => api.sendToChild("fixture", { id: 1 }, sid)).toThrow(/not found/);
    children[0].emit("close", 0);
  });

  it("escalates a stuck owning child once, and never starts a replacement", () => {
    vi.useFakeTimers();
    try {
      const { api, children, sid, spawn } = bridge();
      api.unregisterSession("fixture", sid);
      vi.advanceTimersByTime(5000);
      expect(children[0].kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
      expect(spawn).toHaveBeenCalledTimes(1);
      children[0].emit("close", 0);
    } finally { vi.useRealTimers(); }
  });
});
const asEvent = (line) => `event: message\ndata: ${line}\n\n`;

describe("MCP stdio output is a transparent transport", () => {
  it.each([
    ["distinct references and action parameters", Array.from({ length: 60 }, (_, i) =>
      `- button \"Confirm invoice ${9000 + i}, amount ${i}.05\" [ref=e${i}]: unique action ${i}`).join("\n")],
    ["code, empty values and indentation", "function example() {\n  return `" + "x".repeat(2100) + '\n- generic:\n- text: ""\n`;\n}'],
    ["long code and trailing error evidence", "const evidence = \"" + "a".repeat(60_000) + '\";\nthrow new Error("TAIL_ERROR_291");'],
    ["deep children without invented sibling counts", "- button First [ref=e1]\n" + "  - paragraph detail\n".repeat(100) + "- link Last [ref=e2]\n"],
  ])("preserves %s byte for byte", (_label, text) => {
    const { emit, send } = bridge();
    const line = frame(text);
    emit(Buffer.from(`${line}\n`));
    expect(send.mock.calls).toEqual([[asEvent(line)]]);
  });

  it("preserves isError, signed metadata, structured values and numeric lexemes", () => {
    const { emit, send } = bridge();
    const text = "private diagnostics\n".repeat(4000);
    const line = frame(text, {
      isError: true, _meta: { signature: "signed-évidence", citation: "https://example.test/paper#291" },
      structuredContent: { amount: "1.2300", code: "keep  spacing" },
    }).replace('"call-17"', "900719925474099312345").replace('"1.2300"', "1.2300e+09");
    emit(Buffer.from(`${line}\n`));
    expect(send.mock.calls).toEqual([[asEvent(line)]]);
  });

  it("retains exact Unicode at every possible UTF-8 chunk boundary", () => {
    const line = frame("Évidence 日本語 🌊 e\u0301 \u2028");
    const bytes = Buffer.from(`${line}\n`);
    for (let cut = 1; cut < bytes.length; cut++) {
      const { emit, send } = bridge();
      emit(bytes.subarray(0, cut));
      expect(send).not.toHaveBeenCalled();
      emit(bytes.subarray(cut));
      expect(send.mock.calls, `UTF-8 byte boundary ${cut}`).toEqual([[asEvent(line)]]);
    }
  });

  it("preserves message order and escaped newlines across fragmented/coalesced frames", () => {
    const { emit, send } = bridge();
    const first = frame("line one\nline two");
    const second = JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 50 } });
    emit(Buffer.from(first.slice(0, 12)));
    expect(send).not.toHaveBeenCalled();
    emit(Buffer.from(`${first.slice(12)}\n${second}\n`));
    expect(send.mock.calls).toEqual([[asEvent(first)], [asEvent(second)]]);
  });

  it("ignores empty framing lines while retaining JSON whitespace", () => {
    const { emit, send } = bridge();
    const line = `  ${frame("exact whitespace")}  `;
    emit(Buffer.from(`\n \n${line}\n`));
    expect(send.mock.calls).toEqual([[asEvent(line)]]);
  });
});
