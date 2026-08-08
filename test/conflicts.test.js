import assert from "node:assert/strict";
import test from "node:test";
import { createLegacyRuntime } from "../src/core.js";
import { extensionApi, installBrowserMocks } from "./support.js";

function installGraph(childrenByUid) {
  const browser = installBrowserMocks();
  window.roamAlphaAPI.data.pull = (_pattern, eid) => {
    const uid = Array.isArray(eid) ? eid[1] : String(eid).match(/"([^"]+)"/)?.[1];
    return {
      ":block/children": (childrenByUid.get(uid) || []).map((child, order) => ({
        ":block/uid": child.uid,
        ":block/string": child.string,
        ":block/order": order,
      })),
    };
  };
  return browser;
}

function overlappingGraph(extraPageChildren = [], statusChildren = null) {
  const pageUid = "day";
  const tbUid = "timeblock";
  const statusUid = "status";
  const children = new Map([
    [pageUid, [
      { uid: tbUid, string: "Schedule #TimeBlock" },
      ...extraPageChildren,
    ]],
    [tbUid, [
      { uid: "a", string: "09:00 - 10:00 A" },
      { uid: "b", string: "09:30 - 10:30 B" },
    ]],
  ]);
  if (statusChildren) children.set(statusUid, statusChildren);
  return { pageUid, tbUid, statusUid, children };
}

test("organizer never rewrites user times, even with retired legacy flags", async () => {
  const graph = overlappingGraph();
  const browser = installGraph(graph.children);
  const runtime = createLegacyRuntime({ extensionAPI: extensionApi([]) });
  runtime.applySettings({ autoResolveConflicts: true, conflictDetection: true });

  await runtime.helpers.reconcileTimeBlock(graph.pageUid, "test");

  assert.equal(browser.calls.filter(([name]) => name === "block:update").length, 0);
  assert.equal(browser.calls.filter(([name]) => name === "block:create").length, 0);
  assert.deepEqual(graph.children.get(graph.tbUid).map(block => block.string), [
    "09:00 - 10:00 A",
    "09:30 - 10:30 B",
  ]);
});

test("disabled persistent output removes every stale or duplicate status block", async () => {
  const graph = overlappingGraph([
    { uid: "status-one", string: "**TimeBlock Conflicts** (7) #timeblock-status" },
    { uid: "status-two", string: "**TimeBlock Conflicts** (1) #timeblock-status" },
  ]);
  const browser = installGraph(graph.children);
  const runtime = createLegacyRuntime({ extensionAPI: extensionApi([]) });

  await runtime.helpers.reconcileTimeBlock(graph.pageUid, "cleanup-test");

  const deleted = browser.calls
    .filter(([name]) => name === "block:delete")
    .map(([, args]) => args.block.uid);
  assert.deepEqual(deleted, ["status-one", "status-two"]);
});

test("opted-in conflict status creates one deterministic header and line", async () => {
  const graph = overlappingGraph();
  const browser = installGraph(graph.children);
  const runtime = createLegacyRuntime({ extensionAPI: extensionApi([]) });
  runtime.applySettings({ persistentConflictOutput: true });

  await runtime.helpers.reconcileTimeBlock(graph.pageUid, "status-test");

  const creates = browser.calls.filter(([name]) => name === "block:create");
  assert.equal(creates.length, 2);
  assert.equal(creates[0][1].block.string, "**TimeBlock Conflicts** (1) #timeblock-status");
  assert.equal(creates[1][1].block.string, "((a)) overlaps ((b)) — 30min");
});

test("identical persisted conflict output performs zero writes", async () => {
  const header = { uid: "status", string: "**TimeBlock Conflicts** (1) #timeblock-status" };
  const graph = overlappingGraph([header], [{
    uid: "line",
    string: "((a)) overlaps ((b)) — 30min",
  }]);
  const browser = installGraph(graph.children);
  const runtime = createLegacyRuntime({ extensionAPI: extensionApi([]) });
  runtime.applySettings({ persistentConflictOutput: true });

  await runtime.helpers.reconcileTimeBlock(graph.pageUid, "idempotence-test");

  assert.equal(browser.calls.filter(([name]) => name.startsWith("block:")).length, 0);
});
