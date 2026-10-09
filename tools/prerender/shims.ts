/* eslint-disable @typescript-eslint/no-explicit-any */
// Browser globals the design's logic class may touch while it is constructed and rendered on the server
// (renderToString never runs lifecycle methods, so only constructors, class fields and renderVals() execute).
// The shims are deterministic: an in-memory Storage seeded with the default theme, matchMedia that matches nothing,
// a location for the page's route, the design's preview size as the window size. Date is NOT pinned unless
// PRERENDER_NOW is set (the parity build sets it to the harness's frozen instant).

export interface ShimOptions {
  route: string
  siteUrl: string
  storage?: Record<string, string>
  width?: number
  height?: number
  /** ISO instant with an explicit offset; pins Date.now() and `new Date()` with no arguments */
  now?: string | null
  timeZone?: string
}

export interface ShimHandle {
  /** what the logic wrote to localStorage during the render (should normally be empty) */
  storageWrites: Record<string, string>
  restore(): void
}

class MemoryStorage {
  private map = new Map<string, string>()
  readonly writes: Record<string, string> = {}
  constructor(seed: Record<string, string>) {
    for (const [k, v] of Object.entries(seed)) this.map.set(k, v)
  }
  get length(): number {
    return this.map.size
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null
  }
  getItem(k: string): string | null {
    return this.map.has(String(k)) ? this.map.get(String(k))! : null
  }
  setItem(k: string, v: string): void {
    this.map.set(String(k), String(v))
    this.writes[String(k)] = String(v)
  }
  removeItem(k: string): void {
    this.map.delete(String(k))
  }
  clear(): void {
    this.map.clear()
  }
}

const noop = () => {}

export function installShims(o: ShimOptions): ShimHandle {
  const g = globalThis as any
  const saved = new Map<string, { had: boolean; value: unknown }>()
  const set = (key: string, value: unknown) => {
    const desc = Object.getOwnPropertyDescriptor(g, key)
    if (desc && !desc.writable && !desc.set && !desc.configurable) return // e.g. navigator on Node 22
    if (!saved.has(key)) saved.set(key, { had: key in g, value: g[key] })
    if (desc && !desc.writable && !desc.set)
      Object.defineProperty(g, key, { value, configurable: true, writable: true })
    else g[key] = value
  }
  const storage = new MemoryStorage(o.storage ?? {})
  const width = o.width ?? 1480
  const height = o.height ?? 1000
  const url = new URL(o.route, o.siteUrl.replace(/\/?$/, '/'))
  if (o.timeZone && !process.env.TZ) process.env.TZ = o.timeZone

  set('localStorage', storage)
  set('sessionStorage', new MemoryStorage({}))
  set('matchMedia', (query: string) => ({
    matches: false,
    media: String(query),
    onchange: null,
    addEventListener: noop,
    removeEventListener: noop,
    addListener: noop,
    removeListener: noop,
    dispatchEvent: () => false,
  }))
  set('location', {
    href: url.href,
    origin: url.origin,
    protocol: url.protocol,
    host: url.host,
    hostname: url.hostname,
    port: url.port,
    pathname: url.pathname,
    search: '',
    hash: '',
    assign: noop,
    replace: noop,
    reload: noop,
    toString: () => url.href,
  })
  set('innerWidth', width)
  set('innerHeight', height)
  set('outerWidth', width)
  set('outerHeight', height)
  set('devicePixelRatio', 1)
  set('navigator', { userAgent: 'oasis-prerender', language: 'en-US', languages: ['en-US'], onLine: true })
  set('requestAnimationFrame', (cb: (t: number) => void) => setTimeout(() => cb(0), 0))
  set('cancelAnimationFrame', (id: any) => clearTimeout(id))
  set('scrollTo', noop)
  set('alert', noop)
  set('addEventListener', noop)
  set('removeEventListener', noop)
  set('getComputedStyle', () => ({ getPropertyValue: () => '' }))
  if (!('window' in g)) set('window', g)
  if (!('self' in g)) set('self', g)
  if (!('document' in g)) {
    const el = () => ({
      style: {},
      dataset: {},
      classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
      setAttribute: noop,
      getAttribute: () => null,
      removeAttribute: noop,
      appendChild: noop,
      removeChild: noop,
      addEventListener: noop,
      removeEventListener: noop,
      getBoundingClientRect: () => ({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
      }),
      focus: noop,
      blur: noop,
      querySelector: () => null,
      querySelectorAll: () => [],
    })
    set('document', {
      documentElement: el(),
      body: el(),
      head: el(),
      title: '',
      readyState: 'complete',
      activeElement: null,
      hidden: false,
      visibilityState: 'visible',
      fonts: { ready: Promise.resolve(), addEventListener: noop, removeEventListener: noop },
      createElement: () => el(),
      createTextNode: () => ({}),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: noop,
      removeEventListener: noop,
      cookie: '',
    })
  }
  if (o.now) {
    const fixed = new Date(o.now)
    if (Number.isNaN(fixed.getTime())) throw new Error(`PRERENDER_NOW is not a valid instant: ${o.now}`)
    const RealDate = Date
    const FixedDate = function (this: any, ...args: any[]) {
      if (!new.target) return new RealDate(fixed.getTime()).toString()
      return args.length ? new RealDate(...(args as [any])) : new RealDate(fixed.getTime())
    } as unknown as DateConstructor
    Object.setPrototypeOf(FixedDate, RealDate)
    Object.defineProperty(FixedDate, 'prototype', { value: RealDate.prototype, writable: false })
    ;(FixedDate as { now: () => number }).now = () => fixed.getTime()
    ;(FixedDate as { parse: typeof Date.parse }).parse = RealDate.parse
    ;(FixedDate as { UTC: typeof Date.UTC }).UTC = RealDate.UTC
    set('Date', FixedDate)
  }
  return {
    storageWrites: storage.writes,
    restore() {
      for (const [key, { had, value }] of saved) {
        if (had) g[key] = value
        else delete g[key]
      }
    },
  }
}
