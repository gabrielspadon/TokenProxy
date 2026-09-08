import { NextResponse } from "next/server";
import { isUpdateDisabled, killAppProcesses, spawnUpdaterAndExit } from "@/lib/appUpdater";

export async function POST() {
  // Refuse rather than rely on the banner being hidden: this is the call that
  // replaces the installed version, so the opt-out is enforced here too (#1563).
  if (isUpdateDisabled()) {
    return NextResponse.json(
      { success: false, message: "Updates are disabled on this install (TOKENPROXY_NO_UPDATE)" },
      { status: 403 }
    );
  }

  if (process.env.NODE_ENV !== "production") {
    return NextResponse.json(
      { success: false, message: "Update is only available in production build (tokenproxy CLI)" },
      { status: 403 }
    );
  }

  try {
    // Kill sibling processes (MITM, stray next-server) to release file locks on Windows
    await killAppProcesses();
  } catch { /* best effort */ }

  // Schedule detached updater then exit current server process
  spawnUpdaterAndExit();

  return NextResponse.json({ success: true, message: "Updater started. This app will exit shortly." });
}
