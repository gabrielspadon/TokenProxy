#!/usr/bin/env node
import "../../tests/qa/gateway-performance/aliases.mjs";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const stages = ["tools", "schema", "thinking", "rtk", "privacy", "inject", "pxpipe", "mem", "headroom", "qac", "pairs", "reorder", "midinject", "final"];
const fail = (message) => { throw new Error(message); };

export function fixtureRequest(variant, session, index, clock) {
  const persistence = variant === "operator-persistence";
  const before = persistence ? 20000 + index * 2000 : 5000 + index * 50;
  let bytes = before;
  const chain = (persistence ? ["rtk", "final"] : stages).map((stage) => {
    const input = bytes;
    if (stage === "rtk") bytes -= 1000;
    return { stage, in: input, out: bytes, semanticPreserving: stage === "rtk" };
  });
  return {
    id: persistence ? `ui-persisted-${index}` : `browser-history-${session}-${String(index).padStart(3, "0")}`,
    timestamp: new Date(clock - (persistence ? (2 - index) : session ? 180 + session + index : 60 - index) * 60_000).toISOString(),
    provider: "openai", model: "local-contract-model", connectionId: "connection-fixture-alpha", status: "success",
    tokens: { prompt_tokens: persistence ? 10000 + index * 1000 : 1200 + index, completion_tokens: 500 + index * 100, cached_tokens: persistence ? 8000 + index * 500 : 400 + index },
    latency: { total: 1300 + index * 100, ttft: 250 },
    contextTelemetry: {
      sessionHash: persistence ? "b".repeat(32) : (session + 1).toString(16).repeat(64), identitySource: "routing",
      logicalRequestId: persistence ? `ui-logical-${index}` : `browser-logical-${session}-${index}`,
      requestedModel: "local-contract-model", clientTool: "Isolated browser test", contextEstimate: 10000 + index * 1200, inputEstimate: 10000 + index * 1200,
      bodyAfterBytes: bytes, cachePrefixBytes: 15000, messageCount: 10 + index * 2, toolCount: 3, routeKind: "direct", formatPair: "openai:openai", selection: "round-robin", attempt: 1,
      controls: { rtk: true, rtkAllowLossy: false }, stages: chain,
    },
  };
}

export async function seedBrowserHistory(root, variant) {
  if (!["operator-persistence", "context-history", "legacy-workspace"].includes(variant)) fail("unknown browser history fixture variant");
  const canonical = realpathSync(root);
  const marker = JSON.parse(readFileSync(join(canonical, "owner.json"), "utf8"));
  const auth = JSON.parse(readFileSync(join(canonical, "preview-auth.json"), "utf8"));
  if (marker.kind !== "tokenproxy-redesign-preview-v1" || marker.root !== canonical || auth.syntheticOnly !== "redesign-fixture" || existsSync(join(canonical, "process.json"))) fail("browser history seed requires a fresh, unstarted owned synthetic fixture");
  if (resolve(process.env.DATA_DIR || "") !== join(canonical, "runtime")) fail("browser history DATA_DIR does not match owned fixture");
  const { getAdapter } = await import("../../src/lib/db/driver.js");
  const { saveRequestStats } = await import("../../src/lib/db/repos/requestStatsRepo.js");
  const { createApiKey } = await import("../../src/lib/db/repos/apiKeysRepo.js");
  const db = await getAdapter();
  if (db.get("SELECT COUNT(*) AS n FROM requestStats").n !== 0 || db.get("SELECT COUNT(*) AS n FROM contextSessions").n !== 0) fail("browser history seed refuses existing retained requests");
  const clock = Date.parse(auth.capturedAt);
  if (!Number.isFinite(clock)) fail("browser fixture clock is invalid");
  if (variant === "legacy-workspace") {
    if (db.get("SELECT COUNT(*) AS n FROM providerConnections").n !== 0) fail("legacy workspace requires an empty account fixture");
    const accounts = [];
    const at = new Date(clock - 60_000).toISOString();
    const old = new Date(clock - 8 * 86400_000).toISOString();
    const resetAt = new Date(clock + 3600_000).toISOString();
    db.transaction(() => {
      for (let index = 0; index < 24; index += 1) {
        const account = { id: `legacy-fixture-${index}`, provider: index < 2 ? "codex" : index < 4 ? "claude" : "openai", name: `Synthetic historical account ${index + 1}` };
        accounts.push(account);
        const windows = Array.from({ length: index < 9 ? 2 : 1 }, (_, window) => ({ key: `Synthetic window ${window + 1}`, remainingPercentage: 30 + index, resetAt }));
        db.run("INSERT INTO providerConnections(id,provider,authType,name,priority,isActive,data,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?)", [account.id, account.provider, "apikey", account.name, index + 1, 0, JSON.stringify({ lastQuotaSnapshot: { fetchedAt: at, windows }, maxConcurrent: 2 }), at, at]);
        for (const window of windows) db.run('INSERT INTO quotaWindows(connectionId,scope,remaining,"limit",resetAt,observedAt,confidence) VALUES(?,?,?,?,?,?,?)', [account.id, window.key, window.remainingPercentage, 100, resetAt, at, "fresh"]);
      }
      db.run(`WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<77588)
        INSERT INTO requestStats(id,timestamp,provider,model,connectionId,status,promptTokens,completionTokens,latencyTotal,latencyTtft,requestedModel,dispatchCoverage)
        SELECT 'legacy-request-'||x,CASE WHEN x BETWEEN 76009 AND 76014 THEN ? ELSE ? END,
          CASE WHEN x%24<2 THEN 'codex' WHEN x%24<4 THEN 'claude' ELSE 'openai' END,'synthetic-model','legacy-fixture-'||(x%24),'success',1000,100,1000,100,'synthetic-model','unknown' FROM n`, [old, at]);
      db.run(`INSERT INTO usageHistory(timestamp,provider,model,connectionId,status,promptTokens,completionTokens,cost,tokens,meta,requestId)
        SELECT timestamp,provider,model,connectionId,'ok',promptTokens,completionTokens,0.001,'{}','{"synthetic":true}',id
        FROM requestStats WHERE CAST(SUBSTR(id,16) AS INTEGER)<76015`);
      db.run("INSERT INTO accountSwitches(id,sessionHash,model,fromConnectionId,toConnectionId,trigger,reason,windows,switchedAt) VALUES(?,?,?,?,?,?,?,?,?)", ["legacy-routing-receipt", "a".repeat(64), "synthetic-model", "legacy-fixture-0", "legacy-fixture-1", "exhaustion", "Synthetic historical routing evidence", "{}", at]);
    });
    const manifestPath = join(canonical, "fixture-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, accounts, source: "synthetic-historical-shape" }, null, 2)}\n`, { mode: 0o600 });
    const receipt = { kind: "tokenproxy-browser-history-fixture-v1", variant, root: canonical, runId: marker.runId, synthetic: true, accounts: accounts.length, sessions: 0, requests: db.get("SELECT COUNT(*) AS n FROM requestStats").n, ledgerRows: db.get("SELECT COUNT(*) AS n FROM usageHistory").n, recentLedgerRows: db.get("SELECT COUNT(*) AS n FROM usageHistory WHERE timestamp>=?", [new Date(clock - 7 * 86400_000).toISOString()]).n, quotaWindows: db.get("SELECT COUNT(*) AS n FROM quotaWindows").n, routingReceipts: db.get("SELECT COUNT(*) AS n FROM accountSwitches").n, upstreamCalls: 0 };
    if (receipt.requests !== 77589 || receipt.ledgerRows !== 76015 || receipt.recentLedgerRows !== 76009) fail("synthetic historical-shape counts do not match browser contract");
    writeFileSync(join(canonical, "browser-history-seed.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    db.flush?.();
    return receipt;
  }
  const sessions = variant === "operator-persistence" ? [3] : [60, 1, 1];
  for (const [session, count] of sessions.entries()) {
    for (let index = 0; index < count; index += 1) {
      const detail = fixtureRequest(variant, session, index, clock);
      await saveRequestStats(detail);
      const stored = db.get("SELECT contextSessionId,contextTelemetryError FROM requestStats WHERE id=?", [detail.id]);
      if (!stored?.contextSessionId || stored.contextTelemetryError) fail("browser fixture context telemetry was not retained");
    }
  }
  const retained = db.all("SELECT id,sessionHash FROM contextSessions ORDER BY lastSeenAt DESC");
  retained.forEach((session, index) => db.run("UPDATE contextSessions SET projectLabel=? WHERE id=?", [variant === "operator-persistence" ? "Persisted contract session" : `Synthetic context history ${index + 1}`, session.id]));
  const key = await createApiKey("Synthetic disclosure fixture", "controlled-browser");
  writeFileSync(join(canonical, "synthetic-key.json"), `${JSON.stringify(key)}\n`, { mode: 0o600 });
  const receipt = { kind: "tokenproxy-browser-history-fixture-v1", variant, root: canonical, runId: marker.runId, synthetic: true, sessions: retained.length, requests: db.get("SELECT COUNT(*) AS n FROM requestStats").n, stages: db.get("SELECT COUNT(*) AS n FROM contextStages").n, plaintextProviderCredentials: false, upstreamCalls: 0 };
  writeFileSync(join(canonical, "browser-history-seed.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  db.flush?.();
  return receipt;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) seedBrowserHistory(process.argv[2], process.argv[3]).then((receipt) => console.log(JSON.stringify(receipt))).catch((error) => { console.error(error.message); process.exitCode = 1; });
