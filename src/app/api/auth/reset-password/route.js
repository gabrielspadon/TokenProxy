import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { updateSettings } from "@/lib/localDb";
import { clearDashboardAuthCookie, createDashboardSessionGeneration } from "@/lib/auth/dashboardSession";

// Reset dashboard password to default by clearing the stored hash.
// Local-only (enforced by dashboardGuard). Never returns the default literal.
export async function POST() {
  try {
    await updateSettings(
      { password: null },
      {
        durability: "critical",
        dashboardSessionGeneration: createDashboardSessionGeneration(),
      },
    );
    clearDashboardAuthCookie(await cookies());
    return NextResponse.json({
      success: true,
      sessionRevoked: true,
      redirectTo: "/login",
    });
  } catch {
    return NextResponse.json({ error: "Password reset could not be durably stored" }, { status: 500 });
  }
}
