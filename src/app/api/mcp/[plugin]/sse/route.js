import { registerSession, unregisterSession, findPlugin } from "@/lib/mcp/stdioSseBridge";
import { isLocalRequest, hasValidCliToken } from "@/dashboardGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Defense in depth for #1114. These routes drive MCP stdio plugins, so reaching
// them means talking to a local child process, and a mistake here is remote code
// execution rather than a data leak. dashboardGuard already restricts /api/mcp/
// through LOCAL_ONLY_PATHS, but that is one list in one file: a middleware
// config change, or a new route added beside these, silently removes the only
// check. The predicate mirrors the middleware exactly rather than inventing a
// narrower one, so a CLI token stays as valid here as it is there.
async function assertLocalOnly(request) {
  if (isLocalRequest(request)) return null;
  if (await hasValidCliToken(request)) return null;
  return { error: "Local only: MCP requires localhost access" };
}


export async function GET(request, { params }) {
  const denied = await assertLocalOnly(request);
  if (denied) return new Response(JSON.stringify(denied), { status: 403, headers: { "Content-Type": "application/json" } });

  const { plugin } = await params;
  if (!findPlugin(plugin)) {
    return new Response(`Unknown plugin: ${plugin}`, { status: 404 });
  }

  const encoder = new TextEncoder();
  let sid;
  let closed = false;
  let controllerRef;
  const close = () => {
    if (closed) return;
    closed = true;
    request.signal.removeEventListener("abort", close);
    if (sid) unregisterSession(plugin, sid);
    try { controllerRef?.close(); } catch { /* cancelled stream */ }
  };
  if (request.signal.aborted) return new Response(null, { status: 499 });
  let stream;
  try {
    stream = new ReadableStream({
    start(controller) {
      controllerRef = controller;
      const send = (chunk) => {
        const bytes = encoder.encode(chunk);
        if (closed || controller.desiredSize < bytes.byteLength) throw new Error("MCP client stopped reading");
        controller.enqueue(bytes);
      };
      sid = registerSession(plugin, send, close);
      request.signal.addEventListener("abort", close, { once: true });
      if (request.signal.aborted) { close(); return; }
      // MCP SSE handshake: tell client where to POST messages.
      send(`event: endpoint\ndata: /api/mcp/${plugin}/message?sessionId=${sid}\n\n`);
    },
    cancel: close,
    }, { highWaterMark: 16 * 1024 * 1024 + 1024, size: (chunk) => chunk.byteLength });
  } catch (error) {
    close();
    const status = [409, 503].includes(error.status) ? error.status : 500;
    return new Response(JSON.stringify({ error: status === 500 ? "MCP session could not start" : error.message }), {
      status, headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
