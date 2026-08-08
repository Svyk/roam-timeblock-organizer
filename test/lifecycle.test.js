import assert from "node:assert/strict";
import test from "node:test";
import extension, {
  migrateSettings,
  SETTINGS_MIGRATION_KEY,
  SETTINGS_MIGRATION_VERSION,
} from "../src/extension.js";
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

test("legacy settings migrate once to canonical Depot keys and marker is last", async () => {
  const browser = installBrowserMocks();
  const calls = [];
  localStorage.setItem("timeblock-organizer:settings", JSON.stringify({ enabled: false }));
  const runtime = {
    readLegacySettings: () => ({ enabled: false, timeblockSignature: "#Legacy" }),
    applySettings(value) { this.applied = value; },
  };
  const api = extensionApi(calls, { settings: { enabled: true, timeblockSignature: "#Snapshot", autoResolveConflicts: true } });
  const effective = await migrateSettings({ extensionAPI: api, runtime });
  assert.equal(effective.enabled, true);
  assert.equal(effective.timeblockSignature, "#Snapshot");
  assert.equal(effective.persistentConflictOutput, false);
  assert.equal("autoResolveConflicts" in effective, false);
  assert.equal(api.values.get(SETTINGS_MIGRATION_KEY), SETTINGS_MIGRATION_VERSION);
  const writes = calls.filter(([name]) => name === "setting:set");
  assert.equal(writes.at(-1)[1], SETTINGS_MIGRATION_KEY, "migration marker must be written last");
  assert.equal(browser.localValues.has("timeblock-organizer:settings"), false);
});

test("current migration marker ignores every legacy source", async () => {
  installBrowserMocks();
  const calls = [];
  const runtime = {
    reads: 0,
    readLegacySettings() { this.reads++; return { enabled: false }; },
    applySettings(value) { this.applied = value; },
  };
  const api = extensionApi(calls, {
    [SETTINGS_MIGRATION_KEY]: SETTINGS_MIGRATION_VERSION,
    enabled: true,
  });
  const effective = await migrateSettings({ extensionAPI: api, runtime });
  assert.equal(runtime.reads, 0);
  assert.equal(effective.enabled, true);
  assert.equal(calls.filter(([name]) => name === "setting:set").length, 0);
});

test("read-only Depot installs do not finalize or repeatedly write migration", async () => {
  installBrowserMocks();
  const calls = [];
  const runtime = {
    reads: 0,
    readLegacySettings() { this.reads++; return { enabled: false }; },
    applySettings(value) { this.applied = value; },
  };
  const api = extensionApi(calls, {}, false);
  const effective = await migrateSettings({ extensionAPI: api, runtime });
  assert.equal(runtime.reads, 0);
  assert.equal(effective.enabled, true);
  assert.equal(api.values.has(SETTINGS_MIGRATION_KEY), false);
  assert.equal(calls.filter(([name]) => name === "setting:set").length, 0);
});

test("Depot panel exposes only user-facing switches and enabled reconfigures live", async () => {
  const browser = installBrowserMocks();
  const api = extensionApi(browser.calls, {
    [SETTINGS_MIGRATION_KEY]: SETTINGS_MIGRATION_VERSION,
    enabled: false,
    "persistent-conflict-output": false,
  });
  const cleanup = await extension.onload({ extensionAPI: api, extension: { version: "test" } });
  const panel = browser.calls.find(([name]) => name === "panel:create")[1];
  assert.deepEqual(panel.settings.map(setting => setting.id), [
    "enabled",
    "persistent-conflict-output",
  ]);
  assert.equal(window["timeblock-organizer_state"].activeWatches.size, 0);

  panel.settings[0].action.onChange({ target: { checked: true } });
  assert.equal(window["timeblock-organizer_state"].monitoringActive, true);
  assert.equal(window["timeblock-organizer_state"].activeWatches.size, 2);

  panel.settings[0].action.onChange({ target: { checked: false } });
  assert.equal(window["timeblock-organizer_state"].monitoringActive, false);
  assert.equal(window["timeblock-organizer_state"].activeWatches.size, 0);
  cleanup();
  await Promise.resolve();
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

function installGraph(childrenByUid) {
  const browser = installBrowserMocks();
  window.roamAlphaAPI.data.pull = (_pattern, eid) => {
    const uid = Array.isArray(eid) ? eid[1] : String(eid).match(/"([^"]+)"/)?.[1];
    const children = childrenByUid.get(uid) || [];
    return {
      ":block/children": children.map((child, order) => ({
        ":block/uid": child.uid,
        ":block/string": child.string,
        ":block/order": order,
      })),
    };
  };
  return browser;
}

test("watched pages own a shallow page watch and a shallow TimeBlock watch", async () => {
  const pageUid = "page-uid";
  const timeBlockUid = "timeblock";
  const browser = installGraph(new Map([
    [pageUid, [{ uid: timeBlockUid, string: "Schedule #TimeBlock" }]],
    [timeBlockUid, [{ uid: "button", string: "{{🕗↦:SmartBlock:Double timestamp buttons2}}" }]],
  ]));
  const runtime = createLegacyRuntime({ extensionAPI: extensionApi([]) });
  runtime.applySettings({ debounceMs: 60_000, timeblockDebounceMs: 60_000 });
  runtime.helpers.registerWatch(pageUid, "test");

  const adds = browser.calls.filter(([name]) => name === "watch:add");
  assert.equal(adds.length, 2);
  assert.match(adds[0][2], /page-uid/);
  assert.match(adds[1][2], /timeblock/);

  runtime.helpers.unregisterWatch(pageUid);
  await new Promise(resolve => setImmediate(resolve));
  const removes = browser.calls.filter(([name]) => name === "watch:remove");
  assert.equal(removes.length, 2, "cleanup removes only the two owned callbacks");
  assert.equal(removes[0].length, 4, "pattern, entity and exact callback are retained");
});

test("description-only active-session edits do not schedule organizer work", () => {
  installBrowserMocks();
  const h = createLegacyRuntime({ extensionAPI: extensionApi([]) }).helpers;
  const before = {
    ":block/children": [{
      ":block/uid": "active",
      ":block/string": "07:56 {{⇥🕞:SmartBlock:Elapsed time}} first description",
      ":block/order": 1,
    }],
  };
  const afterDescription = {
    ":block/children": [{
      ":block/uid": "active",
      ":block/string": "07:56 {{⇥🕞:SmartBlock:Elapsed time}} edited description",
      ":block/order": 1,
    }],
  };
  const afterClose = {
    ":block/children": [{
      ":block/uid": "active",
      ":block/string": "07:56 - 08:30 (**34'**) edited description",
      ":block/order": 1,
    }],
  };
  assert.equal(h.timeBlockWatchFingerprint(before), h.timeBlockWatchFingerprint(afterDescription));
  assert.notEqual(h.timeBlockWatchFingerprint(before), h.timeBlockWatchFingerprint(afterClose));
});

test("one atomic reorder replaces an all-children move storm", async () => {
  const pageUid = "daily-page";
  const timeBlockUid = "timeblock";
  const launcher = "{{🕗↦:SmartBlock:Double timestamp buttons2}}";
  const children = new Map([
    [pageUid, [{ uid: timeBlockUid, string: "Schedule #TimeBlock" }]],
    [timeBlockUid, [
      { uid: "planned", string: "08:00 - 09:00 planned" },
      { uid: "button", string: launcher },
      { uid: "finished", string: "07:56 - 08:30 (**34'**) finished" },
    ]],
  ]);
  const browser = installGraph(children);
  window.roamAlphaAPI.data.block.reorderBlocks = async (args) => {
    browser.calls.push(["block:reorder", args]);
    const byUid = new Map(children.get(timeBlockUid).map(item => [item.uid, item]));
    children.set(timeBlockUid, args.blocks.map(uid => byUid.get(uid)));
  };
  const runtime = createLegacyRuntime({ extensionAPI: extensionApi([]) });

  await runtime.helpers.reconcileTimeBlock(pageUid, "test");

  const reorders = browser.calls.filter(([name]) => name === "block:reorder");
  const moves = browser.calls.filter(([name]) => name === "block:move");
  assert.equal(reorders.length, 1);
  assert.deepEqual(reorders[0][1].blocks, ["finished", "planned", "button"]);
  assert.equal(moves.length, 0);
});

test("hot-path reconciliation uses asynchronous narrow pulls", async () => {
  const pageUid = "async-day";
  const timeBlockUid = "async-timeblock";
  const browser = installGraph(new Map([
    [pageUid, [{ uid: timeBlockUid, string: "Schedule #TimeBlock" }]],
    [timeBlockUid, [{ uid: "entry", string: "09:00 - 10:00 work" }]],
  ]));
  const syncPull = window.roamAlphaAPI.data.pull;
  let asyncPulls = 0;
  window.roamAlphaAPI.data.async.pull = async (...args) => {
    asyncPulls++;
    return syncPull(...args);
  };
  const runtime = createLegacyRuntime({ extensionAPI: extensionApi([]) });

  await runtime.helpers.reconcileTimeBlock(pageUid, "async-test");

  assert.equal(asyncPulls, 2, "one page pull and one TimeBlock pull");
  assert.equal(browser.calls.filter(([name]) => name.startsWith("block:")).length, 0);
});

test("a 200-entry TimeBlock still needs only one reorder write", async () => {
  const pageUid = "large-day";
  const timeBlockUid = "large-timeblock";
  const entries = Array.from({ length: 200 }, (_, index) => {
    const start = index * 5;
    const end = start + 4;
    const hhmm = value => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
    return { uid: `entry-${index}`, string: `${hhmm(start)} - ${hhmm(end)} item ${index}` };
  });
  const button = { uid: "button", string: "{{🕗↦:SmartBlock:Double timestamp buttons2}}" };
  const children = new Map([
    [pageUid, [{ uid: timeBlockUid, string: "Schedule #TimeBlock" }]],
    [timeBlockUid, [button, ...entries.toReversed()]],
  ]);
  const browser = installGraph(children);
  window.roamAlphaAPI.data.block.reorderBlocks = async (args) =>
    browser.calls.push(["block:reorder", args]);
  const runtime = createLegacyRuntime({ extensionAPI: extensionApi([]) });

  await runtime.helpers.reconcileTimeBlock(pageUid, "large-test");

  const reorders = browser.calls.filter(([name]) => name === "block:reorder");
  assert.equal(reorders.length, 1);
  assert.equal(reorders[0][1].blocks.length, 201);
  assert.equal(browser.calls.filter(([name]) => name === "block:move").length, 0);
});

test("async open-page lookup registers the current historical page", async () => {
  const browser = installGraph(new Map([
    ["open-day", [{ uid: "tb", string: "Schedule #TimeBlock" }]],
    ["tb", []],
  ]));
  const currentDay = new Date().getDate();
  window.roamAlphaAPI.util.dateToPageUid = date =>
    date.getDate() === currentDay - 1 ? "open-day" : `day-${date.getDate()}`;
  window.roamAlphaAPI.ui.mainWindow.getOpenPageOrBlockUid = async () => "open-day";
  const runtime = createLegacyRuntime({ extensionAPI: extensionApi([]) });
  runtime.start();
  await runtime.helpers.onPageNavigation();
  assert.equal(runtime.state.activeWatches.has("open-day"), true);
  assert.ok(browser.calls.some(([name]) => name === "watch:add"));
  runtime.stop();
  await new Promise(resolve => setImmediate(resolve));
});

test("visibility recovery reconciles today only and skips hidden documents", async () => {
  const todayUid = "today";
  const tomorrowUid = "tomorrow";
  const children = new Map([
    [todayUid, [{ uid: "today-tb", string: "Schedule #TimeBlock" }]],
    ["today-tb", [
      { uid: "late", string: "10:00 - 11:00 late" },
      { uid: "early", string: "09:00 - 10:00 early" },
    ]],
    [tomorrowUid, [{ uid: "tomorrow-tb", string: "Schedule #TimeBlock" }]],
    ["tomorrow-tb", [
      { uid: "tomorrow-late", string: "10:00 - 11:00 late" },
      { uid: "tomorrow-early", string: "09:00 - 10:00 early" },
    ]],
  ]);
  const browser = installGraph(children);
  const currentDay = new Date().getDate();
  window.roamAlphaAPI.util.dateToPageUid = date =>
    date.getDate() === currentDay ? todayUid : tomorrowUid;
  const runtime = createLegacyRuntime({ extensionAPI: extensionApi([]) });
  runtime.start();
  browser.calls.length = 0;

  browser.document.visibilityState = "hidden";
  browser.document.dispatchEvent(new Event("visibilitychange"));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(browser.calls.filter(([name]) => name === "block:reorder").length, 0);

  browser.document.visibilityState = "visible";
  browser.document.dispatchEvent(new Event("visibilitychange"));
  await new Promise(resolve => setTimeout(resolve, 0));
  const reorders = browser.calls.filter(([name]) => name === "block:reorder");
  assert.equal(reorders.length, 1);
  assert.equal(reorders[0][1].location["parent-uid"], "today-tb");
  runtime.stop();
  await Promise.resolve();
});
