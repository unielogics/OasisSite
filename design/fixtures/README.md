# Test fixtures

The three Claude Design bundles of the dashboard (Operations, Payments, Settings), copied byte for byte from
`OasisDashboard/design/original/`. They exist only to prove the website pipeline end to end before the real
design ("Oasis Site v2") is readable: intake, compiler, prerender, hydration and parity all run against them.
Never edit them. `pages.json` here is the fixture page list used by the tests; `design/pages.json` is what the
build reads.
