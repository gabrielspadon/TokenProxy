import { NextResponse } from "next/server";
import { exportDb, getSettings, importDb } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import {
  verifyDashboardPassword,
  verifyDashboardAuthToken,
} from "@/lib/auth/dashboardSession";
import { hasValidCliToken } from "@/dashboardGuard";

const PASSWORD_HEADER = "x-tp-password";

// Gate is (valid CLI token OR valid JWT) AND dashboard password. Presence of the
// x-tp-cli-token header alone is not sufficient (GHSA-qvfm / upstream PR #3500).
async function isAuthorized(request, password) {
  const jwt = request.cookies?.get?.("auth_token")?.value;
  const identityOk =
    (await hasValidCliToken(request)) ||
    (jwt && (await verifyDashboardAuthToken(jwt)));
  return Boolean(identityOk) && (await verifyDashboardPassword(password));
}

export async function GET(request) {
  try {
    if (!(await isAuthorized(request, request.headers.get(PASSWORD_HEADER)))) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }
    const payload = await exportDb();
    return NextResponse.json(payload);
  } catch (error) {
    console.log("Error exporting database:", error);
    return NextResponse.json(
      { error: "Failed to export database" },
      { status: 500 },
    );
  }
}

export async function POST(request) {
  try {
    const { password, ...payload } = await request.json();
    if (!(await isAuthorized(request, password))) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }
    await importDb(payload);

    // Ensure proxy settings take effect immediately after a DB import.
    try {
      const settings = await getSettings();
      applyOutboundProxyEnv(settings);
    } catch (err) {
      console.warn(
        "[Settings][DatabaseImport] Failed to re-apply outbound proxy env:",
        err,
      );
      return NextResponse.json({
        success: true, outcome: 'partial',
        completion: { databaseImported: true, outboundProxyEnvironment: 'failed' },
        message: 'The database import completed, but the process proxy environment could not be refreshed. Read the restored configuration before taking another action. Do not automatically repeat the import.',
      }, { status: 207 });
    }

    return NextResponse.json({ success: true, outcome: 'applied', completion: { databaseImported: true, outboundProxyEnvironment: 'applied' } });
  } catch (error) {
    console.log("Error importing database:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to import database" },
      { status: 400 },
    );
  }
}
