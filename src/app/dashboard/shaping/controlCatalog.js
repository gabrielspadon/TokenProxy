const epochDependency = 'Claude-format requests with a usable session cache boundary. A stable or unknown boundary leaves the stage inactive. The request-level shaping gate must also allow it.';
const localFailure = 'Unsupported inputs or unmet gates leave this stage unchanged. Historical event totals do not prove the outcome of an individual request.';

// UI descriptions accompany the server-owned settings and profile contracts.
// A shared stage is not evidence that each contributing flag executed.
export const CONTROL_GROUPS = ['Tool traffic', 'History', 'Compression', 'Instructions', 'Privacy and cache'];
export const CONTROLS = [
  { key: 'rtkEnabled', stage: 'rtk', group: 'Tool traffic', name: 'Tool result reducer', purpose: 'Reduce repeated tool output before forwarding it.', effect: 'Preserves content unless tool result elision is also allowed.', dependency: 'Request shaping enabled; eligible tool results.', threshold: 'Reducer rules depend on the tool output. Error results are excluded.', source: 'open-sse/rtk/index.js', override: 'rtk', defaultOn: true },
  { key: 'rtkAllowLossy', stage: 'rtk', group: 'Tool traffic', name: 'Tool result elision', purpose: 'Allow the reducer to remove parts of tool output.', effect: 'Removes content. Requires explicit opt-in.', dependency: 'Tool result reducer enabled.', threshold: 'Uses the reducer’s eligible-output rules.', source: 'open-sse/handlers/chatCore.js', dependsOn: 'rtkEnabled' },
  { key: 'schemaDistillEnabled', stage: 'schema', group: 'Tool traffic', name: 'Tool schema reduction', purpose: 'Reduce schema overhead in large tool inventories.', effect: 'Keeps schemas intact unless metadata removal is allowed.', dependency: 'Request shaping enabled; tool schemas present.', threshold: 'At least 8,192 serialized tool bytes.', source: 'open-sse/utils/schemaDistiller.js', override: 'schema' },
  { key: 'schemaAllowLossy', stage: 'schema', group: 'Tool traffic', name: 'Schema metadata removal', purpose: 'Permit the schema reducer to remove metadata.', effect: 'Removes schema information and can change model behavior.', dependency: 'Tool schema reduction enabled.', threshold: 'At least 8,192 serialized tool bytes.', source: 'open-sse/utils/schemaDistiller.js', dependsOn: 'schemaDistillEnabled' },
  { key: 'toolDisclosureEnabled', stage: 'tools', group: 'Tool traffic', name: 'Tool list filtering', purpose: 'Limit the tools disclosed to an upstream request.', effect: 'Withholds tool definitions; available tools can change.', dependency: 'A request carrying tools and disclosure policy.', threshold: 'Maximum disclosed tools is editable below.', source: 'open-sse/handlers/chatCore.js' },
  { key: 'toolDisclosureFilterEnabled', stage: 'tools', group: 'Tool traffic', name: 'Tool list exclusions', purpose: 'Apply configured tool and server exclusions.', effect: 'Removes excluded tools from the upstream inventory.', dependency: 'Configured tool or server exclusion lists.', threshold: 'Uses exact configured exclusions.', source: 'open-sse/handlers/chatCore.js' },
  { key: 'memoryToolPruningEnabled', defaultOn: true, stage: 'mem', group: 'History', name: 'Older tool results', purpose: 'Shorten historical tool payloads under context pressure.', effect: 'Removes older payload content while preserving recent context.', dependency: 'Eligible request history and context pressure.', threshold: 'Recent full turns and historical character ceiling are editable below.', source: 'open-sse/handlers/chatCore.js' },
  { key: 'memoryMediaPruningEnabled', defaultOn: true, stage: 'mem', group: 'History', name: 'Older attachments', purpose: 'Prune historical media when context needs to be reduced.', effect: 'Removes historical media content.', dependency: 'Eligible historical media and context pressure.', threshold: 'Uses the memory ladder and protected recent history.', source: 'open-sse/handlers/chatCore.js' },
  { key: 'memoryCompactionEnabled', stage: 'mem', group: 'History', name: 'History compaction', purpose: 'Compact older history when the request exceeds its budget.', effect: 'Replaces older context with a condensed representation.', dependency: 'Eligible history in the memory ladder.', threshold: 'Compaction token estimate and recent retained turns are editable below.', source: 'open-sse/handlers/chatCore.js' },
  { key: 'memoryHandoffEnabled', stage: 'mem', group: 'History', name: 'Handoff summary', purpose: 'Carry a condensed account of earlier work into later requests.', effect: 'Replaces historical detail with summary content.', dependency: 'Eligible memory-compaction path and session history.', threshold: 'Uses the memory ladder’s pressure and retention rules.', source: 'open-sse/handlers/chatCore.js' },
  { key: 'pairDropEnabled', stage: 'pairs', group: 'History', name: 'Old turn pairs', purpose: 'Drop complete old text pairs while over context budget.', effect: 'Deletes eligible history; keeps tool transaction structure.', dependency: 'Claude-format request; positive context deficit; a new decision is allowed.', threshold: 'Preserves six recent turns. No drop while the request fits its budget.', source: 'open-sse/utils/pairDropper.js', override: 'pairs' },
  { key: 'epochMicroEnabled', stage: 'epochMicro', group: 'History', name: 'Boundary-aware clearing', purpose: 'Replace old text and tool payloads beyond the shared cache boundary with short stubs.', effect: 'Removes payload content. Cache anchors, tool links and the recent tail stay protected.', dependency: epochDependency, threshold: 'Payloads at least 500 characters; last four messages retained.', failure: 'No usable boundary, no eligible old payload or unsupported input leaves the body unchanged. The aggregate does not distinguish every skip cause.', source: 'open-sse/utils/epochCompact.js', technical: 'Epoch micro-compaction', override: 'epochMicro' },
  { key: 'epochAutoEnabled', stage: 'epochAuto', group: 'History', name: 'Boundary-aware summary', purpose: 'Replace older history beyond the shared cache boundary with a deterministic digest under high context pressure.', effect: 'Drops history and inserts a digest of turn count, tool names and file paths. It is not a semantic model summary.', dependency: `${epochDependency} A known model context window is required.`, threshold: 'Estimated occupancy at least 75% of the context window; six recent turns requested, with tool-pair boundary alignment.', failure: 'No window, low pressure, an unusable boundary, a crossing tool pair or summary failure leaves history unchanged. No model call is made by the digest.', source: 'open-sse/utils/epochCompact.js', technical: 'Epoch auto-compaction', override: 'epochAuto' },
  { key: 'dietEnabled', stage: 'diet', group: 'History', name: 'Expired result pruning', purpose: 'Stub old, unreferenced tool results beyond the shared cache boundary.', effect: 'Removes eligible result payloads. Keeps tool links, diff hunks, protected error traces and referenced results.', dependency: epochDependency, threshold: 'At least eight assistant turns old and 2,048 characters. Scans the last three assistant turns for references.', failure: 'A stable or unknown boundary, recent/reference-protected content or an unmet size gate leaves the result unchanged. No sidecar or model call.', source: 'open-sse/utils/dietPrune.js', technical: 'Diet', override: 'diet' },
  { key: 'embedReorderEnabled', stage: 'reorder', group: 'History', name: 'Relevant history ordering', purpose: 'Move relevant earlier pairs closer to the recent tail.', effect: 'Reorders history and may change prefix cache behavior.', dependency: 'Claude-format request and configured embedding endpoint. Fresh scoring follows an earlier prefix rewrite; otherwise session order is replayed.', threshold: 'A saved session order or an earlier prefix rewrite.', failure: 'Embedding failure leaves the existing order unchanged.', source: 'open-sse/utils/embedReorder.js', override: 'reorder' },
  { key: 'headroomEnabled', stage: 'headroom', group: 'Compression', name: 'Context rewriting service', purpose: 'Apply the configured Headroom transformation before forwarding.', effect: 'Rewriting requires the separate content-change opt-in.', dependency: 'Configured and reachable Headroom endpoint; request shaping enabled.', threshold: 'Uses model context pressure and configured timeout.', failure: 'Unavailable or failed transformation passes through the request. Reported token reductions are distinct from measured body bytes.', source: 'open-sse/handlers/chatCore.js', technical: 'Headroom', override: 'headroom' },
  { key: 'headroomAllowLossy', stage: 'headroom', group: 'Compression', name: 'Allow context rewriting', purpose: 'Permit content-changing Headroom processing.', effect: 'Allows replacement or removal of request content.', dependency: 'Context rewriting service enabled.', threshold: 'Uses the service’s pressure and timeout rules.', source: 'open-sse/handlers/chatCore.js', dependsOn: 'headroomEnabled' },
  { key: 'headroomCompressUserMessages', stage: 'headroom', group: 'Compression', name: 'Rewrite earlier user messages', purpose: 'Include earlier user messages in Headroom compression.', effect: 'May remove or replace earlier user content; the current user message stays protected.', dependency: 'Context rewriting service enabled with content-change permission.', threshold: 'Uses the service’s pressure and timeout rules.', source: 'open-sse/rtk/contentPolicy.js', dependsOn: 'headroomAllowLossy' },
  { key: 'headroomLossless', stage: 'headroom', group: 'Compression', name: 'Legacy Headroom lossless flag', purpose: 'Retain the saved compatibility value.', effect: 'Has no execution effect. Current Headroom behavior uses its content-change permission.', dependency: 'No runtime reader is connected to this compatibility setting.', threshold: 'No active threshold.', source: 'src/lib/shaping/runtimeSupport.js' },
  { key: 'pxpipeEnabled', stage: 'pxpipe', group: 'Compression', name: 'Visual compression service', purpose: 'Use the installed PXPIPE transformer for eligible requests.', effect: 'Can replace text with visual content when its separate opt-in is allowed.', dependency: 'Installed local PXPIPE module and content-change opt-in.', threshold: 'Minimum characters and timeout are editable below.', failure: 'Missing service, a declined transform or timeout passes the request through. Opening this page does not load the module.', source: 'open-sse/handlers/chatCore.js', technical: 'PXPIPE', override: 'pxpipe' },
  { key: 'pxpipeAllowLossy', stage: 'pxpipe', group: 'Compression', name: 'Allow visual replacement', purpose: 'Permit PXPIPE to replace text with visual content.', effect: 'Content-changing and dependent on model vision support.', dependency: 'Visual compression service enabled.', threshold: 'Uses service minimum characters and timeout.', source: 'open-sse/handlers/chatCore.js', dependsOn: 'pxpipeEnabled' },
  { key: 'queryAwareCompressionEnabled', stage: 'qac', group: 'Compression', name: 'Query-aware history', purpose: 'Replace low-relevance historical turns with placeholders.', effect: 'Removes text selected against the current query; earlier decisions replay within the session.', dependency: 'Claude-format request, usable query or saved decisions, and request shaping enabled.', threshold: 'Fresh scoring only while over context budget; two recent turns retained.', source: 'open-sse/handlers/chatCore.js', override: 'qac' },
  { key: 'linguaEnabled', stage: 'lingua', group: 'Compression', name: 'Selective prose compression', purpose: 'Compress large older prose payloads beyond the shared cache boundary through a local sidecar.', effect: 'Replaces text in place. Skips detected code, JSON, diff hunks, cache anchors and the live user tail.', dependency: `${epochDependency} Requires TOKENPROXY_LINGUA_ENDPOINT on loopback or a Unix socket.`, threshold: 'At least 5,120 characters. Requested ratio is min(0.5, 4,096 / characters); timeout 30 seconds.', failure: 'No endpoint, refused endpoint, timeout, abort or invalid response leaves the entire stage unchanged. Detailed failures are in debug logs; the aggregate has limited skip reasons.', source: 'open-sse/utils/linguaCompress.js', technical: 'Lingua / LLMLingua-2', override: 'lingua' },
  { key: 'thinkingStripEnabled', stage: 'thinking', group: 'Instructions', name: 'Historical reasoning removal', purpose: 'Remove earlier assistant thinking blocks on compatible upstreams.', effect: 'Removes historical reasoning; retains the live reasoning turn.', dependency: 'Claude-format third-party path. Native Claude and Anthropic providers skip it.', threshold: 'Keeps the latest assistant turn.', source: 'open-sse/handlers/chatCore.js', override: 'thinking' },
  { key: 'midPrefixInjectEnabled', stage: 'midinject', group: 'Instructions', name: 'Transformation note', purpose: 'Tell the model which prefix transformations occurred.', effect: 'Adds an instruction near the live boundary. Body bytes can increase.', dependency: 'Claude-format path and eligible transformation notes.', threshold: 'Only when earlier stages produce a boundary note.', source: 'open-sse/handlers/chatCore.js', override: 'midinject' },
  { key: 'cavemanEnabled', stage: 'inject', group: 'Instructions', name: 'Compact response instructions', purpose: 'Ask the model for compressed response wording.', effect: 'Adds a response-style prompt; changes instructions, not measured billing.', dependency: 'Request shaping enabled; configured instruction level.', threshold: 'Uses the saved lite, full or ultra level.', source: 'open-sse/handlers/chatCore.js', technical: 'Caveman', override: 'caveman' },
  { key: 'ponytailEnabled', stage: 'inject', group: 'Instructions', name: 'Structured response instructions', purpose: 'Apply the configured Ponytail response-style prompt.', effect: 'Adds instructions and can increase request bytes.', dependency: 'Request shaping enabled; configured instruction level.', threshold: 'Uses the saved lite, full or ultra level.', source: 'open-sse/handlers/chatCore.js', technical: 'Ponytail', override: 'ponytail' },
  { key: 'privacyFilterEnabled', stage: 'privacy', group: 'Privacy and cache', name: 'Private term filtering', purpose: 'Pseudonymize emails and configured terms in outbound content.', effect: 'Rewrites matching terms; mapped values are restored in the client response.', dependency: 'Global privacy policy and matching content.', threshold: 'Uses configured privacy terms and email detection.', source: 'open-sse/handlers/chatCore.js' },
  { key: 'adaptiveCacheTtlEnabled', stage: null, group: 'Privacy and cache', name: 'Adaptive cache lifetime', purpose: 'Choose a longer cache-anchor lifetime for sessions with long request gaps.', effect: 'Changes cache metadata, not text. Explicit client lifetimes and anchor positions stay in place; cache charges may differ.', dependency: 'Claude-format cache-anchor path and session gap observations. Global only; routing plans cannot override it.', threshold: 'At least three valid gaps and p90 strictly greater than 20 minutes selects one hour; otherwise five minutes.', failure: 'Missing or insufficient observations keep five minutes. Flag off retains the existing anchoring policy. No dedicated stage-byte or billing measurement is recorded here.', source: 'open-sse/utils/prefixStability.js', technical: 'Adaptive cache TTL' },
];

export const THRESHOLDS = [
  { key: 'headroomTimeoutMs', stage: 'headroom', name: 'Context rewriting timeout', unit: 'milliseconds', min: 1, max: 599999, nullable: true },
  { key: 'pxpipeMinChars', stage: 'pxpipe', name: 'Minimum request size', unit: 'characters', min: 1, max: 10000000 },
  { key: 'pxpipeTimeoutMs', stage: 'pxpipe', name: 'Transform timeout', unit: 'milliseconds', min: 1, max: 599999 },
  { key: 'memoryMaxToolTurnsKeepFull', stage: 'mem', name: 'Recent tool turns kept whole', unit: 'turns', min: 0, max: 1000 },
  { key: 'memoryMaxHistoricalToolChars', stage: 'mem', name: 'Older tool result ceiling', unit: 'characters', min: 1, max: 10000000 },
  { key: 'memoryRecentTurnsToKeep', stage: 'mem', name: 'Recent turns kept intact', unit: 'turns', min: 1, max: 1000 },
  { key: 'memoryCompactionThresholdTokens', stage: 'mem', name: 'Compaction threshold', unit: 'estimated tokens', min: 1, max: 10000000 },
  { key: 'toolDisclosureMaxTools', stage: 'tools', name: 'Maximum disclosed tools', unit: 'tools', min: 1, max: 10000 },
];

export const CONFIGURATION_FIELDS = [
  { key: 'cavemanLevel', control: 'cavemanEnabled', name: 'Compact response level', options: ['lite', 'full', 'ultra'] },
  { key: 'ponytailLevel', control: 'ponytailEnabled', name: 'Structured response level', options: ['lite', 'full', 'ultra'] },
  { key: 'privacyFilterTerms', control: 'privacyFilterEnabled', name: 'Private terms', list: true },
  { key: 'toolDisclosureExcludeServers', control: 'toolDisclosureFilterEnabled', name: 'Excluded tool servers', list: true },
  { key: 'toolDisclosureExcludeTools', control: 'toolDisclosureFilterEnabled', name: 'Excluded tools', list: true },
];

export const controlLabel = key => CONTROLS.find(control => control.key === key)?.name || THRESHOLDS.find(field => field.key === key)?.name || CONFIGURATION_FIELDS.find(field => field.key === key)?.name || key.replace(/Enabled$/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
export const controlFailure = control => control.failure || localFailure;
export const controlScope = control => control.override ? 'Global default, with supported routing-plan overrides' : 'Global only';
export function configuredState(settings, control) {
  // These permissions are implicit false in the gateway when never persisted.
  if (settings && !Object.hasOwn(settings, control.key) && control.key.endsWith('AllowLossy')) return 'Off';
  return typeof settings?.[control.key] === 'boolean' ? settings[control.key] ? 'On' : 'Off' : 'Unknown';
}
export function stageEvidence(stageMap, stage) {
  const record = stage ? stageMap?.[stage] : null;
  return {
    records: Number.isFinite(record?.requests) ? record.requests : null,
    applied: Number.isFinite(record?.applied) ? record.applied : null,
    delta: Number.isFinite(record?.bytesSaved) ? record.bytesSaved : null,
    measuredRecords: Number.isFinite(record?.measuredRequests) ? record.measuredRequests : null,
    // Older API responses may have a delta without a byte-coverage count.
    measured: Number.isFinite(record?.bytesSaved) && Number.isFinite(record?.measuredRequests) && record.measuredRequests > 0,
  };
}
export function thresholdPatch(draft) {
  const entries = Object.entries(draft);
  if (!entries.length) return null;
  for (const [key, value] of entries) {
    const field = THRESHOLDS.find(item => item.key === key);
    if (field?.nullable && (value === null || String(value).trim() === '')) continue;
    const number = Number(value);
    if (!field || String(value).trim() === '' || !Number.isSafeInteger(number) || number < field.min || number > field.max) return null;
  }
  return Object.fromEntries(entries.map(([key, value]) => [key, THRESHOLDS.find(field => field.key === key)?.nullable && (value === null || String(value).trim() === '') ? null : Number(value)]));
}

export function configurationPatch(draft) {
  const numeric = Object.fromEntries(Object.entries(draft).filter(([key]) => THRESHOLDS.some(field => field.key === key)));
  const patch = Object.keys(numeric).length ? thresholdPatch(numeric) : {};
  if (!patch || !Object.keys(draft).length) return null;
  for (const [key, value] of Object.entries(draft)) {
    if (Object.hasOwn(patch, key)) continue;
    const field = CONFIGURATION_FIELDS.find(item => item.key === key);
    if (!field || (field.list ? !Array.isArray(value) || value.length > 100 || value.some(item => typeof item !== 'string' || item.length > 500) : !field.options.includes(value))) return null;
    patch[key] = value;
  }
  return patch;
}
