import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getAdapter } from "../../src/lib/db/driver.js";
import { saveRequestStats } from "../../src/lib/db/repos/requestStatsRepo.js";
import { getContextSession } from "../../src/lib/db/repos/contextRepo.js";

// Presence flags are what let the dashboard say "Unknown" instead of a
// confident zero. They are captured from the RAW provider tokens, because
// canonicalizeUsage synthesizes cache_creation_input_tokens: 0 and so cannot
// tell an unreported write from a reported one.
//
// contextRepo previously checked a local flat key list for the write while
// checking nested keys for the read. OpenAI reports its write nested, at
// input_tokens_details.cache_write_tokens, so a documented write persisted as
// cacheWritePresent=0. Resolution now goes through resolveCacheTokens.
//
// Exercised against a real SQLite file through the public Context query, not
// by asserting on the resolver directly.
let db;
const now = new Date().toISOString();
const SESSION = "c".repeat(32);

function detail(id, tokens, patch = {}) {
  return {
    id, timestamp: now, provider: "codex", model: "gpt-5.6-sol",
    connectionId: "account-presence", status: "success", tokens,
    ...patch,
    contextTelemetry: {
      requestId: id, sessionHash: SESSION, identitySource: "routing",
      logicalRequestId: id, attempt: 1, clientTool: "codex", stages: [],
      ...patch.contextTelemetry,
    },
  };
}

async function turnFor(id) {
  // Expose this owned request fixture to the public analytics filter.
  db.run("UPDATE requestStats SET dataOrigin='unknown' WHERE id=?", [id]);
  // contextSessions.id autoincrements across the whole file, so resolve it
  // from the row rather than assuming 1 after a per-test delete.
  const sessionId = db.get("SELECT contextSessionId FROM requestStats WHERE id=?", [id]).contextSessionId;
  const session = await getContextSession(sessionId, {});
  return session.turns.find((turn) => turn.id === id);
}

beforeAll(async () => { db = await getAdapter(); });
beforeEach(() => {
  db.run("DELETE FROM requestStats");
  db.run("DELETE FROM contextSessions");
});

describe("cache write presence survives real persistence", () => {
  it("records a nested OpenAI write as present and returns the count", async () => {
    await saveRequestStats(detail("nested-write", {
      input_tokens: 20000, output_tokens: 500,
      input_tokens_details: { cached_tokens: 12000, cache_write_tokens: 6000 },
    }));
    const row = db.get("SELECT cacheWritePresent,cacheReadPresent,cacheCreationTokens,promptTokens FROM requestStats WHERE id=?", ["nested-write"]);
    expect(row.cacheWritePresent).toBe(1);
    expect(row.cacheReadPresent).toBe(1);
    expect(row.cacheCreationTokens).toBe(6000);
    // OpenAI accounting is inclusive: the write must not inflate input.
    expect(row.promptTokens).toBe(20000);
    expect(await turnFor("nested-write")).toMatchObject({
      cacheWriteTokens: 6000, cacheReadTokens: 12000, providerInputTokens: 20000, usageSource: "provider",
    });
  });

  it("distinguishes a reported zero write from an absent one at the query boundary", async () => {
    await saveRequestStats(detail("zero-write", {
      input_tokens: 5000, input_tokens_details: { cached_tokens: 3000, cache_write_tokens: 0 },
    }));
    await saveRequestStats(detail("absent-write", {
      input_tokens: 5000, input_tokens_details: { cached_tokens: 3000 },
    }));

    // Both store 0 in the token column; only the flag separates them.
    for (const id of ["zero-write", "absent-write"]) {
      expect(db.get("SELECT cacheCreationTokens FROM requestStats WHERE id=?", [id]).cacheCreationTokens).toBe(0);
    }
    expect(db.get("SELECT cacheWritePresent FROM requestStats WHERE id=?", ["zero-write"]).cacheWritePresent).toBe(1);
    expect(db.get("SELECT cacheWritePresent FROM requestStats WHERE id=?", ["absent-write"]).cacheWritePresent).toBe(0);

    // The public projection is where it matters: a real zero, versus Unknown.
    expect((await turnFor("zero-write")).cacheWriteTokens).toBe(0);
    expect((await turnFor("absent-write")).cacheWriteTokens).toBeNull();
  });

  it("keeps the Anthropic exclusive fold and flags both quantities", async () => {
    await saveRequestStats(detail("claude-shape", {
      input_tokens: 100, output_tokens: 10,
      cache_read_input_tokens: 1800, cache_creation_input_tokens: 248,
    }, { provider: "claude", model: "claude-opus-5" }));
    const row = db.get("SELECT promptTokens,cachedTokens,cacheCreationTokens,cacheWritePresent,cacheReadPresent FROM requestStats WHERE id=?", ["claude-shape"]);
    // Exclusive: prompt EXCLUDES cache upstream, so it folds to 100+1800+248.
    expect(row.promptTokens).toBe(2148);
    expect(row.cachedTokens).toBe(1800);
    expect(row.cacheCreationTokens).toBe(248);
    expect(row.cacheWritePresent).toBe(1);
    expect(row.cacheReadPresent).toBe(1);
  });

  it("marks estimated usage as estimated rather than provider-reported", async () => {
    await saveRequestStats(detail("estimated", {
      prompt_tokens: 400, completion_tokens: 20, estimated: true,
    }));
    expect(db.get("SELECT usageSource FROM requestStats WHERE id=?", ["estimated"]).usageSource).toBe("estimated");
    // An estimate is not a provider observation, so the Context projection
    // withholds the token counts rather than presenting them as measured.
    expect(await turnFor("estimated")).toMatchObject({ usageSource: "estimated", providerInputTokens: null, cacheWriteTokens: null });
  });

  it("reports no usage at all as missing", async () => {
    await saveRequestStats(detail("no-usage", null));
    const row = db.get("SELECT usageSource,cacheWritePresent,cacheReadPresent FROM requestStats WHERE id=?", ["no-usage"]);
    expect(row.usageSource).toBe("missing");
    expect(row.cacheWritePresent).toBe(0);
    expect(row.cacheReadPresent).toBe(0);
    expect((await turnFor("no-usage")).cacheWriteTokens).toBeNull();
  });

  it("is idempotent: re-saving the same attempt does not re-fold or drop the flag", async () => {
    const tokens = { input_tokens: 20000, output_tokens: 500,
      input_tokens_details: { cached_tokens: 12000, cache_write_tokens: 6000 } };
    await saveRequestStats(detail("repeat", tokens));
    await saveRequestStats(detail("repeat", tokens));
    const row = db.get("SELECT promptTokens,cacheCreationTokens,cacheWritePresent FROM requestStats WHERE id=?", ["repeat"]);
    expect(row.promptTokens).toBe(20000);
    expect(row.cacheCreationTokens).toBe(6000);
    expect(row.cacheWritePresent).toBe(1);
  });

  it("keeps Responses reasoning tokens through persistence", async () => {
    await saveRequestStats(detail("reasoning", {
      input_tokens: 9000, output_tokens: 800,
      input_tokens_details: { cached_tokens: 4000 },
      output_tokens_details: { reasoning_tokens: 300 },
    }));
    expect(db.get("SELECT reasoningTokens FROM requestStats WHERE id=?", ["reasoning"]).reasoningTokens).toBe(300);
  });
});
