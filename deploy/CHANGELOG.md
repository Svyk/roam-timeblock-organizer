# Changelog

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

