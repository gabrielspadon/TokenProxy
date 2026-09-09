import { NextResponse } from "next/server";
import {
  WEBHOOK_EVENTS,
  getNotificationsConfig,
  saveNotificationsConfig,
  getDeliveryHistory,
} from "@/lib/notifications/webhooks.js";
import { evaluate, ensureWatcher } from "@/lib/notifications/watcher.js";
import { canWriteNotifications } from "./authz.js";
import { findBlockedError, SSRF_BLOCKED_ERROR_CODE } from "@/shared/utils/ssrfGuard.js";
import { getAdapter } from '@/lib/db/driver.js';
import { readDeliveryHistory } from '@/lib/notifications/outbox.mjs';

export const dynamic = "force-dynamic";

// Reading the config is also what arms the statsEmitter subscription, which is
// the only boot path this lane can reach (see watcher.js ensureWatcher).
export async function GET() {
  ensureWatcher();
  const config = await getNotificationsConfig();
  const retained = readDeliveryHistory(await getAdapter());
  return NextResponse.json(
    {
      config: { ...config, endpoints: config.endpoints.map(redact) },
      events: WEBHOOK_EVENTS,
      deliveries: [...retained, ...getDeliveryHistory()]
        .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

// Secrets are write-only: the dashboard shows whether one is set, never its
// value, so a read of this endpoint can never hand back the signing key.
function redact(endpoint) {
  const { secret, ...rest } = endpoint;
  return { ...rest, hasSecret: Boolean(secret) };
}

export async function PUT(request) {
  if (!(await canWriteNotifications(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    const config = await saveNotificationsConfig(body);
    ensureWatcher();
    return NextResponse.json({ config: { ...config, endpoints: config.endpoints.map(redact) } });
  } catch (error) {
    if (error?.code === SSRF_BLOCKED_ERROR_CODE || findBlockedError(error)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof TypeError) {
      return NextResponse.json({ error: "Invalid webhook URL" }, { status: 400 });
    }
    console.log("Error saving notification config:", error);
    return NextResponse.json({ error: "Failed to save notification config" }, { status: 500 });
  }
}

// Run the diff pass now instead of waiting for the next traffic tick. Exists so
// an external scheduler (cron, the CLI, an uptime probe) can drive detection on
// an instance that is idle — a gateway with no traffic emits no statsEmitter
// "update" and would otherwise never notice a provider recovering.
export async function POST(request) {
  if (!(await canWriteNotifications(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  ensureWatcher();
  const result = await evaluate();
  return NextResponse.json(result);
}
