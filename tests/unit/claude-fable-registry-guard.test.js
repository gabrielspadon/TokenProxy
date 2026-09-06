import { describe, it, expect } from 'vitest';
import claudeRegistry from 'open-sse/providers/registry/claude.js';
import {
  getModelInfoCore,
  resolveBareModelStaticOwner,
  ModelNotFoundError,
} from 'open-sse/services/model.js';

// ANTI-REVERT GUARD (ec62de2b). Bare "claude-fable-5-1" once resolved to no
// static owner because the registry row was missing, so getModelInfoCore threw
// ModelNotFoundError for a model the pool serves every day. These tests fail
// loudly if the row is removed again, and pin the 404 error contract for a
// genuinely unknown model so it never regresses to a 500 shape.

describe('claude registry declares the Fable lane (ec62de2b)', () => {
  it('keeps claude-fable-5-1 in the static model catalog', () => {
    expect(claudeRegistry.models.map((m) => m.id)).toContain('claude-fable-5-1');
  });

  it('resolves bare claude-fable-5-1 to the claude provider', () => {
    expect(resolveBareModelStaticOwner('claude-fable-5-1')).toBe('claude');
  });

  it('routes bare claude-fable-5-1 through getModelInfoCore without an alias map', async () => {
    await expect(getModelInfoCore('claude-fable-5-1', {})).resolves.toEqual({
      provider: 'claude',
      model: 'claude-fable-5-1',
    });
  });

  it('keeps every routed Claude lane declared, so no sibling row silently drops', () => {
    // Shape over the registry export, not a restated catalog: every declared
    // row is a unique bare id with a static owner, so no row's bare requests
    // can fall through to ModelNotFoundError (the ec62de2b failure mode). A
    // shared id may resolve to another declaring provider; null is the bug.
    const ids = claudeRegistry.models.map((m) => m.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate rows
    for (const id of ids) {
      expect(typeof id).toBe('string');
      expect(resolveBareModelStaticOwner(id), `no static owner for ${id}`).not.toBeNull();
    }
  });
});

describe('unknown bare model rejection keeps the 404 contract', () => {
  it('throws ModelNotFoundError with status 404 / invalid_request_error / model_not_found', async () => {
    await expect(getModelInfoCore('claude-fable-99-does-not-exist', {})).rejects.toBeInstanceOf(
      ModelNotFoundError
    );
    // The full client-visible shape, not just the status: a route catching this
    // builds its error body from these exact fields, and any drift here turns a
    // clean 404 into a 500 for the caller.
    await expect(getModelInfoCore('claude-fable-99-does-not-exist', {})).rejects.toMatchObject({
      status: 404,
      type: 'invalid_request_error',
      code: 'model_not_found',
      model: 'claude-fable-99-does-not-exist',
      message: expect.stringContaining('claude-fable-99-does-not-exist'),
    });
  });

  it('the error class itself carries the contract fields for any model name', () => {
    const err = new ModelNotFoundError('x');
    expect(err.status).toBe(404);
    expect(err.type).toBe('invalid_request_error');
    expect(err.code).toBe('model_not_found');
  });
});
