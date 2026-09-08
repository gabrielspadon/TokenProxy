import { expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { buildSession, turnBodies } from '../qa/saver-audit/fixture.mjs';
import { CANONICAL_ORDER, newCtx, runPipeline, invariants } from '../qa/saver-audit/stages.mjs';
import { STAGE_ORDER } from '../../src/lib/shaping/evaluate.mjs';
import { estimateRequestTokens } from '../../open-sse/services/memory/contextBudget.js';
import { memoClear } from '../../open-sse/services/memory/sessionMemo.js';
import { redactOutbound } from '../../open-sse/utils/privacyFilter.js';

const configurations = () => {
  const output = [[]];
  for (const stage of CANONICAL_ORDER) output.push([stage]);
  for (let i = 0; i < CANONICAL_ORDER.length; i++) for (let j = i + 1; j < CANONICAL_ORDER.length; j++) output.push([CANONICAL_ORDER[i], CANONICAL_ORDER[j]]);
  for (let count = 3; count <= CANONICAL_ORDER.length; count++) output.push(CANONICAL_ORDER.slice(0, count));
  return output;
};

it('covers all stage families alone, all ordered pairs, every group size and the full ordered pipeline', async () => {
  expect(CANONICAL_ORDER).toEqual(STAGE_ORDER);
  const rejectNetwork = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Unexpected external service call'); });
  const cases = turnBodies(buildSession({ rounds: 12, tools: 16, seed: 79 })).slice(-2);
  const records = [], configs = configurations();
  const estimates = cases.map(value => estimateRequestTokens(value.body));
  try {
    for (const regime of ['wide', 'pressure']) for (let index = 0; index < configs.length; index++) {
      const order = configs[index], window = regime === 'wide' ? estimates.at(-1) * 8 : Math.max(8192, Math.round(estimates.at(-1) * 0.48));
      for (let turn = 0; turn < cases.length; turn++) {
        memoClear();
        const body = cases[turn].body;
        const ctx = newCtx({ sid: `coverage-${regime}-${index}`, connectionId: `coverage-${regime}-${index}`,
          contextWindow: window, order, settings: { toolDisclosure: { filterEnabled: true, disclosureEnabled: true, maxTools: 12 },
            memoryToolPruningEnabled: true, memoryMediaPruningEnabled: true, memoryCompactionEnabled: true, memoryMaxToolTurnsKeepFull: 8,
            pxpipeAllowLossy: true, epochConsent: true, memoryHandoffEnabled: true, privacyTerms: [], cavemanLevel: 'full', ponytailLevel: 'full' } });
        const result = await runPipeline(body, order, ctx), expectedContent = structuredClone(body);
        if (order.includes('privacy')) redactOutbound(expectedContent, []);
        const violations = invariants(expectedContent, result.body, ctx);
        const item = { regime, order, turn, beforeBytes: result.entryBytes, afterBytes: result.finalBytes,
          ledger: result.ledger, anchorDeltaBytes: result.anchorDeltaBytes, localMs: result.ms, violations, errors: ctx.errors, serviceFixtures: ctx.serviceFixtures,
          capacity: violations.includes('over-window') ? 'Still over the fixture window; no claim that selected stages make it fit' : 'Within fixture window estimate' };
        records.push(item);
        expect(violations.filter(code => code !== 'over-window'), `${regime} ${order.join('>')} turn ${turn}`).toEqual([]);
        expect(ctx.errors, `${regime} ${order.join('>')} errors`).toEqual([]);
        expect(result.ledger.reduce((sum, stage) => sum + stage.deltaBytes, result.anchorDeltaBytes)).toBe(result.finalBytes - result.entryBytes);
      }
    }
    expect(configs.filter(order => order.length === 1)).toHaveLength(18);
    expect(configs.filter(order => order.length === 2)).toHaveLength(153);
  } finally {
    rejectNetwork.mockRestore(); memoClear();
    if (process.env.SHAPING_COVERAGE_REPORT) writeFileSync(process.env.SHAPING_COVERAGE_REPORT, JSON.stringify({
      stageFamilies: CANONICAL_ORDER, settingsVariants: 'Production family wrappers with explicit fixture consent; individual switch and failure guards remain in focused regression suites.',
      configurationCount: configs.length, regimes: ['wide', 'pressure'], turnsPerConfiguration: cases.length, completedRecords: records.length,
      grouping: 'all singletons, all ordered pairs, canonical prefix groups of sizes 3 through 18; not all 262143 subsets or alternate mutation orders',
      evidence: 'Local UTF-8 byte ledger and protocol invariants. No billed-token, monetary, service-quality, or task-outcome claim. Epoch cut is a fixture boundary.',
      runtime: process.version, externalCalls: 0, records,
    }, null, 2));
  }
}, 120000);

it.each(['pxpipe', 'diet', 'lingua', 'epochMicro', 'epochAuto', 'handoff'])('keeps %s content changes disabled without the fixture opt-in', async stage => {
  const body = turnBodies(buildSession({ rounds: 10, tools: 10, seed: 80 })).at(-1).body;
  const settings = { pxpipeAllowLossy: false, epochConsent: false };
  const baseline = await runPipeline(body, [], newCtx({ settings, contextWindow: 8192, order: [] }));
  const result = await runPipeline(body, [stage], newCtx({ settings, contextWindow: 8192, order: [stage] }));
  expect(result.body).toEqual(baseline.body);
});
