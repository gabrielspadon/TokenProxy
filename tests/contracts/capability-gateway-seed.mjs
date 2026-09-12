import "../qa/gateway-performance/aliases.mjs";
import { writeFile } from "node:fs/promises";

const providerBaseUrl = process.env.CAPABILITY_PROVIDER_BASE_URL;
const authFile = process.env.CAPABILITY_AUTH_FILE;
if (!providerBaseUrl || !authFile) throw new Error("Capability gateway fixture requires provider and auth paths");

const { createProviderNode } = await import("../../src/lib/db/repos/nodesRepo.js");
const { createProviderConnection } = await import("../../src/lib/db/repos/connectionsRepo.js");
const { createApiKey } = await import("../../src/lib/db/repos/apiKeysRepo.js");
const { updateSettings } = await import("../../src/lib/db/repos/settingsRepo.js");

const nodeId = "capability-fixture-openai";
await createProviderNode({
  id: nodeId,
  type: "openai-compatible",
  prefix: "fixture",
  name: "Capability fixture upstream",
  apiType: "chat",
  baseUrl: providerBaseUrl,
});
await createProviderConnection({
  provider: nodeId,
  authType: "apikey",
  name: "Capability fixture account",
  apiKey: "fixture-upstream-key",
  isActive: true,
  testStatus: "active",
  providerSpecificData: { baseUrl: providerBaseUrl },
});
await updateSettings({
  requireApiKey: true,
  requireLogin: false,
  rtkEnabled: false,
  headroomEnabled: false,
  pxpipeEnabled: false,
  contextStructureEnabled: false,
  storeRequestDetails: false,
  backgroundTokenRefreshEnabled: false,
});
const fixtureKey = await createApiKey("capability-gateway", "controlled-loopback");
await writeFile(authFile, `Bearer ${fixtureKey.key}\n`, { mode: 0o600 });
