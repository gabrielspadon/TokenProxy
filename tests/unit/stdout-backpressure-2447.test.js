import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const serverPath = fileURLToPath(new URL("../../custom-server.js", import.meta.url));
const src = readFileSync(serverPath, "utf8");

// A launcher that redirects stdout to a pipe and never reads it fills the pipe
// buffer; the write stops draining and every HTTP request times out while the
// port stays LISTENING. Console output is not worth a hung gateway.
describe("a stalled stdout reader cannot wedge the server (#2447)", () => {
  it("guards the console chokepoint rather than individual call sites", () => {
    expect(src).toContain("function guardStreamBackpressure");
    expect(src).toContain("console[method] = (...args) =>");
    for (const m of ["'log'", "'info'", "'warn'", "'error'"]) {
      expect(src, `console.${m} is unguarded`).toContain(m);
    }
  });

  it("leaves a TTY alone, since only a pipe can wedge", () => {
    const fn = src.slice(src.indexOf("function guardStreamBackpressure"));
    expect(fn.slice(0, fn.indexOf("\n}"))).toContain("stream.isTTY");
  });

  it("reports what it dropped once the reader catches up", () => {
    expect(src).toContain("resumed ${label} logging; dropped ${lost} writes");
  });

  it("drops writes past the threshold and keeps them below it", async () => {
    // Exercise the real predicate against a stream whose reader never runs.
    const script = `
      const LOG_BACKPRESSURE_BYTES = 1024;
      ${src.slice(src.indexOf("function guardStreamBackpressure"), src.indexOf("const stdoutStalled"))}
      const fake = { isTTY: false, writableLength: 0, write() {} };
      const stalled = guardStreamBackpressure(fake, 'test');
      fake.writableLength = 0;      const under = stalled();
      fake.writableLength = 5000;   const over  = stalled();
      fake.writableLength = 0;      const back  = stalled();
      process.stdout.write(JSON.stringify({ under, over, back }));
    `;
    const out = await new Promise((resolve, reject) => {
      const c = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
      let s = "", e = "";
      c.stdout.on("data", (d) => { s += d; });
      c.stderr.on("data", (d) => { e += d; });
      c.on("error", reject);
      c.on("close", () => (e.trim() ? reject(new Error(e)) : resolve(s)));
    });
    expect(JSON.parse(out)).toEqual({ under: false, over: true, back: false });
  });

  it("the threshold is overridable without editing the file", () => {
    expect(src).toContain("process.env.LOG_BACKPRESSURE_BYTES");
  });
});
