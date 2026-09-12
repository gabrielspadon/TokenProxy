import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import "./registerAll.js";
import { describeTranslationRoute } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const loadJson = async (path) => JSON.parse(await readFile(`${root}/${path}`, "utf8"));

describe("capability contract manifest", () => {
  it("declares each of the 121 format cells once with executable route expectations", async () => {
    const manifest = await loadJson("tests/contracts/capabilities.json");
    const formats = Object.values(FORMATS);
    expect(manifest.formats).toEqual(formats);
    expect(manifest.cells).toHaveLength(121);
    expect(new Set(manifest.cells.map(({ source, target }) => `${source}>${target}`)).size).toBe(121);

    for (const source of formats) {
      for (const target of formats) {
        const cell = manifest.cells.find((candidate) => candidate.source === source && candidate.target === target);
        expect(cell, `${source}>${target}`).toBeTruthy();
        for (const kind of ["request", "response"]) {
          expect(["supported", "documented-loss", "rejected", "executor-managed"]).toContain(cell[kind].status);
          expect(Array.isArray(cell[kind].lossPolicy)).toBe(true);
          const route = describeTranslationRoute(source, target, kind);
          expect(cell[kind].status === "rejected", `${kind} ${source}>${target}`).toBe(!route.supported);
          expect(cell[kind].mode).toBe(route.mode);
        }
      }
    }
  });

  it("defines the 36 primary endpoint cases from referenced immutable fixtures", async () => {
    const manifest = await loadJson("tests/contracts/capabilities.json");
    const scenarios = ["text", "tool-cycle", "parallel-tools", "reasoning", "image", "malformed"];
    const endpoints = ["/v1/chat/completions", "/v1/messages", "/v1/responses"];
    expect(manifest.primaryEndpoints).toHaveLength(36);
    expect(new Set(manifest.primaryEndpoints.map(({ id }) => id))).toHaveProperty("size", 36);

    for (const endpoint of endpoints) {
      for (const stream of [false, true]) {
        expect(manifest.primaryEndpoints
          .filter((entry) => entry.endpoint === endpoint && entry.stream === stream)
          .map((entry) => entry.scenario).sort()).toEqual([...scenarios].sort());
      }
    }
    for (const entry of manifest.primaryEndpoints) {
      const fixture = await loadJson(entry.fixture);
      expect(fixture).toBeTypeOf("object");
      expect(entry.expected.upstreamDispatch).toBe(entry.scenario !== "malformed");
      expect(entry.expected.outcome).toBe(entry.scenario === "malformed" ? "rejected" : "success");
    }
  });

  it("covers protocol, modality and terminal outcome boundaries explicitly", async () => {
    const manifest = await loadJson("tests/contracts/capabilities.json");
    for (const protocol of ["aws-eventstream", "connectrpc-protobuf", "ndjson"]) {
      expect(manifest.binaryProtocols.filter((entry) => entry.protocol === protocol)
        .map((entry) => entry.variant).sort()).toEqual(["malformed", "oversized", "valid"]);
    }
    for (const route of manifest.modalityRoutes) {
      expect(route.cases.map(({ variant }) => variant).sort()).toEqual(
        ["base64", "malformed", "oversized", "url", "valid"],
      );
      for (const entry of route.cases) await expect(loadJson(entry.fixture)).resolves.toBeTypeOf("object");
    }
    expect(manifest.outcomes.map(({ outcome }) => outcome).sort()).toEqual(
      ["provider-error", "success", "transport-abrupt"],
    );
  });
});
