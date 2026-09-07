import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Per-stage savings: windows.<win>.stages.<saver> = { requests, applied,
// measuredRequests, bytesSaved }. `requests` is the measurement denominator.
let TMP;
let eventsMod;

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tokenproxy-tsstages-"));
});

afterEach(() => {
  if (eventsMod) eventsMod.__setTokenSaverEventsDirForTest(null);
  eventsMod = null;
  fs.rmSync(TMP, { recursive: true, force: true });
});

function dayMs(n) {
  return Date.now() - n * 24 * 60 * 60 * 1000;
}

async function loadMod() {
  return (eventsMod = await import("@/lib/tokenSaver/events.js"));
}

describe("tokenSaver per-stage savings", () => {
  it("sums signed bytesSaved per saver per window", async () => {
    const mod = await loadMod();
    mod.__setTokenSaverEventsDirForTest(TMP);
    // today: rtk twice (one without bytesSaved), headroom once
    mod.appendTokenSaverEvent({ ts: Date.now(), saver: "rtk", applied: true, charsSaved: 10, bytesSaved: -1000 });
    mod.appendTokenSaverEvent({ ts: Date.now(), saver: "rtk", applied: true, charsSaved: 5 });
    mod.appendTokenSaverEvent({ ts: Date.now(), saver: "headroom", applied: true, tokensSaved: 400, bytesSaved: -500 });
    // yesterday: pxpipe growth (positive bytesSaved is reported, not clamped)
    mod.appendTokenSaverEvent({ ts: dayMs(1), saver: "pxpipe", applied: true, tokensSavedEst: 10, bytesSaved: 200 });
    // 8 days ago: rtk, only in all + last30d
    mod.appendTokenSaverEvent({ ts: dayMs(8), saver: "rtk", applied: false, charsSaved: 3, bytesSaved: -80 });

    const s = mod.getTokenSaverStats();

    expect(s.windows.today.stages.rtk).toEqual({ requests: 2, applied: 2, measuredRequests: 1, bytesSaved: -1000 });
    expect(s.windows.today.stages.headroom).toEqual({ requests: 1, applied: 1, measuredRequests: 1, bytesSaved: -500 });
    // sparse stage map: savers with no rows in the window are absent
    expect(s.windows.today.stages.pxpipe).toBeUndefined();
    expect(s.windows.yesterday.stages.pxpipe).toEqual({ requests: 1, applied: 1, measuredRequests: 1, bytesSaved: 200 });
    expect(s.windows.yesterday.stages.rtk).toBeUndefined();
    expect(s.windows.last7d.stages.rtk.bytesSaved).toBe(-1000);
    expect(s.windows.last30d.stages.rtk).toEqual({ requests: 3, applied: 2, measuredRequests: 2, bytesSaved: -1080 });
    expect(s.windows.all.stages.rtk).toEqual({ requests: 3, applied: 2, measuredRequests: 2, bytesSaved: -1080 });
  });

  it("applies sinceMs filtering to stages exactly like the window totals", async () => {
    const mod = await loadMod();
    mod.__setTokenSaverEventsDirForTest(TMP);
    mod.appendTokenSaverEvent({ ts: dayMs(10), saver: "rtk", applied: true, charsSaved: 10, bytesSaved: -700 });
    mod.appendTokenSaverEvent({ ts: Date.now(), saver: "rtk", applied: true, charsSaved: 4, bytesSaved: -300 });

    const cutoff = dayMs(5);
    const s = mod.getTokenSaverStats({ sinceMs: cutoff });

    expect(s.windows.all.requests).toBe(1);
    expect(s.windows.all.stages.rtk).toEqual({ requests: 1, applied: 1, measuredRequests: 1, bytesSaved: -300 });
  });

  it("distinguishes a measured zero from an absent measurement and retains signed growth", async () => {
    const mod = await loadMod();
    mod.__setTokenSaverEventsDirForTest(TMP);
    mod.appendTokenSaverEvent({ ts: Date.now(), saver: "diet", applied: true, bytesSaved: 0 });
    mod.appendTokenSaverEvent({ ts: Date.now(), saver: "diet", applied: false });
    mod.appendTokenSaverEvent({ ts: Date.now(), saver: "diet", applied: true, bytesSaved: 25 });

    expect(mod.getTokenSaverStats().windows.all.stages.diet).toEqual({
      requests: 3, applied: 2, measuredRequests: 2, bytesSaved: 25,
    });
  });

  it("aggregates the ledger-backed savers (inject, mem, schema, privacy)", async () => {
    const mod = await loadMod();
    mod.__setTokenSaverEventsDirForTest(TMP);
    mod.appendTokenSaverEvent({ ts: Date.now(), saver: "inject", applied: true, bytesSaved: 3952 });
    mod.appendTokenSaverEvent({ ts: Date.now(), saver: "mem", applied: true, bytesSaved: -42400 });
    mod.appendTokenSaverEvent({ ts: Date.now(), saver: "schema", applied: true, bytesSaved: -1800 });
    mod.appendTokenSaverEvent({ ts: Date.now(), saver: "privacy", applied: false });

    const s = mod.getTokenSaverStats({});
    expect(s.windows.all.stages.inject).toEqual({ requests: 1, applied: 1, measuredRequests: 1, bytesSaved: 3952 });
    expect(s.windows.all.stages.mem).toEqual({ requests: 1, applied: 1, measuredRequests: 1, bytesSaved: -42400 });
    expect(s.windows.all.stages.schema).toEqual({ requests: 1, applied: 1, measuredRequests: 1, bytesSaved: -1800 });
    expect(s.windows.all.stages.privacy).toEqual({ requests: 1, applied: 0, measuredRequests: 0, bytesSaved: 0 });
  });

  it("stages ride along through the /api/token-saver/stats route response", async () => {
    const mod = await loadMod();
    mod.__setTokenSaverEventsDirForTest(TMP);
    mod.appendTokenSaverEvent({ ts: Date.now(), saver: "headroom", applied: true, tokensSaved: 12, bytesSaved: -42 });

    const { GET } = await import("../../src/app/api/token-saver/stats/route.js");
    const res = await GET({ url: "http://localhost/api/token-saver/stats" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.windows.all.stages.headroom).toEqual({ requests: 1, applied: 1, measuredRequests: 1, bytesSaved: -42 });
    // no rtk row today: the sparse map has no rtk stage at all
    expect(body.windows.all.stages.rtk).toBeUndefined();
  });
});

describe("rid allowlist and (rid, saver) dedupe", () => {
  it("keeps valid 8-hex rid normalized lowercase, drops invalid", async () => {
    const mod = await loadMod();
    mod.__setTokenSaverEventsDirForTest(TMP);
    mod.appendTokenSaverEvent({ ts: Date.now(), saver: "rtk", applied: true, charsSaved: 10, rid: "ABCD1234" });
    mod.appendTokenSaverEvent({ ts: Date.now(), saver: "rtk", applied: true, charsSaved: 5, rid: "not-hex!!" });
    mod.appendTokenSaverEvent({ ts: Date.now(), saver: "rtk", applied: true, charsSaved: 3, rid: "abc" });
    const rows = mod.readTokenSaverEvents();
    expect(rows[0].rid).toBe("abcd1234");
    expect("rid" in rows[1]).toBe(false);
    expect("rid" in rows[2]).toBe(false);
  });

  it("two rows with same rid+saver (fallback attempts) count once; different rids count twice", async () => {
    const mod = await loadMod();
    mod.__setTokenSaverEventsDirForTest(TMP);
    // one request, three account-fallback attempts: identical rows
    for (let i = 0; i < 3; i++) {
      mod.appendTokenSaverEvent({ ts: Date.now(), saver: "rtk", applied: true, charsSaved: 100, bytesSaved: -400 });
    }
    // rewrite rids directly to share one rid (append path validates shape only)
    const file = path.join(TMP, "events.jsonl");
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l, i) => {
      const row = JSON.parse(l);
      row.rid = "aaaa0001";
      return JSON.stringify(row);
    });
    fs.writeFileSync(file, lines.join("\n") + "\n");
    // a second request with a different rid
    mod.appendTokenSaverEvent({ ts: Date.now(), saver: "rtk", applied: true, charsSaved: 50, bytesSaved: -200, rid: "bbbb0002" });

    const s = mod.getTokenSaverStats();
    expect(s.windows.today.requests).toBe(2);
    expect(s.windows.today.stages.rtk).toEqual({ requests: 2, applied: 2, measuredRequests: 2, bytesSaved: -600 });
    expect(s.windows.today.charsReduced).toBe(150);
  });

  it("mixed rid/no-rid rows aggregate independently", async () => {
    const mod = await loadMod();
    mod.__setTokenSaverEventsDirForTest(TMP);
    mod.appendTokenSaverEvent({ ts: Date.now(), saver: "headroom", applied: true, tokensSaved: 10, bytesSaved: -40, rid: "cccc0003" });
    mod.appendTokenSaverEvent({ ts: Date.now(), saver: "headroom", applied: true, tokensSaved: 10, bytesSaved: -40, rid: "cccc0003" });
    // legacy row without rid: aggregated as before, no dedupe
    mod.appendTokenSaverEvent({ ts: Date.now(), saver: "headroom", applied: true, tokensSaved: 5, bytesSaved: -20 });
    mod.appendTokenSaverEvent({ ts: Date.now(), saver: "headroom", applied: true, tokensSaved: 5, bytesSaved: -20 });

    const s = mod.getTokenSaverStats();
    expect(s.windows.today.stages.headroom).toEqual({ requests: 3, applied: 3, measuredRequests: 3, bytesSaved: -80 });
  });
});
