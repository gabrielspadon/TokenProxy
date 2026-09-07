import { NextResponse } from "next/server";
import { getPricing, updatePricing, resetPricing, resetAllPricing } from "@/lib/localDb.js";
import { getDefaultPricing } from "open-sse/providers/pricing.js";

/**
 * GET /api/pricing
 * Get current pricing configuration (merged user + defaults)
 */
export async function GET() {
  try {
    const pricing = await getPricing();
    return NextResponse.json(pricing);
  } catch (error) {
    console.error("Error fetching pricing:", error);
    return NextResponse.json(
      { error: "Failed to fetch pricing" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/pricing
 * Update pricing configuration
 * Body: { provider: { model: { input: number, output: number, cached: number, ... } } }
 */
export async function PATCH(request) {
  try {
    const body = await request.json();

    // Validate body structure
    if (typeof body !== "object" || body === null || Array.isArray(body) || !Object.keys(body).length) {
      return NextResponse.json(
        { error: "Invalid pricing data format" },
        { status: 400 }
      );
    }

    // Validate pricing structure
    for (const [provider, models] of Object.entries(body)) {
      if (!provider.trim() || provider.length>200 || ["__proto__","prototype","constructor"].includes(provider) || typeof models !== "object" || models === null || Array.isArray(models) || !Object.keys(models).length) {
        return NextResponse.json(
          { error: `Invalid pricing for provider: ${provider}` },
          { status: 400 }
        );
      }

      for (const [model, pricing] of Object.entries(models)) {
        if (!model.trim() || model.length>200 || ["__proto__","prototype","constructor"].includes(model) || typeof pricing !== "object" || pricing === null || Array.isArray(pricing) || !Object.keys(pricing).length) {
          return NextResponse.json(
            { error: `Invalid pricing for model: ${provider}/${model}` },
            { status: 400 }
          );
        }

        // Validate pricing fields
        const validFields = ["input", "output", "cached", "reasoning", "cache_creation"];
        for (const [key, value] of Object.entries(pricing)) {
          if (!validFields.includes(key)) {
            return NextResponse.json(
              { error: `Invalid pricing field: ${key} for ${provider}/${model}` },
              { status: 400 }
            );
          }
          if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
            return NextResponse.json(
              { error: `Invalid pricing value for ${key} in ${provider}/${model}: must be non-negative number` },
              { status: 400 }
            );
          }
        }
      }
    }

    const updatedPricing = await updatePricing(body);
    return NextResponse.json(updatedPricing);
  } catch (error) {
    console.error("Error updating pricing:", error);
    return NextResponse.json(
      { error: "Failed to update pricing" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/pricing
 * Reset pricing to defaults
 * Query params: ?provider=xxx&model=yyy (optional)
 */
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider");
    const model = searchParams.get("model");
    if ([...searchParams.keys()].some(key=>!["provider","model"].includes(key) || searchParams.getAll(key).length!==1) || (model && !provider)
      || [provider,model].some(value=>value!==null && (!value.trim() || value.length>200 || ["__proto__","prototype","constructor"].includes(value)))) {
      return NextResponse.json({error:"Invalid pricing reset scope"},{status:400});
    }

    if (provider && model) {
      // Reset specific model
      await resetPricing(provider, model);
    } else if (provider) {
      // Reset entire provider
      await resetPricing(provider);
    } else {
      // Reset all pricing
      await resetAllPricing();
    }

    const pricing = await getPricing();
    return NextResponse.json(pricing);
  } catch (error) {
    console.error("Error resetting pricing:", error);
    return NextResponse.json(
      { error: "Failed to reset pricing" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/pricing/defaults
 * Get default pricing configuration
 */
export async function GET_DEFAULTS() {
  try {
    const defaultPricing = getDefaultPricing();
    return NextResponse.json(defaultPricing);
  } catch (error) {
    console.error("Error fetching default pricing:", error);
    return NextResponse.json(
      { error: "Failed to fetch default pricing" },
      { status: 500 }
    );
  }
}
