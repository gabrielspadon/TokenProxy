import { NextResponse } from "next/server";
import { deleteApiKey, getApiKeyById, updateApiKey } from "@/lib/localDb";
import { pickLimits } from "@/lib/db/repos/apiKeysRepo.js";
import { requireAdmin } from "@/lib/admin/guard.js";
import { publicApiKey } from "@/lib/admin/publicApiKey.js";
import { validateBudgetPolicy } from "@/lib/db/repos/budgetRepo.js";

// GET /api/keys/[id] - Get single key
export async function GET(request, { params }) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ key: publicApiKey(key) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.log("Error fetching key:", error);
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
}

// PUT /api/keys/[id] - Update key
export async function PUT(request, { params }) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await params;
    const body = await request.json();
    const { isActive } = body;
    if (body.budgetPolicy !== undefined) {
      try { validateBudgetPolicy(body.budgetPolicy); }
      catch (error) { return NextResponse.json({ error: error.message }, { status: 400 }); }
    }

    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const updateData = {};
    if (isActive !== undefined) updateData.isActive = isActive;
    // Each ceiling is set independently, and passing null clears it back to no
    // ceiling (#3371); allowedModels behaves the same way and null clears it
    // back to every model (#1154). A field the caller omits is left as it was.
    Object.assign(updateData, pickLimits(body));

    const updated = await updateApiKey(id, updateData);

    return NextResponse.json({ key: publicApiKey(updated) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.log("Error updating key:", error);
    return NextResponse.json({ error: "Failed to update key" }, { status: 500 });
  }
}

// DELETE /api/keys/[id] - Delete API key
export async function DELETE(request, { params }) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await params;

    const deleted = await deleteApiKey(id);
    if (!deleted) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch (error) {
    console.log("Error deleting key:", error);
    return NextResponse.json({ error: "Failed to delete key" }, { status: 500 });
  }
}
