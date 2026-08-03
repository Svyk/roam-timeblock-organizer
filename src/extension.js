import { createLegacyRuntime } from "./core.js";

export const VERSION = "1.1.6";
export const SETTINGS_KEY = "settings";
let activeRuntime = null;

async function setInitial(extensionAPI, id, value) {
  if (extensionAPI.settings.get(id) == null && extensionAPI.settings.canSet !== false) {
    await extensionAPI.settings.set(id, value);
  }
  const stored = extensionAPI.settings.get(id);
  return stored == null ? value : stored;
}

export async function migrateSettings({ extensionAPI, runtime }) {
  const legacy = runtime.readLegacySettings();
  let snapshot = extensionAPI.settings.get(SETTINGS_KEY);
  if (!snapshot || typeof snapshot !== "object") {
    snapshot = { ...legacy };
    if (extensionAPI.settings.canSet !== false) await extensionAPI.settings.set(SETTINGS_KEY, snapshot);
  }
  const effective = { ...legacy, ...snapshot };
  runtime.applySettings(effective);
  return effective;
}

async function createPanel(extensionAPI, runtime, effective) {
  const toggles = [
    ["enabled", "enabled", "Enabled", "Watch daily pages and keep TimeBlock children organized."],
    ["conflict-detection", "conflictDetection", "Conflict detection", "Detect overlapping time ranges."],
    ["conflict-status", "conflictStatusBlock", "Conflict status block", "Write a status block when conflicts exist."],
    ["auto-resolve", "autoResolveConflicts", "Auto-resolve conflicts", "Bump later items forward. Off by default."],
    ["dry-run", "dryRun", "Dry run", "Log intended moves without writing them."],
    ["verbose", "verbose", "Verbose logging", "Print reconciliation diagnostics."],
  ];
  for (const [id, key] of toggles) effective[key] = await setInitial(extensionAPI, id, effective[key]);
  runtime.applySettings(effective);
  const change = (key) => async (event) => {
    runtime.setSetting(key, Boolean(event.target.checked));
    if (extensionAPI.settings.canSet !== false) {
      await extensionAPI.settings.set(SETTINGS_KEY, runtime.getSettings());
    }
  };
  await extensionAPI.settings.panel.create({
    tabTitle: "TimeBlock Organizer",
    settings: toggles.map(([id, key, name, description]) => ({
      id,
      name,
      description,
      action: { type: "switch", onChange: change(key) },
    })),
  });
}

export async function onload({ extensionAPI, extension }) {
  if (activeRuntime) activeRuntime.stop();
  const runtime = createLegacyRuntime({ extensionAPI });
  activeRuntime = runtime;
  try {
    const effective = await migrateSettings({ extensionAPI, runtime });
    await createPanel(extensionAPI, runtime, effective);
    runtime.start();
    console.info(`[timeblock-organizer] loaded v${extension?.version || VERSION}`);
  } catch (error) {
    runtime.stop();
    if (activeRuntime === runtime) activeRuntime = null;
    throw error;
  }
  return () => {
    if (activeRuntime === runtime) activeRuntime = null;
    runtime.stop();
  };
}

export function onunload() {
  const runtime = activeRuntime;
  activeRuntime = null;
  runtime?.stop();
}

export default { onload, onunload };

