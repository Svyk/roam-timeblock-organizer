/* timeblock-organizer v1.2.0
 *
 * Organizes direct children beneath standalone #TimeBlock parents with two
 * shallow watches per active Daily Note. Completed ranges sort chronologically;
 * unfinished Elapsed Time sessions remain in a stable Now lane; the permanent
 * launcher remains last. Conflict inspection is read-only. Persistent status
 * output is opt-in and idempotent. Startup, visibility resume, and hourly
 * today-only recovery cover missed events without graph-wide polling.
 *
 * No LLM call. Narrow Roam pulls plus bounded block.move/reorderBlocks writes.
 */
export function createLegacyRuntime({ extensionAPI }) {
  const commandPaletteApi = extensionAPI?.ui?.commandPalette ?? window.roamAlphaAPI?.ui?.commandPalette;
  const VERSION = "1.2.0";
  const NAMESPACE = "timeblock-organizer";
  const SETTINGS_PAGE = "TimeBlock Organizer Settings";

  const DEFAULTS = {
    enabled: true,
    timeblockSignature: "#TimeBlock",
    activeSessionSignature: "{{⇥🕞:SmartBlock:Elapsed time}}",
    smartblockButtonSignature: "{{🕗↦:SmartBlock:Double timestamp buttons2}}",
    persistentConflictOutput: false,
    conflictIgnoreMarkers: "#calendar, #concurrent, #no-conflict",
    looseSortFallback: true,               // when strict regex fails, scan first 30 chars for HH:MM and sort by that anyway (catches in-progress edits like "19:00 " or "{{[[TODO]]}} 19:00 thing"); never rewrites the block
    untimedAtBottom: true,                 // when an entry can't be timed even loosely, park it at the BOTTOM of the TimeBlock (not the top — that was the surprise)
  };

  // Safety limits are implementation details, not user settings. Keeping them
  // fixed prevents an innocent preference edit from multiplying Roam work.
  const RUNTIME = {
    pageDebounceMs: 8000,
    timeblockDebounceMs: 1500,
    historicalWindowDays: 7,
    maxWatchedPages: 3,
    recoveryIntervalMs: 60 * 60_000,
    rolloverCheckMs: 60_000,
    suppressMs: 2000,
  };

  const state = {
    settings: { ...DEFAULTS },
    disposed: false,
    activeWatches: new Map(),              // pageUid → owned page + TimeBlock watches
    pendingReconciles: new Map(),          // pageUid → debounce timer
    inFlightReconciles: new Map(),         // pageUid → active reconcile promise
    dirtyReconciles: new Map(),            // pageUid → latest reason received in flight
    suppressUntilByPage: new Map(),        // pageUid → ignore own watch callbacks until timestamp
    recoveryTimer: null,
    rolloverTimer: null,
    cachedTodayUid: null,
    navigationPageUid: null,
    navigationListenerAttached: false,
    visibilityListenerAttached: false,
    monitoringActive: false,
    registeredCommandLabels: new Set(),
  };

  const log = (lvl, msg, data) =>
    console[lvl](`[${NAMESPACE}] ${msg}`, data ?? "");
  const debug = () => {};

  /* ---------- Roam helpers ---------- */
  const CHILDREN_PULL = "[{:block/children [:block/uid :block/string :block/order]}]";

  function childrenFromPull(data) {
    return (data?.[":block/children"] || [])
      .map(c => ({
        uid: c[":block/uid"],
        string: c[":block/string"] || "",
        order: c[":block/order"] || 0,
      }))
      .sort((a, b) => a.order - b.order);
  }

  function todayPageUid() {
    try { return window.roamAlphaAPI.util.dateToPageUid(new Date()); } catch { return null; }
  }
  function tomorrowPageUid() {
    try {
      const t = new Date(); t.setDate(t.getDate() + 1);
      return window.roamAlphaAPI.util.dateToPageUid(t);
    } catch { return null; }
  }
  function offsetPageUid(offsetDays) {
    try {
      const d = new Date(); d.setDate(d.getDate() + offsetDays);
      return window.roamAlphaAPI.util.dateToPageUid(d);
    } catch { return null; }
  }

  function getDirectChildren(parentUid) {
    try {
      const data = window.roamAlphaAPI.data.pull(
        CHILDREN_PULL,
        [":block/uid", parentUid]
      );
      return childrenFromPull(data);
    } catch (e) {
      debug("getDirectChildren failed", { parentUid, err: e?.message || e });
      return [];
    }
  }

  async function getDirectChildrenAsync(parentUid) {
    try {
      const asyncPull = window.roamAlphaAPI.data.async?.pull;
      const data = typeof asyncPull === "function"
        ? await asyncPull(CHILDREN_PULL, [":block/uid", parentUid])
        : window.roamAlphaAPI.data.pull(CHILDREN_PULL, [":block/uid", parentUid]);
      return childrenFromPull(data);
    } catch (e) {
      debug("getDirectChildrenAsync failed", { parentUid, err: e?.message || e });
      return [];
    }
  }

  function buildTimeBlockSignatureRegex(signature = state.settings.timeblockSignature) {
    if (!signature) return null;
    const escSig = signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // A standalone tag may appear in a human-friendly heading such as
    // "Schedule #TimeBlock". Keep both boundaries so lookalikes such as
    // #TimeBlocked and foo#TimeBlock remain excluded.
    return new RegExp("(?:^|\\s)" + escSig + "(?=\\s|$)");
  }

  function findTimeBlockUid(dailyPageUid) {
    const re = buildTimeBlockSignatureRegex();
    if (!re) return null;
    const children = getDirectChildren(dailyPageUid);
    for (const c of children) {
      if (re.test(c.string)) return c.uid;
    }
    return null;
  }

  function findTimeBlockUidInChildren(children) {
    const re = buildTimeBlockSignatureRegex();
    if (!re) return null;
    return children.find(child => re.test(child.string))?.uid || null;
  }

  /* ---------- parsing ---------- */
  // Two accepted shapes for time-prefixed blocks:
  //   (A) Canonical Svy format — time range FIRST:
  //         HH:MM - HH:MM <anything>
  //         HH:MM - HH:MM {{[[TODO]]}} description
  //         HH:MM - HH:MM ((block-uid))
  //         HH:MM - HH:MM [text](((block-uid)))
  //         HH:MM - HH:MM **bold meeting** description
  //   (B) Tool-prefixed format — TODO/DONE marker FIRST, time range SECOND:
  //         {{[[TODO]]}} HH:MM - HH:MM description
  //         {{[[DONE]]}} HH:MM - HH:MM done thing
  //       Chief of Staff's roam_create_todo and similar writers prepend the
  //       marker automatically, producing this shape. We sort/reconcile them
  //       too — without rewriting them to canonical (would surprise the user).
  // Lookahead `(?=\S)` requires content after the time range — bare
  // `HH:MM - HH:MM` alone won't match. Tolerates en-dash and optional
  // whitespace around the dash.
  const TIME_PREFIX_RE = /^(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})\s+(?=\S)/;
  const TODO_TIME_PREFIX_RE = /^(\{\{\[\[(?:TODO|DONE)\]\]\}\}\s+)(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})\s+(?=\S)/;
  // v1.1.3 (C) Single-timestamp entries — SmartBlock elapsed-time logs
  // and similar point-in-time markers. Zero duration → sort-only support;
  // detectOverlaps filters on endMin > startMin so they never conflict.
  // The organizer never rewrites user-entered timestamps.
  const SINGLE_TIME_PREFIX_RE = /^(\d{1,2}):(\d{2})\s+(?=\S)/;
  const ACTIVE_TIME_PREFIX_RE = /^(\d{1,2}):(\d{2})(?:\s*[-–])?\s+(?=\S)/;

  function parseTimePrefix(blockString) {
    if (!blockString) return null;
    // Try canonical shape (A) first
    let m = blockString.match(TIME_PREFIX_RE);
    let sh, sm, eh, em;
    if (m) {
      sh = parseInt(m[1], 10); sm = parseInt(m[2], 10);
      eh = parseInt(m[3], 10); em = parseInt(m[4], 10);
    } else {
      // Try tool-prefixed shape (B)
      m = blockString.match(TODO_TIME_PREFIX_RE);
      if (m) {
        sh = parseInt(m[2], 10); sm = parseInt(m[3], 10);
        eh = parseInt(m[4], 10); em = parseInt(m[5], 10);
      } else {
        // Try single-timestamp shape (C). Zero duration: endMin == startMin.
        m = blockString.match(SINGLE_TIME_PREFIX_RE);
        if (!m) return null;
        sh = parseInt(m[1], 10); sm = parseInt(m[2], 10);
        eh = sh; em = sm;
      }
    }
    // v1.1.3: 24:00 is canonical end-of-day (1440 min) and must be allowed
    // as an END time (not start). 24:01+ stays invalid.
    if (sh > 23 || sm > 59 || em > 59) return null;
    if (eh > 24 || (eh === 24 && em > 0)) return null;
    return { startMin: sh * 60 + sm, endMin: eh * 60 + em };
  }

  function isTimePrefixed(s) {
    return parseTimePrefix(s) !== null;
  }

  /* v1.1.4 — loose sort fallback. When parseTimePrefix returns null (the
   * three strict regexes don't match), scan the first 30 chars for any
   * HH:MM and return its startMin so the block can still sort by intended
   * time. Catches in-progress entries: bare "19:00" with no description
   * yet, "{{[[TODO]]}} 19:00 thing" with the time mid-text after a tool
   * marker, or "[[some link]] 19:00 description" with leading content.
   * Never used to rewrite — pure sort hint. Returns null if no usable
   * HH:MM is in the head. */
  const LOOSE_TIME_RE = /\b(\d{1,2}):(\d{2})\b/;

  /* v1.1.7 — the 30-char window was measured from the RAW string, so any
   * leading noise pushed a real time out of scan range and the block was
   * bucketed untimed and sorted to the bottom. `{{[[TODO]]}} ` alone is 13
   * chars, so a single page ref before the time was enough:
   *
   *   "{{[[TODO]]}} [[Food Safety Weekly Review]] 07:00 first thing"
   *
   * scored null and landed last despite being the earliest item on the page.
   * Strip the known prefix vocabulary first, then apply the window to what
   * remains — that keeps the "time must be near the front" intent (a 14:00
   * buried in prose still shouldn't set sort order) without punishing entries
   * for carrying refs or markers. */
  const LEADING_NOISE_RE =
    /^(?:\s|\{\{\[\[(?:TODO|DONE)\]\]\}\}|\[\[[^\]]*\]\]|\(\([^)]*\)\)|\*\*|__|#[\w/-]+|[-–—•]\s)+/;
  function stripLeadingNoise(s) {
    let out = s, prev = null;
    // bounded: each pass must shorten the string, cap at 12 to stay O(1)
    for (let i = 0; i < 12 && out !== prev; i++) {
      prev = out;
      out = out.replace(LEADING_NOISE_RE, "");
    }
    return out;
  }

  function looseParseTimePrefix(s) {
    if (!s || !state.settings.looseSortFallback) return null;
    const head = stripLeadingNoise(s).slice(0, 30);
    const m = head.match(LOOSE_TIME_RE);
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const mn = parseInt(m[2], 10);
    if (h > 23 || mn > 59) return null;
    return h * 60 + mn;
  }

  function isSmartBlockButton(s) {
    return s === state.settings.smartblockButtonSignature;
  }

  function activeSessionStart(s) {
    const marker = state.settings.activeSessionSignature;
    if (!s || !marker || !s.includes(marker)) return null;
    const m = s.match(ACTIVE_TIME_PREFIX_RE);
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const mn = parseInt(m[2], 10);
    if (h > 23 || mn > 59) return null;
    return h * 60 + mn;
  }

  function isActiveSession(s) {
    return activeSessionStart(s) !== null;
  }

  function formatMinAsHHMM(minutes) {
    if (!Number.isFinite(minutes) || minutes < 0) return "00:00";
    // 1440 is the canonical end-of-day accepted by parseTimePrefix as an end.
    if (minutes === 1440) return "24:00";
    const h = Math.floor(minutes / 60) % 24;
    const m = minutes % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  /* ---------- Phase 2: conflict detection ---------- */
  /**
   * Given items already sorted by startMin asc, return the list of overlapping
   * pairs. Each pair: { a, b, overlapMinutes }. Skips zero-duration items
   * (no time to overlap) and malformed ones (end < start).
   */
  function conflictIgnoreTags() {
    return Array.from(new Set(String(state.settings.conflictIgnoreMarkers || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)));
  }

  function detectOverlaps(sortedItems) {
    const conflicts = [];
    // Any configured marker on either block makes the overlap intentional.
    const ignoreSet = conflictIgnoreTags();
    const hasIgnoreTag = str => ignoreSet.some(tag => str.includes(tag));
    const parsed = sortedItems
      .map(it => ({ ...it, t: parseTimePrefix(it.string) }))
      .filter(it => it.t && it.t.endMin > it.t.startMin);
    for (let i = 0; i < parsed.length; i++) {
      const a = parsed[i];
      for (let j = i + 1; j < parsed.length; j++) {
        const b = parsed[j];
        if (b.t.startMin >= a.t.endMin) break; // sorted; no further overlaps with a
        if (ignoreSet.length && (hasIgnoreTag(a.string) || hasIgnoreTag(b.string))) {
          continue;
        }
        const overlapStart = Math.max(a.t.startMin, b.t.startMin);
        const overlapEnd = Math.min(a.t.endMin, b.t.endMin);
        if (overlapEnd > overlapStart) {
          conflicts.push({ a, b, overlapMinutes: overlapEnd - overlapStart });
        }
      }
    }
    return conflicts;
  }

  function shortDescription(blockString) {
    // Strip "HH:MM - HH:MM {{[[TODO/DONE]]}} " prefix; truncate.
    const stripped = blockString.replace(TIME_PREFIX_RE, "").trim();
    if (stripped.length <= 50) return stripped;
    return stripped.slice(0, 47) + "…";
  }

  function timeRangeOf(item) {
    const t = parseTimePrefix(item.string);
    if (!t) return "??:??";
    return `${formatMinAsHHMM(t.startMin)}-${formatMinAsHHMM(t.endMin)}`;
  }

  /* ---------- status block management (Phase 2) ---------- */
  const STATUS_BLOCK_PREFIX = "**TimeBlock Conflicts**";

  function statusBlocksIn(children) {
    return children.filter(child => child.string.startsWith(STATUS_BLOCK_PREFIX));
  }

  function conflictStatusLine(conflict) {
    return `((${conflict.a.uid})) overlaps ((${conflict.b.uid})) — ${conflict.overlapMinutes}min`;
  }

  function conflictReportLine(conflict) {
    const a = `${timeRangeOf(conflict.a)} "${shortDescription(conflict.a.string)}"`;
    const b = `${timeRangeOf(conflict.b)} "${shortDescription(conflict.b.string)}"`;
    return `${a} overlaps ${b} — ${conflict.overlapMinutes}min`;
  }

  async function syncConflictStatus(pageUid, conflicts, pageChildren) {
    if (state.disposed || !state.settings.enabled) return { writes: 0 };
    const api = window.roamAlphaAPI.data.block;
    const statuses = statusBlocksIn(pageChildren);
    let writes = 0;

    // Turning output off also cleans duplicate/stale generated status blocks on
    // pages the organizer actually visits. Historical graph data is not scanned.
    if (!state.settings.persistentConflictOutput || conflicts.length === 0) {
      for (const status of statuses) {
        if (state.disposed || !state.settings.enabled) break;
        try {
          setPageSuppression(pageUid);
          await api.delete({ block: { uid: status.uid } });
          writes++;
        } catch (e) { log("warn", `delete status block ${status.uid} failed`, e?.message || e); }
      }
      return { writes };
    }

    const header = `${STATUS_BLOCK_PREFIX} (${conflicts.length}) #timeblock-status`;
    const lines = conflicts.map(conflictStatusLine);
    let canonical = statuses[0] || null;

    for (const extra of statuses.slice(1)) {
      if (state.disposed || !state.settings.enabled) break;
      try {
        setPageSuppression(pageUid);
        await api.delete({ block: { uid: extra.uid } });
        writes++;
      } catch (e) { log("warn", `delete duplicate status ${extra.uid} failed`, e?.message || e); }
    }

    if (!canonical) {
      canonical = { uid: window.roamAlphaAPI.util.generateUID(), string: "" };
      try {
        setPageSuppression(pageUid);
        await api.create({
          location: { "parent-uid": pageUid, order: "last" },
          block: { uid: canonical.uid, string: header, open: false },
        });
        canonical.string = header;
        writes++;
      } catch (e) {
        log("warn", "create status block failed", e?.message || e);
        return { writes };
      }
    } else if (canonical.string !== header) {
      try {
        setPageSuppression(pageUid);
        await api.update({ block: { uid: canonical.uid, string: header } });
        writes++;
      } catch (e) { log("warn", "update status header failed", e?.message || e); }
    }

    const existing = await getDirectChildrenAsync(canonical.uid);
    if (state.disposed || !state.settings.enabled) return { writes };
    const sameLines = existing.length === lines.length &&
      existing.every((child, index) => child.string === lines[index]);
    if (sameLines) return { writes };

    for (const child of existing) {
      if (state.disposed || !state.settings.enabled) break;
      try {
        setPageSuppression(pageUid);
        await api.delete({ block: { uid: child.uid } });
        writes++;
      } catch (e) { log("warn", `delete conflict line ${child.uid} failed`, e?.message || e); }
    }
    for (let order = 0; order < lines.length; order++) {
      if (state.disposed || !state.settings.enabled) break;
      try {
        setPageSuppression(pageUid);
        await api.create({
          location: { "parent-uid": canonical.uid, order },
          block: { string: lines[order] },
        });
        writes++;
      } catch (e) { log("warn", "create conflict line failed", e?.message || e); }
    }
    return { writes };
  }

  /* ---------- the core: reconcile ---------- */
  /**
   * Compute desired order for TimeBlock children:
   *   [time-prefixed TODOs sorted by startMin asc, ..., SmartBlock button(s) last]
   *
   * Items already under TimeBlock that AREN'T time-prefixed AND aren't the
   * SmartBlock button stay where they are (we don't reorder them).
   *
   * Items at the daily-page level that ARE time-prefixed get pulled into
   * TimeBlock at the right position.
   */
  function computeDesiredOrderFromChildren(pageChildren, tbChildren, tbUid) {
    const pageLevelMisplaced = pageChildren.filter(c =>
      c.uid !== tbUid && (isTimePrefixed(c.string) || isActiveSession(c.string))
    );

    const tbButtons = tbChildren.filter(c => isSmartBlockButton(c.string));

    // Active Elapsed Time sessions are intentionally separate from completed
    // ranges. They remain in a stable "Now" lane immediately above the
    // permanent launcher, so the block being edited does not jump through the
    // outline. Once the inline Elapsed button becomes an end time, the marker
    // disappears and the completed range joins chronological sorting.
    const nonButtonChildren = tbChildren.filter(c => !isSmartBlockButton(c.string));
    let seq = 0;
    const keyed = (c, start, end) => ({ c, start, end, seq: seq++ });
    const allTimed = [];
    const activeSessions = [];
    const tbUntimed = [];

    const classify = (c, mayBeUntimed) => {
      const activeStart = activeSessionStart(c.string);
      if (activeStart !== null) {
        activeSessions.push(keyed(c, activeStart, activeStart));
        return;
      }
      const strict = parseTimePrefix(c.string);
      if (strict) {
        allTimed.push(keyed(c, strict.startMin, strict.endMin));
        return;
      }
      const loose = looseParseTimePrefix(c.string);
      if (loose !== null) {
        allTimed.push(keyed(c, loose, loose));
        return;
      }
      if (mayBeUntimed) tbUntimed.push(c);
    };

    for (const c of nonButtonChildren) classify(c, true);
    for (const c of pageLevelMisplaced) classify(c, false);

    allTimed.sort((a, b) => (a.start - b.start) || (a.end - b.end) || (a.seq - b.seq));
    activeSessions.sort((a, b) => (a.start - b.start) || (a.seq - b.seq));
    const allTodos = allTimed.map(x => x.c);
    const activeTodos = activeSessions.map(x => x.c);

    // Final desired sequence — depends on `untimedAtBottom`:
    //   true (default since v1.1.4): timed entries first, untimed at bottom,
    //                                SmartBlock button last
    //   false (legacy):              untimed first, timed sorted, button last
    const desired = state.settings.untimedAtBottom
      ? [...allTodos, ...tbUntimed, ...activeTodos, ...tbButtons]
      : [...tbUntimed, ...allTodos, ...activeTodos, ...tbButtons];

    return {
      desired,
      pageLevelMisplaced,
      currentTbChildren: tbChildren,
    };
  }

  function computeDesiredOrder(pageUid, tbUid) {
    return computeDesiredOrderFromChildren(
      getDirectChildren(pageUid),
      getDirectChildren(tbUid),
      tbUid,
    );
  }

  function isAlreadyOrganized(desired, currentTbChildren, pageLevelMisplaced) {
    if (pageLevelMisplaced.length > 0) return false;
    if (currentTbChildren.length !== desired.length) return false;
    for (let i = 0; i < desired.length; i++) {
      if (currentTbChildren[i].uid !== desired[i].uid) return false;
    }
    return true;
  }

  function setPageSuppression(pageUid) {
    state.suppressUntilByPage.set(pageUid, Date.now() + RUNTIME.suppressMs);
  }

  function isPageSuppressed(pageUid) {
    const until = state.suppressUntilByPage.get(pageUid) || 0;
    if (Date.now() < until) return true;
    if (until) state.suppressUntilByPage.delete(pageUid);
    return false;
  }

  function buildMinimalMovePlan(currentUids, desiredUids) {
    const working = [...currentUids];
    const moves = [];
    for (let order = 0; order < desiredUids.length; order++) {
      const uid = desiredUids[order];
      if (working[order] === uid) continue;
      const from = working.indexOf(uid);
      if (from < 0) continue;
      working.splice(from, 1);
      working.splice(order, 0, uid);
      moves.push({ uid, order });
    }
    return moves;
  }

  function focusedActiveSessionWouldMove(desired, currentTbChildren, pageLevelMisplaced) {
    let focusedUid = null;
    try { focusedUid = window.roamAlphaAPI.ui.getFocusedBlock()?.["block-uid"] || null; }
    catch {}
    if (!focusedUid) return false;
    const focused = desired.find(item => item.uid === focusedUid);
    if (!focused || !isActiveSession(focused.string)) return false;
    if (pageLevelMisplaced.some(item => item.uid === focusedUid)) return true;
    return currentTbChildren.findIndex(item => item.uid === focusedUid) !==
      desired.findIndex(item => item.uid === focusedUid);
  }

  async function applyDesiredOrder(pageUid, tbUid, desired, pageLevelMisplaced) {
    const api = window.roamAlphaAPI.data.block;
    const desiredUids = desired.map(item => item.uid);
    let writes = 0;

    // Cross-parent entrants must be moved under TimeBlock before Roam's atomic
    // sibling reorder can accept the complete child UID list.
    for (const item of pageLevelMisplaced) {
      try {
        setPageSuppression(pageUid);
        await api.move({
          location: { "parent-uid": tbUid, order: "last" },
          block: { uid: item.uid },
        });
        writes++;
      } catch (e) {
        log("warn", `move into TimeBlock failed for ${item.uid}`, e?.message || e);
        return { writes, failed: 1 };
      }
    }

    if (state.disposed || !state.settings.enabled) return { writes, failed: 0 };
    const freshChildren = await getDirectChildrenAsync(tbUid);
    const workingUids = freshChildren.map(item => item.uid);
    if (workingUids.length === desiredUids.length &&
        workingUids.every((uid, index) => uid === desiredUids[index])) {
      return { writes, failed: 0 };
    }

    const currentSet = new Set(workingUids);
    const exactSet = workingUids.length === desiredUids.length &&
      desiredUids.every(uid => currentSet.has(uid));
    if (!exactSet) {
      // A SmartBlock changed siblings while we were awaiting writes. Never send
      // a stale/partial list to reorderBlocks; coalesce a fresh pass instead.
      scheduleReconcile(pageUid, "stale-reorder", RUNTIME.timeblockDebounceMs);
      return { writes, failed: 0 };
    }

    let fallbackUids = workingUids;
    if (typeof api.reorderBlocks === "function") {
      try {
        setPageSuppression(pageUid);
        await api.reorderBlocks({
          location: { "parent-uid": tbUid },
          blocks: desiredUids,
        });
        return { writes: writes + 1, failed: 0 };
      } catch (e) {
        log("warn", `atomic reorder failed on ${tbUid}; using minimal-move fallback`, e?.message || e);
        fallbackUids = (await getDirectChildrenAsync(tbUid)).map(item => item.uid);
        const fallbackSet = new Set(fallbackUids);
        const stillExact = fallbackUids.length === desiredUids.length &&
          desiredUids.every(uid => fallbackSet.has(uid));
        if (!stillExact || state.disposed || !state.settings.enabled) {
          scheduleReconcile(pageUid, "stale-reorder-fallback", RUNTIME.timeblockDebounceMs);
          return { writes, failed: 0 };
        }
      }
    }

    let failed = 0;
    const movePlan = buildMinimalMovePlan(fallbackUids, desiredUids);
    for (const move of movePlan) {
      try {
        setPageSuppression(pageUid);
        await api.move({
          location: { "parent-uid": tbUid, order: move.order },
          block: { uid: move.uid },
        });
        writes++;
      } catch (e) {
        failed++;
        log("warn", `fallback reorder failed for ${move.uid}`, e?.message || e);
      }
    }
    return { writes, failed };
  }

  async function reconcileTimeBlock(pageUid, reason = "watch") {
    if (state.disposed || !state.settings.enabled) return;
    const pageChildren = await getDirectChildrenAsync(pageUid);
    if (state.disposed || !state.settings.enabled) return;
    const tbUid = findTimeBlockUidInChildren(pageChildren);
    if (!tbUid) {
      await syncConflictStatus(pageUid, [], pageChildren);
      debug(`no TimeBlock parent on page ${pageUid} — skip`);
      return;
    }
    const tbChildren = await getDirectChildrenAsync(tbUid);
    if (state.disposed || !state.settings.enabled) return;
    const { desired, pageLevelMisplaced, currentTbChildren } =
      computeDesiredOrderFromChildren(pageChildren, tbChildren, tbUid);

    const alreadyOrganized = isAlreadyOrganized(desired, currentTbChildren, pageLevelMisplaced);

    if (!alreadyOrganized) {
      log("info", `reconciling TimeBlock on ${pageUid} (${reason}): ${pageLevelMisplaced.length} pulled in + reorder`);
      if (focusedActiveSessionWouldMove(desired, currentTbChildren, pageLevelMisplaced)) {
        debug(`focused active session on ${pageUid} would move — defer until its next change`);
      } else {
        const { writes, failed } = await applyDesiredOrder(
          pageUid, tbUid, desired, pageLevelMisplaced
        );
        debug(`reconcile order complete: ${writes} write(s), ${failed} failure(s)`);
      }
    } else {
      debug(`page ${pageUid} already organized (${desired.length} children)`);
    }

    if (state.disposed || !state.settings.enabled) return;

    const completedRanges = desired.filter(item =>
      isTimePrefixed(item.string) && !isActiveSession(item.string)
    );
    const conflicts = state.settings.persistentConflictOutput
      ? detectOverlaps(completedRanges)
      : [];
    if (conflicts.length > 0) {
      log("warn", `${conflicts.length} conflict(s) on page ${pageUid}`);
      for (const conflict of conflicts) {
        log("warn", `  ${conflictReportLine(conflict)}`);
      }
    }
    await syncConflictStatus(pageUid, conflicts, pageChildren);
  }

  async function runReconcile(pageUid, reason) {
    if (state.disposed || !state.settings.enabled) return;
    if (state.inFlightReconciles.has(pageUid)) {
      state.dirtyReconciles.set(pageUid, reason);
      return state.inFlightReconciles.get(pageUid);
    }
    const task = (async () => {
      let nextReason = reason;
      do {
        state.dirtyReconciles.delete(pageUid);
        await reconcileTimeBlock(pageUid, nextReason);
        nextReason = state.dirtyReconciles.get(pageUid);
      } while (nextReason && !state.disposed && state.settings.enabled);
    })().finally(() => {
      state.inFlightReconciles.delete(pageUid);
      state.dirtyReconciles.delete(pageUid);
    });
    state.inFlightReconciles.set(pageUid, task);
    return task;
  }

  function scheduleReconcile(pageUid, reason, delayMs = RUNTIME.pageDebounceMs) {
    if (state.disposed || !state.settings.enabled) return;
    if (state.pendingReconciles.has(pageUid)) {
      clearTimeout(state.pendingReconciles.get(pageUid));
    }
    const t = setTimeout(() => {
      state.pendingReconciles.delete(pageUid);
      runReconcile(pageUid, reason).catch(e =>
        log("warn", `reconcile threw on ${pageUid}`, e?.message || e)
      );
    }, Math.max(0, delayMs));
    state.pendingReconciles.set(pageUid, t);
  }

  /* ---------- watches ---------- */
  const WATCH_PULL = "[:block/uid {:block/children [:block/uid :block/string :block/order]}]";

  function pullWatchEntity(uid) {
    const escaped = String(uid).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `[:block/uid "${escaped}"]`;
  }

  function childrenFromWatchPull(pull) {
    return (pull?.[":block/children"] || [])
      .map(c => ({
        uid: c[":block/uid"] || "",
        string: c[":block/string"] || "",
        order: c[":block/order"] || 0,
      }))
      .sort((a, b) => a.order - b.order);
  }

  function watchSortKey(item) {
    const activeStart = activeSessionStart(item.string);
    if (activeStart !== null) return `active:${activeStart}`;
    if (isSmartBlockButton(item.string)) return "button";
    const strict = parseTimePrefix(item.string);
    if (strict) return `timed:${strict.startMin}:${strict.endMin}`;
    const loose = looseParseTimePrefix(item.string);
    if (loose !== null) return `loose:${loose}`;
    return "untimed";
  }

  function pageWatchFingerprint(pull) {
    const parentRe = buildTimeBlockSignatureRegex();
    return childrenFromWatchPull(pull)
      .map(item => ({
        item,
        parent: Boolean(parentRe && parentRe.test(item.string)),
        sortKey: watchSortKey(item),
      }))
      .filter(({ parent, sortKey }) => parent || sortKey !== "untimed")
      .map(({ item, parent, sortKey }) => `${item.uid}:${parent ? "parent" : sortKey}`)
      .join("|");
  }

  function timeBlockWatchFingerprint(pull) {
    const ignoreTags = state.settings.persistentConflictOutput ? conflictIgnoreTags() : [];
    return childrenFromWatchPull(pull)
      .map(item => `${item.uid}:${item.order}:${watchSortKey(item)}:${ignoreTags.some(tag => item.string.includes(tag)) ? 1 : 0}`)
      .join("|");
  }

  function hasRelevantWatchChange(before, after, kind) {
    if (!before || !after) return true;
    const fingerprint = kind === "page" ? pageWatchFingerprint : timeBlockWatchFingerprint;
    return fingerprint(before) !== fingerprint(after);
  }

  function addOwnedPullWatch(uid, callback, label) {
    const entity = pullWatchEntity(uid);
    const data = window.roamAlphaAPI.data;
    let removed = false;
    const guarded = (before, after) => {
      if (!removed && !state.disposed) callback(before, after);
    };
    let ready;
    try {
      ready = Promise.resolve(data.addPullWatch(WATCH_PULL, entity, guarded)).then(() => true).catch(e => {
        log("warn", `addPullWatch failed for ${label} ${uid}`, e?.message || e)
        return false;
      });
    } catch (e) {
      log("warn", `addPullWatch failed for ${label} ${uid}`, e?.message || e);
      ready = Promise.resolve(false);
    }
    return () => {
      if (removed) return;
      removed = true;
      ready.then((registered) => {
        if (!registered) return;
        try {
          return Promise.resolve(data.removePullWatch(WATCH_PULL, entity, guarded)).catch(e =>
            debug(`removePullWatch failed for ${label} ${uid}`, e?.message || e)
          );
        } catch (e) {
          debug(`removePullWatch failed for ${label} ${uid}`, e?.message || e)
        }
      }).catch(() => {});
    };
  }

  function refreshTimeBlockWatch(pageUid) {
    const watch = state.activeWatches.get(pageUid);
    if (!watch) return;
    const nextUid = findTimeBlockUid(pageUid);
    if (nextUid === watch.timeBlockUid) return;
    try { watch.timeBlockUnsub?.(); } catch {}
    watch.timeBlockUid = nextUid;
    watch.timeBlockUnsub = null;
    if (!nextUid) return;
    const callback = (before, after) => {
      if (isPageSuppressed(pageUid)) {
        debug(`TimeBlock watch on ${pageUid} suppressed (self-triggered)`);
        return;
      }
      if (!hasRelevantWatchChange(before, after, "timeblock")) return;
      watch.lastUsed = Date.now();
      scheduleReconcile(pageUid, "timeblock-watch", RUNTIME.timeblockDebounceMs);
    };
    watch.timeBlockCallback = callback;
    watch.timeBlockUnsub = addOwnedPullWatch(nextUid, callback, "TimeBlock");
    debug(`watching TimeBlock ${nextUid} for page ${pageUid}`);
  }

  function registerWatch(pageUid, reason) {
    if (state.activeWatches.has(pageUid)) {
      const w = state.activeWatches.get(pageUid);
      w.lastUsed = Date.now();
      refreshTimeBlockWatch(pageUid);
      return;
    }
    if (state.activeWatches.size >= RUNTIME.maxWatchedPages) {
      // Evict LRU
      let oldestUid = null, oldestTs = Infinity;
      for (const [uid, w] of state.activeWatches) {
        if (w.lastUsed < oldestTs) { oldestTs = w.lastUsed; oldestUid = uid; }
      }
      if (oldestUid) {
        unregisterWatch(oldestUid);
        debug(`LRU evicted watch on ${oldestUid}`);
      }
    }
    const watch = {
      pageUnsub: null,
      timeBlockUnsub: null,
      timeBlockUid: null,
      lastUsed: Date.now(),
      registeredAt: Date.now(),
    };
    state.activeWatches.set(pageUid, watch);
    const pageCallback = (before, after) => {
      if (isPageSuppressed(pageUid)) {
        debug(`page watch on ${pageUid} suppressed (self-triggered)`);
        return;
      }
      if (!hasRelevantWatchChange(before, after, "page")) return;
      watch.lastUsed = Date.now();
      refreshTimeBlockWatch(pageUid);
      scheduleReconcile(pageUid, "page-watch", RUNTIME.pageDebounceMs);
    };
    watch.pageCallback = pageCallback;
    watch.pageUnsub = addOwnedPullWatch(pageUid, pageCallback, "page");
    refreshTimeBlockWatch(pageUid);
    debug(`registered watch on ${pageUid} (${reason}) — ${state.activeWatches.size} active`);
    scheduleReconcile(pageUid, `${reason}-initial`, RUNTIME.timeblockDebounceMs);
  }

  function unregisterWatch(pageUid) {
    const w = state.activeWatches.get(pageUid);
    if (!w) return;
    try { w.pageUnsub?.(); } catch {}
    try { w.timeBlockUnsub?.(); } catch {}
    state.activeWatches.delete(pageUid);
    if (state.pendingReconciles.has(pageUid)) {
      clearTimeout(state.pendingReconciles.get(pageUid));
      state.pendingReconciles.delete(pageUid);
    }
    state.suppressUntilByPage.delete(pageUid);
    state.dirtyReconciles.delete(pageUid);
    debug(`unregistered watch on ${pageUid}`);
  }

  /* ---------- rollover + bounded recovery ---------- */
  function checkRollover() {
    if (!state.monitoringActive || !state.settings.enabled) return;
    const newToday = todayPageUid();
    if (!newToday) return;
    if (newToday === state.cachedTodayUid) return;
    const oldToday = state.cachedTodayUid;
    log("info", `date rollover detected: ${oldToday} → ${newToday}`);
    state.cachedTodayUid = newToday;
    if (oldToday && oldToday !== state.navigationPageUid) unregisterWatch(oldToday);
    registerWatch(newToday, "rollover-today");
    const newTomorrow = tomorrowPageUid();
    if (newTomorrow) registerWatch(newTomorrow, "rollover-tomorrow");
    onPageNavigation().catch(e => debug("rollover navigation refresh failed", e?.message || e));
  }

  async function recoverToday(reason = "recovery") {
    if (state.disposed || !state.monitoringActive || !state.settings.enabled) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    checkRollover();
    const pageUid = state.cachedTodayUid || todayPageUid();
    if (!pageUid) return;
    registerWatch(pageUid, reason);
    await runReconcile(pageUid, reason);
  }

  function attachVisibilityListener() {
    if (state.visibilityListenerAttached || typeof document === "undefined") return;
    const handler = () => {
      if (document.visibilityState !== "visible") return;
      recoverToday("visibility-recovery").catch(e =>
        log("warn", "visibility recovery failed", e?.message || e)
      );
    };
    document.addEventListener("visibilitychange", handler);
    state._visibilityHandler = handler;
    state.visibilityListenerAttached = true;
  }

  function detachVisibilityListener() {
    if (!state.visibilityListenerAttached) return;
    try { document.removeEventListener("visibilitychange", state._visibilityHandler); } catch {}
    state._visibilityHandler = null;
    state.visibilityListenerAttached = false;
  }

  /* ---------- navigation listener ---------- */
  async function onPageNavigation() {
    if (state.disposed || !state.monitoringActive || !state.settings.enabled) return;
    let openUid;
    try { openUid = await window.roamAlphaAPI.ui.mainWindow.getOpenPageOrBlockUid(); }
    catch { return; }
    if (state.disposed || !state.monitoringActive || !state.settings.enabled) return;
    let offset = null;
    const window_ = RUNTIME.historicalWindowDays;
    for (let i = -window_; i <= 1; i++) {
      if (openUid === offsetPageUid(i)) {
        offset = i;
        break;
      }
    }
    const today = state.cachedTodayUid || todayPageUid();
    const tomorrow = tomorrowPageUid();
    const nextHistorical = offset !== null && openUid !== today && openUid !== tomorrow
      ? openUid
      : null;
    if (state.navigationPageUid && state.navigationPageUid !== nextHistorical &&
        state.navigationPageUid !== today && state.navigationPageUid !== tomorrow) {
      unregisterWatch(state.navigationPageUid);
    }
    state.navigationPageUid = nextHistorical;
    if (offset !== null && openUid) registerWatch(openUid, `nav-${offset}`);
  }

  function attachNavigationListener() {
    if (state.navigationListenerAttached) return;
    // Roam doesn't expose a clean event for page navigation in its public API.
    // Listen for hash changes (Roam routes via `/page/<uid>` in the hash) and
    const handler = () => onPageNavigation().catch(e =>
      debug("navigation refresh failed", e?.message || e)
    );
    window.addEventListener("hashchange", handler);
    state._navHandler = handler;
    state.navigationListenerAttached = true;
  }

  function detachNavigationListener() {
    if (!state.navigationListenerAttached) return;
    if (state._navHandler) {
      try { window.removeEventListener("hashchange", state._navHandler); } catch {}
      state._navHandler = null;
    }
    state.navigationListenerAttached = false;
  }

  /* ---------- commands ---------- */
  function registerCommands() {
    const add = (label, callback) => {
      try { commandPaletteApi.removeCommand({ label }); } catch {}
      try {
        commandPaletteApi.addCommand({ label, callback });
        state.registeredCommandLabels.add(label);
      } catch (e) { log("warn", `add cmd failed: ${label}`, e); }
    };

    add("TimeBlock Organizer: show conflicts on current page", async () => {
      let openUid;
      try { openUid = await window.roamAlphaAPI.ui.mainWindow.getOpenPageOrBlockUid(); }
      catch {}
      if (!openUid) return log("warn", "no open page detected");
      const pageChildren = await getDirectChildrenAsync(openUid);
      const tbUid = findTimeBlockUidInChildren(pageChildren);
      if (!tbUid) return log("info", `no TimeBlock parent on ${openUid}`);
      const finalChildren = await getDirectChildrenAsync(tbUid);
      const todos = finalChildren
        .filter(c => isTimePrefixed(c.string) && !isActiveSession(c.string))
        .sort((a, b) => {
          const at = parseTimePrefix(a.string);
          const bt = parseTimePrefix(b.string);
          return (at.startMin - bt.startMin) || (at.endMin - bt.endMin);
        });
      const conflicts = detectOverlaps(todos);
      if (conflicts.length === 0) {
        log("info", "no conflicts on this page");
        try { alert("No conflicts on this page."); } catch {}
        return;
      }
      const lines = [
        `${conflicts.length} conflict(s):`,
        "",
        ...conflicts.map(conflict => `• ${conflictReportLine(conflict)}`),
      ];
      console.log(lines.join("\n"));
      try { alert(lines.join("\n")); } catch {}
    });
    add("TimeBlock Organizer: reconcile current page now", async () => {
      let openUid;
      try { openUid = await window.roamAlphaAPI.ui.mainWindow.getOpenPageOrBlockUid(); }
      catch {}
      if (!openUid) return log("warn", "no open page detected");
      await runReconcile(openUid, "manual");
    });
    add("TimeBlock Organizer: reconcile today + tomorrow", async () => {
      const today = todayPageUid();
      const tomorrow = tomorrowPageUid();
      if (today) await runReconcile(today, "manual-today");
      if (tomorrow) await runReconcile(tomorrow, "manual-tomorrow");
    });
    add("TimeBlock Organizer: show stats (current settings)", () => {
      const onOff = (b) => b ? "ON " : "OFF";
      const lines = [
        `timeblock-organizer v${VERSION}`,
        ``,
        `── settings ──`,
        `  ${onOff(state.settings.enabled)} enabled (master switch)`,
        `  ${onOff(state.settings.persistentConflictOutput)} persistent conflict output`,
        ``,
        `── runtime ──`,
        `  Watched pages: ${state.activeWatches.size} / ${RUNTIME.maxWatchedPages}`,
        `  Owned pull watches: ${Array.from(state.activeWatches.values()).reduce((n, w) => n + 1 + (w.timeBlockUid ? 1 : 0), 0)}`,
        `  Pending reconciles: ${state.pendingReconciles.size}`,
        `  In-flight reconciles: ${state.inFlightReconciles.size}`,
        `  Today UID: ${state.cachedTodayUid || "(none)"}`,
        `  TimeBlock signature: ${state.settings.timeblockSignature.slice(0, 60)}...`,
        `  SmartBlock button: ${state.settings.smartblockButtonSignature}`,
        `  Recovery: today only every ${RUNTIME.recoveryIntervalMs / 60000}min while visible`,
        ``,
        `Watched pages:`,
        ...Array.from(state.activeWatches.entries()).map(([uid, w]) =>
          `  - ${uid} (last used ${Math.round((Date.now() - w.lastUsed) / 1000)}s ago)`
        ),
        ``,
        `Settings are managed in Roam Depot → TimeBlock Organizer.`,
      ];
      console.log(lines.join("\n"));
      try { alert(lines.join("\n")); } catch {}
    });
    add("TimeBlock Organizer: list active watches (debug)", () => {
      console.table(Array.from(state.activeWatches.entries()).map(([uid, w]) => ({
        page_uid: uid,
        timeblock_uid: w.timeBlockUid || "",
        registered_at: new Date(w.registeredAt).toLocaleString(),
        last_used_sec_ago: Math.round((Date.now() - w.lastUsed) / 1000),
      })));
    });
  }

  /* ---------- init / cleanup ---------- */
  function activateMonitoring() {
    if (state.monitoringActive || state.disposed || !state.settings.enabled) return;
    state.monitoringActive = true;
    state.cachedTodayUid = todayPageUid();
    if (state.cachedTodayUid) registerWatch(state.cachedTodayUid, "init-today");
    const tomorrow = tomorrowPageUid();
    if (tomorrow) registerWatch(tomorrow, "init-tomorrow");
    attachNavigationListener();
    attachVisibilityListener();
    onPageNavigation().catch(e => debug("initial navigation refresh failed", e?.message || e));
    state.rolloverTimer = setInterval(checkRollover, RUNTIME.rolloverCheckMs);
    state.recoveryTimer = setInterval(() => {
      recoverToday("hourly-recovery").catch(e =>
        log("warn", "hourly recovery failed", e?.message || e)
      );
    }, RUNTIME.recoveryIntervalMs);
  }

  function deactivateMonitoring() {
    state.monitoringActive = false;
    if (state.rolloverTimer) clearInterval(state.rolloverTimer);
    if (state.recoveryTimer) clearInterval(state.recoveryTimer);
    state.rolloverTimer = null;
    state.recoveryTimer = null;
    for (const timer of state.pendingReconciles.values()) clearTimeout(timer);
    state.pendingReconciles.clear();
    for (const uid of [...state.activeWatches.keys()]) unregisterWatch(uid);
    state.dirtyReconciles.clear();
    state.suppressUntilByPage.clear();
    state.navigationPageUid = null;
    detachNavigationListener();
    detachVisibilityListener();
  }

  function init() {
    log("info", `v${VERSION} starting`);
    const priorCleanup = window[`${NAMESPACE}_cleanup`];
    if (typeof priorCleanup === "function" && priorCleanup !== cleanup) {
      try { priorCleanup(); log("info", "cleaned up prior version"); }
      catch (e) { log("warn", "prior cleanup threw", e?.message || e); }
    }
    registerCommands();

    if (state.settings.enabled) {
      activateMonitoring();
    } else {
      log("warn", "enabled=false — running in dormant mode (no watches, no reconciles)");
    }

    window[`${NAMESPACE}_state`] = state;
    log("info", `ready. ${state.activeWatches.size} watches active.`);
  }

  function cleanup() {
    deactivateMonitoring();
    state.inFlightReconciles.clear();
    if (state.registeredCommandLabels) {
      for (const label of state.registeredCommandLabels) {
        try { commandPaletteApi.removeCommand({ label }); } catch {}
      }
      state.registeredCommandLabels.clear();
    }
    log("info", "cleaned up");
  }
  let started = false;
  function readLegacySettings() {
    const found = {};
    const retainedKeys = new Set([
      "enabled", "timeblockSignature", "activeSessionSignature",
      "smartblockButtonSignature", "looseSortFallback", "untimedAtBottom",
    ]);
    try {
      const raw = localStorage.getItem(`${NAMESPACE}:settings`);
      const stored = raw ? JSON.parse(raw) : null;
      if (stored && typeof stored === "object") {
        for (const key of retainedKeys) {
          if (stored[key] !== undefined) found[key] = stored[key];
        }
      }
    } catch (e) { log("warn", "legacy local settings read failed", e?.message || e); }
    try {
      const safeName = SETTINGS_PAGE.replaceAll('"', '\\"');
      const rows = window.roamAlphaAPI.data.q(`
        [:find ?s :where [?p :node/title "${safeName}"] [?b :block/page ?p] [?b :block/string ?s]]
      `);
      const graphValues = Object.fromEntries((rows || []).map(row => {
        const match = String(row?.[0] || "").trim().match(/^([a-z_][a-z0-9_]*)::\s*(.*)$/i);
        return match ? [match[1], match[2]] : ["", ""];
      }));
      const specs = [
        ["enabled", "enabled", "bool"],
        ["timeblock_signature", "timeblockSignature", "string"],
        ["active_session_signature", "activeSessionSignature", "string"],
        ["smartblock_button_signature", "smartblockButtonSignature", "string"],
        ["loose_sort_fallback", "looseSortFallback", "bool"],
        ["untimed_at_bottom", "untimedAtBottom", "bool"],
      ];
      for (const [graphKey, key, type] of specs) {
        if (!(graphKey in graphValues)) continue;
        const raw = graphValues[graphKey];
        found[key] = type === "bool"
          ? ["true", "yes", "on", "1", "y"].includes(String(raw).trim().toLowerCase())
          : String(raw).trim();
      }
    } catch (e) { log("warn", "legacy graph settings read failed", e?.message || e); }
    return found;
  }
  function applySettings(settings) {
    for (const key of Object.keys(DEFAULTS)) {
      if (settings?.[key] !== undefined) state.settings[key] = settings[key];
    }
  }
  function setSetting(key, value) {
    if (!(key in DEFAULTS)) return;
    const wasEnabled = state.settings.enabled;
    state.settings[key] = value;
    if (!started) return;
    if (key === "enabled" && Boolean(value) !== wasEnabled) {
      if (value) activateMonitoring();
      else deactivateMonitoring();
      return;
    }
    if (key === "persistentConflictOutput") {
      recoverToday("settings-change").catch(e =>
        log("warn", "settings recovery failed", e?.message || e)
      );
    }
  }
  function start() {
    if (started) return;
    const priorCleanup = window[`${NAMESPACE}_cleanup`];
    if (typeof priorCleanup === "function" && priorCleanup !== cleanup) {
      try { priorCleanup(); } catch {}
    }
    window[`${NAMESPACE}_cleanup`] = cleanup;
    started = true;
    state.disposed = false;
    init();
  }
  function stop() {
    if (!started) return;
    started = false;
    state.disposed = true;
    cleanup();
    if (window[`${NAMESPACE}_cleanup`] === cleanup) delete window[`${NAMESPACE}_cleanup`];
    if (window[`${NAMESPACE}_state`] === state) delete window[`${NAMESPACE}_state`];
  }
  return {
    start,
    stop,
    state,
    readLegacySettings,
    applySettings,
    setSetting,
    getSettings: () => ({ ...state.settings }),
    helpers: {
      parseTimePrefix, looseParseTimePrefix, detectOverlaps,
      formatMinAsHHMM, stripLeadingNoise, activeSessionStart, isActiveSession,
      buildTimeBlockSignatureRegex, buildMinimalMovePlan,
      computeDesiredOrder, reconcileTimeBlock, runReconcile, registerWatch,
      unregisterWatch, onPageNavigation, recoverToday, syncConflictStatus,
      pageWatchFingerprint,
      timeBlockWatchFingerprint,
      /* v1.1.7 — pure ordering kernel, extracted so the sort contract is
       * testable without a live graph. computeDesiredOrder does the same
       * bucketing against real block records; this takes plain strings. */
      sortTimedEntries(items) {
        let seq = 0;
        const keyed = [], untimed = [], active = [];
        for (const it of items) {
          const s = typeof it === "string" ? it : it.string;
          const activeStart = activeSessionStart(s);
          if (activeStart !== null) {
            active.push({ it, start: activeStart, seq: seq++ });
            continue;
          }
          const strict = parseTimePrefix(s);
          if (strict) { keyed.push({ it, start: strict.startMin, end: strict.endMin, seq: seq++ }); continue; }
          const loose = looseParseTimePrefix(s);
          if (loose !== null) { keyed.push({ it, start: loose, end: loose, seq: seq++ }); continue; }
          untimed.push(it);
        }
        keyed.sort((a, b) => (a.start - b.start) || (a.end - b.end) || (a.seq - b.seq));
        active.sort((a, b) => (a.start - b.start) || (a.seq - b.seq));
        return { timed: keyed.map(x => x.it), untimed, active: active.map(x => x.it) };
      },
    },
  };
}
