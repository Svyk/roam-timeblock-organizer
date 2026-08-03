# TimeBlock Organizer

Depot-ready v1.1.6 of the personal TimeBlock Organizer. It watches current and recently visited daily pages, moves time-prefixed blocks under `#TimeBlock`, keeps the timestamp SmartBlock pinned, and preserves the established conflict detection and opt-in bump-forward resolution behavior.

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

