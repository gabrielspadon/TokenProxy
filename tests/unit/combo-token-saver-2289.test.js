// #2289 / #2037: token saving was global, so turning it on for a coding combo
// also rewrote prompts for translation and creative-writing combos. A combo may
// now declare its own settings in settings.comboStrategies[<name>].tokenSaver,
// beside the strategy fields that bag already carries.
//
// The load-bearing property is the last one in this file: a combo that declares
// nothing resolves to the global flags, byte for byte.
import { describe, it, expect } from 'vitest';
import { resolveComboTokenSaver } from '../../open-sse/services/combo.js';

const GLOBAL = {
  rtkEnabled: true,
  schemaDistillEnabled: false,
  headroomEnabled: true,
  cavemanEnabled: false,
  ponytailEnabled: false,
  pxpipeEnabled: true,
  thinkingStripEnabled: false,
  queryAwareCompressionEnabled: false,
  pairDropEnabled: false,
  embedReorderEnabled: false,
  midPrefixInjectEnabled: false,
  epochMicroEnabled: false,
  epochAutoEnabled: false,
  dietEnabled: false,
};

const ALL_OFF = {
  rtkEnabled: false,
  schemaDistillEnabled: false,
  headroomEnabled: false,
  cavemanEnabled: false,
  ponytailEnabled: false,
  pxpipeEnabled: false,
  thinkingStripEnabled: false,
  queryAwareCompressionEnabled: false,
  pairDropEnabled: false,
  embedReorderEnabled: false,
  midPrefixInjectEnabled: false,
  epochMicroEnabled: false,
  epochAutoEnabled: false,
  dietEnabled: false,
};

function settings(comboStrategies) {
  return { ...GLOBAL, comboStrategies };
}

describe('#2289 per-combo token-saver overrides', () => {
  it('turns every saver off for a combo that says enabled: false', () => {
    const resolved = resolveComboTokenSaver(
      new Set(['general']),
      settings({
        general: { tokenSaver: { enabled: false } },
      })
    );
    expect(resolved).toEqual(ALL_OFF);
  });

  it('accepts the boolean shorthand the report asks for', () => {
    expect(
      resolveComboTokenSaver('translation', settings({ translation: { tokenSaver: false } }))
    ).toEqual(ALL_OFF);
  });

  it('turns a single saver on for a combo while the global stays off', () => {
    const resolved = resolveComboTokenSaver(
      ['coding'],
      settings({
        coding: { tokenSaver: { ponytail: true } },
      })
    );
    expect(resolved).toEqual({ ...GLOBAL, ponytailEnabled: true });
  });

  it("lets a per-saver key outrank the combo's own enabled: false", () => {
    const resolved = resolveComboTokenSaver(
      new Set(['coding']),
      settings({
        coding: { tokenSaver: { enabled: false, rtk: true } },
      })
    );
    expect(resolved).toEqual({ ...ALL_OFF, rtkEnabled: true });
  });

  it('leaves the globals alone for enabled: true, the way the master gate does', () => {
    expect(
      resolveComboTokenSaver(
        new Set(['coding']),
        settings({ coding: { tokenSaver: { enabled: true } } })
      )
    ).toEqual(GLOBAL);
  });

  it('keeps the strategy fields the same bag already carries working', () => {
    const bag = { coding: { fallbackStrategy: 'round-robin', tokenSaver: { headroom: false } } };
    expect(resolveComboTokenSaver(new Set(['coding']), settings(bag))).toEqual({
      ...GLOBAL,
      headroomEnabled: false,
    });
    expect(bag.coding.fallbackStrategy).toBe('round-robin');
  });

  it('gives the outermost combo in a nested chain the decision', () => {
    // The chain is the chat handler's cycle-guard Set: the name the client sent
    // first, then each member combo expanded under it.
    const chain = new Set(['general', 'coding']);
    const resolved = resolveComboTokenSaver(
      chain,
      settings({
        general: { tokenSaver: { enabled: false } },
        coding: { tokenSaver: { rtk: true, headroom: true } },
      })
    );
    expect(resolved).toEqual(ALL_OFF);
  });

  it('falls through to a member combo when the outer one declares nothing', () => {
    const resolved = resolveComboTokenSaver(
      new Set(['general', 'coding']),
      settings({
        general: { fallbackStrategy: 'fallback' },
        coding: { tokenSaver: { enabled: false } },
      })
    );
    expect(resolved).toEqual(ALL_OFF);
  });

  it('ignores an inherited property, since a combo may legally be named constructor', () => {
    expect(resolveComboTokenSaver(new Set(['constructor', 'toString']), settings({}))).toEqual(
      GLOBAL
    );
  });

  it('ignores a malformed override rather than throwing', () => {
    for (const tokenSaver of [null, [], 'off', 0]) {
      expect(
        resolveComboTokenSaver(new Set(['coding']), settings({ coding: { tokenSaver } }))
      ).toEqual(GLOBAL);
    }
  });

  it('returns the global flags unchanged when nothing declares an override', () => {
    for (const chain of [new Set(['coding']), ['coding'], 'coding', null, undefined, new Set()]) {
      expect(resolveComboTokenSaver(chain, settings({}))).toEqual(GLOBAL);
      expect(resolveComboTokenSaver(chain, GLOBAL)).toEqual(GLOBAL);
    }
    // …and a bare settings object still resolves to booleans, never undefined.
    expect(resolveComboTokenSaver(new Set(['coding']), {})).toEqual(ALL_OFF);
    expect(resolveComboTokenSaver(null, undefined)).toEqual(ALL_OFF);
  });
});
