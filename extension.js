/* TimeBlock Organizer v1.1.6 | MIT | generated from src/ */

// src/core.js
function createLegacyRuntime({ extensionAPI }) {
  const commandPaletteApi = extensionAPI?.ui?.commandPalette ?? window.roamAlphaAPI?.ui?.commandPalette;
  const VERSION2 = "1.1.6";
  const NAMESPACE = "timeblock-organizer";
  const SETTINGS_PAGE = "TimeBlock Organizer Settings";
  const DEFAULTS = {
    enabled: true,
    debounceMs: 8e3,
    // coalesce burst writes
    historicalWindowDays: 7,
    // how far back to auto-watch on navigation
    maxActiveWatches: 14,
    // LRU cap
    timeblockSignature: "#TimeBlock",
    smartblockButtonSignature: "{{\u{1F557}\u21A6:SmartBlock:Double timestamp buttons2}}",
    sweepIntervalMs: 5 * 6e4,
    // periodic reconcile in case watches miss edits
    rolloverCheckMs: 6e4,
    // how often to check for date rollover
    suppressMs: 2e3,
    // ignore watch fires from our own writes
    dryRun: false,
    // log moves without executing
    verbose: false,
    // v1.1.0 Phase 2: conflict detection
    conflictDetection: true,
    // scan for overlapping ranges after each reconcile
    conflictStatusBlock: true,
    // write a status block on the daily page
    // v1.1.0 Phase 3: auto-resolve (opt-in)
    autoResolveConflicts: false,
    // off by default — you might WANT overlaps
    conflictStrategy: "bump_forward",
    // only one strategy supported for now
    cascadeCutoffTime: "23:00",
    // refuse to bump past this (HH:MM)
    pinnedMarker: "#pinned-time",
    // items with this tag don't get bumped
    // v1.1.4
    concurrentMarker: "#concurrent",
    // overlap pair where EITHER block has this tag is intentional — skip the conflict warning
    conflictIgnoreMarkers: "#calendar, #calender, #allday, #all-day, #leaving-early, #early-out, #out-early",
    // v1.1.6: comma-separated additional ignore tags. Merged with `concurrentMarker` on every reconcile. Calendar/all-day/early-out events are flags on the schedule, not real conflicts.
    looseSortFallback: true,
    // when strict regex fails, scan first 30 chars for HH:MM and sort by that anyway (catches in-progress edits like "19:00 " or "{{[[TODO]]}} 19:00 thing"); never rewrites the block
    untimedAtBottom: true
    // when an entry can't be timed even loosely, park it at the BOTTOM of the TimeBlock (not the top — that was the surprise)
  };
  const state = {
    settings: { ...DEFAULTS },
    activeWatches: /* @__PURE__ */ new Map(),
    // pageUid → { unsub, lastUsed }
    pendingReconciles: /* @__PURE__ */ new Map(),
    // pageUid → debounce timer
    suppressUntil: 0,
    // ms timestamp; ignore watches before this
    sweepTimer: null,
    rolloverTimer: null,
    cachedTodayUid: null,
    navigationListenerAttached: false,
    registeredCommandLabels: /* @__PURE__ */ new Set()
  };
  const log = (lvl, msg, data) => console[lvl](`[${NAMESPACE}] ${msg}`, data ?? "");
  const sk = (k) => `${NAMESPACE}:${k}`;
  const debug = (msg, data) => {
    if (state.settings.verbose) log("debug", msg, data);
  };
  const GRAPH_SETTINGS = [
    [
      "enabled",
      "enabled",
      "bool",
      true,
      "Master switch. false = no watches, no reconciles, the plugin is dormant."
    ],
    [
      "debounce_ms",
      "debounceMs",
      "int",
      8e3,
      "ms to wait after a daily-page change before reconciling. Coalesces burst writes from COS / Better Tasks."
    ],
    [
      "historical_window_days",
      "historicalWindowDays",
      "int",
      7,
      "How many days back to auto-register watches when you navigate to a historical daily page. 0 = today + tomorrow only."
    ],
    [
      "max_active_watches",
      "maxActiveWatches",
      "int",
      14,
      "Cap on simultaneously-watched daily pages. LRU evicts when exceeded."
    ],
    [
      "timeblock_signature",
      "timeblockSignature",
      "string",
      DEFAULTS.timeblockSignature,
      "TAG that identifies the TimeBlock parent block on a daily page. Default `#TimeBlock`. v1.1.5+: matched as `^<tag>(\\s|$)` \u2014 block must START with the tag followed by whitespace or end-of-string. Permits both legacy form (`#TimeBlock {{[[roam/render]]:((roam-render-Nautilus-cljs))...}}`) and post-2026-05-07 plain `#TimeBlock`. Edit if you renamed the tag (e.g. `#tb`)."
    ],
    [
      "smartblock_button_signature",
      "smartblockButtonSignature",
      "string",
      DEFAULTS.smartblockButtonSignature,
      "Exact string of the SmartBlock timestamp-button block that must always be the last child of TimeBlock. If you renamed it, paste the new exact string here."
    ],
    [
      "sweep_interval_ms",
      "sweepIntervalMs",
      "int",
      3e5,
      "Periodic reconcile sweep over all watched pages. Catches edits that pull-watch on :block/children misses (e.g. text-only changes that add a time prefix)."
    ],
    [
      "rollover_check_ms",
      "rolloverCheckMs",
      "int",
      6e4,
      "How often to check whether the date has rolled over (so today's daily page changes uid)."
    ],
    [
      "suppress_ms",
      "suppressMs",
      "int",
      2e3,
      "After we issue our own block.move calls, ignore watch callbacks for this many ms (avoids self-triggered loops)."
    ],
    [
      "dry_run",
      "dryRun",
      "bool",
      false,
      "Log every move that WOULD be executed, without actually moving blocks. Useful for previewing behavior."
    ],
    [
      "verbose",
      "verbose",
      "bool",
      false,
      "Verbose console logging. Off by default \u2014 most operations are silent."
    ],
    // Phase 2: conflict detection
    [
      "conflict_detection",
      "conflictDetection",
      "bool",
      true,
      "After each reconcile, scan TimeBlock children for overlapping time ranges. Off = no conflict warnings at all."
    ],
    [
      "conflict_status_block",
      "conflictStatusBlock",
      "bool",
      true,
      "Write a `**TimeBlock Conflicts** (N) #timeblock-status` block on the daily page when overlaps exist. Auto-deleted when zero conflicts. Off = console-only warnings."
    ],
    // Phase 3: auto-resolve
    [
      "auto_resolve_conflicts",
      "autoResolveConflicts",
      "bool",
      false,
      "Auto-rewrite conflicting time prefixes (bump the later item forward by the overlap). OFF by default \u2014 you might intentionally want overlaps. Only takes effect when conflict_detection is also on."
    ],
    [
      "conflict_strategy",
      "conflictStrategy",
      "string",
      "bump_forward",
      "Resolution strategy. Only `bump_forward` supported in v1.1.0 \u2014 push the later item's start to the earlier item's end, cascading forward."
    ],
    [
      "cascade_cutoff_time",
      "cascadeCutoffTime",
      "string",
      "23:00",
      "If a cascade would push an item to start past this time (HH:MM, 24h), refuse the resolution and flag the item as a dead-end in the status block. Default 23:00 (no scheduling past 11pm)."
    ],
    [
      "pinned_marker",
      "pinnedMarker",
      "string",
      "#pinned-time",
      "Substring/tag that marks an item as user-pinned. Pinned items are NEVER auto-bumped, even if they're the cause of a cascade dead-end. Add this tag to a TODO to lock its time."
    ],
    // v1.1.4 ──────────────────────────────────────────────────────────────────
    [
      "concurrent_marker",
      "concurrentMarker",
      "string",
      "#concurrent",
      "Substring/tag for blocks that may legitimately overlap. If EITHER block in an overlapping pair contains this tag, the pair is treated as intentional concurrent work and is NOT flagged in the **TimeBlock Conflicts** status block. Use when you're working on two things at once (e.g. a long meeting that runs in parallel with a flexible Plodding task)."
    ],
    // v1.1.6 ──────────────────────────────────────────────────────────────────
    [
      "conflict_ignore_markers",
      "conflictIgnoreMarkers",
      "string",
      "#calendar, #calender, #allday, #all-day, #leaving-early, #early-out, #out-early",
      "Comma-separated list of additional tags whose presence on EITHER block in an overlapping pair causes the pair to be skipped in conflict detection. Merged with the single `concurrent_marker` setting on every reconcile. Defaults cover calendar/agenda anchors, all-day events, and early-departure markers \u2014 none of those should flag as time conflicts with real focus blocks. Add/remove tags as needed. Leave empty to disable the multi-tag list (then only `concurrent_marker` applies)."
    ],
    [
      "loose_sort_fallback",
      "looseSortFallback",
      "bool",
      true,
      "When strict regex fails (incomplete entries like '19:00 ' with nothing after, or '{{[[TODO]]}} 19:00 thing' with the time mid-text), scan the first 30 chars for any HH:MM and sort the block by that time anyway. Never rewrites the block \u2014 sort-only. Off = old strict behavior where any non-strict block lands in the bucketed group."
    ],
    [
      "untimed_at_bottom",
      "untimedAtBottom",
      "bool",
      true,
      "Park entries that can't be timed (even with loose-sort fallback) at the BOTTOM of the TimeBlock rather than the top. False = legacy behavior (untimed at top). Bottom is less surprising \u2014 incomplete entries drift to the end where you can finish them."
    ]
  ];
  function createSettingsManager(ctx) {
    const { SETTINGS_PAGE: SETTINGS_PAGE2, GRAPH_SETTINGS: GRAPH_SETTINGS2, settingsRef, log: log2, sk: sk2 } = ctx;
    function parseSettingValue(type, raw) {
      if (raw == null) return null;
      const s = String(raw).trim();
      if (type === "bool") {
        const lower = s.toLowerCase();
        return lower === "true" || lower === "yes" || lower === "on" || lower === "1" || lower === "y";
      }
      if (type === "int") {
        const n = parseInt(s, 10);
        return Number.isFinite(n) ? n : null;
      }
      if (type === "float") {
        const n = parseFloat(s);
        return Number.isFinite(n) ? n : null;
      }
      return s;
    }
    function formatSettingValue(type, value) {
      if (type === "bool") return value ? "true" : "false";
      return String(value);
    }
    function loadPersistentSettings2() {
      try {
        const raw = localStorage.getItem(sk2("settings"));
        if (!raw) return;
        const stored = JSON.parse(raw);
        for (const [, settingsKey] of GRAPH_SETTINGS2) {
          if (stored[settingsKey] !== void 0) settingsRef[settingsKey] = stored[settingsKey];
        }
      } catch (e) {
        log2("warn", "loadPersistentSettings failed", e);
      }
    }
    function persistSettings2() {
      try {
        const obj = {};
        for (const [, settingsKey] of GRAPH_SETTINGS2) obj[settingsKey] = settingsRef[settingsKey];
        localStorage.setItem(sk2("settings"), JSON.stringify(obj));
      } catch (e) {
        log2("warn", "persistSettings failed", e);
      }
    }
    function loadAllSettingsFromGraph2() {
      try {
        const safeName = SETTINGS_PAGE2.replaceAll('"', '\\"');
        const rows = window.roamAlphaAPI.data.q(`
          [:find ?s :where [?p :node/title "${safeName}"] [?b :block/page ?p] [?b :block/string ?s]]
        `);
        const blocksByKey = {};
        for (const r of rows) {
          const s = (r[0] || "").trim();
          const m = s.match(/^([a-z_][a-z0-9_]*)::\s*(.*)$/i);
          if (m) blocksByKey[m[1]] = m[2];
        }
        let updated = 0;
        for (const [graphKey, settingsKey, type] of GRAPH_SETTINGS2) {
          if (!(graphKey in blocksByKey)) continue;
          const raw = blocksByKey[graphKey];
          if (graphKey === "gemini_api_key" && (raw === "" || raw === "PASTE_YOUR_KEY_HERE")) continue;
          const parsed = parseSettingValue(type, raw);
          if (parsed === null) continue;
          if (settingsRef[settingsKey] === parsed) continue;
          settingsRef[settingsKey] = parsed;
          updated++;
        }
        if (updated > 0) {
          persistSettings2();
          log2("info", `loaded ${updated} setting(s) from [[${SETTINGS_PAGE2}]]`);
        }
        return updated;
      } catch (e) {
        log2("debug", "loadAllSettingsFromGraph failed", e);
        return 0;
      }
    }
    async function ensureSettingsBlock(pageUid, graphKey, type, currentValue, description, order) {
      const safeName = SETTINGS_PAGE2.replaceAll('"', '\\"');
      const rows = window.roamAlphaAPI.data.q(`
        [:find ?u :where [?p :node/title "${safeName}"] [?b :block/page ?p] [?b :block/uid ?u] [?b :block/string ?s] [(clojure.string/starts-with? ?s "${graphKey}::")]]
      `);
      let blockUid = rows?.[0]?.[0];
      if (blockUid) return blockUid;
      blockUid = window.roamAlphaAPI.util.generateUID();
      const placeholder = graphKey === "gemini_api_key" && !currentValue ? "PASTE_YOUR_KEY_HERE" : formatSettingValue(type, currentValue);
      await window.roamAlphaAPI.data.block.create({
        location: { "parent-uid": pageUid, order },
        block: { uid: blockUid, string: `${graphKey}:: ${placeholder}` }
      });
      const descUid = window.roamAlphaAPI.util.generateUID();
      await window.roamAlphaAPI.data.block.create({
        location: { "parent-uid": blockUid, order: 0 },
        block: { uid: descUid, string: description }
      });
      return blockUid;
    }
    async function persistSettingToGraph2(graphKey) {
      const row = GRAPH_SETTINGS2.find((r) => r[0] === graphKey);
      if (!row) return;
      const [, settingsKey, type] = row;
      const value = settingsRef[settingsKey];
      const safeName = SETTINGS_PAGE2.replaceAll('"', '\\"');
      try {
        const rows = window.roamAlphaAPI.data.q(`
          [:find ?u :where [?p :node/title "${safeName}"] [?b :block/page ?p] [?b :block/uid ?u] [?b :block/string ?s] [(clojure.string/starts-with? ?s "${graphKey}::")]]
        `);
        const blockUid = rows?.[0]?.[0];
        if (!blockUid) return;
        await window.roamAlphaAPI.data.block.update({
          block: { uid: blockUid, string: `${graphKey}:: ${formatSettingValue(type, value)}` }
        });
      } catch (e) {
        log2("debug", `persistSettingToGraph(${graphKey}) failed`, e?.message || e);
      }
    }
    async function ensureSettingsPage2(openInSidebar = true) {
      const safeName = SETTINGS_PAGE2.replaceAll('"', '\\"');
      let pageUid;
      try {
        const rows = window.roamAlphaAPI.data.q(`
          [:find ?u :where [?p :node/title "${safeName}"] [?p :block/uid ?u]]
        `);
        pageUid = rows?.[0]?.[0];
      } catch {
      }
      if (!pageUid) {
        pageUid = window.roamAlphaAPI.util.generateUID();
        await window.roamAlphaAPI.data.page.create({ page: { title: SETTINGS_PAGE2, uid: pageUid } });
      }
      const headerRows = window.roamAlphaAPI.data.q(`
        [:find ?u :where [?p :node/title "${safeName}"] [?b :block/page ?p] [?b :block/uid ?u] [?b :block/string ?s] [(clojure.string/starts-with? ?s "**How to use this page**")]]
      `);
      if (!headerRows?.[0]?.[0]) {
        const headerUid = window.roamAlphaAPI.util.generateUID();
        await window.roamAlphaAPI.data.block.create({
          location: { "parent-uid": pageUid, order: 0 },
          block: { uid: headerUid, string: '**How to use this page** \u2014 every setting below is `key:: value`. Edit the value inline (click the block, change the text, click out). The script reloads from this page on each scan cycle, or instantly via the matching cmd palette "reload settings from graph" command. Bool keys: `true` or `false`. Numbers as plain digits.' }
        });
      }
      let order = 1;
      for (const [graphKey, settingsKey, type, , description] of GRAPH_SETTINGS2) {
        await ensureSettingsBlock(pageUid, graphKey, type, settingsRef[settingsKey], description, order);
        order++;
      }
      if (openInSidebar) {
        try {
          await window.roamAlphaAPI.ui.rightSidebar.addWindow({ window: { type: "outline", "block-uid": pageUid } });
        } catch (e) {
          try {
            await window.roamAlphaAPI.ui.mainWindow.openPage({ page: { uid: pageUid } });
          } catch {
          }
        }
      }
      return pageUid;
    }
    return {
      parseSettingValue,
      formatSettingValue,
      loadPersistentSettings: loadPersistentSettings2,
      persistSettings: persistSettings2,
      loadAllSettingsFromGraph: loadAllSettingsFromGraph2,
      ensureSettingsBlock,
      persistSettingToGraph: persistSettingToGraph2,
      ensureSettingsPage: ensureSettingsPage2
    };
  }
  const _settingsMgr = createSettingsManager({
    SETTINGS_PAGE,
    GRAPH_SETTINGS,
    settingsRef: state.settings,
    log,
    sk
  });
  const {
    loadPersistentSettings,
    persistSettings,
    loadAllSettingsFromGraph,
    persistSettingToGraph,
    ensureSettingsPage
  } = _settingsMgr;
  function todayPageUid() {
    try {
      return window.roamAlphaAPI.util.dateToPageUid(/* @__PURE__ */ new Date());
    } catch {
      return null;
    }
  }
  function tomorrowPageUid() {
    try {
      const t = /* @__PURE__ */ new Date();
      t.setDate(t.getDate() + 1);
      return window.roamAlphaAPI.util.dateToPageUid(t);
    } catch {
      return null;
    }
  }
  function offsetPageUid(offsetDays) {
    try {
      const d = /* @__PURE__ */ new Date();
      d.setDate(d.getDate() + offsetDays);
      return window.roamAlphaAPI.util.dateToPageUid(d);
    } catch {
      return null;
    }
  }
  function getDirectChildren(parentUid) {
    try {
      const data = window.roamAlphaAPI.data.pull(
        "[{:block/children [:block/uid :block/string :block/order]}]",
        [":block/uid", parentUid]
      );
      const children = (data?.[":block/children"] || []).map((c) => ({
        uid: c[":block/uid"],
        string: c[":block/string"] || "",
        order: c[":block/order"] || 0
      })).sort((a, b) => a.order - b.order);
      return children;
    } catch (e) {
      debug("getDirectChildren failed", { parentUid, err: e?.message || e });
      return [];
    }
  }
  function findTimeBlockUid(dailyPageUid) {
    const sig = state.settings.timeblockSignature;
    if (!sig) return null;
    const escSig = sig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("^" + escSig + "(?:\\s|$)");
    const children = getDirectChildren(dailyPageUid);
    for (const c of children) {
      if (re.test(c.string)) return c.uid;
    }
    return null;
  }
  const TIME_PREFIX_RE = /^(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})\s+(?=\S)/;
  const TODO_TIME_PREFIX_RE = /^(\{\{\[\[(?:TODO|DONE)\]\]\}\}\s+)(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})\s+(?=\S)/;
  const SINGLE_TIME_PREFIX_RE = /^(\d{1,2}):(\d{2})\s+(?=\S)/;
  function parseTimePrefix(blockString) {
    if (!blockString) return null;
    let m = blockString.match(TIME_PREFIX_RE);
    let sh, sm, eh, em;
    if (m) {
      sh = parseInt(m[1], 10);
      sm = parseInt(m[2], 10);
      eh = parseInt(m[3], 10);
      em = parseInt(m[4], 10);
    } else {
      m = blockString.match(TODO_TIME_PREFIX_RE);
      if (m) {
        sh = parseInt(m[2], 10);
        sm = parseInt(m[3], 10);
        eh = parseInt(m[4], 10);
        em = parseInt(m[5], 10);
      } else {
        m = blockString.match(SINGLE_TIME_PREFIX_RE);
        if (!m) return null;
        sh = parseInt(m[1], 10);
        sm = parseInt(m[2], 10);
        eh = sh;
        em = sm;
      }
    }
    if (sh > 23 || sm > 59 || em > 59) return null;
    if (eh > 24 || eh === 24 && em > 0) return null;
    return { startMin: sh * 60 + sm, endMin: eh * 60 + em };
  }
  function isTimePrefixed(s) {
    return parseTimePrefix(s) !== null;
  }
  const LOOSE_TIME_RE = /\b(\d{1,2}):(\d{2})\b/;
  function looseParseTimePrefix(s) {
    if (!s || !state.settings.looseSortFallback) return null;
    const head = s.slice(0, 30);
    const m = head.match(LOOSE_TIME_RE);
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const mn = parseInt(m[2], 10);
    if (h > 23 || mn > 59) return null;
    return h * 60 + mn;
  }
  function sortHint(s) {
    const strict = parseTimePrefix(s);
    if (strict) return strict.startMin;
    return looseParseTimePrefix(s);
  }
  function isSmartBlockButton(s) {
    return s === state.settings.smartblockButtonSignature;
  }
  function isPinned(s) {
    const marker = state.settings.pinnedMarker;
    return marker && s.includes(marker);
  }
  function formatMinAsHHMM(minutes) {
    if (!Number.isFinite(minutes) || minutes < 0) return "00:00";
    const h = Math.floor(minutes / 60) % 24;
    const m = minutes % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  function parseCutoffTime(hhmm) {
    if (!hhmm || typeof hhmm !== "string") return 23 * 60;
    const m = hhmm.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return 23 * 60;
    const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
    if (h > 23 || mm > 59) return 23 * 60;
    return h * 60 + mm;
  }
  function rewriteTimePrefix(blockString, newStartMin, newEndMin) {
    const sh = formatMinAsHHMM(newStartMin);
    const eh = formatMinAsHHMM(newEndMin);
    if (TIME_PREFIX_RE.test(blockString)) {
      return blockString.replace(TIME_PREFIX_RE, `${sh} - ${eh} `);
    }
    if (TODO_TIME_PREFIX_RE.test(blockString)) {
      return blockString.replace(TODO_TIME_PREFIX_RE, (_match, marker) => `${marker}${sh} - ${eh} `);
    }
    return blockString;
  }
  function detectOverlaps(sortedItems) {
    const conflicts = [];
    const concurrentMarker = state.settings.concurrentMarker;
    const ignoreList = String(state.settings.conflictIgnoreMarkers || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (concurrentMarker) ignoreList.push(concurrentMarker);
    const ignoreSet = Array.from(new Set(ignoreList));
    const containsIgnoreTag = (str) => {
      for (const tag of ignoreSet) {
        if (str.includes(tag)) return true;
      }
      return false;
    };
    const parsed = sortedItems.map((it) => ({ ...it, t: parseTimePrefix(it.string) })).filter((it) => it.t && it.t.endMin > it.t.startMin);
    for (let i = 0; i < parsed.length; i++) {
      const a = parsed[i];
      for (let j = i + 1; j < parsed.length; j++) {
        const b = parsed[j];
        if (b.t.startMin >= a.t.endMin) break;
        if (ignoreSet.length && (containsIgnoreTag(a.string) || containsIgnoreTag(b.string))) {
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
    const stripped = blockString.replace(TIME_PREFIX_RE, "").trim();
    if (stripped.length <= 50) return stripped;
    return stripped.slice(0, 47) + "\u2026";
  }
  function timeRangeOf(item) {
    const t = parseTimePrefix(item.string);
    if (!t) return "??:??";
    return `${formatMinAsHHMM(t.startMin)}-${formatMinAsHHMM(t.endMin)}`;
  }
  function resolveConflicts(items, cutoffMin) {
    const working = items.map((it) => ({
      uid: it.uid,
      originalString: it.string,
      currentString: it.string,
      t: parseTimePrefix(it.string),
      pinned: isPinned(it.string)
    })).filter((it) => it.t);
    const updates = [];
    const deadEnds = [];
    for (let i = 1; i < working.length; i++) {
      const prev = working[i - 1];
      const curr = working[i];
      if (curr.t.startMin >= prev.t.endMin) continue;
      if (curr.pinned) {
        deadEnds.push({
          item: curr,
          reason: `pinned (${state.settings.pinnedMarker}) \u2014 refusing to bump`
        });
        continue;
      }
      const duration = curr.t.endMin - curr.t.startMin;
      const newStart = prev.t.endMin;
      const newEnd = newStart + duration;
      if (newEnd > cutoffMin) {
        deadEnds.push({
          item: curr,
          reason: `cascade past cutoff: would end ${formatMinAsHHMM(newEnd)} > ${formatMinAsHHMM(cutoffMin)}`
        });
        continue;
      }
      curr.t = { startMin: newStart, endMin: newEnd };
      curr.currentString = rewriteTimePrefix(curr.currentString, newStart, newEnd);
      updates.push({
        uid: curr.uid,
        oldString: curr.originalString,
        newString: curr.currentString,
        bumpedFrom: parseTimePrefix(curr.originalString),
        bumpedTo: { startMin: newStart, endMin: newEnd }
      });
    }
    return { updates, deadEnds };
  }
  const STATUS_BLOCK_PREFIX = "**TimeBlock Conflicts**";
  function findStatusBlockUid(pageUid) {
    const children = getDirectChildren(pageUid);
    for (const c of children) {
      if (c.string.startsWith(STATUS_BLOCK_PREFIX)) return c.uid;
    }
    return null;
  }
  async function deleteStatusBlock(pageUid) {
    const uid = findStatusBlockUid(pageUid);
    if (!uid) return false;
    try {
      await window.roamAlphaAPI.data.block.delete({ block: { uid } });
      return true;
    } catch (e) {
      log("warn", `delete status block ${uid} failed`, e?.message || e);
      return false;
    }
  }
  async function ensureStatusBlock(pageUid, conflicts, deadEnds) {
    if (!state.settings.conflictStatusBlock) return;
    const total = conflicts.length + deadEnds.length;
    if (total === 0) {
      await deleteStatusBlock(pageUid);
      return;
    }
    const headerString = `${STATUS_BLOCK_PREFIX} (${total}) #timeblock-status`;
    let statusUid = findStatusBlockUid(pageUid);
    if (!statusUid) {
      statusUid = window.roamAlphaAPI.util.generateUID();
      try {
        await window.roamAlphaAPI.data.block.create({
          location: { "parent-uid": pageUid, order: "last" },
          block: { uid: statusUid, string: headerString, open: false }
        });
      } catch (e) {
        log("warn", `create status block failed`, e?.message || e);
        return;
      }
    } else {
      try {
        await window.roamAlphaAPI.data.block.update({
          block: { uid: statusUid, string: headerString }
        });
      } catch (e) {
        log("warn", `update status block string failed`, e?.message || e);
      }
    }
    const existing = getDirectChildren(statusUid);
    for (const c of existing) {
      try {
        await window.roamAlphaAPI.data.block.delete({ block: { uid: c.uid } });
      } catch {
      }
    }
    let order = 0;
    for (const conf of conflicts) {
      const aDesc = `${timeRangeOf(conf.a)} "${shortDescription(conf.a.string)}"`;
      const bDesc = `${timeRangeOf(conf.b)} "${shortDescription(conf.b.string)}"`;
      const line = `${aDesc} overlaps ${bDesc} \u2014 ${conf.overlapMinutes}min`;
      try {
        await window.roamAlphaAPI.data.block.create({
          location: { "parent-uid": statusUid, order },
          block: { string: line }
        });
        order++;
      } catch (e) {
        log("debug", `conflict line create failed`, e?.message || e);
      }
    }
    for (const de of deadEnds) {
      const desc = `${timeRangeOf(de.item)} "${shortDescription(de.item.originalString)}"`;
      const line = `Dead-end: ${desc} \u2014 ${de.reason}`;
      try {
        await window.roamAlphaAPI.data.block.create({
          location: { "parent-uid": statusUid, order },
          block: { string: line }
        });
        order++;
      } catch (e) {
        log("debug", `dead-end line create failed`, e?.message || e);
      }
    }
  }
  function computeDesiredOrder(pageUid, tbUid) {
    const pageChildren = getDirectChildren(pageUid);
    const tbChildren = getDirectChildren(tbUid);
    const pageLevelMisplaced = pageChildren.filter(
      (c) => c.uid !== tbUid && isTimePrefixed(c.string)
    );
    const tbButtons = tbChildren.filter((c) => isSmartBlockButton(c.string));
    const nonButtonChildren = tbChildren.filter((c) => !isSmartBlockButton(c.string));
    const tbStrictTimed = nonButtonChildren.filter((c) => isTimePrefixed(c.string));
    const tbLooseTimed = nonButtonChildren.filter(
      (c) => !isTimePrefixed(c.string) && looseParseTimePrefix(c.string) !== null
    );
    const tbUntimed = nonButtonChildren.filter(
      (c) => !isTimePrefixed(c.string) && looseParseTimePrefix(c.string) === null
    );
    const allTimed = [
      ...tbStrictTimed.map((c) => ({ c, sort: parseTimePrefix(c.string).startMin })),
      ...tbLooseTimed.map((c) => ({ c, sort: looseParseTimePrefix(c.string) })),
      ...pageLevelMisplaced.map((c) => ({ c, sort: parseTimePrefix(c.string).startMin }))
    ];
    allTimed.sort((a, b) => a.sort - b.sort);
    const allTodos = allTimed.map((x) => x.c);
    const desired = state.settings.untimedAtBottom ? [...allTodos, ...tbUntimed, ...tbButtons] : [...tbUntimed, ...allTodos, ...tbButtons];
    return {
      desired,
      pageLevelMisplaced,
      currentTbChildren: tbChildren
    };
  }
  function isAlreadyOrganized(desired, currentTbChildren, pageLevelMisplaced) {
    if (pageLevelMisplaced.length > 0) return false;
    if (currentTbChildren.length !== desired.length) return false;
    for (let i = 0; i < desired.length; i++) {
      if (currentTbChildren[i].uid !== desired[i].uid) return false;
    }
    return true;
  }
  async function reconcileTimeBlock(pageUid, reason = "watch") {
    if (!state.settings.enabled) return;
    const tbUid = findTimeBlockUid(pageUid);
    if (!tbUid) {
      debug(`no TimeBlock parent on page ${pageUid} \u2014 skip`);
      return;
    }
    const { desired, pageLevelMisplaced, currentTbChildren } = computeDesiredOrder(pageUid, tbUid);
    const alreadyOrganized = isAlreadyOrganized(desired, currentTbChildren, pageLevelMisplaced);
    if (!alreadyOrganized) {
      const moveCount = pageLevelMisplaced.length + desired.filter(
        (d, i) => currentTbChildren[i]?.uid !== d.uid
      ).length;
      log("info", `reconciling TimeBlock on ${pageUid} (${reason}): ${pageLevelMisplaced.length} pulled in + reorder, ${moveCount} block.moves`);
      if (state.settings.dryRun) {
        log("info", `[dry-run] would move into order:`, desired.map((d) => ({
          uid: d.uid,
          preview: d.string.slice(0, 50)
        })));
      } else {
        state.suppressUntil = Date.now() + state.settings.suppressMs;
        const api = window.roamAlphaAPI.data.block;
        let executed = 0, failed = 0;
        for (const item of desired) {
          try {
            await api.move({
              location: { "parent-uid": tbUid, order: "last" },
              block: { uid: item.uid }
            });
            executed++;
          } catch (e) {
            log("warn", `move failed for ${item.uid}`, e?.message || e);
            failed++;
          }
        }
        if (failed > 0) log("warn", `reconcile complete with ${failed} failures (${executed} ok)`);
      }
    } else {
      debug(`page ${pageUid} already organized (${desired.length} children)`);
    }
    let resolvedUpdates = [];
    if (state.settings.conflictDetection && state.settings.autoResolveConflicts && !state.settings.dryRun) {
      const finalChildren = getDirectChildren(tbUid);
      const todos = finalChildren.filter((c) => isTimePrefixed(c.string));
      const cutoff = parseCutoffTime(state.settings.cascadeCutoffTime);
      const result = resolveConflicts(todos, cutoff);
      if (result.updates.length > 0) {
        state.suppressUntil = Date.now() + state.settings.suppressMs;
        const api = window.roamAlphaAPI.data.block;
        for (const u of result.updates) {
          try {
            await api.update({ block: { uid: u.uid, string: u.newString } });
            resolvedUpdates.push(u);
            log("info", `bumped ((${u.uid})): ${formatMinAsHHMM(u.bumpedFrom.startMin)} \u2192 ${formatMinAsHHMM(u.bumpedTo.startMin)}`);
          } catch (e) {
            log("warn", `bump failed for ${u.uid}`, e?.message || e);
          }
        }
        if (resolvedUpdates.length > 0) {
          const refreshedChildren = getDirectChildren(tbUid);
          const refreshedTodos = refreshedChildren.filter((c) => isTimePrefixed(c.string));
          const refreshedSorted = [...refreshedTodos].sort(
            (a, b) => parseTimePrefix(a.string).startMin - parseTimePrefix(b.string).startMin
          );
          let needsResort = false;
          for (let i = 0; i < refreshedTodos.length; i++) {
            if (refreshedTodos[i].uid !== refreshedSorted[i].uid) {
              needsResort = true;
              break;
            }
          }
          if (needsResort) {
            const buttons = refreshedChildren.filter((c) => isSmartBlockButton(c.string));
            const others = refreshedChildren.filter(
              (c) => !isTimePrefixed(c.string) && !isSmartBlockButton(c.string)
            );
            const finalDesired = [...others, ...refreshedSorted, ...buttons];
            for (const item of finalDesired) {
              try {
                await api.move({ location: { "parent-uid": tbUid, order: "last" }, block: { uid: item.uid } });
              } catch (e) {
                log("warn", `post-bump re-sort move failed for ${item.uid}`, e?.message || e);
              }
            }
          }
        }
      }
    }
    if (state.settings.conflictDetection) {
      const finalChildren = getDirectChildren(tbUid);
      const todos = finalChildren.filter((c) => isTimePrefixed(c.string));
      const conflicts = detectOverlaps(todos);
      let deadEnds = [];
      if (state.settings.autoResolveConflicts) {
        const cutoff = parseCutoffTime(state.settings.cascadeCutoffTime);
        const result = resolveConflicts(todos, cutoff);
        deadEnds = result.deadEnds;
      }
      if (conflicts.length > 0 || deadEnds.length > 0) {
        log("warn", `${conflicts.length} conflict(s)${deadEnds.length ? ` + ${deadEnds.length} dead-end(s)` : ""} on page ${pageUid}`);
        for (const c of conflicts) {
          log("warn", `  ${timeRangeOf(c.a)} "${shortDescription(c.a.string)}" overlaps ${timeRangeOf(c.b)} "${shortDescription(c.b.string)}" (${c.overlapMinutes}min)`);
        }
        for (const de of deadEnds) {
          log("warn", `  dead-end: ${timeRangeOf(de.item)} "${shortDescription(de.item.originalString)}" \u2014 ${de.reason}`);
        }
        if (!state.settings.dryRun) {
          state.suppressUntil = Date.now() + state.settings.suppressMs;
          await ensureStatusBlock(pageUid, conflicts, deadEnds);
        }
      } else {
        if (!state.settings.dryRun) {
          state.suppressUntil = Date.now() + state.settings.suppressMs;
          await deleteStatusBlock(pageUid);
        }
      }
    }
  }
  function scheduleReconcile(pageUid, reason) {
    if (state.pendingReconciles.has(pageUid)) {
      clearTimeout(state.pendingReconciles.get(pageUid));
    }
    const t = setTimeout(() => {
      state.pendingReconciles.delete(pageUid);
      reconcileTimeBlock(pageUid, reason).catch(
        (e) => log("warn", `reconcile threw on ${pageUid}`, e?.message || e)
      );
    }, state.settings.debounceMs);
    state.pendingReconciles.set(pageUid, t);
  }
  function registerWatch(pageUid, reason) {
    if (state.activeWatches.has(pageUid)) {
      const w = state.activeWatches.get(pageUid);
      w.lastUsed = Date.now();
      return;
    }
    if (state.activeWatches.size >= state.settings.maxActiveWatches) {
      let oldestUid = null, oldestTs = Infinity;
      for (const [uid, w] of state.activeWatches) {
        if (w.lastUsed < oldestTs) {
          oldestTs = w.lastUsed;
          oldestUid = uid;
        }
      }
      if (oldestUid) {
        try {
          state.activeWatches.get(oldestUid).unsub();
        } catch {
        }
        state.activeWatches.delete(oldestUid);
        debug(`LRU evicted watch on ${oldestUid}`);
      }
    }
    const cb = () => {
      if (Date.now() < state.suppressUntil) {
        debug(`watch on ${pageUid} fired but suppressed (self-triggered)`);
        return;
      }
      scheduleReconcile(pageUid, "watch");
    };
    try {
      window.roamAlphaAPI.data.addPullWatch(
        "[{:block/children [:block/uid :block/string :block/order]}]",
        [":block/uid", pageUid],
        cb
      );
      state.activeWatches.set(pageUid, {
        unsub: () => {
          try {
            window.roamAlphaAPI.data.removePullWatch(
              "[{:block/children [:block/uid :block/string :block/order]}]",
              [":block/uid", pageUid],
              cb
            );
          } catch {
          }
        },
        lastUsed: Date.now(),
        registeredAt: Date.now()
      });
      debug(`registered watch on ${pageUid} (${reason}) \u2014 ${state.activeWatches.size} active`);
      scheduleReconcile(pageUid, `${reason}-initial`);
    } catch (e) {
      log("warn", `addPullWatch failed for ${pageUid}`, e?.message || e);
    }
  }
  function unregisterWatch(pageUid) {
    const w = state.activeWatches.get(pageUid);
    if (!w) return;
    try {
      w.unsub();
    } catch {
    }
    state.activeWatches.delete(pageUid);
    if (state.pendingReconciles.has(pageUid)) {
      clearTimeout(state.pendingReconciles.get(pageUid));
      state.pendingReconciles.delete(pageUid);
    }
    debug(`unregistered watch on ${pageUid}`);
  }
  function checkRollover() {
    const newToday = todayPageUid();
    if (!newToday) return;
    if (newToday === state.cachedTodayUid) return;
    log("info", `date rollover detected: ${state.cachedTodayUid} \u2192 ${newToday}`);
    state.cachedTodayUid = newToday;
    registerWatch(newToday, "rollover-today");
    const newTomorrow = tomorrowPageUid();
    if (newTomorrow) registerWatch(newTomorrow, "rollover-tomorrow");
  }
  async function periodicSweep() {
    if (!state.settings.enabled) return;
    debug(`periodic sweep over ${state.activeWatches.size} watched pages`);
    for (const [pageUid] of state.activeWatches) {
      try {
        await reconcileTimeBlock(pageUid, "sweep");
      } catch (e) {
        debug(`sweep reconcile failed on ${pageUid}`, e?.message || e);
      }
    }
  }
  function onPageNavigation() {
    if (!state.settings.enabled) return;
    let openUid;
    try {
      openUid = window.roamAlphaAPI.ui.mainWindow.getOpenPageOrBlockUid();
    } catch {
      return;
    }
    if (!openUid) return;
    const window_ = state.settings.historicalWindowDays;
    for (let i = -window_; i <= 1; i++) {
      if (openUid === offsetPageUid(i)) {
        registerWatch(openUid, `nav-${i}`);
        return;
      }
    }
  }
  function attachNavigationListener() {
    if (state.navigationListenerAttached) return;
    const handler = () => onPageNavigation();
    window.addEventListener("hashchange", handler);
    state._navHandler = handler;
    state.navigationListenerAttached = true;
  }
  function detachNavigationListener() {
    if (!state.navigationListenerAttached) return;
    if (state._navHandler) {
      try {
        window.removeEventListener("hashchange", state._navHandler);
      } catch {
      }
      state._navHandler = null;
    }
    state.navigationListenerAttached = false;
  }
  function registerCommands() {
    const add = (label, callback) => {
      try {
        commandPaletteApi.removeCommand({ label });
      } catch {
      }
      try {
        commandPaletteApi.addCommand({ label, callback });
        state.registeredCommandLabels.add(label);
      } catch (e) {
        log("warn", `add cmd failed: ${label}`, e);
      }
    };
    const toggleSetting = (graphKey, settingsKey, descriptor) => async () => {
      state.settings[settingsKey] = !state.settings[settingsKey];
      persistSettings();
      await persistSettingToGraph(graphKey);
      log("info", `${descriptor}: ${state.settings[settingsKey] ? "ON" : "OFF"}`);
    };
    add("TimeBlock Organizer: open settings page (edit toggles inline)", async () => {
      try {
        await ensureSettingsPage(true);
        log("info", "Settings page opened in right sidebar");
      } catch (e) {
        log("error", "ensureSettingsPage failed", e);
      }
    });
    add("TimeBlock Organizer: reload settings from graph", () => {
      const u = loadAllSettingsFromGraph();
      log("info", u > 0 ? `${u} setting(s) reloaded` : "no setting changes detected");
    });
    add("TimeBlock Organizer: toggle enabled (master switch)", toggleSetting("enabled", "enabled", "enabled"));
    add("TimeBlock Organizer: toggle dry-run mode", toggleSetting("dry_run", "dryRun", "dryRun"));
    add("TimeBlock Organizer: toggle verbose logging", toggleSetting("verbose", "verbose", "verbose"));
    add("TimeBlock Organizer: toggle conflict detection (Phase 2)", toggleSetting("conflict_detection", "conflictDetection", "conflictDetection"));
    add("TimeBlock Organizer: toggle conflict status block on daily page", toggleSetting("conflict_status_block", "conflictStatusBlock", "conflictStatusBlock"));
    add("TimeBlock Organizer: toggle auto-resolve conflicts (Phase 3, opt-in)", toggleSetting("auto_resolve_conflicts", "autoResolveConflicts", "autoResolveConflicts"));
    add("TimeBlock Organizer: show conflicts on current page", async () => {
      let openUid;
      try {
        openUid = window.roamAlphaAPI.ui.mainWindow.getOpenPageOrBlockUid();
      } catch {
      }
      if (!openUid) return log("warn", "no open page detected");
      const tbUid = findTimeBlockUid(openUid);
      if (!tbUid) return log("info", `no TimeBlock parent on ${openUid}`);
      const finalChildren = getDirectChildren(tbUid);
      const todos = finalChildren.filter((c) => isTimePrefixed(c.string));
      const conflicts = detectOverlaps(todos);
      const cutoff = parseCutoffTime(state.settings.cascadeCutoffTime);
      const { deadEnds } = resolveConflicts(todos, cutoff);
      if (conflicts.length === 0 && deadEnds.length === 0) {
        log("info", "no conflicts on this page");
        try {
          alert("No conflicts on this page.");
        } catch {
        }
        return;
      }
      const lines = [
        `${conflicts.length} conflict(s), ${deadEnds.length} dead-end(s):`,
        "",
        ...conflicts.map(
          (c) => `\u2022 ${timeRangeOf(c.a)} "${shortDescription(c.a.string)}" overlaps ${timeRangeOf(c.b)} "${shortDescription(c.b.string)}" \u2014 ${c.overlapMinutes}min`
        ),
        ...deadEnds.map(
          (de) => `\xD7 dead-end: ${timeRangeOf(de.item)} "${shortDescription(de.item.originalString)}" \u2014 ${de.reason}`
        )
      ];
      console.log(lines.join("\n"));
      try {
        alert(lines.join("\n"));
      } catch {
      }
    });
    add("TimeBlock Organizer: reconcile current page now", async () => {
      let openUid;
      try {
        openUid = window.roamAlphaAPI.ui.mainWindow.getOpenPageOrBlockUid();
      } catch {
      }
      if (!openUid) return log("warn", "no open page detected");
      await reconcileTimeBlock(openUid, "manual");
    });
    add("TimeBlock Organizer: reconcile today + tomorrow", async () => {
      const today = todayPageUid();
      const tomorrow = tomorrowPageUid();
      if (today) await reconcileTimeBlock(today, "manual-today");
      if (tomorrow) await reconcileTimeBlock(tomorrow, "manual-tomorrow");
    });
    add("TimeBlock Organizer: show stats (current settings)", () => {
      const onOff = (b) => b ? "ON " : "OFF";
      const lines = [
        `timeblock-organizer v${VERSION2}`,
        ``,
        `\u2500\u2500 toggles \u2500\u2500`,
        `  ${onOff(state.settings.enabled)} enabled (master switch)`,
        `  ${onOff(state.settings.dryRun)} dry-run mode`,
        `  ${onOff(state.settings.verbose)} verbose logging`,
        `  ${onOff(state.settings.conflictDetection)} conflict detection (Phase 2)`,
        `  ${onOff(state.settings.conflictStatusBlock)} status block on daily page`,
        `  ${onOff(state.settings.autoResolveConflicts)} auto-resolve conflicts (Phase 3, opt-in)`,
        ``,
        `\u2500\u2500 runtime \u2500\u2500`,
        `  Active watches: ${state.activeWatches.size} / ${state.settings.maxActiveWatches}`,
        `  Pending reconciles: ${state.pendingReconciles.size}`,
        `  Today UID: ${state.cachedTodayUid || "(none)"}`,
        `  TimeBlock signature: ${state.settings.timeblockSignature.slice(0, 60)}...`,
        `  SmartBlock button: ${state.settings.smartblockButtonSignature}`,
        `  Debounce: ${state.settings.debounceMs}ms / sweep: ${state.settings.sweepIntervalMs / 6e4}min`,
        `  Conflict strategy: ${state.settings.conflictStrategy} / cutoff: ${state.settings.cascadeCutoffTime} / pinned marker: ${state.settings.pinnedMarker}`,
        ``,
        `Watched pages:`,
        ...Array.from(state.activeWatches.entries()).map(
          ([uid, w]) => `  - ${uid} (last used ${Math.round((Date.now() - w.lastUsed) / 1e3)}s ago)`
        ),
        ``,
        `Edit any setting via cmd palette \u2192 "open settings page", or paste new toggles into [[${SETTINGS_PAGE}]].`
      ];
      console.log(lines.join("\n"));
      try {
        alert(lines.join("\n"));
      } catch {
      }
    });
    add("TimeBlock Organizer: list active watches (debug)", () => {
      console.table(Array.from(state.activeWatches.entries()).map(([uid, w]) => ({
        page_uid: uid,
        registered_at: new Date(w.registeredAt).toLocaleString(),
        last_used_sec_ago: Math.round((Date.now() - w.lastUsed) / 1e3)
      })));
    });
  }
  function init() {
    log("info", `v${VERSION2} starting`);
    const priorCleanup = window[`${NAMESPACE}_cleanup`];
    if (typeof priorCleanup === "function" && priorCleanup !== cleanup) {
      try {
        priorCleanup();
        log("info", "cleaned up prior version");
      } catch (e) {
        log("warn", "prior cleanup threw", e?.message || e);
      }
    }
    loadPersistentSettings();
    ensureSettingsPage(false).then(() => extensionAPI ? 0 : loadAllSettingsFromGraph()).catch((e) => log("warn", "settings page bootstrap failed", e?.message || e));
    registerCommands();
    if (state.settings.enabled) {
      state.cachedTodayUid = todayPageUid();
      if (state.cachedTodayUid) registerWatch(state.cachedTodayUid, "init-today");
      const tomorrow = tomorrowPageUid();
      if (tomorrow) registerWatch(tomorrow, "init-tomorrow");
      attachNavigationListener();
      state.rolloverTimer = setInterval(checkRollover, state.settings.rolloverCheckMs);
      state.sweepTimer = setInterval(() => {
        periodicSweep().catch((e) => log("warn", "sweep threw", e?.message || e));
      }, state.settings.sweepIntervalMs);
    } else {
      log("warn", "enabled=false \u2014 running in dormant mode (no watches, no reconciles)");
    }
    window[`${NAMESPACE}_state`] = state;
    log("info", `ready. ${state.activeWatches.size} watches active.`);
  }
  function cleanup() {
    if (state.rolloverTimer) clearInterval(state.rolloverTimer);
    if (state.sweepTimer) clearInterval(state.sweepTimer);
    for (const t of state.pendingReconciles.values()) clearTimeout(t);
    state.pendingReconciles.clear();
    for (const [uid, w] of state.activeWatches) {
      try {
        w.unsub();
      } catch {
      }
    }
    state.activeWatches.clear();
    detachNavigationListener();
    if (state.registeredCommandLabels) {
      for (const label of state.registeredCommandLabels) {
        try {
          commandPaletteApi.removeCommand({ label });
        } catch {
        }
      }
      state.registeredCommandLabels.clear();
    }
    log("info", "cleaned up");
  }
  let started = false;
  function readLegacySettings() {
    loadPersistentSettings();
    loadAllSettingsFromGraph();
    return { ...state.settings };
  }
  function applySettings(settings) {
    Object.assign(state.settings, settings || {});
    persistSettings();
  }
  function setSetting(key, value) {
    state.settings[key] = value;
    persistSettings();
  }
  function start() {
    if (started) return;
    const priorCleanup = window[`${NAMESPACE}_cleanup`];
    if (typeof priorCleanup === "function" && priorCleanup !== cleanup) {
      try {
        priorCleanup();
      } catch {
      }
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
    helpers: { parseTimePrefix, looseParseTimePrefix, detectOverlaps, resolveConflicts, formatMinAsHHMM }
  };
}

// src/extension.js
var VERSION = "1.1.6";
var SETTINGS_KEY = "settings";
var activeRuntime = null;
async function setInitial(extensionAPI, id, value) {
  if (extensionAPI.settings.get(id) == null && extensionAPI.settings.canSet !== false) {
    await extensionAPI.settings.set(id, value);
  }
  const stored = extensionAPI.settings.get(id);
  return stored == null ? value : stored;
}
async function migrateSettings({ extensionAPI, runtime }) {
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
    ["verbose", "verbose", "Verbose logging", "Print reconciliation diagnostics."]
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
      action: { type: "switch", onChange: change(key) }
    }))
  });
}
async function onload({ extensionAPI, extension }) {
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
function onunload() {
  const runtime = activeRuntime;
  activeRuntime = null;
  runtime?.stop();
}
var extension_default = { onload, onunload };
export {
  SETTINGS_KEY,
  VERSION,
  extension_default as default,
  migrateSettings,
  onload,
  onunload
};
