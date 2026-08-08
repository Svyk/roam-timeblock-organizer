# TimeBlock Organizer

Depot-ready v1.1.8 of the personal TimeBlock Organizer. It recognizes standalone `#TimeBlock` tags in headings such as `Schedule #TimeBlock`, continuously organizes direct children with bounded shallow watches, keeps unfinished Elapsed Time sessions in a stable Now lane above the timestamp launcher, and moves completed sessions into chronological order.

The live path is intentionally light: today, tomorrow, and at most one open historical Daily Note are watched; description-only typing is ignored; relevant TimeBlock changes use a 1.5-second trailing debounce; and an order change uses one `block.reorderBlocks` write when Roam supports it. A five-minute sweep remains only as recovery.

## Install for development

Run `npm ci --ignore-scripts --no-audit --no-fund && npm run check`. In Roam open **Settings → Roam Depot**, enable **Developer mode**, choose **Developer Extensions → Load extension → URL**, and enter `https://svyk.github.io/roam-timeblock-organizer` without `/extension.js`. Install it once per client; developer extensions do not sync across devices. Reload with `Ctrl-D`, then `Ctrl-R`.

For a local checkout, choose **Local folder** and select this repository root. `build.sh` performs the locked clean-checkout build expected by Depot.

On first load, settings from localStorage and `[[TimeBlock Organizer Settings]]` are imported into extension-scoped settings. Existing `TimeBlock Organizer:` command names remain available. Unload removes watches, pending reconciles, sweep/rollover timers, navigation listeners, commands, and owned globals.

## Development

- `npm run build` bundles browser ESM with pinned esbuild.
- `npm test` runs lifecycle, migration, conflict-helper, and artifact tests.
- `npm run scan:secrets` rejects common credentials.
- `npm run check` runs the complete release gate.

Source is MIT licensed.
