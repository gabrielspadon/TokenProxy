import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { GET as readiness } from "@/app/api/ready/route.js";
import {
  getPublicModelCatalogState,
  refreshPublicModelCatalogWith,
  resetPublicModelCatalogForTests,
} from "@/app/api/v1/models/catalogSnapshot.js";

describe("started local readiness while catalog refresh is stalled", () => {
  let server;
  let origin;
  let releaseCatalog;
  let refresh;

  beforeAll(async () => {
    resetPublicModelCatalogForTests();
    refresh = refreshPublicModelCatalogWith(
      () =>
        new Promise((resolve) => {
          releaseCatalog = resolve;
        }),
      { reason: "background", timeoutMs: 10_000 }
    );
    while (!getPublicModelCatalogState().running) await delay(1);
    server = createServer(async (_request, response) => {
      const result = await readiness();
      const body = Buffer.from(await result.arrayBuffer());
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(body);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    const started = await fetch(`${origin}/api/ready`);
    if (started.status !== 200) throw new Error("isolated readiness listener did not start");
    await started.arrayBuffer();
  });

  afterAll(async () => {
    releaseCatalog([]);
    await refresh;
    await new Promise((resolve) => server.close(resolve));
    resetPublicModelCatalogForTests();
  });

  it("keeps 1000 loopback requests locally ready with p99 below 100ms", async () => {
    const samples = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: 16 }, async () => {
        while (next < 1000) {
          next += 1;
          const started = performance.now();
          const response = await fetch(`${origin}/api/ready`);
          await response.arrayBuffer();
          samples.push({ status: response.status, elapsed: performance.now() - started });
        }
      })
    );
    const durations = samples.map(({ elapsed }) => elapsed).sort((a, b) => a - b);
    const p99 = durations[Math.ceil(durations.length * 0.99) - 1];
    expect(samples.every(({ status }) => status === 200)).toBe(true);
    expect(getPublicModelCatalogState().running).toBe(true);
    console.log(`[ready-stall] requests=1000 concurrency=16 p99_ms=${p99.toFixed(3)}`);
    expect(p99).toBeLessThan(100);
  });
});
