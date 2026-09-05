// MCP context_status endpoint: JSON-RPC 2.0 over streamable-HTTP-minimal.
// One JSON body in, one application/json response out (Accept:
// application/json and text/event-stream are answered identically — a plain
// JSON body — because this deployment never holds an SSE stream open).
//
// Auth mirrors the chat path exactly: the first bearer credential the client
// presents that the gateway recognizes (resolveClientApiKey + validateApiKey,
// the same pair chat.js uses). The caller's sid is derived the way the chat
// path derives it — the session identity read out of the request headers,
// namespaced per provider, hashed — except the route cannot know which
// provider a session used, so it computes the candidate sid for every
// provider that has a connection and returns the freshest matching snapshot.
// An explicit sid argument skips derivation; both are operator introspection
// on a loopback-only deployment, so no further auth layer is added.

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { resolveClientApiKey } from "@/lib/auth/clientApiKey";
import { getProviderConnections, validateApiKey } from "@/lib/localDb";
import { idPrefix } from "@/shared/observability/decide.js";
import { readContextStatus } from "open-sse/handlers/chatCore/contextStatusStore.js";
import { resolveSessionIdentity } from "open-sse/utils/sessionManager.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const PROTOCOL_VERSION = "2025-03-26";
const SID_RE = /^[a-f0-9]{8}$/;

const CONTEXT_STATUS_TOOL = {
  name: "context_status",
  description:
    "TokenProxy per-session context telemetry for the session identified by the request bearer credential. ctxTokensActual is the prompt size the provider billed on the last completed request (input + cache read + cache creation) and is the number to size against; ctxTokens is the gateway's byte-based estimate of the last dispatched body; saveBytes is what the savers cut; ceBytes is how much of the previous request's prefix the last one reproduced; compactHint is true when that prefix was rewritten by more than half.",
  inputSchema: {
    type: "object",
    properties: {
      sid: {
        type: "string",
        description:
          "optional override; defaults to the caller's own session",
      },
    },
  },
};

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function json(body, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Exact replica of the chat path's hash chain (auth.js resolveRoutingSessionHash):
// the identity must reproduce across two resolutions or it is treated as
// anonymous, then sha256(`${provider}:${sessionId}`) truncated the same way.
// Returns { hash, anonymous }: anonymous is true when identity resolution
// found nothing, meaning the hash is the SHARED anonymous-namespace hash, not
// this caller's own. Callers must not treat an anonymous hash as "your own"
// session, or the freshest anonymous entry from any caller leaks across sessions.
function sessionHashForProvider(providerId, headers) {
  let sessionId = null;
  try {
    const args = { headers, body: null, scope: providerId };
    const first = resolveSessionIdentity(args);
    if (
      first?.sessionId &&
      !first?.ephemeral &&
      first.sessionId === resolveSessionIdentity(args)?.sessionId
    ) {
      sessionId = first.sessionId;
    }
  } catch {
    sessionId = null;
  }
  return {
    anonymous: !sessionId,
    hash: createHash("sha256")
      .update(`${providerId}:${sessionId || "anonymous"}`)
      .digest("hex")
      .slice(0, 32),
  };
}

function callerHeaders(request) {
  const headers = {};
  try {
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
  } catch {
    /* no headers → anonymous */
  }
  return headers;
}

async function resolveOwnStatus(request) {
  let providers;
  try {
    const conns = await getProviderConnections();
    providers = [
      ...new Set(
        (Array.isArray(conns) ? conns : [])
          .map((c) => c?.provider)
          .filter((p) => typeof p === "string" && p),
      ),
    ];
  } catch {
    providers = [];
  }
  const headers = callerHeaders(request);
  let freshest = null;
  for (const provider of providers) {
    const { hash, anonymous } = sessionHashForProvider(provider, headers);
    // Anonymous hashes are a shared namespace: reading "your own" status from
    // one would return the freshest anonymous entry from ANY caller. Only
    // non-anonymous identities qualify; none matching means no own telemetry.
    if (anonymous) continue;
    const entry = await readContextStatus(idPrefix(hash));
    if (entry && (!freshest || String(entry.updatedAt) > String(freshest.updatedAt))) {
      freshest = entry;
    }
  }
  return freshest;
}

function statusResult(entry) {
  return {
    isError: false,
    content: [
      {
        type: "resource",
        uri: "context://status",
        mimeType: "application/json",
        text: JSON.stringify({
          sid: entry.sid,
          rid: entry.rid ?? null,
          ctxTokens: entry.ctxTokens ?? null,
          ctxTokensActual: entry.ctxTokensActual ?? null,
          saveBytes: entry.saveBytes ?? null,
          ceBytes: entry.ceBytes ?? null,
          compactHint: entry.compactHint === true,
          updatedAt: entry.updatedAt ?? null,
        }),
      },
    ],
    structuredContent: {
      sid: entry.sid,
      rid: entry.rid ?? null,
      ctxTokens: entry.ctxTokens ?? null,
      ctxTokensActual: entry.ctxTokensActual ?? null,
      saveBytes: entry.saveBytes ?? null,
      ceBytes: entry.ceBytes ?? null,
      compactHint: entry.compactHint === true,
      updatedAt: entry.updatedAt ?? null,
    },
  };
}

async function handleToolsCall(request, rpc) {
  const params = rpc.params || {};
  if (params.name !== CONTEXT_STATUS_TOOL.name) {
    return json({
      jsonrpc: "2.0",
      id: rpc.id ?? null,
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text: `Unknown tool: ${String(params.name ?? "")}`,
          },
        ],
      },
    });
  }

  let entry = null;
  const sidArg = params.arguments?.sid;
  if (sidArg !== undefined && sidArg !== null && sidArg !== "") {
    if (!SID_RE.test(String(sidArg))) {
      return json({
        jsonrpc: "2.0",
        id: rpc.id ?? null,
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: "sid must be an 8-character lowercase hex id",
            },
          ],
        },
      });
    }
    entry = await readContextStatus(String(sidArg));
  } else {
    entry = await resolveOwnStatus(request);
  }

  if (!entry) {
    return json({
      jsonrpc: "2.0",
      id: rpc.id ?? null,
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text: sidArg
              ? `No context telemetry for sid ${String(sidArg)}`
              : "No context telemetry found for this session",
          },
        ],
      },
    });
  }

  return json({ jsonrpc: "2.0", id: rpc.id ?? null, result: statusResult(entry) });
}

export async function POST(request) {
  // Same credential gate as the chat path: first recognized bearer wins.
  // Telemetry for sessions this caller does not own is still reachable
  // through the explicit sid argument, which is operator introspection by
  // contract on this loopback-only deployment.
  const resolved = await resolveClientApiKey(request, validateApiKey);
  if (!resolved.valid) {
    return json(rpcError(null, -32001, "unauthorized"), 401);
  }

  let rpc;
  try {
    rpc = JSON.parse(await request.text());
  } catch {
    return json(rpcError(null, -32700, "Parse error"), 400);
  }
  if (!rpc || typeof rpc !== "object" || Array.isArray(rpc)) {
    return json(rpcError(null, -32600, "Invalid Request"), 400);
  }

  // JSON-RPC notifications carry no id and never get a reply, per spec. This
  // runs before the method switch so notifications/cancelled and any future
  // notifications/* method are all absorbed the same way.
  if (
    rpc.id == null &&
    typeof rpc.method === "string" &&
    rpc.method.startsWith("notifications/")
  ) {
    return new Response(null, { status: 202 });
  }

  switch (rpc.method) {
    case "initialize":
      return json({
        jsonrpc: "2.0",
        id: rpc.id ?? null,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "tokenproxy", version: "0.0.1" },
        },
      });
    case "notifications/initialized":
      // Notification, not a request: 202 with an empty body, nothing to echo.
      return new Response(null, { status: 202 });
    case "tools/list":
      return json({
        jsonrpc: "2.0",
        id: rpc.id ?? null,
        result: { tools: [CONTEXT_STATUS_TOOL] },
      });
    case "tools/call":
      return handleToolsCall(request, rpc);
    default:
      return json(
        rpcError(rpc.id ?? null, -32601, `Method not found: ${String(rpc.method ?? "")}`),
        404,
      );
  }
}
