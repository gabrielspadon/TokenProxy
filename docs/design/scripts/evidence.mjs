#!/usr/bin/env node
// Deterministic evidence for one slice of the operator surface. Runs against
// the isolated instance only, writes files, prints one line per check, exits
// non-zero on any failure. No model reads screenshots by default: the numbers
// in evidence/<slice>/report.json are what the lead reads.
//
//   node docs/design/scripts/evidence.mjs --slice login --routes /login
//   node docs/design/scripts/evidence.mjs --slice all --routes /dashboard,/dashboard/keys
//
// Checks per route x locale x width: page loads 200, console has no errors,
// no request leaves for a non-loopback host, axe reports zero serious or
// critical violations, no horizontal overflow, RTL locales resolve dir=rtl.
// Plus, once per run: every string in the UI literal catalogue exists in all
// 34 translated locale files (English is the key and has no file).
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]] : []).filter(Boolean));
const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:20143";
const PASSWORD = process.env.SMOKE_PASSWORD || "123456";
const slice = args.slice || "unnamed";
const routes = (args.routes || "/dashboard").split(",");
const locales = (args.locales || "en,de,vi,zh-CN,fa").split(",");
const widths = (args.widths || "390,768,1440").split(",").map(Number);
const RTL = new Set(["he", "ar", "fa", "ur"]);
const out = resolve("docs/design/evidence", slice);
mkdirSync(out, { recursive: true });

const report = { slice, base: BASE, at: new Date().toISOString(), checks: [], failures: 0 };
const check = (name, ok, detail = "") => {
  report.checks.push({ name, ok, detail });
  if (!ok) report.failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
// Session cookie once, via the real login route.
const login = await ctx.request.post("/api/auth/login", { data: { password: PASSWORD } });
check("login", login.ok(), `status=${login.status()}`);

for (const locale of locales) {
  await ctx.request.post("/api/locale", { data: { locale } });
  for (const width of widths) {
    const page = await ctx.newPage();
    await page.setViewportSize({ width, height: 900 });
    const consoleErrors = [];
    const thirdParty = new Set();
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 160)); });
    page.on("request", (r) => { const h = new URL(r.url()).hostname; if (!["127.0.0.1", "localhost"].includes(h)) thirdParty.add(h); });
    for (const route of routes) {
      const tag = `${route.replace(/\W+/g, "_") || "root"}.${locale}.${width}`;
      const res = await page.goto(route, { waitUntil: "networkidle" }).catch(() => null);
      check(`${tag} loads`, !!res && res.status() === 200, `status=${res?.status()}`);
      if (!res) continue;
      await page.screenshot({ path: `${out}/${tag}.png`, fullPage: true });
      const dir = await page.evaluate(() => document.documentElement.getAttribute("dir"));
      if (RTL.has(locale)) check(`${tag} rtl`, dir === "rtl", `dir=${dir}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`${tag} no-h-overflow`, overflow <= 0, `overflow=${overflow}px`);
      const axe = await new AxeBuilder({ page }).analyze();
      const bad = axe.violations.filter((v) => ["serious", "critical"].includes(v.impact));
      check(`${tag} axe`, bad.length === 0, bad.map((v) => `${v.id}(${v.nodes.length})`).join(",") || "0 serious/critical");
      writeFileSync(`${out}/${tag}.axe.json`, JSON.stringify(axe.violations, null, 1));
    }
    check(`${locale}.${width} console`, consoleErrors.length === 0, consoleErrors[0] || "clean");
    check(`${locale}.${width} third-party`, thirdParty.size === 0, [...thirdParty].join(",") || "none");
    await page.close();
  }
}
await browser.close();

// Locale coverage. English is the key itself and has no file. The inherited
// files are unequal to each other (thousands of keys differ), so the
// reference is not their union but the strings the new surface actually
// ships: every entry in docs/design/strings.json, which the lead maintains as
// the UI's own literal catalogue, must exist in all 34 translated files.
const dir = "public/i18n/literals";
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
let catalogue = [];
try { catalogue = JSON.parse(readFileSync("docs/design/strings.json", "utf8")); } catch { /* not written yet */ }
check("strings catalogue", Array.isArray(catalogue) && catalogue.length > 0, `docs/design/strings.json has ${catalogue.length} strings`);
for (const f of files) {
  const keys = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
  const missing = catalogue.filter((k) => !(k in keys));
  check(`literals ${f}`, missing.length === 0, missing.length ? `${missing.length} missing, first: ${missing[0]}` : `${catalogue.length} covered`);
}
check("literals file-count", files.length === 34, `${files.length} files`);

writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 1));
console.log(`\n${report.failures === 0 ? "PASS" : "FAIL"} ${slice}: ${report.checks.length} checks, ${report.failures} failed, evidence in ${out}`);
process.exit(report.failures ? 1 : 0);
