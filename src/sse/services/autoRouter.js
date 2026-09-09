import { PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";
import { classifyModel, splitModelId } from "@/shared/services/modelTiers.js";

/**
 * Resolve the virtual model id "auto" to a real model, chosen from the request
 * itself (#1386).
 *
 * The report asks for OpenRouter's Auto Router: one id whose model is decided
 * per request rather than per client config. The value is spending: a greeting
 * and an architecture question both go to the flagship today because the client
 * only ever names one model.
 *
 * What this is NOT is a second routing engine. It picks a model string and
 * hands it back to the normal path, so combos, the capacity adapter, account
 * fallback and usage all behave exactly as they do for a typed model id. It
 * also never invents a model: the candidates are the same listing /v1/models
 * serves, minus whatever availability reports exhausted.
 */

// Deliberately NOT the bare "auto". That string is already a real model name in
// this tree — Trae treats model "auto" as its own strategy value, and a bare
// alias resolves through connection defaults — so claiming it would shadow a
// model a user actually has. The report offered "auto or auto-router"; this
// takes the unambiguous one.
// The id advertised in /v1/models. The set below is what is ACCEPTED, which is
// wider, so a client that guessed a spelling still routes.
export const AUTO_ROUTER_MODEL_ID = "auto-router";
export const AUTO_MODEL_IDS = new Set([AUTO_ROUTER_MODEL_ID, "tokenproxy/auto", "tokenproxy/auto-router"]);

// Class to tier. A cheap model handles a greeting; a flagship earns its price
// on architecture and long reasoning. Coding sits between them because the
// workhorse models are the ones actually tuned for it.
const CLASS_TIERS = {
  simple: ["budget", "standard", "unpriced", "top"],
  coding: ["standard", "top", "unpriced", "budget"],
  reasoning: ["top", "standard", "unpriced", "budget"],
};

// Long prompts are reasoning work whatever they say. The threshold is in
// characters because the router runs before any tokenizer does.
const REASONING_CHARS = 8000;
const SIMPLE_CHARS = 400;

const CODING_HINTS = /```|\b(refactor|debug|stack ?trace|compile|traceback|regex|SQL|API|function|class|import|npm|git|typescript|javascript|python|rust)\b/i;
const REASONING_HINTS = /\b(architecture|trade-?offs?|prove|theorem|derive|analy[sz]e|design a|why does|step by step|reason(ing)? through)\b/i;

function promptText(body) {
  const parts = [];
  for (const message of body?.messages || []) {
    const c = message?.content;
    if (typeof c === "string") parts.push(c);
    else if (Array.isArray(c)) for (const block of c) if (typeof block?.text === "string") parts.push(block.text);
  }
  // Responses-shaped bodies carry the prompt under `input` instead.
  if (typeof body?.input === "string") parts.push(body.input);
  else if (Array.isArray(body?.input)) {
    for (const item of body.input) {
      if (typeof item?.content === "string") parts.push(item.content);
      else if (Array.isArray(item?.content)) for (const b of item.content) if (typeof b?.text === "string") parts.push(b.text);
    }
  }
  return parts.join("\n");
}

export function classifyTask(body) {
  // Tools mean the model has to produce a structured call, which is the one
  // thing the cheapest models are reliably worse at. Decided before the text.
  if (Array.isArray(body?.tools) && body.tools.length) return "coding";

  const text = promptText(body);
  if (text.length >= REASONING_CHARS) return "reasoning";
  if (REASONING_HINTS.test(text)) return "reasoning";
  if (CODING_HINTS.test(text)) return "coding";
  if (text.length <= SIMPLE_CHARS) return "simple";
  return "coding";
}

// Availability is advisory: an unreadable list means "nothing known to be
// exhausted", never "route nowhere".
async function blockedSets() {
  const models = new Set();
  const providers = new Set();
  try {
    // Imported here rather than at module scope: this file is reached from the
    // chat handler, and pulling two Next route modules into that import graph
    // changes what the handler's own tests resolve.
    const { GET: getAvailability } = await import("@/app/api/models/availability/route.js");
    const response = await getAvailability();
    if (!response.ok) return { models, providers };
    for (const entry of (await response.json()).models || []) {
      if (!entry?.provider) continue;
      const alias = PROVIDER_ID_TO_ALIAS[entry.provider] || entry.provider;
      if (!entry.model || entry.model === "__all") {
        providers.add(alias);
        providers.add(entry.provider);
        continue;
      }
      models.add(`${alias}/${entry.model}`);
      models.add(`${entry.provider}/${entry.model}`);
    }
  } catch {
    /* fail open */
  }
  return { models, providers };
}

function cheapestOfTier(classified, tier) {
  const inTier = classified.filter((m) => m.tier === tier);
  if (!inTier.length) return null;
  // Cheapest first, then the larger context window, then a stable name order so
  // the same request routes the same way twice.
  inTier.sort((a, b) => {
    const price = (a.outputPricePerMillion ?? Infinity) - (b.outputPricePerMillion ?? Infinity);
    if (price !== 0) return price;
    const ctx = (b.contextWindow || 0) - (a.contextWindow || 0);
    if (ctx !== 0) return ctx;
    return a.id.localeCompare(b.id);
  });
  return inTier[0].id;
}

/**
 * @returns {Promise<{model: string, taskClass: string, source: string}|null>}
 *   null when nothing can be routed to, so the caller reports the model as
 *   unknown rather than silently answering from somewhere unexpected.
 */
export async function resolveAutoModel(body, settings = {}) {
  const taskClass = classifyTask(body);

  // An explicit rule wins outright. This is the config half of the report, and
  // it is the only part a user can get wrong, so it is checked for shape.
  const explicit = selectAutoModelFromCatalog(taskClass, [], undefined, settings);
  if (explicit) return explicit;

  let models;
  try {
    const { buildModelsList } = await import("@/app/api/v1/models/route.js");
    models = await buildModelsList(["llm"]);
  } catch {
    return null;
  }

  const blocked = await blockedSets();
  return selectAutoModelFromCatalog(taskClass, models, blocked, settings);
}

/** Pure captured-catalog decision; callers own catalog acquisition. */
export function selectAutoModelFromCatalog(taskClass, models, blocked = { models: new Set(), providers: new Set() }, settings = {}) {
  if (!CLASS_TIERS[taskClass]) return null;
  const rule = settings?.autoRouter?.rules?.[taskClass];
  if (typeof rule === "string" && splitModelId(rule)) return { model: rule, taskClass, source: "rule" };
  const classified = [];
  for (const model of models || []) {
    if (typeof model?.id !== "string" || model.owned_by === "combo") continue;
    if (blocked.providers.has(model.owned_by) || blocked.models.has(model.id)) continue;
    if (AUTO_MODEL_IDS.has(model.id)) continue;
    const entry = classifyModel(model.id);
    if (entry) classified.push(entry);
  }
  if (!classified.length) return null;

  for (const tier of CLASS_TIERS[taskClass]) {
    const pick = cheapestOfTier(classified, tier);
    if (pick) return { model: pick, taskClass, source: "tier" };
  }
  return null;
}
