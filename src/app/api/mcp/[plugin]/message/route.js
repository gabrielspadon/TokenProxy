import { NextResponse } from "next/server";
import { sendToChild, findPlugin } from "@/lib/mcp/stdioSseBridge";
import { isLocalRequest, hasValidCliToken } from "@/dashboardGuard";
import { jsonCompact } from "open-sse/rtk/filters/jsonCompact.js";

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


export async function POST(request, { params }) {
  const denied = await assertLocalOnly(request);
  if (denied) return NextResponse.json(denied, { status: 403 });

  const { plugin } = await params;
  if (!findPlugin(plugin)) {
    return NextResponse.json({ error: `Unknown plugin: ${plugin}` }, { status: 404 });
  }
  const sid = new URL(request.url).searchParams.get("sessionId");
  if (!sid) return NextResponse.json({ error: "MCP session not found" }, { status: 404 });
  try {
    const raw = await request.text();
    const body = jsonCompact(raw);
    const parsed = body && JSON.parse(body);
    if (!parsed || Array.isArray(parsed) || parsed.jsonrpc !== "2.0") {
      return NextResponse.json({ error: "Invalid MCP message" }, { status: 400 });
    }
    sendToChild(plugin, body, sid);
    return new Response(null, { status: 202 });
  } catch (e) {
    const status = [400, 404, 413, 429].includes(e.status) ? e.status : 500;
    return NextResponse.json({ error: status === 500 ? "MCP message delivery failed" : e.message }, { status });
  }
}
