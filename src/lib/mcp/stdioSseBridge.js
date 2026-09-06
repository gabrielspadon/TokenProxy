// One stdio child per SSE session. Wire IDs, capabilities, notifications and
// request/response payloads never cross session boundaries.
const { spawn } = require("child_process");
const { StringDecoder } = require("node:string_decoder");
const crypto = require("crypto");
const { LOCAL_STDIO_PLUGINS } = require("@/shared/constants/coworkPlugins");

const G_KEY = "__tokenproxyMcpBridges";
const MAX_SESSIONS = 16;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const KILL_GRACE_MS = 5000;
const getStore = () => {
  if (!globalThis[G_KEY]) globalThis[G_KEY] = new Map();
  return globalThis[G_KEY];
};
function bridgeError(message, status = 500) {
  return Object.assign(new Error(message), { status });
}
function findPlugin(name) {
  return LOCAL_STDIO_PLUGINS.find((plugin) => plugin.name === name) || null;
}
function signalChild(entry, signal) {
  try {
    // Only groups created by this bridge are addressed. npx/uvx descendants
    // otherwise survive killing their launcher and can retain browser ports.
    if (entry.processGroup && Number.isInteger(entry.proc.pid)) process.kill(-entry.proc.pid, signal);
    else entry.proc.kill(signal);
  } catch { /* already exited */ }
}
function stopSession(entry) {
  if (entry.closing) return;
  entry.closing = true;
  entry.buffer = "";
  entry.bufferBytes = 0;
  entry.send = null;
  try { entry.onClose?.(); } catch { /* client already disconnected */ }
  entry.onClose = null;
  signalChild(entry, "SIGTERM");
  entry.killTimer = setTimeout(() => signalChild(entry, "SIGKILL"), KILL_GRACE_MS);
  entry.killTimer.unref?.();
}
function registerSession(name, sendFn, onClose) {
  const plugin = findPlugin(name);
  if (!plugin) throw bridgeError("Unknown local plugin", 404);
  const store = getStore();
  // Do not attach new clients to handles created by the previous shared-child
  // implementation during a development hot reload.
  if (store.has(name)) throw bridgeError("Legacy bridge must close before reconnecting", 409);
  const count = Array.from(store.values()).filter((entry) => entry.name === name).length;
  if (plugin.maxSessions && count >= plugin.maxSessions) {
    throw bridgeError("This plugin already has an active session; close it before reconnecting", 409);
  }
  if (store.size >= MAX_SESSIONS) throw bridgeError("MCP session capacity reached", 503);
  const sid = crypto.randomUUID();
  const processGroup = process.platform !== "win32";
  const proc = spawn(plugin.command, plugin.args, {
    stdio: ["pipe", "pipe", "pipe"], env: process.env, detached: processGroup,
  });
  const entry = { name, sid, proc, processGroup, send: sendFn, onClose, buffer: "", bufferBytes: 0, closing: false };
  const decoder = new StringDecoder("utf8");
  store.set(sid, entry);
  proc.stdout.on("data", (chunk) => {
    if (entry.closing) return;
    entry.bufferBytes += chunk.length;
    entry.buffer += decoder.write(chunk);
    let idx;
    while ((idx = entry.buffer.indexOf("\n")) >= 0) {
      const raw = entry.buffer.slice(0, idx);
      const bytes = Buffer.byteLength(raw, "utf8");
      entry.buffer = entry.buffer.slice(idx + 1);
      entry.bufferBytes -= bytes + 1;
      if (bytes > MAX_FRAME_BYTES) { stopSession(entry); return; }
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (!line.trim()) continue;
      // No content filtering or parse/stringify round trip. Those lose code,
      // references, numeric lexemes, signed metadata and complete error evidence.
      try { entry.send(`event: message\ndata: ${line}\n\n`); }
      catch { stopSession(entry); return; }
    }
    // Oversized/incomplete frames terminate the session explicitly. Never
    // synthesize a successfully truncated tool result.
    if (entry.bufferBytes > MAX_FRAME_BYTES) stopSession(entry);
  });
  // Plugin diagnostics may include private tool data. Drain without copying
  // arbitrary stderr into the shared application log.
  proc.stderr.on("data", () => {});
  proc.on("error", () => stopSession(entry));
  proc.stdin.on?.("error", () => stopSession(entry));
  proc.on("exit", () => stopSession(entry));
  proc.on("close", () => {
    stopSession(entry);
    clearTimeout(entry.killTimer);
    if (store.get(sid) === entry) store.delete(sid);
  });
  return sid;
}
function unregisterSession(name, sid) {
  const entry = getStore().get(sid);
  if (entry?.name === name) stopSession(entry);
}
function killAllBridges() {
  for (const entry of getStore().values()) stopSession(entry);
}
function sendToChild(name, jsonRpc, sid) {
  const entry = getStore().get(sid);
  if (!sid || entry?.name !== name || entry.closing || !entry.proc?.stdin?.writable) {
    throw bridgeError("MCP session not found", 404);
  }
  const line = typeof jsonRpc === "string" ? jsonRpc : JSON.stringify(jsonRpc);
  if (typeof line !== "string" || /[\r\n]/.test(line)) throw bridgeError("Invalid MCP frame", 400);
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > MAX_FRAME_BYTES) throw bridgeError("MCP frame exceeds transport limit", 413);
  if ((entry.proc.stdin.writableLength || 0) + bytes + 1 > MAX_FRAME_BYTES + 1) {
    throw bridgeError("MCP input queue is full", 429);
  }
  // Backpressure does not authorize resending an accepted tool invocation.
  // A false return means queued successfully; later stream errors close only
  // this session and are never replayed automatically.
  entry.proc.stdin.write(`${line}\n`);
}
function isRunning(name) {
  return Array.from(getStore().values()).some((entry) => entry.name === name &&
    entry.proc?.exitCode === null);
}

// Snapshot existing process handles only. Reading this function never creates
// a bridge, executes a command, or exposes process environment/configuration.
function getBridgeStatus() {
  const store = globalThis[G_KEY];
  const presets = LOCAL_STDIO_PLUGINS.map((plugin) => {
    const entries = Array.from(store?.values?.() || []).filter((entry) => entry.name === plugin.name);
    // A kill signal is a request, not evidence that the process exited.
    const running = entries.some((entry) => entry.proc?.exitCode === null);
    return {
      id: plugin.name, name: plugin.title || plugin.name, transport: "stdio",
      configured: true, installation: "not-probed", running,
      clients: entries.filter((entry) => !entry.closing).length,
      endpoint: `/api/mcp/${encodeURIComponent(plugin.name)}/sse`,
      declaredToolCount: Array.isArray(plugin.toolNames) ? plugin.toolNames.length : 0,
    };
  });
  return {
    observedAt: new Date().toISOString(), scope: "local-process", presets,
    summary: { presets: presets.length, running: presets.filter((p) => p.running).length, clients: presets.reduce((n,p) => n+p.clients,0) },
    capabilities: { status: true, takeover: false, modelMapping: false },
  };
}

module.exports = { registerSession, unregisterSession, sendToChild, isRunning, findPlugin, killAllBridges, getBridgeStatus };
