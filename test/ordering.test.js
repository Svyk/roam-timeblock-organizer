import assert from "node:assert/strict";
import test from "node:test";
import { createLegacyRuntime } from "../src/core.js";
import { extensionApi, installBrowserMocks } from "./support.js";

function helpers() {
  installBrowserMocks();
  return createLegacyRuntime({ extensionAPI: extensionApi([]) }).helpers;
}

/* Bug A — the reported symptom. looseParseTimePrefix measured its 30-char
 * window from the RAW string, so leading markers/refs pushed a real time out
 * of range and the entry was bucketed untimed and sorted to the BOTTOM. */
test("entries with leading markers and page refs still sort by their time", () => {
  const h = helpers();

  // "{{[[TODO]]}} " is 13 chars on its own; one page ref is enough to break it.
  const withRef = "{{[[TODO]]}} [[Food Safety Weekly Review]] 07:00 first thing";
  const withTwoRefs = "{{[[TODO]]}} [[EMP/26-002-EMP]] and [[Lori]] 06:30 very early";

  assert.equal(h.looseParseTimePrefix(withRef), 7 * 60, "07:00 behind a page ref must parse");
  assert.equal(h.looseParseTimePrefix(withTwoRefs), 6 * 60 + 30, "06:30 behind two refs must parse");

  const { timed, untimed } = h.sortTimedEntries([
    "14:00 - 15:00 afternoon",
    withRef,
    "08:00 - 09:00 standup",
    withTwoRefs,
  ]);
  assert.equal(untimed.length, 0, "nothing with a time may be bucketed untimed");
  assert.deepEqual(timed, [withTwoRefs, withRef, "08:00 - 09:00 standup", "14:00 - 15:00 afternoon"]);
});

test("a time buried deep in prose is still NOT treated as the sort key", () => {
  const h = helpers();
  const prose = "review the long meeting notes and every remaining action item before 16:00 today";
  assert.equal(h.looseParseTimePrefix(prose), null,
    "widening the window must not turn any late-mentioned time into a sort key");
});

test("stripLeadingNoise removes markers, refs, tags and bullets but keeps content", () => {
  const h = helpers();
  assert.equal(h.stripLeadingNoise("{{[[TODO]]}} [[Page]] 09:00 x"), "09:00 x");
  assert.equal(h.stripLeadingNoise("((abc123)) 10:15 y"), "10:15 y");
  assert.equal(h.stripLeadingNoise("#ctx/work 11:00 z"), "11:00 z");
  assert.equal(h.stripLeadingNoise("09:00 already clean"), "09:00 already clean");
});

/* Bug B — equal start times fell back to bucket insertion order. */
test("same-start entries tie-break on end time, then document order", () => {
  const h = helpers();
  const { timed } = h.sortTimedEntries([
    "09:00 - 11:00 longer",
    "09:00 - 09:30 shorter",
    "09:00 - 10:00 middle",
  ]);
  assert.deepEqual(timed, [
    "09:00 - 09:30 shorter",
    "09:00 - 10:00 middle",
    "09:00 - 11:00 longer",
  ], "at equal start, shorter block first");
});

test("strict and loose entries interleave chronologically, not by bucket", () => {
  const h = helpers();
  const loose = "{{[[TODO]]}} [[Project]] 10:00 loose entry";
  const { timed } = h.sortTimedEntries([
    "11:00 - 12:00 late strict",
    loose,
    "09:00 - 10:00 early strict",
  ]);
  assert.deepEqual(timed, ["09:00 - 10:00 early strict", loose, "11:00 - 12:00 late strict"],
    "a loose 10:00 must land between strict 09:00 and 11:00, not after both");
});

test("ordering is total and stable for identical keys", () => {
  const h = helpers();
  const { timed } = h.sortTimedEntries([
    "09:00 - 10:00 first",
    "09:00 - 10:00 second",
    "09:00 - 10:00 third",
  ]);
  assert.deepEqual(timed, ["09:00 - 10:00 first", "09:00 - 10:00 second", "09:00 - 10:00 third"]);
});

/* Bug C — `% 24` mapped end-of-day 1440 to 00:00. */
test("24:00 end-of-day round-trips instead of collapsing to 00:00", () => {
  const h = helpers();
  const parsed = h.parseTimePrefix("23:00 - 24:00 end of day wrap");
  assert.equal(parsed.startMin, 23 * 60);
  assert.equal(parsed.endMin, 1440);
  assert.equal(h.formatMinAsHHMM(1440), "24:00", "1440 is end-of-day, not midnight");
  assert.equal(h.formatMinAsHHMM(0), "00:00");
  assert.equal(h.formatMinAsHHMM(23 * 60), "23:00");
});

/* Speed contract: the comparator must not run the parsing regexes. */
test("sort keys are computed once per entry, not per comparison", () => {
  const h = helpers();
  const items = [];
  for (let i = 0; i < 200; i++) {
    const hh = String(i % 24).padStart(2, "0");
    items.push(`${hh}:00 - ${hh}:30 entry ${i}`);
  }
  const t0 = process.hrtime.bigint();
  const { timed } = h.sortTimedEntries(items);
  const us = Number(process.hrtime.bigint() - t0) / 1000;
  assert.equal(timed.length, 200);
  // O(n) parses is ~sub-millisecond here; O(n log n) regex runs is far slower.
  assert.ok(us < 25000, `sorting 200 entries took ${us.toFixed(0)}us — comparator is likely re-parsing`);
});
