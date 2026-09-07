import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { KeyLifecycle } from '@/app/dashboard/keys/KeyLifecycle.js';

// The panel renders from whatever the keys list carries, and the list carries
// nulls by design. These assert the unknown paths produce a sentence rather
// than a crash or a misleading zero.
const base = { id: 'k1', name: 'Client key', profile: null, rotation: null, attribution: null };
const html = (record, profiles = []) =>
  renderToStaticMarkup(
    <KeyLifecycle record={record} profiles={profiles} now={Date.parse('2026-06-01T00:00:00Z')} />
  );

it('says a key with nothing recorded is unknown, never zero', () => {
  const out = html(base);
  expect(out).toContain('Managed by hand');
  expect(out).toContain('No attributed request is retained');
  // A rotation panel for a key that never rotated would be noise.
  expect(out).not.toContain('Successor');
});

it('names the drifted fields and the profile it drifted from', () => {
  const out = html({
    ...base,
    profile: {
      profileId: 'p1',
      profileName: 'Read-only agents',
      adoptedVersion: 1,
      currentVersion: 1,
      behind: false,
      drifted: true,
      driftedFields: ['maxCostUsd'],
      baseline: 'adopted-version',
    },
  });
  expect(out).toContain('Read-only agents');
  expect(out).toContain('maxCostUsd');
  expect(out).toContain('changed away from the version it adopted');
});

// The two signals stay distinguishable in the rendered output, not just in the
// payload: an operator reading the panel must be able to tell them apart.
it('distinguishes behind from drifted in the rendered copy', () => {
  const behind = html({
    ...base,
    profile: {
      profileId: 'p1',
      profileName: 'Bundle',
      adoptedVersion: 1,
      currentVersion: 3,
      behind: true,
      drifted: false,
      driftedFields: [],
      baseline: 'adopted-version',
    },
  });
  expect(behind).toContain('matches the version it adopted');
  expect(behind).toContain('has since moved on');
  expect(behind).not.toContain('changed away from');
});

it('reports an unavailable baseline rather than vouching for the key', () => {
  const out = html({
    ...base,
    profile: {
      profileId: 'gone',
      profileName: null,
      adoptedVersion: 2,
      currentVersion: null,
      behind: false,
      drifted: false,
      driftedFields: [],
      baseline: 'unavailable',
    },
  });
  expect(out).toContain('no longer retained');
  expect(out).not.toContain('matches the version it adopted');
});

it('gives a superseded key its deadline and a successor its lineage', () => {
  const superseded = html({
    ...base,
    supersededAt: '2026-05-30T00:00:00Z',
    rotation: {
      role: 'superseded',
      counterpartKeyId: 'k2',
      rotatedAt: '2026-05-30T00:00:00Z',
      overlapEndsAt: '2026-06-03T00:00:00Z',
      overlapHours: 96,
    },
  });
  expect(superseded).toContain('successor');
  expect(superseded).toContain('k2');
  expect(superseded).toContain('stops on its next use');

  const successor = html({
    ...base,
    rotation: {
      role: 'successor',
      counterpartKeyId: 'k1',
      rotatedAt: '2026-05-30T00:00:00Z',
      overlapEndsAt: '2026-06-03T00:00:00Z',
      overlapHours: 96,
    },
  });
  expect(successor).toContain('replaced an earlier one');
  expect(successor).not.toContain('stops on its next use');
});

it('separates a key whose requests named no client from one with no requests', () => {
  expect(
    html({
      ...base,
      attribution: {
        clientTool: null,
        lastSeenAt: null,
        requests: 4,
        distinctClients: 0,
        attribution: 'unattributed',
      },
    })
  ).toContain('named no client');
  expect(
    html({
      ...base,
      attribution: {
        clientTool: 'claude-code',
        lastSeenAt: '2026-05-31T00:00:00Z',
        requests: 4,
        distinctClients: 1,
        attribution: 'observed',
      },
    })
  ).toContain('claude-code');
});

it('does not present an edited expiry as the original overlap deadline', () => {
  const out = html({ ...base, expiresAt: null, rotation: { role: 'superseded', counterpartKeyId: 'k2', rotatedAt: '2026-05-30T00:00:00Z', overlapEndsAt: '2026-06-03T00:00:00Z', overlapHours: 96 } });
  expect(out).toContain('expiry changed after rotation');
  expect(out).toContain('Current expiry is not set');
  expect(out).not.toContain('stops on its next use');
});
