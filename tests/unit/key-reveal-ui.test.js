// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

const fixture = vi.hoisted(() => ({ calls: [], response: null, refresh: vi.fn(), keyName: "Workstation" }));
vi.mock("@/shared/hooks/usePoll", () => ({ usePoll: url => ({ loading: false, goodAt: 1, refresh: fixture.refresh,
  data: url === "/api/keys" ? { keys: [{ id: "fixture-key", name: fixture.keyName, keyPreview: "••••last", secretRedacted: true,
    isActive: true, usage: {}, machineId: "fixture", allowedModels: null }] } : url === "/api/settings" ? { requireApiKey: true, requireLogin: true } : { devices: [], windowMinutes: 30 },
}) }));
vi.mock("@/store/authStatus", () => ({ useAuthStatus: selector => selector({ status: { authenticated: true, displayName: "Operator" } }) }));
vi.mock("@/shared/api", () => ({ call: vi.fn(async (url, options) => { fixture.calls.push({ url, ...options }); return fixture.response; }) }));
const { default: KeysPage } = await import("../../src/app/dashboard/keys/page.js");
const secret = "sk-fixture-deliberately-revealed-secret";
let container, root;
beforeEach(async () => {
  fixture.calls = [];
  fixture.keyName = "Workstation";
  fixture.response = { ok: true, body: { id: "fixture-key", key: secret, name: "Workstation" } };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  container = document.createElement("div"); document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<KeysPage />));
  await act(async () => [...container.querySelectorAll("button")].find(el => el.textContent.trim() === "Configure Workstation").click());
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });
async function openReveal() {
  await act(async () => [...container.querySelectorAll("button")].find(el => el.textContent.trim().endsWith("Reveal key")).click());
  return container.querySelector("dialog[open]");
}
async function submit(dialog) { await act(async () => dialog.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); }

it("returns keyboard focus to the current key configuration trigger after closing the panel", async () => {
  fixture.keyName = "Renamed workstation";
  await act(async () => root.render(<KeysPage />));
  const close = [...container.querySelectorAll("button")].find(el => el.textContent.trim() === "Close key");
  close.focus();
  expect(document.activeElement).toBe(close);
  await act(async () => close.click());
  expect(container.querySelector('[aria-label="Selected key configuration"]')).toBeNull();
  const configure = [...container.querySelectorAll("button")].find(el => el.textContent.trim() === "Configure Renamed workstation");
  expect(configure).toBeTruthy();
  expect(document.activeElement).toBe(configure);
  expect(configure.getAttribute("aria-pressed")).toBe("false");
  expect(fixture.calls).toHaveLength(0);
});

it("selects the key through its enclosing label without configuring or mutating the key", async () => {
  const label = container.querySelector(".keys-pick");
  const checkbox = label.querySelector('input[type="checkbox"]');
  expect(label.control).toBe(checkbox);
  expect(checkbox.checked).toBe(false);
  await act(async () => label.click());
  expect(checkbox.checked).toBe(true);
  expect(fixture.calls).toHaveLength(0);
  await act(async () => label.click());
  expect(checkbox.checked).toBe(false);
});

it("reveals one selected key only after explicit confirmation, then clears it on close", async () => {
  expect(container.textContent).toContain("••••last");
  expect(container.textContent).not.toContain(secret);
  const dialog = await openReveal();
  expect(dialog.open).toBe(true);
  expect(fixture.calls).toHaveLength(0);
  await submit(dialog);
  expect(fixture.calls).toEqual([{ url: "/api/keys/fixture-key/reveal", method: "POST" }]);
  expect(dialog.textContent).toContain(secret);
  expect(dialog.textContent).toContain("Key revealed");
  await act(async () => [...dialog.querySelectorAll("button")].find(el => el.textContent === "Cancel").click());
  expect(container.textContent).not.toContain(secret);
  expect(dialog.open).toBe(false);
});

it("does not retain a delayed reveal result after the dialog was closed", async () => {
  let resolve;
  fixture.response = new Promise(done => { resolve = done; });
  const dialog = await openReveal();
  await submit(dialog);
  await act(async () => [...dialog.querySelectorAll("button")].find(el => el.textContent === "Cancel").click());
  await act(async () => resolve({ ok: true, body: { key: secret } }));
  expect(container.textContent).not.toContain(secret);
  expect(dialog.open).toBe(false);
});

it("clears a revealed credential when the tab becomes hidden", async () => {
  const dialog = await openReveal(); await submit(dialog);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(container.textContent).not.toContain(secret);
  expect(dialog.open).toBe(false);
});

it("shows a refused reveal beside its control without creating a credential", async () => {
  fixture.response = { ok: false, status: 403, body: { code: "forbidden_class", error: "Operator credential required" } };
  const dialog = await openReveal(); await submit(dialog);
  expect(dialog.open).toBe(true);
  expect(container.textContent).not.toContain(secret);
  expect(dialog.textContent).toContain("Operator credential required");
});

it("sends the selected protection policy only when the operator saves limits", async () => {
  fixture.response = { ok: true, body: {} };
  const select = container.querySelector('[aria-label="Selected key configuration"] select');
  expect(select.value).toBe("reserve-remaining");
  await act(async () => { select.value = "strict"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(fixture.calls).toHaveLength(0);
  expect(container.textContent).toContain("Existing reservations and uncertain outcomes stay held");
  await act(async () => [...container.querySelectorAll("button")].find(el => el.textContent.trim() === "Review key budgets and model access").click());
  const dialog = container.querySelector("dialog[open]");
  expect(dialog.querySelector("input, select, textarea")).toBeNull();
  await submit(dialog);
  expect(fixture.calls).toEqual([{ url: "/api/keys/fixture-key", method: "PUT", body: {
    budgetPolicy: "strict",
  } }]);
  expect(dialog.open).toBe(false);
  expect(fixture.refresh).toHaveBeenCalled();
});

it("preserves the selected policy and refusal when saving fails", async () => {
  fixture.response = { ok: false, status: 503, body: { error: "Storage unavailable" } };
  await act(async () => [...container.querySelectorAll("button")].find(el => el.textContent.trim() === "Review key budgets and model access").click());
  const dialog = container.querySelector("dialog[open]");
  await submit(dialog);
  expect(dialog.open).toBe(true);
  expect(container.querySelector('[aria-label="Selected key configuration"] select').value).toBe("reserve-remaining");
  expect(dialog.textContent).toContain("Storage unavailable");
});
