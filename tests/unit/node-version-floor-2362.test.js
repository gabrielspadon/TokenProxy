import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

// Opening a dashboard page on Node 18 answered 500 with nothing naming the
// cause (#2362). Next 16 requires >=20.9.0, so that runtime was never supported;
// what was missing is anything that SAYS so. The floor is one number and every
// place that states it has to agree, or the guard tells the user something the
// install already contradicted.
const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));

const nextFloor = read("../../node_modules/next/package.json").engines.node;
const transportFloor = read("../../node_modules/undici/package.json").engines.node;
const minimum = [nextFloor, transportFloor].map(range => range.match(/^>=([\d.]+)$/)[1])
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
const requiredFloor = `>=${minimum}`;
const rootPkg = read("../../package.json");
const cliPkg = read("../../cli/package.json");
const server = readFileSync(new URL("../../custom-server.js", import.meta.url), "utf8");

describe("supported Node floor is stated once and consistently (#2362)", () => {
  it("the gateway package covers both application and transport runtime requirements", () => {
    expect(rootPkg.engines?.node).toBe(requiredFloor);
  });

  it("the CLI launcher declares the same floor", () => {
    expect(cliPkg.engines?.node).toBe(requiredFloor);
  });

  it("the server refuses to boot below that floor instead of answering 500", () => {
    const declared = server.match(/const MIN_NODE_VERSION = '([\d.]+)'/)?.[1];
    expect(declared).toBe(minimum);
    expect(server).toContain("process.versions.node");
  });

  it.each([['18.20.4', false], ['20.9.0', false], ['20.18.0', false], ['20.18.1', true], ['24.14.0', true]])
    ('executes the actual boot guard on Node %s', (version, accepted) => {
      const stopped = new Error('process exited'), error = vi.fn(), exit = vi.fn(() => { throw stopped; });
      const boot = () => runInNewContext(server.slice(0, server.indexOf('// A launcher')),
        { require: createRequire(import.meta.url), process: { versions: { node: version }, exit }, console: { error } });
      if (accepted) { expect(boot).not.toThrow(); expect(exit).not.toHaveBeenCalled(); }
      else { expect(boot).toThrow(stopped); expect(exit).toHaveBeenCalledWith(1); expect(error.mock.calls[0][0]).toContain(minimum); }
    });
});
