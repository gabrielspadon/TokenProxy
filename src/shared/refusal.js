// One sentence per refusal shape. `status` is the HTTP status, `body` the JSON.
export function refusal(status, body) {
  const code = body?.code;
  if (status === 0 || code === "network") {
    return { tone: "bad", title: "The gateway did not answer.", next: "Check that TokenProxy is running, then reload." };
  }
  if (body?.source === "tokenproxy-admin") {
    switch (code) {
      case "unauthorized":
        return { tone: "warn", title: "This needs an operator credential.", next: "Sign in to the dashboard, or use the CLI token." };
      case "forbidden_class":
        return { tone: "bad", title: "An inference API key does not satisfy this endpoint.", next: "Sign in as the operator." };
      case "forbidden_loopback":
        return { tone: "bad", title: "State changes are loopback-bound.", next: "Run this from the machine that hosts the gateway, or through a tunnel that ends as a loopback peer." };
      case "not_found":
        return { tone: "warn", title: "Nothing exists at this id.", next: "It may have been deleted since the list was read." };
      case "state_unavailable":
        return { tone: "bad", title: "The gateway could not read its own state.", next: "Try again in a moment.", detail: body.error };
      case "no_prior_release":
        return { tone: "warn", title: "There is no earlier release to roll back to.", next: "Activate a specific release instead." };
      case "precondition_failed":
        return { tone: "warn", title: "That release cannot be activated.", detail: body.error };
      case "recheck_in_progress":
        if (/draining/i.test(body.error || "")) return { tone: "warn", title: "This connection is draining, so a probe is refused.", next: "Cancel the drain first, or wait for it to finish." };
        return { tone: "warn", title: "Another check is already running.", next: "Wait for it to finish, then try again." };
      default:
        break;
    }
    if (status === 412) {
      return { tone: "warn", title: "The record changed since you read it.", next: "Reload to see the current version, then decide again.", detail: body.currentVersion };
    }
    if (status === 409) {
      return { tone: "warn", title: "Another check is already running.", next: "Wait for it to finish, then try again." };
    }
  }
  if (status === 401) return { tone: "warn", title: "Your session has ended.", next: "Sign in again." };
  if (status === 404) return { tone: "warn", title: "Nothing exists at this id.", next: "It may have been deleted since the list was read." };
  if (status === 400) return { tone: "warn", title: "The gateway refused the input.", detail: body?.error };
  if (status === 403) return { tone: "bad", title: "This action is not allowed from here.", detail: body?.error };
  return { tone: "bad", title: "The request failed.", detail: body?.error || `HTTP ${status}` };
}
