import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { updateSettings } from "@/lib/localDb";
import {
  clearDashboardAuthCookie,
  createDashboardSessionGeneration,
  verifyDashboardAuthToken,
} from "@/lib/auth/dashboardSession";

export async function POST(request) {
  const cookieStore = await cookies();
  let allSessions = false;
  if (request) {
    try {
      allSessions = (await request.json())?.allSessions === true;
    } catch {
      allSessions = false;
    }
  }
  if (allSessions) {
    const token = cookieStore.get("auth_token")?.value;
    if (!(await verifyDashboardAuthToken(token))) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }
    try {
      await updateSettings(
        {},
        {
          durability: "critical",
          dashboardSessionGeneration: createDashboardSessionGeneration(),
        },
      );
    } catch {
      return NextResponse.json(
        { error: "Session revocation could not be durably stored" },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      );
    }
  }
  clearDashboardAuthCookie(cookieStore);
  cookieStore.delete("oidc_state");
  cookieStore.delete("oidc_nonce");
  cookieStore.delete("oidc_code_verifier");
  return NextResponse.json(
    {
      success: true,
      ...(allSessions
        ? { sessionRevoked: true, redirectTo: "/login" }
        : {}),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
