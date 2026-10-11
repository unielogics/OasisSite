// pnpm build:parity — dist-parity/: the parity variant (data-dc-tpl, the __oasisParity hook) built at the harness's
// frozen instant with the fixture hours and the design's own availability pattern (serve-dist answers the same
// payloads), the design's content as the catalog snapshot (DV-CATALOG), SITE_BOOKING=sms (the launch default), same-origin API.
import './env'
process.env.TZ = process.env.PARITY_TZ ?? 'America/New_York'
import path from 'node:path'
import { buildSite } from '../prerender/build'
import { FIXED_NOW, ROOT } from './config'
import { availabilityFixture, catalogFixture, hoursFixture } from './serve-dist'

async function main(): Promise<number> {
  const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1]! : 'dist-parity'
  const r = await buildSite({
    root: ROOT,
    variant: 'parity',
    outDir: out,
    now: FIXED_NOW,
    hoursJson: hoursFixture('design'),
    availabilityJson: availabilityFixture('design'),
    catalogJson: catalogFixture(),
    booking: 'sms',
    apiOrigin: '',
  })
  console.log(
    `build:parity OK: ${r.pages.length} page(s) -> ${path.relative(ROOT, r.outDir)} at ${r.buildNow}, hours ${r.hoursSource}, availability ${r.availabilitySource}, catalog ${r.catalogSource}, ${r.warnings.length} warning(s)`,
  )
  return 0
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e)
    process.exit(1)
  },
)
