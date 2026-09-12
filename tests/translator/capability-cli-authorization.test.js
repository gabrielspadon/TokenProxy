import { describe, expect, it } from "vitest";
import { resolveCliAuthorization } from "../contracts/run-capability-matrix.mjs";

describe("capability matrix CLI authorization", () => {
  it("reads a fake authorization value from a named environment variable", () => {
    expect(resolveCliAuthorization(
      ["node", "runner", "--authorization-env=CAPABILITY_GATEWAY_AUTH"],
      { CAPABILITY_GATEWAY_AUTH: "Bearer fixture-client-key\n" },
    )).toBe("Bearer fixture-client-key");
  });

  it("reads a fake authorization value from a supplied file descriptor", () => {
    expect(resolveCliAuthorization(
      ["node", "runner", "--authorization-fd=9"],
      {},
      (fd, encoding) => {
        expect(fd).toBe(9);
        expect(encoding).toBe("utf8");
        return "Bearer fixture-fd-key\n";
      },
    )).toBe("Bearer fixture-fd-key");
  });

  it("refuses an authorization value on argv", () => {
    expect(() => resolveCliAuthorization(["node", "runner", "--authorization=Bearer fixture-key"]))
      .toThrow("must not be passed on argv");
  });
});
