import { createLegacyRuntime } from "./core.js";

export const VERSION = "1.2.0";
export const SETTINGS_MIGRATION_VERSION = 2;
export const SETTINGS_MIGRATION_KEY = "settings-migration-version";
const LEGACY_SNAPSHOT_KEY = "settings";

export const SETTING_SPECS = [
  { id: "enabled", key: "enabled", defaultValue: true },
  { id: "persistent-conflict-output", key: "persistentConflictOutput", defaultValue: false },
  { id: "timeblock-signature", key: "timeblockSignature", defaultValue: "#TimeBlock" },
  { id: "active-session-signature", key: "activeSessionSignature", defaultValue: "{{⇥🕞:SmartBlock:Elapsed time}}" },
  { id: "smartblock-button-signature", key: "smartblockButtonSignature", defaultValue: "{{🕗↦:SmartBlock:Double timestamp buttons2}}" },
  { id: "ignore-overlap-markers", key: "conflictIgnoreMarkers", defaultValue: "#calendar, #concurrent, #no-conflict" },
  { id: "loose-sort-fallback", key: "looseSortFallback", defaultValue: true },
  { id: "untimed-at-bottom", key: "untimedAtBottom", defaultValue: true },
];

let activeRuntime = null;

function canonicalSettings(extensionAPI) {
  return Object.fromEntries(SETTING_SPECS.map(spec => {
    const saved = extensionAPI.settings.get(spec.id);
    return [spec.key, saved == null ? spec.defaultValue : saved];
  }));
}

export async function migrateSettings({ extensionAPI, runtime }) {
  const marker = extensionAPI.settings.get(SETTINGS_MIGRATION_KEY);
  if (marker !== SETTINGS_MIGRATION_VERSION && extensionAPI.settings.canSet !== false) {
    const legacy = runtime.readLegacySettings();
    const snapshot = extensionAPI.settings.get(LEGACY_SNAPSHOT_KEY);
    const oldDepot = snapshot && typeof snapshot === "object" ? snapshot : {};

    for (const spec of SETTING_SPECS) {
      if (extensionAPI.settings.get(spec.id) != null) continue;
      let value = oldDepot[spec.key] ?? legacy[spec.key] ?? spec.defaultValue;
      // The old status setting was auto-seeded true, so intent is unknowable.
      // A new ID and explicit false policy make persistent output genuinely opt-in.
      if (spec.key === "persistentConflictOutput") value = false;
      if (spec.key === "conflictIgnoreMarkers") value = spec.defaultValue;
      await extensionAPI.settings.set(spec.id, value);
    }
    // Marker last: a partial write safely retries next load.
    await extensionAPI.settings.set(SETTINGS_MIGRATION_KEY, SETTINGS_MIGRATION_VERSION);
    try { localStorage.removeItem("timeblock-organizer:settings"); } catch {}
  }

  const effective = canonicalSettings(extensionAPI);
  runtime.applySettings(effective);
  return effective;
}

async function createPanel(extensionAPI, runtime) {
  const change = key => event => runtime.setSetting(key, Boolean(event.target.checked));
  await extensionAPI.settings.panel.create({
    tabTitle: "TimeBlock Organizer",
    settings: [
      {
        id: "enabled",
        name: "Enabled",
        description: "Organize TimeBlock entries during active work sessions.",
        action: { type: "switch", onChange: change("enabled") },
      },
      {
        id: "persistent-conflict-output",
        name: "Persistent conflict output",
        description: "Write a conflict summary on Daily Notes. Manual conflict inspection remains available when off.",
        action: { type: "switch", onChange: change("persistentConflictOutput") },
      },
    ],
  });
}

export async function onload({ extensionAPI, extension }) {
  if (activeRuntime) activeRuntime.stop();
  const runtime = createLegacyRuntime({ extensionAPI });
  activeRuntime = runtime;
  try {
    await migrateSettings({ extensionAPI, runtime });
    await createPanel(extensionAPI, runtime);
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
