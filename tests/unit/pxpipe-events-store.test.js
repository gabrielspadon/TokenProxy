// Coverage for src/lib/pxpipe/events.js: append/rotate, read filters, and the
// getPxpipeStats aggregation. PXPIPE_DIR derives from DATA_DIR, which the
// per-file setup isolates to a tmp dir, so nothing here touches real state
// and no network exists in this module at all.
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  appendPxpipeEvent,
  readPxpipeEvents,
  getPxpipeStats,
} from "@/lib/pxpipe/events.js";
import { PXPIPE_DIR } from "@/lib/pxpipe/install.js";

const EVENTS_FILE = path.join(PXPIPE_DIR, "events.jsonl");
const ROTATED_FILE = path.join(PXPIPE_DIR, "events.jsonl.1");
const DAY_MS = 24 * 60 * 60 * 1000;

function writeEvents(file, events) {
  fs.mkdirSync(PXPIPE_DIR, { recursive: true });
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

beforeEach(() => {
  fs.rmSync(PXPIPE_DIR, { recursive: true, force: true });
});

describe("appendPxpipeEvent", () => {
  it("creates the dir and appends a timestamped JSONL line", async () => {
    appendPxpipeEvent({ applied: true, tokensSavedEst: 5 });
    await vi.waitFor(() => {
      expect(fs.existsSync(EVENTS_FILE)).toBe(true);
      expect(fs.readFileSync(EVENTS_FILE, "utf8")).toContain('"tokensSavedEst":5');
    });
    const ev = JSON.parse(fs.readFileSync(EVENTS_FILE, "utf8").trim());
    expect(typeof ev.ts).toBe("number");
    expect(ev.applied).toBe(true);
  });

  it("rotates the file once it exceeds the size cap", async () => {
    fs.mkdirSync(PXPIPE_DIR, { recursive: true });
    fs.writeFileSync(EVENTS_FILE, "x".repeat(5 * 1024 * 1024 + 1));
    appendPxpipeEvent({ applied: false });
    await vi.waitFor(() => {
      expect(fs.existsSync(ROTATED_FILE)).toBe(true);
      expect(fs.existsSync(EVENTS_FILE)).toBe(true);
    });
    expect(fs.statSync(EVENTS_FILE).size).toBeLessThan(1024);
  });

  it("never throws when the write path is unusable", () => {
    const spy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => {
      throw new Error("EACCES");
    });
    expect(() => appendPxpipeEvent({ applied: true })).not.toThrow();
    spy.mockRestore();
  });
});

describe("readPxpipeEvents", () => {
  it("merges rotated + current files sorted by ts, skipping corrupt lines", () => {
    writeEvents(ROTATED_FILE, [{ ts: 30, applied: true }, { ts: 10, applied: false }]);
    fs.appendFileSync(EVENTS_FILE, JSON.stringify({ ts: 20, applied: true }) + "\nnot-json\n");
    const out = readPxpipeEvents();
    expect(out.map((e) => e.ts)).toEqual([10, 20, 30]);
  });

  it("applies sinceMs and limit", () => {
    writeEvents(EVENTS_FILE, [{ ts: 1 }, { ts: 2 }, { ts: 3 }, { ts: 4 }]);
    expect(readPxpipeEvents({ sinceMs: 3 }).map((e) => e.ts)).toEqual([3, 4]);
    expect(readPxpipeEvents({ limit: 2 }).map((e) => e.ts)).toEqual([3, 4]);
  });

  it("returns empty when no files exist", () => {
    expect(readPxpipeEvents()).toEqual([]);
  });
});

describe("getPxpipeStats", () => {
  it("buckets events into windows and classifies applied/bypassed/errors", () => {
    // Local noon, not Date.now(): the timeline keys are UTC date strings cut
    // from LOCAL midnights, so an event stamped late evening in a UTC-negative
    // zone lands on the next UTC date and misses its bucket. Noon is safe.
    const now = new Date().setHours(12, 0, 0, 0);
    writeEvents(EVENTS_FILE, [
      { ts: now - 1000, applied: true, tokensBeforeEst: 100, tokensAfterEst: 60, tokensSavedEst: 40, imageCount: 2, durationMs: 10 },
      { ts: now - 2000, applied: false, reason: "transform_error" },
      { ts: now - 3000, applied: false, reason: "timeout" },
      { ts: now - 4000, applied: false, reason: "too_small" },
      { ts: now - 10 * DAY_MS, applied: true, tokensBeforeEst: 50, tokensAfterEst: 25, tokensSavedEst: 25, durationMs: 30 },
    ]);
    const { windows, timeline, recent } = getPxpipeStats({ timelineDays: 30, recentLimit: 2 });

    expect(windows.all.requests).toBe(5);
    expect(windows.all.compressed).toBe(2);
    expect(windows.all.errors).toBe(2);
    expect(windows.all.bypassed).toBe(1);
    expect(windows.all.tokensSavedEst).toBe(65);
    expect(windows.all.imagesGenerated).toBe(2);
    // savedPct = 65/150, avg over 2 compressed events of 10+30ms
    expect(windows.all.savedPct).toBeCloseTo(+((65 / 150) * 100).toFixed(2));
    expect(windows.all.avgCompressionMs).toBe(20);

    // 10-day-old event is outside today/last7d but inside last30d and all
    expect(windows.today.requests).toBe(4);
    expect(windows.last7d.requests).toBe(4);
    expect(windows.last30d.requests).toBe(5);
    expect(windows.yesterday.requests).toBe(0);

    // timeline covers timelineDays buckets; today's bucket carries today's events
    expect(timeline).toHaveLength(30);
    const todayKey = new Date(now).toISOString().slice(0, 10);
    const todayBucket = timeline.find((b) => b.date === todayKey);
    expect(todayBucket.requests).toBe(4);
    expect(todayBucket.compressed).toBe(1);
    expect(todayBucket.tokensSavedEst).toBe(40);

    // recent is newest-first, capped at recentLimit
    expect(recent).toHaveLength(2);
    expect(recent[0].ts).toBeGreaterThan(recent[1].ts);
  });

  it("zero events yields zeroed finalized totals", () => {
    const { windows, timeline } = getPxpipeStats({ timelineDays: 7 });
    expect(windows.all.requests).toBe(0);
    expect(windows.all.savedPct).toBe(0);
    expect(windows.all.avgCompressionMs).toBe(0);
    expect(timeline).toHaveLength(7);
  });
});
