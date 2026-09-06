// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const LOCALES = ["de", "fa", "ja", "vi", "zh-CN"];
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PROVIDER_CREATION_LITERALS = [
  "Back to Providers",
  "Connect",
  "Connect a Provider",
  "Choose a catalog Provider, then add a Provider connection with its supported credential flow.",
  "Catalog Provider",
  "Use the Provider page to choose OAuth, API key, cookie, or its own connection method.",
  "Provider",
  "Select a Provider",
  "Continue to connection",
  "Endpoint",
  "Add a compatible upstream",
  "Register the endpoint first. You can add its Provider connections immediately after validation.",
  "OpenAI Compatible",
  "Chat Completions or Responses API endpoint",
  "Anthropic Compatible",
  "Messages API endpoint",
  "Multi-protocol Compatible",
  "One upstream for OpenAI and Anthropic clients",
];

afterEach(() => {
  document.cookie = "locale=en";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("new provider workflow translations", () => {
  for (const locale of LOCALES) {
    it(`translates every provider-creation literal in ${locale}`, async () => {
      const dictionary = JSON.parse(await readFile(
        resolve(REPO_ROOT, `public/i18n/literals/${locale}.json`),
        "utf8",
      ));
      vi.resetModules();
      document.cookie = `locale=${locale}`;
      vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => dictionary })));

      const { reloadTranslations, translate } = await import("@/i18n/runtime.js");
      await reloadTranslations();

      for (const literal of PROVIDER_CREATION_LITERALS) {
        expect(translate(literal), `${locale} leaves ${literal} in English`).not.toBe(literal);
      }
    });
  }
});
