# Deviations from the design

Every difference between the design bundle and what the site renders is listed here with an id, and every
entry in `design-patches/*.json` (an `href-map` entry, a `copy-map` entry, a patch op) carries the id of the line
that explains it. The compiler fails the build (exit 3) when a patch references an id that is not listed here.
The parity allow-list (`parity/allowlist.json`) references the same ids.

## Fixture configuration (dashboard bundles standing in for the real design)

- **DV-F1** hrefs: the dashboard bundles link between screens by `.dc.html` file name; the fixture pages live at
  `/` (settings) and `/payments`. The Command Center file name has no page here and is mapped to `/`.
  Allow-listed on the original side as `DV-F1-*` swaps.
