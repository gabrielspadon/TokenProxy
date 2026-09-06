// @vitest-environment jsdom
//
// The relay TTL and the pagehide teardown are DOM behaviour: they exist so the OAuth
// code does not sit in localStorage after the popup has served its purpose. Neither is
// observable without a DOM, which is why this file opts into jsdom while the rest of the
// suite stays on the faster node environment.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

const { default: CallbackPage, callbackOutcome } = await import("../../src/app/callback/page.js");

const RELAY_KEY = "oauth_callback";
const RELAY_TTL_MS = 30_000;

const readRelay = () => {
  const raw = localStorage.getItem(RELAY_KEY);
  return raw === null ? null : JSON.parse(raw);
};

function mount(search) {
  window.history.replaceState(null, "", `/callback?${search}`);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<CallbackPage />));
  return {
    container,
    unmount: () => act(() => root.unmount()),
  };
}

describe("OAuth callback relay lifetime", () => {
  let mounted;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    localStorage.clear();
    // jsdom refuses window.close() for a window it did not open, and the success
    // path calls it 1.5s in.
    vi.spyOn(window, "close").mockImplementation(() => {});
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("writes the code to the relay so a listening dashboard tab can pick it up", () => {
    mounted = mount("code=abc123&state=s1");

    expect(readRelay()).toMatchObject({ code: "abc123", state: "s1" });
    expect(typeof readRelay().timestamp).toBe("number");
    expect(readRelay().expiresAt - readRelay().timestamp).toBe(RELAY_TTL_MS);
  });

  it("drops the relay once the TTL elapses, even while the page stays open", () => {
    mounted = mount("code=abc123&state=s1");
    expect(readRelay()).not.toBeNull();

    act(() => vi.advanceTimersByTime(RELAY_TTL_MS - 1));
    expect(readRelay()).not.toBeNull();

    act(() => vi.advanceTimersByTime(1));
    expect(localStorage.getItem(RELAY_KEY)).toBeNull();
  });

  it("drops the relay on pagehide, which is the only teardown a bfcache'd tab gets", () => {
    mounted = mount("code=abc123&state=s1");
    expect(readRelay()).not.toBeNull();

    act(() => { window.dispatchEvent(new Event("pagehide")); });

    expect(localStorage.getItem(RELAY_KEY)).toBeNull();
  });

  it("unregisters the pagehide listener on unmount so it cannot outlive the page", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    mounted = mount("error=access_denied&error_description=nope");

    mounted.unmount();
    mounted = null;

    expect(localStorage.getItem(RELAY_KEY)).toBeNull();
    expect(removeSpy).toHaveBeenCalledWith("pagehide", expect.any(Function));
  });

  it("renders the provider's refusal rather than a success line, and drops the code", () => {
    mounted = mount("code=abc&error=access_denied&error_description=You%20said%20no");

    const alert = mounted.container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert.textContent).toContain("The provider refused the sign-in.");
    expect(alert.textContent).toContain("You said no");
    expect(readRelay()).toMatchObject({ error: "access_denied" });
    expect(readRelay().code).toBeUndefined();
    expect(callbackOutcome({ error: "access_denied", code: "abc" })).toBe("error");
  });
});
