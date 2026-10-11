/* eslint-disable @typescript-eslint/no-explicit-any */
// Test kit for the bridge (tests only, never bundled): the REAL design logic class (design/extracted/index/
// logic.original.js with the copy-map's logic entries, exactly what the compiler emits) wrapped by the bridge with a
// SiteEnv built from site.config.json, a synchronous host like DCHost (setState applies at once, componentDidUpdate
// runs after the update, nested updates are flushed in order), and a scripted fetch that records every request.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as React from 'react'
import { afterEach } from 'vitest'
import { DCLogic } from '../dc/DCLogic'
import { applyCopy, loadPatchConfig } from '../../tools/dc-compile/patches'
import { loadSiteConfig } from '../../tools/prerender/seo'
import { buildSiteEnv } from '../../tools/prerender/site-env'
import { validatePublicHours, type PublicHours } from '../hours/format'
import type { Availability } from './availability'
import { bridge } from './index.bridge'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

let designCache: any = null
/** The design's Component class, as the compiled logic module defines it (no bridge). */
export function designComponent(): any {
  if (designCache) return designCache
  const cfg = loadPatchConfig(ROOT, 'index')
  const src = applyCopy(fs.readFileSync(path.join(ROOT, 'design/extracted/index/logic.original.js'), 'utf8'), cfg.copyEntries, 'logic')
  // the compiler emits the same text as an ES module with React/DCLogic/StreamableLogic in scope (no eval in the build)
  designCache = new Function('React', 'DCLogic', 'StreamableLogic', `${src}\nreturn Component`)(React, DCLogic, DCLogic)
  return designCache
}

export const FALLBACK_HOURS = validatePublicHours(JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/hours.fallback.json'), 'utf8')))

export interface Call {
  method: string
  url: string
  path: string
  headers: Record<string, string>
  body: any
}

export type Handler = (call: Call) => { status: number; body?: unknown; headers?: Record<string, string> } | Promise<{ status: number; body?: unknown; headers?: Record<string, string> }>

export interface SiteOptions {
  booking?: 'sms' | 'live'
  availability?: Availability | null
  hours?: PublicHours | null
  /** DV-CATALOG: the GET /public/catalog snapshot the build bakes (SITE_CATALOG_JSON); none by default */
  catalog?: unknown
  /** path (without query) -> handler; anything else answers 404 */
  routes?: Record<string, Handler>
}

export interface SiteUnderTest {
  c: any
  calls: Call[]
  env: ReturnType<typeof buildSiteEnv>
  /** lets pending fetches and their continuations run */
  settle: () => Promise<void>
  vals: () => any
}

const sites: any[] = []

/**
 * Detaches every site made so far: the design's timers still pending (the toast's 2.6 s flash, the join flow's delayed
 * openBook) and late fetch answers then update nothing, so none of them reaches `document` after jsdom is torn down.
 * Runs after each test of every file that uses the kit.
 */
export function disposeSites(): void {
  for (const c of sites.splice(0)) {
    clearTimeout(c._tt)
    clearTimeout(c._smsT)
    c.__host = undefined
  }
}
afterEach(disposeSites)

export function makeSite(o: SiteOptions = {}): SiteUnderTest {
  const site = loadSiteConfig(ROOT)
  const env = buildSiteEnv({
    site: site as any,
    hours: o.hours ?? FALLBACK_HOURS,
    hoursSource: 'fallback',
    availabilityJson: o.availability ? JSON.stringify(o.availability) : null,
    catalogJson: o.catalog === undefined ? null : JSON.stringify(o.catalog),
    booking: o.booking ?? 'sms',
    apiOrigin: '',
    now: new Date().toISOString(),
    warn: () => {},
  })
  const calls: Call[] = []
  const routes = o.routes ?? {}
  ;(globalThis as any).fetch = async (input: string, init: any = {}) => {
    const url = String(input)
    const u = new URL(url, 'http://site.test')
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = String(v)
    const call: Call = { method: init.method ?? 'GET', url, path: u.pathname, headers, body: init.body ? JSON.parse(init.body) : undefined }
    calls.push(call)
    const h = routes[u.pathname]
    const r = h ? await h(call) : { status: 404, body: { status: 404, title: 'Not found' } }
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    })
  }
  const Site = bridge(designComponent(), env)
  const c = new Site({ theme: 'dark', beads: true, stickyBar: true })
  sites.push(c)
  let updating = false
  let dirty = false
  const commit = () => {
    dirty = true
    if (updating) return
    updating = true
    try {
      for (let n = 0; dirty && n < 20; n++) {
        dirty = false
        c.componentDidUpdate({})
      }
    } finally {
      updating = false
    }
  }
  c.__host = {
    __setLogicState(update: any, cb?: () => void) {
      const prev = c.state
      c.state = { ...prev, ...(typeof update === 'function' ? update(prev) : update) }
      commit()
      cb?.()
    },
    forceUpdate(cb?: () => void) {
      commit()
      cb?.()
    },
  }
  // mounted without the design's own componentDidMount (canvas, observers, the 30 s tick): the bridge's state only
  c.__mounted = true
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
  }
  return { c, calls, env, settle, vals: () => c.renderVals() }
}

/** An availability payload in the API's shape. */
export function payload(days: { date: string; slots: [number, 'open' | 'last' | 'vip' | 'booked', number][]; closed?: boolean }[], generatedAt = new Date().toISOString(), now?: Availability['now']): Availability {
  return {
    tz: 'America/New_York',
    generatedAt,
    serviceKey: 'signature-hand-wash',
    durationMin: 45,
    now: now ?? null,
    days: days.map((d) => ({
      date: d.date,
      label: d.date,
      dateLabel: d.date,
      weekday: new Date(d.date + 'T12:00:00').getDay(),
      closed: !!d.closed,
      openCount: d.slots.filter((s) => s[1] === 'open' || s[1] === 'last').length,
      slots: d.slots.map(([m, state, bays]) => ({ startMin: m, start: String(m), state, bays })),
    })),
  }
}

/** The catalog as the site's config names it (what the fixture API answers), or another one. */
export function configCatalog(): { services: { key: string; name: string }[]; addons: { key: string; name: string }[] } {
  const site = loadSiteConfig(ROOT) as any
  return {
    services: Object.values(site.catalog.services as Record<string, { key: string; name: string }>).map((s) => ({ key: s.key, name: s.name })),
    addons: Object.entries(site.catalog.addons as Record<string, string>).map(([id, key]) => ({ key, name: id })),
  }
}
