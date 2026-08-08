# TimeBlock Organizer

Depot-ready v1.2.0 of the personal TimeBlock Organizer. It recognizes standalone `#TimeBlock` tags in headings such as `Schedule #TimeBlock`, continuously organizes direct children with bounded shallow watches, keeps unfinished Elapsed Time sessions in a stable Now lane above the timestamp launcher, and moves completed sessions into chronological order.

The live path is intentionally light: today, tomorrow, and at most one open historical Daily Note are watched; description-only typing is ignored; relevant TimeBlock changes use a 1.5-second trailing debounce; and an order change uses one `block.reorderBlocks` write when Roam supports it. Missed events are recovered on startup, when Roam becomes visible, and once per hour for today only—there is no recurring sweep across watched pages.

The organizer never rewrites or auto-closes time entries. Use **TimeBlock Organizer: show conflicts on current page** for read-only overlap inspection. Persistent conflict summaries are optional and off by default; when enabled, unchanged output causes no writes. `#calendar`, `#concurrent`, and `#no-conflict` mark intentional overlaps.

## Install for development

Run `npm ci --ignore-scripts --no-audit --no-fund && npm run check`. In Roam open **Settings → Roam Depot**, enable **Developer mode**, choose **Developer Extensions → Load extension → URL**, and enter `https://svyk.github.io/roam-timeblock-organizer` without `/extension.js`. Install it once per client; developer extensions do not sync across devices. Reload with `Ctrl-D`, then `Ctrl-R`.

For a local checkout, choose **Local folder** and select this repository root. `build.sh` performs the locked clean-checkout build expected by Depot.

On the first v1.2 load, compatible values from the old Depot snapshot, localStorage, and `[[TimeBlock Organizer Settings]]` are imported once into individual extension-scoped Depot settings. The old graph page is left untouched but is no longer read or written. Retired conflict-rewrite and technical performance settings are ignored. The **Enabled** switch takes effect immediately without reloading. Unload removes watches, pending reconciles, recovery/rollover timers, navigation/visibility listeners, commands, and owned globals.

## Development

- `npm run build` bundles browser ESM with pinned esbuild.
- `npm test` runs lifecycle, migration, conflict, recovery, ordering, and artifact tests.
- `npm run scan:secrets` rejects common credentials.
- `npm run check` runs the complete release gate.

Source is MIT licensed.
