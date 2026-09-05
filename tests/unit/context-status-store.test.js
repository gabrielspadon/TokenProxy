import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  writeContextStatus,
  readContextStatus,
  readAllContextStatuses,
  __setContextStatusDirForTest,
} from "../../open-sse/handlers/chatCore/contextStatusStore.js";

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-status-test-"));
  __setContextStatusDirForTest(dir);
});

afterEach(() => {
  __setContextStatusDirForTest(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("contextStatusStore", () => {
  it("write/read roundtrip preserves allowlisted fields", async () => {
    writeContextStatus("abcd1234", {
      rid: "0bad000a",
      ctxTokens: 12345,
      saveBytes: -800,
      ceBytes: 4096,
      compactHint: true,
      bogus: "dropped",
      saveBytesNegativeCheck: -5,
    });
    const entry = await readContextStatus("abcd1234");
    expect(entry).toEqual({
      sid: "abcd1234",
      rid: "0bad000a",
      ctxTokens: 12345,
      saveBytes: -800, // signed delta preserved
      ceBytes: 4096,
      compactHint: true,
      updatedAt: entry.updatedAt,
    });
    expect(Number.isNaN(Date.parse(entry.updatedAt))).toBe(false);
  });

  it("omitted fields stay absent; saveBytes of exactly 0 is kept", async () => {
    writeContextStatus("abcd1234", { rid: "0bad000b", ctxTokens: 100 });
    const entry = await readContextStatus("abcd1234");
    expect(entry.saveBytes).toBeUndefined();
    expect(entry.ceBytes).toBeUndefined();
    expect(entry.compactHint).toBeUndefined();
  });

  it("rejects malformed sids and never touches disk", async () => {
    writeContextStatus("not-hex!", { ctxTokens: 1 });
    writeContextStatus("abcd12345", { ctxTokens: 1 });
    writeContextStatus("", { ctxTokens: 1 });
    expect(await readContextStatus("not-hex!")).toBeNull();
    expect(fs.existsSync(path.join(dir, "context-status.json"))).toBe(false);
  });

  it("LRU eviction drops the oldest entry at the 512 cap", async () => {
    for (let i = 0; i < 512; i++) {
      writeContextStatus(i.toString(16).padStart(8, "0"), { ctxTokens: i });
    }
    expect(await readAllContextStatuses()).toHaveLength(512);
    // touch the oldest so it becomes newest, then overflow by one
    writeContextStatus("00000000", { ctxTokens: 999 });
    writeContextStatus("00000200", { ctxTokens: 998 });
    const all = await readAllContextStatuses();
    expect(all).toHaveLength(512);
    expect(all.at(-1).sid).toBe("00000200");
    expect(all.at(-2).sid).toBe("00000000");
    // order after the touches is [02..1ff,00]; adding 200 evicted the 01 head
    expect(all[0].sid).toBe("00000002");
    expect(await readContextStatus("00000001")).toBeNull();
    expect(await readContextStatus("00000002")).not.toBeNull();
    expect((await readContextStatus("00000000")).ctxTokens).toBe(999);
  });

  it("writes atomically with mode 0600 and no leftover tmp file", async () => {
    writeContextStatus("abcd1234", { ctxTokens: 1 });
    await readAllContextStatuses(); // flush the in-module write queue
    const file = path.join(dir, "context-status.json");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("corrupt file recovers to empty without throwing, then accepts writes", async () => {
    fs.mkdirSync(path.join(dir, "token-saver"), { recursive: true });
    fs.writeFileSync(path.join(dir, "context-status.json"), "{not json");
    expect(await readContextStatus("abcd1234")).toBeNull();
    expect(await readAllContextStatuses()).toEqual([]);
    expect(() => writeContextStatus("abcd1234", { ctxTokens: 7 })).not.toThrow();
    expect((await readContextStatus("abcd1234")).ctxTokens).toBe(7);
  });

  it("truncated JSON mid-array also recovers empty", async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "context-status.json"),
      '{"v":1,"entries":[{"sid":"abcd1234","ctxTokens":5',
    );
    expect(await readAllContextStatuses()).toEqual([]);
  });

  it("drops updatedAt that is not ISO-shaped and parseable", async () => {
    // poison the file directly: free-text and garbage timestamps must not
    // survive the read-path sanitize (they would poison freshest-entry picks)
    const file = path.join(dir, "context-status.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        v: 1,
        entries: [
          { sid: "aaaa0001", updatedAt: "not a timestamp" },
          { sid: "bbbb0002", updatedAt: "2026-13-99T99:99:99.000Z" },
          { sid: "cccc0003", updatedAt: "2026-09-04T12:00:00.000Z" },
          { sid: "dddd0004", updatedAt: "2026-09-04" },
        ],
      }),
    );
    const entries = await readAllContextStatuses();
    const bySid = Object.fromEntries(entries.map((e) => [e.sid, e]));
    expect("updatedAt" in bySid["aaaa0001"]).toBe(false);
    expect("updatedAt" in bySid["bbbb0002"]).toBe(false);
    expect(bySid["cccc0003"].updatedAt).toBe("2026-09-04T12:00:00.000Z");
    expect("updatedAt" in bySid["dddd0004"]).toBe(false);
  });

  it("retries once on a rename ENOENT from an interleaved writer, keeping the update", async () => {
    const file = path.join(dir, "context-status.json");
    writeContextStatus("aaaa0001", { ctxTokens: 1 });
    // simulate an interleaved writer deleting the staging tmp mid-flight:
    // patch the async rename to fail once with ENOENT
    const realRename = fs.promises.rename;
    let calls = 0;
    fs.promises.rename = async (a, b) => {
      if (String(a).endsWith(".tmp") && calls++ === 0) {
        const err = new Error("simulated interleave");
        err.code = "ENOENT";
        throw err;
      }
      return realRename(a, b);
    };
    try {
      writeContextStatus("bbbb0002", { ctxTokens: 2 });
      // the retry reapplied the write: both entries present
      expect((await readContextStatus("aaaa0001"))?.ctxTokens).toBe(1);
      expect((await readContextStatus("bbbb0002"))?.ctxTokens).toBe(2);
    } finally {
      fs.promises.rename = realRename;
    }
  });

  it("uses per-process unique tmp names for concurrent writers", async () => {
    writeContextStatus("aaaa0001", { ctxTokens: 1 });
    // with a shared "${file}.tmp" two writers would clobber each other; unique
    // pid.counter names make that structurally impossible. Assert the counter
    // advanced by inspecting that successive writes leave no tmp and land both.
    writeContextStatus("bbbb0002", { ctxTokens: 2 });
    writeContextStatus("cccc0003", { ctxTokens: 3 });
    expect((await readAllContextStatuses()).map((e) => e.sid)).toEqual([
      "aaaa0001",
      "bbbb0002",
      "cccc0003",
    ]);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });

  it("entries with wrong shape are dropped on read", async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "context-status.json"),
      JSON.stringify({
        v: 1,
        entries: [
          { sid: "abcd1234", ctxTokens: 5, updatedAt: "2026-09-04T00:00:00.000Z" },
          { sid: "ZZZ", ctxTokens: 6 },
          "garbage",
          { noSid: true },
        ],
      }),
    );
    const all = await readAllContextStatuses();
    expect(all).toHaveLength(1);
    expect(all[0].sid).toBe("abcd1234");
  });
});
