// Regression: translateResponse()'s same-format fast path returned streamed
// chunks untouched. translateRequest() suffixes client tool names with
// CLAUDE_TOOL_SUFFIX for OAuth-cloaked Claude providers even when no format
// conversion is needed, so a tool_use content_block_start reached the client
// carrying the cloaked name ("run_code_ide") and the call was rejected as an
// unknown tool. The stream-layer passthrough already decloaks
// (streamHelpers.decloakClaudePassthroughToolUse); this covers the exported
// translateResponse() contract, which any engine consumer can call directly.
import { describe, expect, it } from 'vitest';

import { translateResponse } from 'open-sse/translator/index.js';
import { FORMATS } from 'open-sse/translator/formats.js';
import { CLAUDE_TOOL_SUFFIX } from 'open-sse/config/appConstants.js';

const CLOAKED = `run_code${CLAUDE_TOOL_SUFFIX}`;

const toolUseStart = (name) => ({
  type: 'content_block_start',
  index: 1,
  content_block: { type: 'tool_use', id: 'toolu_01XYZ', name, input: {} },
});

describe('translateResponse same-format passthrough (OAuth tool cloak)', () => {
  const state = () => ({ toolNameMap: new Map([[CLOAKED, 'run_code']]) });

  it('restores the original tool name on tool_use content_block_start', () => {
    const [out] = translateResponse(FORMATS.CLAUDE, FORMATS.CLAUDE, toolUseStart(CLOAKED), state());
    expect(out.content_block.name).toBe('run_code');
  });

  it('leaves an uncloaked chunk untouched', () => {
    // Decoy name — declared to the provider unsuffixed, so it is not in the map.
    // "Untouched" is the VALUE, not the object: translateResponse hands back a
    // private copy so the caller's chunk survives translation unmodified.
    const decoy = toolUseStart('Bash');
    const [out] = translateResponse(FORMATS.CLAUDE, FORMATS.CLAUDE, decoy, state());
    expect(out).toEqual(toolUseStart('Bash'));
    expect(decoy).toEqual(toolUseStart('Bash'));
    expect(out.content_block.name).toBe('Bash');

    const delta = {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{}' },
    };
    const deltaSource = structuredClone(delta);
    const [outDelta] = translateResponse(FORMATS.CLAUDE, FORMATS.CLAUDE, delta, state());
    expect(outDelta).toEqual(deltaSource);
    expect(delta).toEqual(deltaSource);
  });

  it('is a no-op without a cloak map, and on a non-Claude same-format stream', () => {
    const bare = toolUseStart(CLOAKED);
    expect(translateResponse(FORMATS.CLAUDE, FORMATS.CLAUDE, bare, {})[0].content_block.name).toBe(
      CLOAKED
    );

    const openaiChunk = { choices: [{ delta: { content: 'hi' } }] };
    const [out] = translateResponse(FORMATS.OPENAI, FORMATS.OPENAI, openaiChunk, state());
    expect(out).toEqual({ choices: [{ delta: { content: 'hi' } }] });
    expect(openaiChunk).toEqual({ choices: [{ delta: { content: 'hi' } }] });
  });

  it('still emits nothing for the null flush chunk', () => {
    expect(translateResponse(FORMATS.CLAUDE, FORMATS.CLAUDE, null, state())).toEqual([]);
  });
});
