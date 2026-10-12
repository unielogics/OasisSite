/* eslint-disable @typescript-eslint/no-explicit-any */
// readSnapshot: the deploy kit (site-deploy.sh) passes SITE_HOURS_JSON as a file path; tests and CI pass the JSON itself.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSiteEnv, readSnapshot } from './site-env'

describe('readSnapshot', () => {
  it('reads inline JSON and the path of a file holding it', () => {
    expect(readSnapshot(' {"tz":"America/New_York"} ')).toEqual({ tz: 'America/New_York' })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-snap-'))
    const file = path.join(dir, 'hours.json')
    fs.writeFileSync(file, '{"week":[]}')
    expect(readSnapshot(file)).toEqual({ week: [] })
    fs.rmSync(dir, { recursive: true })
  })

  it('names the problem when the value is neither', () => {
    expect(() => readSnapshot('/var/www/site/nope.json')).toThrow(/neither JSON nor an existing file/)
    expect(() => readSnapshot('{"broken"')).toThrow()
  })
})

describe('pricing (DV-PRICE-INTERIM)', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
  const site = JSON.parse(fs.readFileSync(path.join(root, 'site.config.json'), 'utf8'))
  const hours = JSON.parse(fs.readFileSync(path.join(root, 'src/data/hours.fallback.json'), 'utf8'))
  const env = (pricing: string | null, cfg: Record<string, unknown> = site, catalogJson: string | null = null) => {
    const warnings: string[] = []
    const e = buildSiteEnv({ site: cfg as any, hours, hoursSource: 'fallback', catalogJson, pricing, now: '2026-10-12T10:00:00-04:00', warn: (w) => warnings.push(w) })
    return { e, warnings }
  }

  it('interim by default (site.config.json, and when the config has none); SITE_PRICING overrides it', () => {
    expect(env(null).e.pricing).toBe('interim')
    const { pricing: _drop, ...noPricing } = site
    void _drop
    expect(env(null, noPricing).e.pricing).toBe('interim')
    expect(env('catalog').e.pricing).toBe('catalog')
    expect(env('live').e.pricing).toBe('live')
    expect(() => env('v2')).toThrow(/pricing .* must be interim or catalog or live, got v2/)
  })

  it('interim bakes only the booking fee of a catalog snapshot (never the old price model), catalog mode bakes a ready one', async () => {
    const { designCatalog } = await import('../site/catalog-fixture')
    const cat = designCatalog()
    cat.guestBookingFeeCents = 3000
    const json = JSON.stringify(cat)
    const interim = env(null, site, json)
    expect(interim.e.catalogSnapshot).toEqual({ guestBookingFeeCents: 3000, services: [], addons: [] })
    expect(interim.e.catalogSource).toBe('SITE_CATALOG_JSON')
    expect(interim.warnings.join('\n')).toMatch(/pricing is interim/)
    // no whole-dollar fee (or no catalog payload): nothing is baked
    for (const bad of [JSON.stringify({ ...cat, guestBookingFeeCents: 2550 }), '{"nope":1}', 'not json']) {
      const e = env(null, site, bad).e
      expect([e.catalogSnapshot, e.catalogSource]).toEqual([null, 'none'])
    }
    expect(env('catalog', site, json).e.catalogSource).toBe('SITE_CATALOG_JSON')
  })

  it('live (DV-CATALOG2) bakes a website-ready catalog v2 (checked), and nothing but a warning otherwise', async () => {
    const { designCatalogV2, unseededCatalogV2, designCatalog } = await import('../site/catalog-fixture')
    const live = env('live', site, JSON.stringify(designCatalogV2()))
    expect(live.e.catalogSource).toBe('SITE_CATALOG_JSON')
    expect((live.e.catalogSnapshot as any).version).toBe(2)
    // the snapshot is the checked payload: no field the site does not read (no ids, no colours, no categories)
    expect(Object.keys(live.e.catalogSnapshot as any).sort()).toEqual(['addons', 'guestBookingFeeCents', 'guestFeeCollect', 'memberDisplay', 'quotes', 'services', 'tiers', 'vehicleClasses', 'version'])
    expect(live.e.endpoints.catalogV2).toBe('/api/v1/public/catalog/v2')
    for (const bad of [JSON.stringify(unseededCatalogV2()), JSON.stringify(designCatalog()), 'not json']) {
      const r = env('live', site, bad)
      expect([r.e.catalogSnapshot, r.e.catalogSource]).toEqual([null, 'none'])
      expect(r.warnings.join('\n')).toMatch(/catalog v2|not a catalog payload/)
    }
    expect(env('live').warnings.join('\n')).toMatch(/SITE_CATALOG_JSON is not set/)
  })
})
