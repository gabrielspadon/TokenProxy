import { trackResponseLifetime } from '../helpers/response-lifetime.js';
const handleChat = trackResponseLifetime(async (...args) => (await import('@/sse/handlers/chat.js')).handleChat(...args));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The agent-efficient decision log (docs/logging-design.md). These assert the
// SCHEMA to the byte, because the whole value of the design is that one `rg`
// answers a question -- a line whose field order or spelling drifts is a line
// no saved grep finds.
import {
  decide, req, fold, formatLine, relativeReset, idPrefix, VERDICTS, __decide,
  nextRid, readRid, RID_HEADER,
} from "@/shared/observability/decide.js";

const AT = Date.parse("2026-09-03T18:09:07.412Z");
let lines;
let spy;

beforeEach(() => {
  __decide.resetState();
  __decide.disableSink(); // the NDJSON half is fs; these assert the line itself
  lines = [];
  spy = vi.spyOn(console, "log").mockImplementation((l) => lines.push(l));
});
afterEach(() => { spy.mockRestore(); });

describe("decision log schema", () => {
  it("is '<iso8601> CLASS.verdict rid=<8hex> k=v...' to the byte", () => {
    expect(formatLine("LEASE", "refused", { rid: "7f3a1c02", conn: "7a1acb09", held: 4, cap: 4 }, AT))
      .toBe("2026-09-03T18:09:07Z LEASE.refused rid=7f3a1c02 conn=7a1acb09 held=4 cap=4");
  });

  it("puts the identity keys first whatever order the caller wrote them", () => {
    const line = formatLine("SEL", "win", { why: "x", model: "m", conn: "c", rid: "r", prov: "p", sid: "s" }, AT);
    expect(line).toBe("2026-09-03T18:09:07Z SEL.win rid=r sid=s conn=c prov=p model=m why=x");
  });

  it("keeps fold bookkeeping last, where it is about the line not the event", () => {
    const line = formatLine("CRED", "refresh-failed", { rep: 12, conn: "c", first: "17:41:12", status: 400 }, AT);
    expect(line.endsWith("status=400 rep=12 first=17:41:12")).toBe(true);
  });

  it("drops null and undefined rather than writing 'k=null'", () => {
    expect(formatLine("REQ", "ok", { rid: "a", sid: null, conn: undefined, t: 0 }, AT))
      .toBe("2026-09-03T18:09:07Z REQ.ok rid=a t=0");
  });
});

describe("the closed verdict enum", () => {
  it("is frozen, class and list", () => {
    expect(Object.isFrozen(VERDICTS)).toBe(true);
    for (const list of Object.values(VERDICTS)) expect(Object.isFrozen(list)).toBe(true);
  });

  it("makes a typo a red test rather than a new string in production", () => {
    expect(() => decide("CRED", "refresh-faild", {})).toThrow(/unknown verdict CRED.refresh-faild/);
    expect(() => decide("NOPE", "admit", {})).toThrow(/unknown verdict/);
  });

  it("holds every verdict the shipped call sites use", () => {
    expect(VERDICTS.ADM).toContain("ratelimited");
    expect(VERDICTS.CRED).toContain("chain-diverged");
    expect(VERDICTS.AUTHZ).toContain("admit");
  });
});

describe("silence policy is structural, not a review habit", () => {
  it("never spreads or stringifies an object into a line", () => {
    const line = formatLine("ACCT", "alias-dropped", { rid: "r", body: { messages: ["secret prompt"] } }, AT);
    expect(line).toContain("body=[non-scalar]");
    expect(line).not.toContain("secret prompt");
  });

  it("routes free text through the shared redaction chokepoint", () => {
    const line = formatLine("UP", "failover", { err: "Bearer sk-ant-api03-AAAAAAAAAAAAAAAAAAAA" }, AT);
    expect(line).not.toContain("sk-ant-api03-AAAAAAAAAAAAAAAAAAAA");
    expect(line).toContain("redacted");
  });

  it("cannot be split into a second line by a value (log injection)", () => {
    const line = formatLine("ADM", "key-invalid", { why: "a b\nADM.admit rid=deadbeef" }, AT);
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toContain("why=a_b_ADM.admit_rid=deadbeef");
  });

  it("truncates free text at 60 characters", () => {
    const line = formatLine("STREAM", "stalled", { err: "z".repeat(200) }, AT);
    expect(line).toContain(`err=${"z".repeat(60)}…`);
  });
});

describe("repeat folding", () => {
  const key = "k";

  it("emits on 1,2,4,8,...,128 then every 128", () => {
    const hits = [];
    for (let n = 1; n <= 300; n++) if (fold(key, AT).emit) hits.push(n);
    expect(hits).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256]);
  });

  it("turns the measured 154 OAuth failures into 8 lines without losing one", () => {
    let emitted = 0;
    let counted = 0;
    for (let n = 0; n < 154; n++) {
      const r = fold(key, AT);
      if (r.emit) { emitted++; counted += r.rep; }
    }
    expect(emitted).toBe(8);          // 1,2,4,8,16,32,64,128
    expect(counted).toBe(128);        // every emitted line names its own run
  });

  it("NEVER folds across a change in why", () => {
    const base = { conn: "7a1acb09", prov: "claude", why: "invalid_grant" };
    for (let n = 0; n < 40; n++) decide("CRED", "refresh-failed", base, AT);
    const before = lines.length;
    decide("CRED", "refresh-failed", { ...base, why: "network" }, AT);
    expect(lines.length).toBe(before + 1);
    expect(lines.at(-1)).toContain("why=network");
    expect(lines.at(-1)).not.toContain("rep=");
  });

  it("names how many occurrences a folded line stands for, and when the run began", () => {
    for (let n = 0; n < 4; n++) decide("LEASE", "refused", { conn: "c", why: "at-limit" }, AT + n * 1000);
    expect(lines.at(-1)).toContain("rep=2");
    expect(lines.at(-1)).toContain("first=0903-18:09:09"); // D-7: MMdd-hh:mm:ss
  });

  it("D-6: never folds across a change in status", () => {
    const base = { conn: "c", why: "http-error" };
    for (let n = 0; n < 40; n++) decide("UP", "failover", { ...base, status: 400 }, AT);
    const before = lines.length;
    decide("UP", "failover", { ...base, status: 500 }, AT);
    expect(lines.length).toBe(before + 1);
    expect(lines.at(-1)).toContain("status=500");
    expect(lines.at(-1)).not.toContain("rep=");
  });

  it("forces a roll-up once an hour so a slow burn cannot go quiet", () => {
    for (let n = 0; n < 200; n++) fold(key, AT);
    const after = fold(key, AT + 3600_000);
    expect(after.emit).toBe(true);
  });

  it("is bounded, so the folding state cannot itself become the leak", () => {
    for (let n = 0; n < __decide.FOLD_MAX_KEYS * 2; n++) fold(`key-${n}`, AT);
    expect(__decide.foldSize()).toBeLessThanOrEqual(__decide.FOLD_MAX_KEYS);
  });
});

describe("storm backstop", () => {
  it("converts an unbounded log storm into a bounded couple of lines a minute", () => {
    for (let n = 0; n < 400; n++) decide("UP", "failover", { conn: `c${n}`, why: "upstream-5xx" }, AT);
    expect(lines.length).toBeLessThanOrEqual(__decide.STORM_LIMIT + 1);
    expect(lines.at(-1)).toContain("LOG.throttled why=storm-backstop");
  });

  it("D-1: counts folded lines, not decide() calls — 300 identical calls emit 9 and never trip it", () => {
    for (let n = 0; n < 300; n++) decide("UP", "failover", { conn: "c", why: "upstream-5xx" }, AT);
    expect(lines.filter((l) => l.includes("UP.failover"))).toHaveLength(9); // 1,2,4,8,16,32,64,128,256
    expect(lines.some((l) => l.includes("LOG.throttled"))).toBe(false);
  });

  it("D-8: storm-throttled occurrences still enter foldState, so the post-resume rep is whole", () => {
    // Trip the backstop: 200 distinct-bucket emissions inside one window.
    for (let n = 0; n < 200; n++) decide("UP", "failover", { conn: `c${n}`, why: "upstream-5xx" }, AT);
    // 100 identical occurrences while throttled: recorded, not emitted.
    for (let n = 0; n < 100; n++) decide("SEL", "refused", { conn: "c", why: "at-limit" }, AT);
    expect(lines.filter((l) => l.includes("SEL.refused"))).toHaveLength(0);
    // The window closes: this call flushes LOG.resumed and resets the backstop.
    lines.length = 0;
    decide("UP", "failover", { conn: "cx", why: "upstream-5xx" }, AT + 61_000);
    expect(lines.some((l) => l.includes("LOG.resumed"))).toBe(true);
    // 28 more occurrences bring the bucket to n=128, its next scheduled emit.
    for (let n = 0; n < 28; n++) decide("SEL", "refused", { conn: "c", why: "at-limit" }, AT + 61_000);
    const repLine = lines.find((l) => l.includes("SEL.refused"));
    expect(repLine).toBeDefined();
    expect(repLine).toContain("rep=64"); // 128-64: the throttled 65..100 are inside it
  });

  it("never throttles the nominal REQ line, which is one per request already", () => {
    for (let n = 0; n < 400; n++) decide("UP", "failover", { conn: `c${n}`, why: "upstream-5xx" }, AT);
    const before = lines.length;
    req("ok", { rid: "7f3a1c02", t: 3543 }, AT);
    expect(lines.length).toBe(before + 1);
    expect(lines.at(-1)).toContain("REQ.ok rid=7f3a1c02 t=3543");
  });
});

describe("request id", () => {
  it("is 8 hex and does not repeat inside a process", () => {
    const ids = new Set();
    for (let n = 0; n < 5000; n++) {
      const id = nextRid();
      expect(id).toMatch(/^[0-9a-f]{8}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(5000);
  });

  it("adopts the front proxy's x-tp-rid so a 503 at admission joins the gateway lines", () => {
    const r = new Request("http://x/v1/chat", { headers: { [RID_HEADER]: "C0912AB4" } });
    expect(readRid(r)).toBe("c0912ab4");
  });

  it("refuses an inbound rid that could forge a second line, and mints instead", () => {
    const r = new Request("http://x/v1/chat", { headers: { [RID_HEADER]: "aaaaaaaa" } });
    expect(readRid(r)).toBe("aaaaaaaa");
    for (const bad of ["not-hex", "", "a".repeat(40), "dead beef"]) {
      const req2 = new Request("http://x/v1/chat", { headers: { [RID_HEADER]: bad } });
      expect(readRid(req2)).toMatch(/^[0-9a-f]{8}$/);
      expect(readRid(req2)).not.toContain(" ");
    }
  });
});

describe("field keys", () => {
  it("SEC-4: keys outside the k=v grammar never reach the line", () => {
    const line = formatLine("UP", "failover", { rid: "a", "bad key": "v", "x=y": "v", ok_key: "v" }, AT);
    expect(line).toBe("2026-09-03T18:09:07Z UP.failover rid=a ok_key=v");
  });
});

describe("helpers", () => {
  it("puts an identity in a line without the line carrying the credential", () => {
    expect(idPrefix("sk-live-abcdef")).toMatch(/^[0-9a-f]{8}$/);
    expect(idPrefix("sk-live-abcdef")).not.toContain("sk-");
    expect(idPrefix(null)).toBeNull();
  });

  it("states a reset relatively, because an instant makes the reader do arithmetic", () => {
    expect(relativeReset(AT + 38_000, AT)).toBe("+38s");
    expect(relativeReset(AT + (4 * 3600 + 12 * 60) * 1000, AT)).toBe("+4h12m");
    expect(relativeReset(null, AT)).toBeNull();
  });
});

// The bar the design sets for itself: two incidents that were logged, or not
// logged, and were undiscoverable either way. Each must become ONE line that a
// single grep finds. These assert the emitter can produce them; the CALL SITES
// are migration steps 3.1 and 3.4 and are not wired yet.
describe("the two incidents the design must make greppable", () => {
  it("OAuth chain rotated underneath us: 169 undiscoverable lines become one", () => {
    const line = formatLine("CRED", "chain-diverged", {
      conn: "7a1acb09", prov: "claude", fp0: "3ac91e77", fp: "unknown",
      why: "issuer-rejected-held-token", peers: "9c291b5a,c98037d0", action: "none",
    }, Date.parse("2026-09-03T18:22:46Z"));
    expect(line).toBe(
      "2026-09-03T18:22:46Z CRED.chain-diverged conn=7a1acb09 prov=claude " +
      "fp0=3ac91e77 fp=unknown why=issuer-rejected-held-token " +
      "peers=9c291b5a,c98037d0 action=none",
    );
    // The grep an agent actually runs, and the connection today's line omits.
    expect(/ CRED\.chain-diverged /.test(line)).toBe(true);
    expect(line).toContain("conn=7a1acb09");
  });

  it("loopback satisfied an inference-class gate: an invisible bypass becomes one line", () => {
    const line = formatLine("AUTHZ", "admit", {
      rid: "a41f0c93", path: "/api/admin/health", class: "inference",
      by: "loopback", operator: false, inference: false, loopback: true, peer: "127.0.0.1",
    }, AT);
    expect(line).toBe(
      "2026-09-03T18:09:07Z AUTHZ.admit rid=a41f0c93 path=/api/admin/health " +
      "class=inference by=loopback operator=false inference=false loopback=true peer=127.0.0.1",
    );
    // 'admitted to an inference-class path with no inference credential'.
    expect(/ AUTHZ\.admit .*by=loopback .*inference=false/.test(line)).toBe(true);
  });
});

// The design's own worked example of a line that costs everything and says
// nothing: src/sse/handlers/chat.js:155 was `log.warn("CHAT", "Rate limit
// exceeded")`, 15,548 lines and 73.9% of a measured six-hour journal, naming
// neither the caller, the limit, the window nor the reset -- with all four in
// scope on the very next line.
describe("chat.js admission refusal (the 73% line)", () => {
  // Drive the limiter to whatever ceiling it is configured with rather than
  // assuming a count. RATE_LIMIT_MAX_REQUESTS is env-tunable
  // (src/sse/handlers/chat.js:89), so a hardcoded 60 stopped burning the window
  // the moment the default moved, and the request under test sailed past the
  // gate these cases exist to exercise. Bounded like the sibling eviction suite
  // so a limiter that never refuses fails the run instead of hanging it.
  function burnWindow(limiter, key) {
    let limited = false;
    for (let n = 0; n < 10000 && !limited; n++) limited = limiter.isRateLimited(key);
    expect(limited).toBe(true);
  }

  it("names the key, the limit, the window and the reset, and folds the repeats", async () => {
    const { __rateLimiter } = await import("@/sse/handlers/chat.js");
    __rateLimiter.reset();
    const ip = "203.0.113.9";
    burnWindow(__rateLimiter, ip);
    lines.length = 0;

    const make = () => new Request("http://localhost:20128/v1/chat/completions", {
      method: "POST",
      headers: { "x-forwarded-for": ip, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-fable-5", messages: [] }),
    });

    const res = await handleChat(make());
    expect(res.status).toBe(429);
    await res.body?.cancel();

    const line = lines.find((l) => l.includes("ADM.ratelimited"));
    expect(line).toBeDefined();
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:]{8}Z ADM\.ratelimited rid=[0-9a-f]{8} /);
    expect(line).toMatch(/ key=ip:[0-9a-f]{8} /);       // the caller, not the address
    // The limit with the window inside it, asserted as SHAPE rather than as the
    // frozen literal 60/60s: both halves are env-tunable, so pinning the number
    // here tests the default instead of the schema this suite is about.
    expect(line).toMatch(/ limit=\d+\/\d+s /);
    expect(line).not.toContain("win=");                 // no separate window field
    expect(line).toMatch(/ reset=\+(\d+s|\d+m|\d+h\d+m)/); // the reset, relatively
    expect(line).toContain("why=ip-window");
    expect(line).not.toContain(ip);                     // never the raw identity

    // The old line was one per refusal. This one folds: 60 more refusals cost 5.
    lines.length = 0;
    for (let n = 0; n < 60; n++) { const response = await handleChat(make()); await response.body?.cancel(); }
    const emitted = lines.filter((l) => l.includes("ADM.ratelimited"));
    expect(emitted.length).toBeLessThanOrEqual(6);
    expect(emitted.at(-1)).toMatch(/ rep=\d+ first=\d{4}-[\d:]{8}$/); // D-7
  });

  it("D-10: the rate-limit refusal emits REQ.refused carrying the same rid", async () => {
    const { __rateLimiter } = await import("@/sse/handlers/chat.js");
    __rateLimiter.reset();
    const ip = "203.0.113.9";
    burnWindow(__rateLimiter, ip);
    lines.length = 0;

    const res = await handleChat(new Request("http://localhost:20128/v1/chat/completions", {
      method: "POST",
      headers: { "x-forwarded-for": ip, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-fable-5", messages: [] }),
    }));
    expect(res.status).toBe(429);
    await res.body?.cancel();
    const line = lines.find((l) => l.includes("REQ.refused"));
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:]{8}Z REQ\.refused rid=[0-9a-f]{8} why=rate-limited$/);
    const admLine = lines.find((l) => l.includes("ADM.ratelimited"));
    expect(line).toContain(admLine.match(/rid=[0-9a-f]{8}/)[0]);
  });

  it("no longer writes the reasonless warn it replaced", async () => {
    const { __rateLimiter } = await import("@/sse/handlers/chat.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    __rateLimiter.reset();
    burnWindow(__rateLimiter, "anonymous");
    await handleChat(new Request("http://localhost:20128/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [] }),
    }));
    expect(warn.mock.calls.flat().join(" ")).not.toContain("Rate limit exceeded");
    warn.mockRestore();
  });
});

describe("path/save truncation cuts at whole codes (audit finding 19)", () => {
  it("a 9-code path renders only whole codes plus an ellipsis, never a mid-code cut", () => {
    const codes = Array.from({ length: 9 }, (_, i) => `XFORM.tool-distill${i}`);
    const line = formatLine("REQ", "ok", { rid: "7f3a1c02", path: codes.join(",") }, AT);
    const rendered = line.split("path=")[1];
    const parts = rendered.split(",");
    expect(rendered.length).toBeLessThanOrEqual(161); // 160 cap + ellipsis
    for (let i = 0; i < parts.length; i++) {
      if (i === parts.length - 1) expect(parts[i].endsWith("…")).toBe(true);
      else expect(parts[i]).toMatch(/^XFORM\.[\w-]+$/);
    }
    // The cut kept the EARLIEST codes whole, dropping the tail.
    expect(parts[0]).toBe("XFORM.tool-distill0");
  });

  it("save= gets the same whole-code treatment", () => {
    const stages = Array.from({ length: 9 }, (_, i) => `stage${i}:-123456789`);
    const line = formatLine("REQ", "ok", { rid: "7f3a1c02", save: stages.join(",") }, AT);
    const rendered = line.split("save=")[1];
    const parts = rendered.split(",");
    expect(parts.at(-1).endsWith("…")).toBe(true);
    for (let i = 0; i < parts.length - 1; i++) {
      expect(parts[i]).toMatch(/^stage\d+:-?\d+$/);
    }
  });
});

// Schema/folding tests capture admitted lines; bounded asynchronous transport has its own suite.
vi.mock('../../open-sse/utils/asyncLogOutput.js', () => ({
  logOutput: line => console.log(line), flushLogOutput: async () => {}, logOutputStatus: () => ({}),
}));
