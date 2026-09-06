import { beforeAll, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ credentials: vi.fn(async () => { throw Error("Exhausted key reached account selection"); }) }));
vi.mock("../../src/sse/services/auth.js", async (original) => ({ ...(await original()), getProviderCredentials: mocks.credentials }));
const { getAdapter } = await import("../../src/lib/db/driver.js");
const { updateSettings } = await import("../../src/lib/db/repos/settingsRepo.js");
const { validateApiKey } = await import("../../src/lib/db/repos/apiKeysRepo.js");
const { resolveClientApiKey } = await import("../../src/lib/auth/clientApiKey.js");
const db = await getAdapter();
const exhausted = "budget-exhausted-synthetic-key";
beforeAll(async () => {
  await updateSettings({ requireApiKey: false });
  db.run("INSERT INTO apiKeys(id,key,isActive,createdAt,maxPromptTokens) VALUES(?,?,?,?,?)", ["budget-key", exhausted, 1, new Date().toISOString(), 0]);
});
const routes = [
  ["chat", "handleChat"], ["embeddings", "handleEmbeddings"], ["rerank", "handleRerank"],
  ["imageGeneration", "handleImageGeneration"], ["videoGeneration", "handleVideoCreate", "generations"],
  ["stt", "handleStt"], ["tts", "handleTts"], ["jsonProxy", "handleJsonProxy", "ocr"],
  ["search", "handleSearch"], ["fetch", "handleFetch"],
];
function request(modality, key = exhausted) {
  let body = JSON.stringify({ model: "openai/gpt-4o", messages: [{ role: "user", content: "fixture" }], input: "fixture", query: "fixture", documents: ["fixture"], prompt: "fixture", document: { type: "document_url", document_url: "https://fixture.invalid" }, url: "https://fixture.invalid" });
  if (modality === "stt") { body = new FormData(); body.set("model", "openai/whisper-1"); body.set("file", new Blob(["fixture"]), "audio.wav"); }
  return new Request("http://localhost/v1/fixture", { method: "POST", headers: { authorization: `Bearer ${key}` }, body });
}
describe("exhausted presented key cannot become anonymous local traffic", () => {
  it("keeps public budget validation unchanged and attaches a terminal budget refusal", async () => {
    expect(await validateApiKey(exhausted)).toBe(false);
    const resolved = await resolveClientApiKey(request("chat"), validateApiKey);
    expect(resolved.apiKey).toBe(exhausted); expect(resolved.valid).toBe(false);
    expect(resolved.refusal.status).toBe(402); expect(resolved.refusal.headers.get("x-should-retry")).toBe("false");
  });
  it.each(routes)("%s refuses before selecting any provider even with requireApiKey=false", async (file, name, action) => {
    const handler = (await import(`../../src/sse/handlers/${file}.js`))[name];
    const response = await handler(request(file), action);
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ error: { code: "api_key_budget_exceeded" } });
    expect(mocks.credentials).not.toHaveBeenCalled();
  });
});
