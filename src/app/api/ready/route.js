import { getAdapter } from "@/lib/db/driver.js";
import { getPublicModelCatalogState } from "@/app/api/v1/models/catalogSnapshot.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const headers = {
  "access-control-allow-origin": "*",
  "cache-control": "no-store",
};

export async function GET() {
  try {
    const db = await getAdapter();
    const row = db.get("SELECT 1 AS ready");
    if (row?.ready !== 1) throw new Error("local database readiness query failed");
    const catalog = { ...getPublicModelCatalogState() };
    delete catalog.file;
    return Response.json({
      ready: true,
      buildSha: process.env.TP_BUILD_SHA || null,
      catalog,
    }, { headers });
  } catch {
    return Response.json({
      ready: false,
      reason: "local-state-unavailable",
      buildSha: process.env.TP_BUILD_SHA || null,
    }, { status: 503, headers });
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      ...headers,
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "*",
    },
  });
}
