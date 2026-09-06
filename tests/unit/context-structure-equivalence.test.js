import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { structuralFixtures } from "../qa/context-structure-fixtures.mjs";
import { measureContextStructure } from "../../open-sse/utils/contextStructure.js";

it("preserves every count and HMAC byte from the version-1 pre-optimization oracle", () => {
  const outputs = structuralFixtures().map((body) => measureContextStructure(body,"physical-dispatch",Buffer.alloc(32,7),{serialized:JSON.stringify(body)}));
  // Frozen from 31dbab83 over these 260 deterministic Unicode/protocol fixtures.
  expect(createHash("sha256").update(JSON.stringify(outputs)).digest("hex"))
    .toBe("5b77d3689a15194454ee94bbbd0d6ef0d773d212dd884c7338eb35307d1ce5ce");
});
