const api = require("../api/client");
const { confirm, pause } = require("../utils/input");
const { showStatus } = require("../utils/display");
const { showMenuWithBack } = require("../utils/menuHelper");

// ANSI colors
const COLORS = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m"
};

const DEFAULT_PASSWORD = "123456";

/**
 * Show settings menu (RTK + reset password)
 * @param {Array<string>} breadcrumb - Breadcrumb path
 */
async function showSettingsMenu(breadcrumb = []) {
  await showMenuWithBack({
    title: "⚙️  Settings",
    breadcrumb,
    headerContent: async (data) => {
      const lines = [];

      // RTK section
      const rtkOn = data?.settings?.rtkEnabled !== false;
      lines.push(`  RTK:      ${rtkOn ? `${COLORS.green}ON${COLORS.reset}` : `${COLORS.red}OFF${COLORS.reset}`} ${COLORS.dim}(Token Saver)${COLORS.reset}`);
      const headroomOn = data?.settings?.headroomEnabled === true;
      lines.push(`  Headroom: ${headroomOn ? `${COLORS.green}ON${COLORS.reset}` : `${COLORS.red}OFF${COLORS.reset}`} ${COLORS.dim}(${data?.settings?.headroomUrl || "http://localhost:8787"})${COLORS.reset}`);

      // Auth mode section
      const authMode = data?.settings?.authMode || "password";
      const authColor = authMode === "password" ? COLORS.green : COLORS.yellow;
      lines.push(`  Auth:     ${authColor}${authMode.toUpperCase()}${COLORS.reset} ${COLORS.dim}(login mode)${COLORS.reset}`);

      return lines.join("\n");
    },
    refresh: async () => {
      const settingsRes = await api.getSettings();
      return {
        settings: settingsRes.success ? (settingsRes.data || {}) : {}
      };
    },
    // A function so the auto-ping entries can be generated from what the
    // server reports rather than from a list that goes stale here.
    items: (d0) => [
      {
        label: (d) => {
          const on = d?.settings?.rtkEnabled !== false;
          return `Token Saver (RTK): ${on ? "ON" : "OFF"} → toggle`;
        },
        action: async (d) => { await toggleRtk(d?.settings?.rtkEnabled !== false); return true; }
      },
      {
        label: (d) => {
          const on = d?.settings?.headroomEnabled === true;
          return `Token Saver (Headroom): ${on ? "ON" : "OFF"} → toggle`;
        },
        action: async (d) => { await toggleHeadroom(d?.settings?.headroomEnabled === true); return true; }
      },
      // One entry per configured auto-ping provider, generated from the table
      // rather than listed here. Naming them meant a newly configured provider
      // had no way to be turned on from this menu at all (#2564).
      ...(d0?.settings?.quotaAutoPingProviders || []).map(({ id, settingsKey }) => {
        const name = id.charAt(0).toUpperCase() + id.slice(1);
        return {
          label: (d) => `Auto-ping (${name}): ${autoPingIsOn(d?.settings?.[settingsKey]) ? "ON" : "OFF"} → toggle`,
          action: async (d) => {
            await toggleAutoPing(settingsKey, name, d?.settings?.[settingsKey]);
            return true;
          },
        };
      }),
      {
        label: "🔑 Reset Password to Default",
        action: async () => { await resetPassword(); return true; }
      },
      {
        label: (d) => {
          const mode = d?.settings?.authMode || "password";
          return mode === "password" ? "🔓 Reset Auth Mode (already password)" : `🔓 Reset Auth Mode to Password (current: ${mode})`;
        },
        action: async () => { await resetAuthMode(); return true; }
      }
    ]
  });
}

/**
 * Reset authMode to "password" via API. Used when OIDC is misconfigured
 * and user is locked out of dashboard. CLI bypasses auth via x-tp-cli-token.
 */
async function resetAuthMode() {
  const ok = await confirm("Reset auth mode to PASSWORD (disable OIDC)?");
  if (!ok) {
    showStatus("Cancelled", "info");
    await pause();
    return;
  }

  const result = await api.updateSettings({ authMode: "password" });
  if (result.success) {
    showStatus("Auth mode reset to password. OIDC disabled.", "success");
  } else {
    showStatus(`Failed: ${result.error}`, "error");
  }
  await pause();
}

/**
 * Toggle RTK (Token Saver) via API
 * @param {boolean} currentlyOn
 */
async function toggleRtk(currentlyOn) {
  const next = !currentlyOn;
  const result = await api.updateSettings({ rtkEnabled: next });
  if (result.success) {
    showStatus(`Token Saver ${next ? "enabled" : "disabled"}`, "success");
  } else {
    showStatus(`Failed: ${result.error}`, "error");
  }
  await pause();
}

async function toggleHeadroom(currentlyOn) {
  const next = !currentlyOn;
  const result = await api.updateSettings({ headroomEnabled: next });
  if (result.success) {
    showStatus(`Headroom ${next ? "enabled" : "disabled"}`, "success");
  } else {
    showStatus(`Failed: ${result.error}`, "error");
  }
  await pause();
}

// Quota auto-ping was reachable only from the dashboard, so a headless install
// could not turn it on or off at all (#2349). Same shape as the two toggles
// above: the settings API already owns both keys and reconfigures the scheduler
// on write, so this needs no new endpoint and no CLI-side state.
// The scheduler gates on the PER-CONNECTION map and reads nothing else, so "on"
// is "at least one account is turned on", not the sibling `enabled` flag, which
// no code path reads.
function autoPingIsOn(cfg) {
  return Object.values(cfg?.connections || {}).some((v) => v === true);
}

// WRITE THE SHAPE THE SCHEDULER READS. This menu used to PATCH a bare boolean,
// and `updateSettings` replaces a top-level key wholesale
// (src/lib/db/repos/settingsRepo.js:251), so one toggle here overwrote
// `{enabled, connections}` with `true` and destroyed the account map. That
// silently turned warming OFF for every account on the provider, because the
// tick skips a provider whose connections map is empty
// (src/shared/services/quotaAutoPing.js:778), and only the dashboard's
// per-connection switches could put it back.
//
// This menu has no connection list of its own, so it flips the accounts already
// enrolled rather than inventing membership: turning a provider on re-arms what
// the dashboard enrolled, and enrolling a NEW account stays a dashboard action.
// Returns null when nothing is enrolled, since writing an empty map would read
// back as "on" while warming nothing.
function nextAutoPingConfig(current) {
  const connections = { ...(current?.connections || {}) };
  const ids = Object.keys(connections);
  if (ids.length === 0) return null;
  const enabled = !autoPingIsOn(current);
  for (const id of ids) connections[id] = enabled;
  return { ...current, enabled, connections };
}

async function toggleAutoPing(key, label, current) {
  const next = nextAutoPingConfig(current);
  if (!next) {
    showStatus(
      `Auto-ping (${label}): no accounts enrolled — enable one in the dashboard first`,
      "info",
    );
    await pause();
    return;
  }
  const result = await api.updateSettings({ [key]: next });
  const count = Object.keys(next.connections).length;
  if (result.success) {
    showStatus(
      `Auto-ping (${label}) ${next.enabled ? "enabled" : "disabled"} for ${count} account(s)`,
      "success",
    );
  } else {
    showStatus(`Failed: ${result.error}`, "error");
  }
  await pause();
}

/**
 * Reset dashboard password to default via server API (writes the live SQLite DB).
 * After reset, user can log in with the default password "123456".
 */
async function resetPassword() {
  const ok = await confirm(`Reset dashboard password to default "${DEFAULT_PASSWORD}"?`);
  if (!ok) {
    showStatus("Cancelled", "info");
    await pause();
    return;
  }

  const result = await api.resetPassword();
  if (result.success) {
    showStatus(`Password reset. Default: ${DEFAULT_PASSWORD}`, "success");
  } else {
    showStatus(`Failed to reset password: ${result.error}`, "error");
  }
  await pause();
}

module.exports = { showSettingsMenu, autoPingIsOn, nextAutoPingConfig };
