import { describe, it, expect } from 'vitest';
import claudeRegistry from 'open-sse/providers/registry/claude.js';
import { CLAUDE_CLI_SPOOF_HEADERS } from 'open-sse/providers/shared.js';
import { applyCloaking } from 'open-sse/utils/claudeCloaking.js';

// ANTI-REVERT GUARD (eaa10ad4). Anthropic gates claude-fable-5-1 behind
// claude-cli >= 2.1.251; the spoofed User-Agent was bumped to 2.1.261. A revert
// to 2.1.92 makes the whole Fable lane 403 while every unit test stays green,
// so pin a numeric FLOOR — not an exact string — on every place the version
// appears. Routine bumps pass; a revert fails.

const MIN_VERSION = [2, 1, 251];

function parseCliVersion(ua) {
  const m = /^claude-cli\/(\d+)\.(\d+)\.(\d+)\b/.exec(ua || '');
  expect(m, `not a claude-cli UA: ${JSON.stringify(ua)}`).not.toBeNull();
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function atLeast(actual, floor) {
  for (let i = 0; i < 3; i++) {
    if (actual[i] > floor[i]) return true;
    if (actual[i] < floor[i]) return false;
  }
  return true; // equal
}

describe('spoofed claude-cli version floor (eaa10ad4)', () => {
  it('registry transport User-Agent is claude-cli >= 2.1.251', () => {
    const v = parseCliVersion(claudeRegistry.transport.headers['User-Agent']);
    expect(atLeast(v, MIN_VERSION), `UA ${v.join('.')} < ${MIN_VERSION.join('.')}`).toBe(true);
  });

  it('CLAUDE_CLI_SPOOF_HEADERS (autoping + agentrouter fingerprint) is >= 2.1.251', () => {
    const v = parseCliVersion(CLAUDE_CLI_SPOOF_HEADERS['User-Agent']);
    expect(atLeast(v, MIN_VERSION), `UA ${v.join('.')} < ${MIN_VERSION.join('.')}`).toBe(true);
  });

  it('billing-header cc_version matches the same floor', () => {
    // claudeCloaking derives cc_version from its own CLAUDE_VERSION constant;
    // it must not lag the UA floor or the fingerprint self-contradicts.
    const body = applyCloaking({ messages: [] }, 'sk-ant-oat-test', 'sess-1');
    const billing = body.system[0].text;
    const m = /cc_version=(\d+)\.(\d+)\.(\d+)\./.exec(billing);
    expect(m, `no cc_version in: ${billing}`).not.toBeNull();
    const v = [Number(m[1]), Number(m[2]), Number(m[3])];
    expect(atLeast(v, MIN_VERSION), `cc_version ${v.join('.')} < ${MIN_VERSION.join('.')}`).toBe(
      true
    );
  });

  it('registry UA and shared spoof headers agree on one version', () => {
    // Two copies of the fingerprint exist; drifting apart is its own tell.
    expect(claudeRegistry.transport.headers['User-Agent']).toBe(
      CLAUDE_CLI_SPOOF_HEADERS['User-Agent']
    );
  });
});
