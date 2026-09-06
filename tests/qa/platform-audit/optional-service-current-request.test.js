import { afterEach, describe, expect, it, vi } from 'vitest';
import { compressWithHeadroom } from '../../../open-sse/rtk/headroom.js';
import { compressWithPxpipe } from '../../../open-sse/rtk/pxpipe.js';
import { jsonCompact } from '../../../open-sse/rtk/filters/jsonCompact.js';
import { pressureFixture, mockVisualTransform, pressureViolations } from './pressure-fixture.mjs';

afterEach(() => vi.unstubAllGlobals());

describe('optional compression cannot erase the current request', () => {
  it.each([false, true])('rejects Headroom current-user changes with lossy consent %s', async (allowLossy) => {
    const body = pressureFixture();
    const before = structuredClone(body);
    vi.stubGlobal('fetch', async (_url, init) => {
      const { messages } = JSON.parse(init.body);
      for (const message of messages) for (const block of message.content || []) {
        if (block.type === 'tool_result' && typeof block.content === 'string') block.content = jsonCompact(block.content) ?? block.content;
      }
      messages.at(-1).content[0].text = 'Current requirements deleted by optional service.';
      return Response.json({ messages, tokens_before: 10000, tokens_after: 1000, tokens_saved: 9000 });
    });
    const result = await compressWithHeadroom(body, { enabled: true, allowLossy, format: 'claude', model: body.model, url: 'http://audit.invalid', contextPressure: { over: true }, compressUserMessages: false });
    expect(result).toBeNull();
    expect(body).toEqual(before);
  });

  it.each(['current-user', 'live-thinking'])('rejects PXPIPE loss of %s despite explicit visual consent', async (target) => {
    const body = pressureFixture();
    const before = structuredClone(body);
    const transform = (input) => {
      const rendered = mockVisualTransform(input);
      const changed = JSON.parse(new TextDecoder().decode(rendered.body));
      if (target === 'current-user') changed.messages.at(-1).content[0].text = 'Current request erased.';
      else changed.messages.at(-2).content[0].thinking = 'Live reasoning rewritten.';
      rendered.body = new TextEncoder().encode(JSON.stringify(changed));
      return rendered;
    };
    const result = await compressWithPxpipe(body, { enabled: true, allowLossy: true, format: 'claude', model: body.model, minChars: 1, transform });
    expect(result.summary.applied).toBe(false);
    expect(result.body).toBeNull();
    expect(body).toEqual(before);
  });

  it('detects pressure-oracle violations for current, schema, transaction and signed reasoning anchors', () => {
    const before = pressureFixture();
    const corruptions = [
      (body) => { body.messages.at(-1).content[0].text = 'current erased'; },
      (body) => { body.messages.at(-2).content[0].signature = 'signature changed'; },
      (body) => { body.tools[0].input_schema.properties.payload.const.default = 'literal changed'; },
      (body) => { body.messages.find((message) => message.content?.[0]?.type === 'tool_result').content[0].tool_use_id = 'orphan'; },
      (body) => { body.system[0].text = 'instruction lost'; },
    ];
    for (const corrupt of corruptions) {
      const candidate = structuredClone(before);
      corrupt(candidate);
      expect(pressureViolations(before, candidate, { allowLossy: true }).length).toBeGreaterThan(0);
    }
  });
});
