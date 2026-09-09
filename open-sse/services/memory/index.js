/**
 * TokenProxy AI Memory & Token Optimization Service
 *
 * Modular pipeline integrating:
 * - Phase 1: Tool Output Pruning & Historical Media Pruning
 * - Phase 2: Sliding Window Context Compaction
 *
 * SPEND THE WINDOW (2026-09-04). These savers used to run on fixed thresholds
 * that knew nothing about the model they were shaping for: tool pruning on
 * every request regardless of size, and compaction at a flat 32,000 tokens.
 * Against a one-million token window that is not optimization, it is throwing
 * away context the operator paid for — 212 million tokens of it across six
 * hours on the RTX seam — and rewriting the prompt prefix every turn, which
 * invalidates the provider's cache and bills a full re-prime to save history
 * nobody asked to lose.
 *
 * The pipeline is now a LADDER, climbed only as far as the overflow requires:
 *
 *   0. request fits inside the window less its reserve  -> nothing is touched
 *   1. replace historical media with placeholders        (already described)
 *   2. trim the oldest tool results, oldest first, each  (loss grows with age)
 *      only as deep as the remaining overflow needs
 *   3. summarize the older conversation                  (last resort, opt-in)
 *
 * Each rung re-measures before the next is considered, so the cheapest thing
 * that clears the overflow is the only thing that happens. Prune as little as
 * possible and as much as needed.
 */

import { pruneHistoricalTools, PRESSURE_TIERS } from "./toolPruner.js";
import { pruneHistoricalMedia } from "./mediaPruner.js";
import { compactContextWindow } from "./contextCompactor.js";
import { measureContextPressure, resolveContextBudget, CHARS_PER_TOKEN } from "./contextBudget.js";

/**
 * Apply all enabled memory enhancements to a request body in sequence
 * @param {Object} body - Request body
 * @param {Object} options
 * @param {Object} [options.settings] - tokenproxy settings object (from localDb)
 * @param {string} [options.targetFormat] - Target provider format
 * @param {number} [options.contextWindow] - the upstream model's own context
 *   window, from getCapabilitiesForModel. Absent falls back to the engine
 *   default, which is deliberately conservative.
 * @param {number} [options.calibration] - provider-count over estimate ratio
 *   for this session (contextBudget.calibrationFactor); 1 when unknown.
 * @param {Object} [options.log] - Logger instance
 * @returns {Promise<{ body: Object, stats: Object }>}
 */
export async function applyMemoryEnhancements(body, options = {}) {
  const {
    settings = {},
    targetFormat = "openai",
    contextWindow = null,
    calibration = 1,
    log,
  } = options;

  const stats = {
    toolPruning: { applied: false, savedChars: 0, tiersUsed: 0 },
    mediaPruning: { applied: false, savedItems: 0 },
    compaction: { applied: false, savedTokens: 0 },
    budget: null,
  };

  if (!body || typeof body !== "object") {
    return { body, stats };
  }

  // Isolation, same discipline as chatCore's isolateCompressibleItems for RTK
  // (#3566) and privacy: every mutation below (tool/media
  // pruning, compaction) rewrites these arrays IN PLACE, and without a private
  // copy an account-fallback retry would hand the pipeline an already-pruned
  // body, so the second run trims ANOTHER slice of history (measured: a second
  // pass re-trimmed 39,822 chars). Only the collections the pruners and the
  // compactor actually touch are copied, never the whole body.
  const collections = {};
  for (const key of ["messages", "input", "contents"]) {
    if (!Array.isArray(body[key])) continue;
    try {
      collections[key] = structuredClone(body[key]);
    } catch {
      return { body, stats, outcome: "failed", errorCode: "transform_exception" };
    }
  }
  Object.assign(body, collections);

  const toolPruningEnabled = settings.memoryToolPruningEnabled !== false;
  const mediaPruningEnabled = settings.memoryMediaPruningEnabled !== false;
  const compactionEnabled = settings.memoryCompactionEnabled === true;

  const budget = resolveContextBudget({ contextWindow, settings });
  const measure = () => measureContextPressure(body, { contextWindow, settings, calibration });
  let pressure = measure();
  // `projected` and `over` describe the request AS IT ARRIVED, which is the
  // question an operator is asking when they look at this. `projectedAfter` and
  // `overAfter` describe what actually went upstream, and the two differ only
  // when a rung below fired.
  stats.budget = {
    limit: pressure.limit,
    reserve: pressure.reserve,
    budget: pressure.budget,
    projected: pressure.projected,
    over: pressure.over,
    projectedAfter: pressure.projected,
    overAfter: pressure.over,
  };

  // THE WHOLE POINT. Inside the budget, the conversation is left exactly as the
  // client sent it. That is what lets a session actually reach the window it
  // is paying for, and it is what keeps the prompt prefix byte-identical from
  // one turn to the next so the provider's cache keeps hitting.
  if (!pressure.over) {
    log?.debug?.(
      "MEMORY",
      `within budget: ~${pressure.projected} of ${pressure.budget} tokens`
      + ` (window ${pressure.limit}, reserve ${pressure.reserve}) — nothing pruned`,
    );
    return { body, stats };
  }

  log?.info?.(
    "MEMORY",
    `over budget: ~${pressure.projected} tokens against ${pressure.budget}`
    + ` (window ${pressure.limit}) — reclaiming ~${pressure.deficitTokens}`,
  );

  // An operator who configured a hard floor still gets it, as the tightest tier
  // rather than as the everyday cap it used to be. Silently ignoring a setting
  // someone deliberately set is worse than honoring it late.
  const configuredFloor = Number(settings.memoryMaxHistoricalToolChars);
  const floorTier = Number.isFinite(configuredFloor) && configuredFloor > 0
    ? [Math.floor(configuredFloor)]
    : [];

  // ONE DEFICIT PER REQUEST, QUANTIZED. The tool walk cuts oldest-first and
  // stops the moment its deficit is covered, so the cut set is a function of
  // the deficit it is handed. Two things made that deficit differ from one
  // request to the next even when nothing else changed: it was re-measured
  // between rungs (media pruning shrank it, so the hard rung ran three tiers
  // on one turn and five on the next and the OLDEST results flipped between
  // cap levels), and it grew by a few hundred chars per turn (one more result
  // cut every request). Measured: 10 of 10 over-budget transitions rewrote
  // the historical prefix. So the deficit is taken once, from the request as
  // it arrived, rounded UP to a multiple of the relief chunk, and threaded
  // through the rungs as a remaining balance. Consecutive turns then ask for
  // the same cuts until real growth crosses the next chunk, and a larger
  // chunk only ever deepens the same cascade, so the prefix is byte-stable
  // between chunk crossings. Stateless, so a retry or a restart agrees.
  const reliefChunkChars = Math.max(1, Math.ceil((budget.budget - budget.target) * (CHARS_PER_TOKEN / pressure.calibration)));
  let remaining = Math.ceil(pressure.deficitChars / reliefChunkChars) * reliefChunkChars;

  const runTools = (tiers) => {
    if (!toolPruningEnabled || remaining <= 0) return;
    const res = pruneHistoricalTools(body, {
      enabled: true,
      budgetAware: true,
      deficitChars: remaining,
      keepRecentTurns: settings.memoryMaxToolTurnsKeepFull,
      tiers,
    });
    if (res.pruned) {
      stats.toolPruning.applied = true;
      stats.toolPruning.savedChars += res.savedChars;
      stats.toolPruning.tiersUsed += res.tiersUsed;
      log?.info?.(
        "MEMORY",
        `tool prune tier${tiers[0]}: ~${Math.round(res.savedChars / 4)} tokens`
        + ` across ${res.count} historical tool turns`,
      );
    }
    remaining = Math.max(0, remaining - res.savedChars);
  };

  // Rung 1: historical media. The assistant has already described these in
  // its own replies, which stay in the conversation, so the placeholder keeps
  // the thread of what happened while giving back the payload. It goes first
  // because it is the cheapest loss, and because it is all-or-nothing and so
  // independent of how much the tool walk below has to find.
  // Its savings are NOT taken off the balance the tool walk works from: the
  // amount media gives back changes as images age into the historical
  // region, and a balance that moved with it moved the walk's stopping point
  // between two turns of equal chunk (measured: one result flipped back to
  // full text). The walk answers to the quantized deficit alone; media is a
  // bonus on top.
  if (mediaPruningEnabled && (remaining > 0 || settings.memoryMediaPruningAlways === true)) {
    const mediaRes = pruneHistoricalMedia(body, { enabled: true });
    if (mediaRes.pruned) {
      stats.mediaPruning = { applied: true, savedItems: mediaRes.savedItems };
      log?.debug?.("MEMORY", `Pruned ${mediaRes.savedItems} historical media items`);
    }
  }

  // Rung 2: tool results, oldest first, each cut only as deep as the
  // remaining overflow requires (toolPruner.js), the operator's floor as the
  // tightest cap where one is configured.
  runTools([...PRESSURE_TIERS, ...floorTier]);
  pressure = measure();

  // Rung 3: Phase 2 sliding-window compaction. Still opt-in, and now the LAST
  // resort rather than a flat 32,000-token trigger — which on a one-million
  // token window fired at 3% of capacity. Its threshold is the budget, so
  // enabling it can no longer cost a conversation that fits.
  if (compactionEnabled && pressure.over && remaining > 0) {
    const compactRes = compactContextWindow(body, {
      enabled: true,
      thresholdTokens: settings.memoryCompactionThresholdTokens ?? budget.budget,
      recentTurnsToKeep: settings.memoryRecentTurnsToKeep ?? 8,
      // The compactor emits role:"system" blocks for other targets, but a
      // claude body cannot carry those inside messages[] (the one normalizer
      // that folds them has already run), so it labels a user-role note.
      format: targetFormat,
    });
    if (compactRes.compacted) {
      // `savedTokens` is not a field the compactor returns; reading it gave
      // `undefined`, which is what the pipeline line printed.
      const saved = Math.max(0, (compactRes.originalTokens || 0) - (compactRes.newTokens || 0));
      stats.compaction = { applied: true, savedTokens: saved };
      log?.info?.(
        "MEMORY",
        `Context Compactor reduced prompt from ~${compactRes.originalTokens}`
        + ` to ~${compactRes.newTokens} tokens`,
      );
      pressure = measure();
    }
  }

  stats.budget.projectedAfter = pressure.projected;
  stats.budget.overAfter = pressure.over;
  if (pressure.over) {
    // Said out loud rather than silently cutting into the protected recent
    // turns: at this point the CURRENT turn alone does not fit, and the right
    // answer is the upstream's own context error, not a request we quietly
    // mangled into shape.
    log?.warn?.(
      "MEMORY",
      `still ~${pressure.projected} tokens against ${pressure.budget} after every rung`
      + ` — the current turn does not fit and is being sent as-is`,
    );
  }

  return { body, stats };
}

export * from "./toolPruner.js";
export * from "./mediaPruner.js";
export * from "./contextCompactor.js";
export * from "./handoffStore.js";
export * from "./contextBudget.js";
