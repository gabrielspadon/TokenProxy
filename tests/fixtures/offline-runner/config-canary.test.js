import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("keeps direct-config test state outside the fake production home", () => {
  expect(process.env.NODE_ENV).toBe("test");
  expect(resolve(process.env.DATA_DIR)).not.toBe(resolve(process.env.HOME, ".tokenproxy"));
  expect(readFileSync(process.env.ISOLATION_CANARY_PATH, "utf8")).toBe("production-canary\n");
});
