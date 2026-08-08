# Changelog

## [1.2.0] - 2026-08-08

Safer active-session behavior with less background work and a smaller settings surface.

- Removed automatic conflict resolution and every timestamp-rewrite path. Manual
  conflict inspection remains available and never changes user blocks.
- Made persistent conflict summaries opt-in. Status synchronization is deterministic,
  skips identical output, removes duplicates, and cleans stale generated summaries on
  pages the organizer visits when output is disabled.
- Replaced the five-minute all-watched-page sweep with startup reconciliation,
  visibility-resume recovery, and an hourly recovery for today only. Reconciliation
  uses narrow asynchronous pulls, while the two shallow event watches remain primary.
- Internalized debounce, watch-cap, suppression, rollover, and recovery controls.
  Simplified intentional-overlap markers to `#calendar`, `#concurrent`, and
  `#no-conflict`.
- Consolidated persistence into individual Roam Depot setting keys. A guarded one-time
  migration preserves compatible workflow signatures and ordering preferences, then
  ignores the old snapshot, localStorage, and graph settings page. The Enabled switch
  now starts and stops watches, timers, and listeners immediately.
- Hardened pull-watch cleanup against unload-before-registration races and prevents
  stale or partial child lists from reaching `block.reorderBlocks`.
- Expanded the regression suite from 23 to 32 tests, covering no-rewrite guarantees,
  opt-in/idempotent status output, migration precedence, read-only installs, async
  pulls, live enable/disable, and visible today-only recovery.

## [1.1.8] - 2026-08-08

Continuous organization without broad graph work.

- **Recognize the live TimeBlock heading.** The configured tag is now matched as a
  standalone token anywhere in the parent string, so `Schedule #TimeBlock` works
  while `#TimeBlocked` remains excluded. This repairs all pages using the current
  Daily Note template rather than only parents that begin with `#TimeBlock`.
- **Organize active work sessions safely.** An unfinished line such as
  `07:56 {{⇥🕞:SmartBlock:Elapsed time}}` stays in a stable Now lane directly
  above the permanent timestamp launcher. It is excluded from conflict resolution
  and is never auto-closed. When Elapsed replaces the marker with an end time and
  duration, the completed range joins chronological order.
- **Watch the right level.** Each watched Daily Note owns two shallow pull watches:
  the page's direct children and the matched TimeBlock's direct children. This catches
  SmartBlock creation/completion immediately without recursive pulls, per-task watches,
  or relying on the five-minute recovery sweep. Description-only edits are filtered.
- **Bound live work.** Normal operation watches only today, tomorrow, and at most one
  currently open historical Daily Note. Reconciles are trailing-debounced,
  single-flight, and use page-specific self-write suppression.
- **Reduce write amplification.** In-parent order drift now uses Roam's documented
  `data.block.reorderBlocks` API for one write. Older clients fall back to numeric
  moves for only the displaced children; the previous implementation moved every
  child sequentially whenever one item was out of place.
- **Follow the current navigation API.** Page navigation and current-page commands now
  await `ui.mainWindow.getOpenPageOrBlockUid()` as documented.
- Added regression tests for heading boundaries, active-to-completed session behavior,
  watch ownership/cleanup, description-event filtering, async navigation, minimal
  fallback moves, and the one-write reorder contract.

## [1.1.7] - 2026-08-06

Ordering correctness. Three defects, each reproduced by a regression test that fails
against 1.1.6 (7 of the 14 tests in `test/ordering.test.js` fail on the old code).

- **Timed entries no longer fall to the bottom.** `looseParseTimePrefix` measured its
  30-character scan window from the raw block string, so leading markers and page refs
  pushed a real time out of range and the entry was bucketed *untimed* and sorted last.
  `{{[[TODO]]}} ` alone is 13 characters, so a single `[[page ref]]` before the time was
  enough — `{{[[TODO]]}} [[Food Safety Weekly Review]] 07:00 first thing` sorted to the
  bottom of the day. The known prefix vocabulary (tool markers, page refs, block refs,
  tags, bullets) is now stripped before the window is applied, so a time buried in prose
  still does not become the sort key.
- **Same-start entries now tie-break deterministically.** Sorting on start minute alone
  left equal starts in bucket-insertion order (all strict, then all loose, then
  page-level), so `09:00 - 11:00` could precede `09:00 - 09:30`. Order is now
  start → end → original document order: at equal start, the shorter block comes first.
  Strict and loose entries interleave chronologically instead of by bucket.
- **`24:00` no longer collapses to `00:00`.** `formatMinAsHHMM` applied `% 24`, mapping
  the canonical end-of-day 1440 to midnight, so `23:00 - 24:00` round-tripped into the
  backwards range `23:00 - 00:00`. 1440 now formats as `24:00`; 1441+ still wraps.

Speed: sort keys are computed once per entry instead of inside the comparator. Both
comparators previously re-ran the parsing regexes on each side of every comparison —
O(n log n) regex executions for O(n) work.

## [1.1.6] - 2026-08-03

- Ported the existing v1.1.6 organizer/conflict engine to a Depot lifecycle without changing reconciliation semantics.
- Added extension settings migration, idempotent cleanup, deterministic builds, tests, and GitHub Pages deployment.
