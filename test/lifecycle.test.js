import assert from "node:assert/strict";
import test from "node:test";
import extension, { migrateSettings } from "../src/extension.js";
import { createLegacyRuntime } from "../src/core.js";
import { extensionApi, installBrowserMocks } from "./support.js";

test("import is inert and double load/unload cleans owned state", async () => {
  assert.equal(globalThis.window?.["timeblock-organizer_state"], undefined);
  const browser = installBrowserMocks();
  const cleanupOne = await extension.onload({ extensionAPI: extensionApi(browser.calls), extension: { version: "one" } });
  const cleanupTwo = await extension.onload({ extensionAPI: extensionApi(browser.calls), extension: { version: "two" } });
  cleanupOne(); cleanupTwo(); extension.onunload(); extension.onunload();
  assert.equal(globalThis.window["timeblock-organizer_state"], undefined);
  assert.equal(globalThis.window["timeblock-organizer_cleanup"], undefined);
  assert.ok(browser.calls.some(([name]) => name === "command:add"));
  assert.ok(browser.calls.some(([name]) => name === "command:remove"));
});

test("legacy settings migrate once and extension snapshot wins", async () => {
  installBrowserMocks();
  const calls = [];
  const runtime = { readLegacySettings: () => ({ enabled: false, debounceMs: 1234 }), applySettings(value) { this.applied = value; } };
  const api = extensionApi(calls, { settings: { enabled: true, debounceMs: 8000 } });
  const effective = await migrateSettings({ extensionAPI: api, runtime });
  assert.equal(effective.enabled, true);
  assert.equal(runtime.applied.debounceMs, 8000);
});

test("critical time parsing and overlap behavior is preserved", () => {
  installBrowserMocks();
  const runtime = createLegacyRuntime({ extensionAPI: extensionApi([]) });
  const parsed = runtime.helpers.parseTimePrefix("09:00 - 10:00 {{[[TODO]]}} Work");
  assert.equal(parsed.startMin, 540);
  assert.equal(parsed.endMin, 600);
  const overlaps = runtime.helpers.detectOverlaps([
    { uid: "a", string: "09:00 - 10:00 A" },
    { uid: "b", string: "09:30 - 10:30 B" },
  ]);
  assert.equal(overlaps.length, 1);
});

test("core falls back to Roam's command palette when no extension UI API is injected", () => {
  const browser = installBrowserMocks();
  const runtime = createLegacyRuntime({ extensionAPI: {} });
  runtime.start();
  runtime.stop();
  assert.ok(browser.calls.some(([name]) => name === "command:add"));
  assert.ok(browser.calls.some(([name]) => name === "command:remove"));
});
