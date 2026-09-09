import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { fixtureSet } from './fixtures.mjs';
import { distillToolSchemas } from '../../../open-sse/utils/schemaDistiller.js';
import { stripHistoricalThinking } from '../../../open-sse/utils/thinkingStrip.js';
import { compressMessages } from '../../../open-sse/rtk/index.js';
import { redactOutbound } from '../../../open-sse/utils/privacyFilter.js';
import { injectCaveman } from '../../../open-sse/rtk/caveman.js';
import { injectPonytail } from '../../../open-sse/rtk/ponytail.js';
import { applyMemoryEnhancements } from '../../../open-sse/services/memory/index.js';
import { measureContextPressure, CHARS_PER_TOKEN } from '../../../open-sse/services/memory/contextBudget.js';
import { compressPrefixByQuery } from '../../../open-sse/utils/queryAwareCompress.js';
import { dropOldestPairs } from '../../../open-sse/utils/pairDropper.js';
import { composeBoundaryNote, injectBoundaryNote } from '../../../open-sse/utils/midPrefixInject.js';
import { stageErrorCode } from '../../../open-sse/utils/stageOutcome.js';

// The parity gate checks this against chatCore's ledger boundaries. These
// are the same transformations, evaluated before final wire/cache anchoring.
export const STAGE_ORDER = ['tools', 'schema', 'thinking', 'rtk', 'privacy', 'inject', 'pxpipe', 'mem', 'headroom', 'qac', 'pairs', 'diet', 'lingua', 'epochMicro', 'epochAuto', 'reorder', 'midinject', 'handoff'];
const digest = encoded => createHash('sha256').update(encoded).digest('hex');
const text = message => typeof message?.content === 'string' ? message.content : (message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
function validity(original, body) {
  const issues = [], calls = new Set(), results = new Set(), tools = new Map((body.tools || []).map(t => [t.name, t]));
  for (const message of body.messages || []) for (const block of Array.isArray(message.content) ? message.content : []) {
    if (block.type === 'tool_use') {
      if (calls.has(block.id) || !tools.has(block.name) || !block.input || typeof block.input !== 'object') issues.push('invalid_tool_call');
      calls.add(block.id);
      const schema = tools.get(block.name)?.input_schema;
      for (const key of schema?.required || []) if (!Object.hasOwn(block.input || {}, key)) issues.push('missing_required_tool_argument');
      for (const [key, property] of Object.entries(schema?.properties || {})) if (property.enum && Object.hasOwn(block.input || {}, key) && !property.enum.includes(block.input[key])) issues.push('invalid_enum_argument');
    }
    if (block.type === 'tool_result') { if (!calls.has(block.tool_use_id) || results.has(block.tool_use_id)) issues.push('orphan_or_duplicate_tool_result'); results.add(block.tool_use_id); }
  }
  if ([...calls].some(id => !results.has(id))) issues.push('unresolved_tool_call');
  const originalCurrent = original.messages.at(-1), current = body.messages.at(-1);
  const currentBlocks = Array.isArray(originalCurrent.content) ? originalCurrent.content.filter(block => block.type !== 'text') : [];
  const currentPreserved = current?.role === originalCurrent.role && text(current).includes(text(originalCurrent)) &&
    currentBlocks.every(block => Array.isArray(current.content) && current.content.some(value => JSON.stringify(value) === JSON.stringify(block)));
  const liveAssistant = original.messages.findLast(message => message.role === 'assistant');
  const live = Array.isArray(liveAssistant?.content) ? liveAssistant.content.filter(block => ['thinking', 'redacted_thinking'].includes(block.type)) : [];
  const livePreserved = live.every(block => body.messages.some(message => Array.isArray(message.content) && message.content.some(value => JSON.stringify(value) === JSON.stringify(block))));
  const errors = original.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === 'tool_result' && b.is_error) : []);
  const errorsPreserved = errors.every(error => body.messages.some(m => Array.isArray(m.content) && m.content.some(b => JSON.stringify(b) === JSON.stringify(error))));
  return { toolTransactionsValid: issues.length === 0, issues, schemaValidation: 'Fixture required properties and enum values only; not a general JSON Schema validator.', currentPreserved, liveThinkingPreserved: livePreserved, liveThinkingCount: live.length, errorEvidencePreserved: errorsPreserved };
}
export async function evaluateSettings(settings, fixtureSetId, { fixtures = fixtureSet(fixtureSetId) } = {}) {
  const results = [];
  for (const fixture of fixtures) {
    let body = structuredClone(fixture.body), memStats = null;
    const originalEncoded = JSON.stringify(fixture.body), originalBytes = Buffer.byteLength(originalEncoded);
    let encoded = originalEncoded, bodyBytes = originalBytes;
    const stages = [], notes = [], started = performance.now();
    const pressure = () => measureContextPressure(body, { contextWindow: fixture.contextWindow, settings, calibration: 1 });
    const mayDecide = () => (settings.memoryToolPruningEnabled || settings.memoryMediaPruningEnabled || settings.memoryCompactionEnabled) ? memStats?.budget?.overAfter === true : true;
    async function stage(name, enabled, run, unsupported) {
      const beforeBytes = bodyBytes, before = encoded, start = performance.now();
      let status = enabled ? unsupported ? 'unsupported' : 'unchanged' : 'disabled', error = null, errorCode = null;
      if (enabled && !unsupported) {
        try { await run(); encoded = JSON.stringify(body); bodyBytes = Buffer.byteLength(encoded); status = encoded === before ? 'unchanged' : 'changed'; }
        catch (caught) { body = JSON.parse(before); encoded = before; bodyBytes = beforeBytes; status = 'error'; errorCode = stageErrorCode(caught); error = 'Local stage failed; its original input was restored.'; }
      }
      stages.push({ stage: name, status, beforeBytes, afterBytes: bodyBytes, deltaBytes: bodyBytes - beforeBytes, latencyMs: performance.now() - start, error, errorCode, reason: enabled ? unsupported || null : null });
    }
    await stage('tools', settings.toolDisclosureEnabled || settings.toolDisclosureFilterEnabled, null, 'Session-sticky tool disclosure and runtime tool catalog are outside this fresh-context fixture.');
    await stage('schema', settings.schemaDistillEnabled, () => { body.tools = distillToolSchemas(body.tools, { allowLossy: settings.schemaAllowLossy }).tools; });
    await stage('thinking', settings.thinkingStripEnabled, () => {
      const result = stripHistoricalThinking(body.messages, { keepRecentTurns: 1 }); body.messages = result.messages;
      if (result.stripped) notes.push({ kind: 'thinking', text: `stripped ${result.stripped} reasoning block(s)` });
    });
    await stage('rtk', settings.rtkEnabled, () => {
      const diagnostics = {}; compressMessages(body, true, { allowLossy: settings.rtkAllowLossy, diagnostics });
      if (diagnostics.outcome === 'failed') throw Object.assign(new Error(diagnostics.errorCode), { code: diagnostics.errorCode });
    });
    await stage('privacy', settings.privacyFilterEnabled, () => redactOutbound(body, settings.privacyFilterTerms));
    await stage('inject', settings.cavemanEnabled || settings.ponytailEnabled, () => {
      if (settings.cavemanEnabled) injectCaveman(body, 'claude', settings.cavemanLevel);
      if (settings.ponytailEnabled) injectPonytail(body, 'claude', settings.ponytailLevel);
    });
    await stage('pxpipe', settings.pxpipeEnabled, null, 'External visual compression is never contacted.');
    await stage('mem', settings.memoryToolPruningEnabled || settings.memoryMediaPruningEnabled || settings.memoryCompactionEnabled, async () => {
      const result = await applyMemoryEnhancements(body, { settings: { ...settings, memoryHandoffEnabled: false }, targetFormat: 'claude', contextWindow: fixture.contextWindow, calibration: 1 });
      if (result.outcome === 'failed') throw Object.assign(new Error(result.errorCode), { code: result.errorCode });
      body = result.body; memStats = result.stats;
    });
    await stage('headroom', settings.headroomEnabled, null, 'External compression is never contacted.');
    await stage('qac', settings.queryAwareCompressionEnabled, () => {
      const result = compressPrefixByQuery(body.messages, { query: text(body.messages.at(-1)), keepRecentTurns: 2, memo: new Set(), scoreNew: pressure().over && mayDecide() }); body.messages = result.messages;
      if (result.compressed) notes.push({ kind: 'qac', text: `compressed ${result.compressed} low-relevance turn(s)` });
    });
    await stage('pairs', settings.pairDropEnabled, () => {
      const p = pressure(); if (!p.deficitChars || !mayDecide()) return;
      const chunk = Math.max(1, Math.ceil((p.budget - p.target) * (CHARS_PER_TOKEN / (p.calibration || 1))));
      const result = dropOldestPairs(body.messages, { deficitChars: Math.ceil(p.deficitChars / chunk) * chunk, keepRecentTurns: 6 }); body.messages = result.messages;
      if (result.droppedPairs) notes.push({ kind: 'pairs', text: `dropped ${result.droppedPairs} pair(s) (~${result.savedChars} chars)` });
    });
    await stage('diet', settings.dietEnabled, null, 'Expired tool-result pruning replays against the live request context; it is not reproduced on the synthetic fixture.');
    await stage('lingua', settings.linguaEnabled, null, 'LLMLingua-2 selective compression reads the session cache-epoch chain and a loopback sidecar; it is not reproduced on the synthetic fixture.');
    await stage('epochMicro', settings.epochMicroEnabled, null, 'Epoch-aligned micro-compaction reads the session cache-epoch chain; it is not reproduced on the synthetic fixture.');
    await stage('epochAuto', settings.epochAutoEnabled, null, 'Epoch-aligned auto-compaction reads the session cache-epoch chain; it is not reproduced on the synthetic fixture.');
    await stage('reorder', settings.embedReorderEnabled, null, 'Embedding service is never contacted.');
    await stage('midinject', settings.midPrefixInjectEnabled && notes.length > 0, () => { body.messages = injectBoundaryNote(body.messages, body.messages.length - 1, composeBoundaryNote(notes)).messages; });
    await stage('handoff', settings.memoryHandoffEnabled, null, 'Requires a retained, approved packet with exact project and session identity. Evaluation cases are not active client sessions.');
    const latencyMs = performance.now() - started;
    results.push({ fixtureId: fixture.id, contextWindow: fixture.contextWindow, beforeBytes: originalBytes, afterBytes: bodyBytes, deltaBytes: bodyBytes - originalBytes, beforeHash: digest(originalEncoded), afterHash: digest(encoded), latencyMs, stages, validity: validity(fixture.body, body), output: body });
  }
  return { results, unsupported: [...new Set(results.flatMap(r => r.stages.filter(s => s.status === 'unsupported').map(s => s.stage)).concat(settings.memoryHandoffEnabled ? ['handoff'] : []))], coverage: { fixtureCount: fixtures.length, format: 'claude', provider: 'synthetic third-party compatible', session: 'Fresh context per fixture; no live memo or calibration.', tokenCounts: null, tokenCountReason: 'No verified local tokenizer is configured. Internal pressure gates retain the gateway character heuristic; it is not reported as a token measurement.', providerCalls: 0, taskQuality: null, cost: null, cacheBilling: null, finalWireValidation: 'Not evaluated; final cache anchors, translation and provider execution are outside this stage evaluator.' } };
}
