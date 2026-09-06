import { vi } from "vitest";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../../src/lib/mcp/stdioSseBridge.js", import.meta.url), "utf8");

export function createMockBridge({ register = true } = {}) {
  const children = [];
  const spawn = vi.fn(() => {
    const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: { writable: true, write: vi.fn() }, killed: false, exitCode: null,
    kill: vi.fn(),
    });
    children.push(proc);
    return proc;
  });
  const send = vi.fn();
  let nextId = 0;
  const sandbox = {
    module: { exports: {} }, globalThis: {}, process: { env: {}, platform: "win32" }, console,
    Buffer, setTimeout, clearTimeout,
    require(name) {
      if (name === "child_process") return { spawn };
      if (name === "crypto") return { randomUUID: () => `offline-session-${++nextId}` };
      if (name === "node:string_decoder") return { StringDecoder };
      if (name === "@/shared/constants/coworkPlugins") return {
        LOCAL_STDIO_PLUGINS: [
          { name: "fixture", command: "never-executed", args: [] },
          { name: "browsermcp", command: "never-executed", args: [], maxSessions: 1 },
        ],
      };
      throw new Error(`Unexpected module ${name}`);
    },
  };
  runInNewContext(source, sandbox);
  const api = sandbox.module.exports;
  const sid = register ? api.registerSession("fixture", send) : null;
  return { emit: (bytes) => children[0].stdout.emit("data", bytes), send, api, children, spawn, sid };
}

