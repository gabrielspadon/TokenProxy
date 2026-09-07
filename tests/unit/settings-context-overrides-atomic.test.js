import { describe, expect, it } from "vitest";
import {
  getSettings,
  mutateContextWindowOverrides,
  updateSettings,
} from "../../src/lib/db/repos/settingsRepo.js";

describe("context window override mutations", () => {
  it("serializes concurrent per-key writes and preserves unrelated overrides", async () => {
    await updateSettings({
      contextWindowOverrides: { remove: 8000, retained: 16000 },
    });

    const [first, second, removed] = await Promise.all([
      mutateContextWindowOverrides({ set: [{ key: "first", contextWindow: 32000 }] }),
      mutateContextWindowOverrides({ set: [{ key: "second", contextWindow: 64000 }] }),
      mutateContextWindowOverrides({ deleteKeys: ["remove"] }),
    ]);

    expect(first).toMatchObject({ nSet: 1, nDel: 0 });
    expect(second).toMatchObject({ nSet: 1, nDel: 0 });
    expect(removed).toMatchObject({ nSet: 0, nDel: 1 });

    expect((await getSettings()).contextWindowOverrides).toEqual({
      retained: 16000,
      first: 32000,
      second: 64000,
    });
  });

  it("keeps the existing whole-map settings replacement contract", async () => {
    await updateSettings({ contextWindowOverrides: { first: 32000, sibling: 64000 } });
    await updateSettings({ contextWindowOverrides: { first: 128000 } });

    expect((await getSettings()).contextWindowOverrides).toEqual({ first: 128000 });
  });

  it("stores reserved keys literally and counts only own deletions", async () => {
    await updateSettings({ contextWindowOverrides: { retained: 16000 } });

    const stored = await mutateContextWindowOverrides({
      set: [{ key: "__proto__", contextWindow: 32000 }],
    });
    expect(stored.nSet).toBe(1);
    expect(Object.hasOwn(stored.overrides, "__proto__")).toBe(true);
    expect((await getSettings()).contextWindowOverrides["__proto__"]).toBe(32000);

    const deleted = await mutateContextWindowOverrides({
      deleteKeys: ["constructor", "toString", "missing", "__proto__"],
    });
    expect(deleted.nDel).toBe(1);
    expect((await getSettings()).contextWindowOverrides).toEqual({ retained: 16000 });
  });
});
