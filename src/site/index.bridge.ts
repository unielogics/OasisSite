/* eslint-disable @typescript-eslint/no-explicit-any */
// The site bridge for "Oasis Site v2": a subclass wrapped around the design's logic class at build time (the compiler
// never edits logic.original.js; see tools/dc-compile/compile.ts and docs/compiler.md "bridge"). It replaces the
// design's fabricated data and mock flows with the real thing, each change listed in design-patches/DEVIATIONS.md:
//   DV-HOURS  hours from GET /api/v1/public/hours (prerendered from the build snapshot, refreshed after mount; Sunday closed)
//   DV-AVAIL  the open-times board, day cards, NEXT OPEN, the hero pill and the SMS mock from GET /api/v1/public/availability
//   DV-BOOK   the booking sheet books for real (SITE_BOOKING=live) or composes the sms: text (SITE_BOOKING=sms)
//   DV-OTP    members identify by phone + one-time code (live mode)
//   DV-JOIN   joining creates the member record; the checkout link is texted (no card fields)
//   DV-CLOCK  the first client render is pinned to the build instant so hydration matches the prerendered markup
//   DV-HASH   the home view is prerendered; #/… views render after mount
//   DV-THEME  the theme follows the device (prefers-color-scheme) live until the visitor picks one, which is remembered
//   DV-CATALOG services, add-ons, tint, detailing, quote-only items, plan prices/perks and the guest fee from GET
//             /api/v1/public/catalog (build snapshot + the refresh after mount) when it is website-ready (src/site/catalog.ts)
import type { PublicHours } from '../hours/format'
import { validatePublicHours } from '../hours/format'
import { daysFromAvailability, daysFromHours, isoDate, validateAvailability, type Availability, type DesignDay } from './availability'
import type { SiteEnv } from './env'
import { decideTheme, LIGHT_QUERY, readStoredTheme, storeTheme, type ThemeConfig } from '../client/theme'
import { designTime, hoursRows, hoursTable, withToday, type HoursTable } from './hours'
import {
  catalogMatch,
  catalogTexts,
  DESIGN_DETAIL,
  DESIGN_FILMS,
  DESIGN_MORE,
  DESIGN_PLANS,
  designContentOf,
  priceFacts,
  swapAmount,
  websiteCatalog,
  type DesignContent,
  type SiteCatalog,
} from './catalog'

export { catalogMatch, slugOfName } from './catalog'

type AnyLogic = new (props?: any) => any

interface Member {
  firstName: string
  tier: 'gold' | 'vip' | null
  washesLeft: number | null
  /** an active membership: no booking fee, member prices (the API decides the fee from the same fact) */
  active: boolean
}

interface Problem {
  status: number
  title: string
  detail?: string
  code?: string
  errors?: { path?: string; message?: string }[]
}

interface Catalog {
  services: { key: string; name: string; kind?: string; durationMin?: number }[]
  addons: { key: string; name: string }[]
}

/** How long a payload's "bays open now" stays believable (the board refreshes every few minutes). */
const NOW_FRESH_MS = 10 * 60_000
/** The board and the hours are fetched again on this interval while the page is open, and when it becomes visible. */
const REFRESH_MS = 5 * 60_000

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The real epoch time (Date.now() is the shop's wall clock for a visitor elsewhere, DV-CLOCK; payload stamps are UTC). */
const realNow = (): number =>
  typeof performance !== 'undefined' && typeof performance.timeOrigin === 'number' ? performance.timeOrigin + performance.now() : Date.now()

/** Test hook: the e2e records sms:/tel: navigations instead of leaving the page. */
const navigate = (url: string): void => {
  const w = window as any
  if (typeof w.__oasisNavigate === 'function') w.__oasisNavigate(url)
  else window.location.href = url
}

export function bridge(Base: AnyLogic | undefined, env: SiteEnv): AnyLogic {
  if (!Base) throw new Error('bridge: the design did not define a Component class')
  const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
  const DAYS = env.availabilityDays || 5
  const fetchDays = DAYS + 2
  const api = (p: string): string => env.apiOrigin.replace(/\/$/, '') + p
  // DV-THEME: only when the design's theme is a prop that follows the device (site.config.json theme)
  const themeCfg: ThemeConfig | null = env.theme && env.theme.prop && env.theme.followSystem ? env.theme : null
  const storage = (): Storage | null => {
    try {
      return window.localStorage
    } catch {
      return null
    }
  }
  const matchMedia = (): ((q: string) => MediaQueryList) | null =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? (q: string) => window.matchMedia(q) : null
  // texts go to the texting number (DV-CONTACT: contact.smsE164); calls stay on contact.phoneE164
  const smsUrl = (body: string): string => `sms:${env.contact.smsE164}?&body=${encodeURIComponent(body)}`

  class SiteComponent extends Base {
    __mounted = false
    __hours: PublicHours | null = env.hours
    __avail: Availability | null = env.availability
    __availFor = ''
    __availSeq = 0
    /** the date (YYYY-MM-DD) of the day the visitor picked; the design keeps only its position in `days`, which moves */
    __pickDate: string | null = null
    /** Idempotency-Key per endpoint, kept only for a retry of the same body (sig) and dropped once it succeeded */
    __idem: { booking: { key: string; sig: string } | null; join: { key: string; sig: string } | null } = { booking: null, join: null }
    __lastProblem: Problem | null = null
    __refreshTimer: ReturnType<typeof setInterval> | null = null
    __onVisible: (() => void) | null = null
    __lastRefresh = 0
    __member: { token: string; member: Member } | null = null
    __otp: { challengeId: string; phone: string } | null = null
    __booking: { bookingRef: string; confirmationBy: string; deposit?: { dueCents: number; how: string } } | null = null
    __memberRef: string | null = null
    __busy = false
    __catalog: Catalog | null = null
    __catalogReady: Promise<void> | null = null
    __schemeMq: MediaQueryList | null = null
    __onScheme: ((e: { matches: boolean }) => void) | null = null

    constructor(props?: any) {
      super(props)
      this.HOURS = this.__table()
      // DV-CATALOG: the build's snapshot (null: the design's content); the browser's catalog load applies the live one
      this.__applyCatalog(env.catalogSnapshot)
    }

    // ---- DV-HASH / DV-CLOCK: the prerendered first render is the home view at the build instant ----------------------
    parseHash(): { page: string; tier: string } {
      if (!this.__mounted) return { page: 'home', tier: 'vip' }
      return super.parseHash()
    }

    componentDidMount(): void {
      this.__mounted = true
      super.componentDidMount()
      // the design's own first-paint state, now with the real clock and the real hash
      this.setState({ now: Date.now(), flapAt: Date.now() })
      if (typeof location !== 'undefined' && location.hash.replace(/^#\/?/, '') !== '') this._hc()
      this.__followDevice()
      this.__refreshAll()
      // the hours' state and the board are snapshots: fetched again while the page stays open, and when it comes back
      if (typeof setInterval === 'function') this.__refreshTimer = setInterval(() => this.__refreshAll(), REFRESH_MS)
      if (typeof document !== 'undefined') {
        this.__onVisible = () => {
          if (document.visibilityState === 'visible' && Date.now() - this.__lastRefresh > 60_000) this.__refreshAll()
        }
        document.addEventListener('visibilitychange', this.__onVisible)
      }
    }

    __refreshAll(): void {
      this.__lastRefresh = Date.now()
      void this.__refreshHours()
      void this.__refreshAvailability()
    }

    componentWillUnmount(): void {
      if (this.__refreshTimer) clearInterval(this.__refreshTimer)
      if (this.__onVisible && typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.__onVisible)
      const mq = this.__schemeMq as any
      if (mq && this.__onScheme) {
        if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', this.__onScheme)
        else if (typeof mq.removeListener === 'function') mq.removeListener(this.__onScheme)
      }
      super.componentWillUnmount()
    }

    componentDidUpdate(...args: any[]): void {
      if (typeof super.componentDidUpdate === 'function') super.componentDidUpdate(...args)
      this.__syncPick()
      // <html data-oasis-theme> (set by the head script, DV-THEME) follows the page's theme
      if (themeCfg && typeof document !== 'undefined') {
        const t = this.theme()
        if (document.documentElement.getAttribute('data-oasis-theme') !== t) document.documentElement.setAttribute('data-oasis-theme', t)
      }
    }

    // ---- DV-THEME: the device decides until the visitor does ------------------------------------------------------------
    /**
     * The pre-hydration script (src/client/theme.entry.ts) already applied the decision and boot passed it as the theme
     * prop; should the script not have run, the decision is applied now (after hydration, so nothing mismatches). From
     * here a change of the device setting is applied while no choice is stored, through the design's own state
     * (themeOverride), and never stored.
     */
    __followDevice(): void {
      if (!themeCfg) return
      const want = decideTheme(themeCfg, storage(), matchMedia()).theme
      if (want !== this.theme()) this.setState({ themeOverride: want })
      const mm = matchMedia()
      if (!mm) return
      const mq = mm(LIGHT_QUERY) as any
      this.__schemeMq = mq
      this.__onScheme = (e: { matches: boolean }) => {
        if (readStoredTheme(themeCfg, storage())) return
        const t = e.matches && themeCfg.values.includes('light') ? 'light' : themeCfg.default
        if (t !== this.theme()) this.setState({ themeOverride: t })
      }
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', this.__onScheme)
      else if (typeof mq.addListener === 'function') mq.addListener(this.__onScheme)
    }

    // ---- DV-HOURS -----------------------------------------------------------------------------------------------------
    __table(): HoursTable {
      return hoursTable(this.__hours)
    }

    async __refreshHours(): Promise<void> {
      try {
        const ctl = new AbortController()
        const t = setTimeout(() => ctl.abort(), env.timeouts.hours)
        const res = await fetch(api(env.endpoints.hours), { signal: ctl.signal, credentials: 'omit', headers: { accept: 'application/json' } })
        clearTimeout(t)
        if (!res.ok) return
        this.__hours = validatePublicHours(await res.json())
        this.HOURS = this.__table()
        this.forceUpdate()
      } catch {
        /* the baked hours stay */
      }
    }

    bays(): { short: string; open: boolean } {
      const h = withToday(this.__hours, new Date())
      const today = h?.today
      if (today && !today.closed && today.state === 'open') {
        // the payload's "now" is believed while it is fresh, and never over its own "closed"
        const a = this.__avail
        const fresh = !!a && Math.abs(realNow() - Date.parse(a.generatedAt)) < NOW_FRESH_MS
        const live = fresh ? a!.now : null
        if (live && live.open === false) return { short: 'CLOSED NOW', open: false }
        if (live && typeof live.baysFree === 'number')
          return { short: `${live.baysFree} OF ${live.baysTotal || 3} BAYS OPEN NOW`, open: true }
        const day = this.days.find((d: DesignDay) => d.i === 0)
        const first = day && !day.unknown ? day.slots.find((s) => s.st !== 'booked') : undefined
        const n = first ? first.bays : day && !day.unknown ? 0 : null
        return { short: n === null ? 'OPEN NOW · TEXT TO CHECK TIMES' : n + ' OF 3 BAYS OPEN NOW', open: true }
      }
      if (today && !today.closed && today.state === 'opens_later' && today.openMin != null)
        return { short: 'OPENS TODAY ' + designTime(Number(today.openMin)), open: false }
      const next = h?.next
      if (next && !next.closed && next.openMin != null && typeof next.weekday === 'number')
        return { short: 'OPENS ' + DOW[next.weekday] + ' ' + designTime(Number(next.openMin)), open: false }
      return { short: 'CLOSED TODAY', open: false }
    }

    // ---- DV-AVAIL -----------------------------------------------------------------------------------------------------
    get days(): DesignDay[] {
      const now = new Date()
      if (this.__avail) {
        const d = daysFromAvailability(this.__avail, now, DAYS)
        if (d.length) return d
      }
      return daysFromHours(this.HOURS, now, DAYS)
    }

    /**
     * The design's service and add-on ids -> the backend's catalog keys, from the live catalog (GET
     * /api/v1/public/catalog, fetched once per page): the configured key (site.config.json) when the catalog carries it,
     * else the catalog item with the design's name. Fail safe: an item without a catalog entry has no key (null /
     * listed as missing) and is never replaced by a look-alike; a booking that needs one is refused (text us instead).
     */
    __serviceKey(): string | null {
      const svc = this.state.bk?.svc || 'signature'
      const cfg = env.catalog.services[svc]
      const cat = this.__catalog
      if (!cat) return null
      const name = cfg?.name || this.WASH.find((w: any) => w.id === svc)?.name || svc
      return catalogMatch(cat.services, cfg?.key, name)?.key ?? null
    }

    __addonKeys(): { keys: string[]; missing: string[] } {
      const cat = this.__catalog
      const keys: string[] = []
      const missing: string[] = []
      for (const id of (this.state.bk?.addons || []) as string[]) {
        const name = this.DURING.find((a: any) => a.id === id)?.name || id
        const hit = cat ? catalogMatch(cat.addons, env.catalog.addons[id], name) : null
        if (hit) keys.push(hit.key)
        else missing.push(name)
      }
      return { keys, missing }
    }

    /** The live catalog, fetched once per page in every booking mode (the availability query needs a key it knows). */
    __loadCatalog(): Promise<void> {
      if (!this.__catalogReady) this.__catalogReady = this.__fetchCatalog()
      return this.__catalogReady
    }

    async __fetchCatalog(): Promise<void> {
      try {
        const ctl = new AbortController()
        const t = setTimeout(() => ctl.abort(), env.timeouts.api)
        const res = await fetch(api(env.endpoints.catalog), { signal: ctl.signal, credentials: 'omit', headers: { accept: 'application/json' } })
        clearTimeout(t)
        if (!res.ok) return
        const c = (await res.json()) as { services?: unknown; addons?: unknown }
        if (Array.isArray(c.services) && Array.isArray(c.addons)) this.__catalog = { services: c.services as any, addons: c.addons as any }
        // DV-CATALOG: the live answer decides the content (a catalog that is not website-ready brings the design's back)
        if (this.__applyCatalog(c)) this.forceUpdate()
      } catch {
        /* no catalog: the board asks for the API's default wash, and bookings are refused until it loads */
      }
    }

    // in every booking mode (the launch default sms included): the board shows real times as soon as the API answers,
    // queried with a catalog key the API knows (the catalog is loaded first)
    async __refreshAvailability(): Promise<void> {
      await this.__loadCatalog()
      // add-ons never change the answer (the API ignores them): the query is the wash only, one URL per wash for the
      // cache in front; a wash the catalog does not carry asks for the API's default wash
      const service = this.__serviceKey()
      const q = `?days=${fetchDays}${service ? `&service=${service}` : ''}`
      if (this.__availFor === q + '|pending') return
      // only the latest query may land: an older answer arriving last would show another wash's times
      const seq = ++this.__availSeq
      this.__availFor = q + '|pending'
      try {
        const ctl = new AbortController()
        const t = setTimeout(() => ctl.abort(), env.timeouts.availability)
        const res = await fetch(api(env.endpoints.availability + q), { signal: ctl.signal, credentials: 'omit', headers: { accept: 'application/json' } })
        clearTimeout(t)
        if (seq !== this.__availSeq) return
        if (!res.ok) {
          this.__availFor = ''
          return
        }
        const avail = validateAvailability(await res.json())
        if (seq !== this.__availSeq) return
        this.__avail = avail
        this.__availFor = q
        this.forceUpdate()
      } catch {
        if (seq === this.__availSeq) this.__availFor = ''
      }
    }

    /** The date of the day at position `i` of the current list (what the visitor sees when they tap it). */
    __dateAt(i: unknown): string | null {
      const days = this.days
      if (typeof i !== 'number' || !days.length) return null
      const d = days[Math.max(0, Math.min(i, days.length - 1))]
      return d ? isoDate(d.d) : null
    }

    /** The day the visitor picked, by its date (null when that day is no longer listed). */
    __pickedDay(): DesignDay | null {
      const days = this.days
      if (this.__pickDate) return days.find((d: DesignDay) => isoDate(d.d) === this.__pickDate) ?? null
      return days[Math.min(this.state.bk?.day ?? 0, days.length - 1)] ?? null
    }

    /**
     * The design keeps the picked day as a position in `days`, a list rebuilt on every render (a refresh drops a day
     * whose last start passed, midnight shifts it). After every update the position is put back on the picked date; when
     * the date or the time is gone the pick is cleared and the visitor is asked for another time.
     */
    __syncPick(): void {
      const s = this.state
      const b = s.bk
      if (!b || !this.__pickDate || (s.sheet === 'book' && s.step === 'done')) return
      const days = this.days
      const idx = days.findIndex((d: DesignDay) => isoDate(d.d) === this.__pickDate)
      const day = idx >= 0 ? days[idx]! : null
      const slotOk = b.slot == null || (!!day && (day.unknown || day.slots.some((x) => x.m === b.slot && x.st !== 'booked')))
      if (day && slotOk) {
        if (b.day !== idx) this.setState({ bk: { ...b, day: idx } })
        return
      }
      if (!day) this.__pickDate = null
      const lost = b.slot != null
      this.setState((ss: any) => ({
        bk: { ...ss.bk, day: day ? idx : 0, slot: null },
        ...(lost && ss.sheet === 'book' && ss.step === 'review' ? { step: 'time' } : {}),
      }))
      if (lost && s.sheet === 'book') this.flash('That time is no longer available. Pick another time.')
    }

    openBook(p?: any): void {
      if (p && 'day' in p) this.__pickDate = this.__dateAt(p.day)
      // live mode: the sheet opens on the member side only for a verified active member (a tier set by a join that is
      // not paid yet, or by the design's own sign-in, proves nothing)
      if (env.booking === 'live' && this.state.tier && !this.__member?.member.active) this.setState({ tier: null })
      super.openBook(p)
      void this.__refreshAvailability()
    }

    setBk(p: any): void {
      if (p && 'day' in p) this.__pickDate = this.__dateAt(p.day)
      else if (p && p.slot != null && !this.__pickDate) this.__pickDate = this.__dateAt(this.state.bk?.day ?? 0)
      super.setBk(p)
      if (p && 'svc' in p) void this.__refreshAvailability()
    }

    // ==== DV-CATALOG (the catalog section, W3e) ===========================================================================
    // The website's services, add-ons, tint table, detailing, quote-only items, plan prices and perks and the guest fee
    // from the Settings catalog (src/site/catalog.ts). While no website-ready catalog is applied (__site null) every
    // override below answers the design's own value. With one, the design's data fields (WASH, DURING, TINT, VEH, FEE)
    // carry the catalog's content and the view models' fixed numbers (the price lists, the plans, the fee, the
    // calculators) are written again from it with the design's own formulas and words.
    __design: DesignContent | null = null
    __site: SiteCatalog | null = null

    /** Applies a catalog payload (null: none); answers whether the page's content changed. */
    __applyCatalog(raw: unknown): boolean {
      // only over the design's own data model (a logic class without it is left alone)
      if (!Array.isArray(this.WASH) || !Array.isArray(this.DURING) || !Array.isArray(this.VEH) || !this.TINT || typeof this.FEE !== 'number') return false
      if (!this.__design) this.__design = { WASH: this.WASH, DURING: this.DURING, TINT: this.TINT, VEH: this.VEH, FEE: this.FEE }
      const site = raw ? websiteCatalog(raw, env.catalog, this.__design).site : null
      const changed = JSON.stringify(site) !== JSON.stringify(this.__site)
      this.__site = site
      Object.assign(this, designContentOf(site, this.__design))
      // an add-on or a vehicle type the new lists do not carry leaves the visitor's choice (the tint page and the booking
      // sheet look the chosen vehicle type up in VEH and TINT); a vehicle falls back to the list's first, as the design starts
      const has = (id: string) => this.DURING.some((a: any) => a.id === id)
      const veh = (k: unknown) => this.VEH.some(([v]: [string, string]) => v === k)
      const s = this.state
      const stale =
        !!s && ((Array.isArray(s.bk?.addons) && !s.bk.addons.every(has)) || (s.bk && !veh(s.bk.vehicle)) || (s.tintVeh != null && !veh(s.tintVeh)))
      if (changed && stale)
        this.setState((ss: any) => {
          const first = this.VEH[0][0]
          return {
            ...(ss.tintVeh != null && !veh(ss.tintVeh) ? { tintVeh: first } : {}),
            bk: { ...ss.bk, addons: Array.isArray(ss.bk.addons) ? ss.bk.addons.filter(has) : ss.bk.addons, vehicle: veh(ss.bk.vehicle) ? ss.bk.vehicle : first },
          }
        })
      return changed
    }

    /**
     * The guest price of a member price the design computes with no catalog item behind it (its fallbacks): the
     * catalog's markup. Every item the page lists shows its own guest price instead (gp, __washGuest, __addonGuest, a
     * tint row's guest prices), also where the design's booking sheet asks g(member) (__catalogSheet).
     */
    g(m: number): number {
      const site = this.__site
      if (!site) return super.g(m)
      return Math.floor((m * (100 + site.markupPct) + 50) / 100)
    }

    /** The guest price of a wash by the design's id. */
    __washGuest(w: { id: string; m: number }): number {
      return this.__site?.wash.find((x) => x.id === w.id)?.gp ?? this.g(w.m)
    }

    /** The guest price of an add-on by the design's id. */
    __addonGuest(id: string): number {
      const a = this.__site?.during?.find((x) => x.id === id)
      if (a) return a.gp
      const dm = this.__design!.DURING.find((x) => x.id === id)
      return this.g(dm ? dm.m : 0)
    }

    __catalogTexts(): Record<string, string> {
      if (!this.__design) return {}
      return catalogTexts(priceFacts(this.__site, this.__design!, (m) => this.g(m)))
    }

    homeVM(): Record<string, any> {
      const v = super.homeVM()
      const site = this.__site
      if (!site) return v
      // the Gold calculator: n guest Signature washes with their fees against the Gold price
      const sig = site.wash.find((w) => w.id === 'signature') ?? site.wash[0]!
      const per = sig.gp + site.fee
      const gold = site.plans.gold.price
      const n = this.state.washes
      const save = n * per - gold
      const k = Math.floor(gold / per) + 1
      return {
        ...v,
        calcGuest: this.$(n * per),
        calcGuestSub: n + ' × ($' + sig.gp + ' wash + $' + site.fee + ' fee)',
        calcSave: save > 0 ? 'Save ' + this.$(save) + '/mo' : 'Pays off at ' + k + ' washes',
        calcSaveSub: save > 0 ? 'with Gold at ' + n + ' wash' + (n > 1 ? 'es' : '') + ' a month' : k + ' guest washes cost ' + this.$(k * per),
        nextSub:
          typeof v.nextSub === 'string'
            ? v.nextSub.replace(/Signature Hand Wash takes about 45 min$/, () => `${sig.name} takes about ${sig.durationMin} min`)
            : v.nextSub,
      }
    }

    /** The design's price groups (priceVM's G) written from the catalog, row for row in the design's formulas. */
    __priceRows(site: SiteCatalog): Record<string, any[]> {
      let i = 0
      const row = (name: string, sub: string, m: number, gp: number, o?: Record<string, any>) => ({
        name,
        sub,
        priced: true,
        quote: false,
        pre: '',
        g: '$' + gp,
        v: '$' + m,
        save: 'SAVE $' + (gp - m),
        vSize: '20px',
        nameSize: '16px',
        delay: i++ * 60 + 'ms',
        ...(o || {}),
      })
      const incl = (name: string, sub: string, gp: number) => row(name, sub, 0, gp, { v: 'Included', vSize: '17px', save: 'SAVE $' + gp })
      const tintGuest = (f: string, k: string): number[] => (site.tint ? site.tint.guest[f]![k]! : this.TINT[f][k].map((x: number) => this.g(x)))
      const films = site.tint ? site.tint.films : DESIGN_FILMS
      const wash = site.wash.map((w) => incl(w.name, w.sub, w.gp)).map((r) => ({ ...r, nameSize: '18px' }))
      const during = this.DURING.map((a: any) => {
        const gp = this.__addonGuest(a.id)
        return a.vip ? incl(a.name, a.vip === 'incl' ? a.sub + ' · included with VIP' : a.sub + ' · ' + a.vip + ' with VIP', gp) : row(a.name, a.sub, a.m, gp)
      })
      const tint = this.VEH.map(([k, l]: [string, string]) => row(l, 'Carbon or ceramic film · side & rear windows', this.TINT.carbon[k][0], tintGuest('carbon', k)[0]!, { pre: 'from' }))
      const tintFull = this.VEH.flatMap(([k, l]: [string, string]) =>
        Object.keys(DESIGN_FILMS).map((f) => {
          const r = this.TINT[f][k]
          const gr = tintGuest(f, k)
          return row(l + ' · ' + films[f], 'VIP ' + this.$(r[0]) + '–' + this.$(r[1]) + ' · guest ' + this.$(gr[0]) + '–' + this.$(gr[1]), r[0], gr[0]!, { pre: 'from' })
        }),
      )
      const detail = (site.detail ?? DESIGN_DETAIL.map((d) => ({ ...d, gp: this.g(d.m) }))).map((d) => row(d.name, d.sub, d.m, d.gp))
      const more = (site.more ?? DESIGN_MORE).map((nm) => ({ name: nm, sub: '', priced: false, nameSize: '15.5px' }))
      return { wash, during, tint, tintFull, detail, more }
    }

    priceVM(): Record<string, any> {
      const v = super.priceVM()
      const site = this.__site
      if (!site) return v
      const G = this.__priceRows(site)
      // the design's groups by their number and title (priceVM's G keys)
      const KEY: Record<string, string> = {
        '01|Hand wash': 'wash',
        '02|Add during your wash': 'during',
        '03|Window tint': 'tint',
        '01|Window tint': 'tintFull',
        '04|Detailing': 'detail',
        '05|More services': 'more',
      }
      // "What VIP is worth a month", the design's items at the catalog's guest prices
      const sig = site.wash.find((w) => w.id === 'signature') ?? site.wash[0]!
      const vm: [string, number][] = [
        ['4 Signature washes', 4 * sig.gp],
        ['4 booking fees', 4 * site.fee],
        ['Hand wax ×4', 4 * this.__addonGuest('wax')],
        ['Engine bay wash', this.__addonGuest('engine')],
        ['Leather conditioning ×2', 2 * this.__addonGuest('leather')],
        ['Stain removal', this.__addonGuest('stain')],
      ]
      const total = vm.reduce((a, x) => a + x[1], 0)
      return {
        ...v,
        prGroups: (v.prGroups || []).map((gr: any) => {
          const k = KEY[gr.n + '|' + gr.title]
          return k && G[k] ? { ...gr, rows: G[k] } : gr
        }),
        vipMonth: vm.map(([label, x]) => ({ label, value: this.$(x) })),
        vipMonthGuest: this.$(total),
        vipMonthSave: 'Save ' + this.$(total - site.plans.vip.price) + '/mo',
        faqs: (v.faqs || []).map((f: any) => ({ ...f, a: swapAmount(f.a, this.__design!.FEE, site.fee) })),
      }
    }

    pagesVM(): Record<string, any> {
      const v = super.pagesVM()
      const site = this.__site
      if (!site) return v
      const s = this.state
      const from = this.__design!.FEE
      const r = this.TINT[s.film][s.tintVeh]
      const gr: number[] = site.tint ? site.tint.guest[s.film]![s.tintVeh]! : r.map((x: number) => this.g(x))
      const cardWash = ['signature', 'exterior'] // washCards: the design's two cards, in this order
      return {
        ...v,
        compRows: (v.compRows || []).map((row: any) =>
          row.f === 'Booking fee' ? { ...row, cells: row.cells.map((c: any) => ('t' in c ? { ...c, t: swapAmount(c.t, from, site.fee) } : c)) } : row,
        ),
        washCards: (v.washCards || []).map((c: any, i: number) => {
          const w = site.wash.find((x) => x.id === cardWash[i])
          return w ? { ...c, name: w.name, g: '$' + w.gp } : c
        }),
        tintGuest: this.$(gr[0]) + ' – ' + this.$(gr[1]),
        tintSave: 'save ' + this.$(gr[0]! - r[0]) + '+',
      }
    }

    /** The join flow's plans (joinVM's T): the catalog's monthly prices and perks under the design's names. */
    __catalogJoin(r: Record<string, any>): Record<string, any> {
      const site = this.__site
      const jv = r.jv
      const tier = this.state.jn?.tier as 'gold' | 'vip'
      if (!site || !jv || this.state.page !== 'join' || !Array.isArray(jv.tiers) || !(tier in site.plans)) return r
      const KEY: Record<string, 'gold' | 'vip'> = { Gold: 'gold', VIP: 'vip' }
      const from = DESIGN_PLANS[tier].price
      const to = site.plans[tier].price
      return {
        ...r,
        jv: {
          ...jv,
          tiers: jv.tiers.map((t: any) => {
            const k = KEY[t.name]
            return k ? { ...t, price: '$' + site.plans[k].price, perks: site.plans[k].perks } : t
          }),
          agreeText: swapAmount(jv.agreeText, from, to),
          lines: (jv.lines || []).map((l: any, i: number) => (i === 0 ? { ...l, value: swapAmount(l.value, from, to) } : l)),
          due: swapAmount(jv.due, from, to),
          ctaLabel: swapAmount(jv.ctaLabel, from, to),
        },
      }
    }

    /**
     * What the visit costs at the shop (sheetVals' atShop). byItem: at each item's own guest price (what the sheet shows);
     * otherwise as the design's logic computed it, with g(member).
     */
    __atShop(byItem: boolean): number {
      const s = this.state
      const b = s.bk
      const isG = b.who === 'guest'
      const vip = s.tier === 'vip'
      const wash = this.WASH.find((w: any) => w.id === b.svc) || this.WASH[0]
      const guestWash = (w: any) => (byItem ? this.__washGuest(w) : this.g(w.m))
      const guestAddon = (a: any) => (byItem ? this.__addonGuest(a.id) : this.g(a.m))
      const addonPrice = (a: any) => (isG ? guestAddon(a) : vip && a.vip ? 0 : a.m)
      return (isG ? guestWash(wash) : 0) + this.DURING.filter((a: any) => b.addons.includes(a.id)).reduce((x: number, a: any) => x + addonPrice(a), 0)
    }

    /**
     * The booking sheet with the catalog: a guest's wash and add-on prices are each item's own guest price (the design's
     * logic asks g(member), which cannot tell two items with one member price apart), and the fee amounts are the
     * catalog's. The sheet's lists follow WASH and DURING in order (sheetVals: washes, addons; review lines: the wash,
     * the picked add-ons, the fee; sumLines: the vehicle, the wash, the picked add-ons, the fee).
     */
    __catalogSheet(r: Record<string, any>): Record<string, any> {
      const site = this.__site
      const d = this.__design
      const sh = r.sh
      const s = this.state
      if (!site || !d || !sh || s.sheet !== 'book') return r
      const from = d.FEE
      const to = site.fee
      const out: Record<string, any> = { ...sh }
      const b = s.bk
      if (b.who === 'guest') {
        const price = (o: any, field: string, logic: number, own: number) => (o && typeof o[field] === 'string' ? { ...o, [field]: swapAmount(o[field], logic, own) } : o)
        const wash = this.WASH.find((w: any) => w.id === b.svc) || this.WASH[0]
        const ads = this.DURING.filter((a: any) => b.addons.includes(a.id))
        const fixWash = (o: any, w: any, field: string) => price(o, field, this.g(w.m), this.__washGuest(w))
        const fixAddon = (o: any, a: any, field: string) => price(o, field, this.g(a.m), this.__addonGuest(a.id))
        if (Array.isArray(sh.washes)) out.washes = sh.washes.map((o: any, i: number) => (this.WASH[i] ? fixWash(o, this.WASH[i], 'price') : o))
        if (Array.isArray(sh.addons)) out.addons = sh.addons.map((o: any, i: number) => (this.DURING[i] ? fixAddon(o, this.DURING[i], 'price') : o))
        if (Array.isArray(sh.lines))
          out.lines = sh.lines.map((o: any, i: number) => (i === 0 ? fixWash(o, wash, 'value') : ads[i - 1] ? fixAddon(o, ads[i - 1], 'value') : o))
        if (Array.isArray(sh.sumLines))
          out.sumLines = sh.sumLines.map((o: any, i: number) => (i === 1 ? fixWash(o, wash, 'value') : i >= 2 && ads[i - 2] ? fixAddon(o, ads[i - 2], 'value') : o))
      }
      const logicAt = this.__atShop(false)
      const ownAt = this.__atShop(true)
      if (Array.isArray(out.lines))
        out.lines = out.lines.map((l: any) => (l.label === 'Booking fee · non-refundable' ? { ...l, value: swapAmount(l.value, from, to) } : l))
      if (Array.isArray(out.sumLines)) out.sumLines = out.sumLines.map((l: any) => (l.label === 'Booking fee' ? { ...l, value: swapAmount(l.value, from, to) } : l))
      if (sh.bReview && sh.isGuest) {
        out.due = swapAmount(sh.due, from, to)
        if (typeof sh.dueSub === 'string')
          out.dueSub = sh.dueSub
            .replace(new RegExp(`^\\$${from}(?![0-9])`), () => `$${to}`)
            .replace(`Pay ${this.$(logicAt)}`, () => `Pay ${this.$(ownAt)}`)
      }
      if (sh.bReview && typeof sh.upsell === 'string') out.upsell = sh.upsell.replace(this.$(logicAt + from), () => this.$(ownAt + to))
      return { ...r, sh: out }
    }
    // ==== end of DV-CATALOG =================================================================================================

    // ---- the view models ------------------------------------------------------------------------------------------------
    renderVals(): Record<string, any> {
      const v = super.renderVals()
      const unknown = this.days.length > 0 && this.days.every((d: DesignDay) => d.unknown)
      v.hoursList = hoursRows(this.__hours)
      if (unknown) {
        v.dayCards = (v.dayCards || []).map((c: any) => ({ ...c, count: 'text us' }))
        v.hasNext = false
      }
      const sh = v.sh || {}
      v.site = {
        boardEmptyText: unknown
          ? `TEXT ${env.contact.smsKeyword} TO ${env.contact.smsDisplay} TO CHECK TIMES`
          : 'NO TIMES IN THIS PART OF THE DAY',
        timeNote:
          sh.bTime && unknown
            ? `We can't show live times right now. Text ${env.contact.smsKeyword} to ${env.contact.smsDisplay} and we'll reply with open times.`
            : '',
        // live mode, review step: guests give a name and a mobile number; a member gives the name to book under (the
        // API keeps what a verified member types as their name, so nothing is sent that they did not type)
        guestDetails: !!(sh.bReview && env.booking === 'live'),
        askPhone: !!(sh.bReview && sh.isGuest && env.booking === 'live'),
        name: this.state.bk?.name || '',
        setName: (e: any) => this.setBk({ name: e.target.value }),
        phone: this.state.bk?.phone || '',
        setPhone: (e: any) => this.setBk({ phone: e.target.value, phoneErr: false }),
        code: this.state.bk?.code || '',
        setCode: (e: any) => this.setBk({ code: e.target.value.replace(/\D/g, '').slice(0, 6), codeErr: '' }),
        codeContinue: () => void this.__verifyCode(),
        resendCode: () => void this.__sendCode(),
        codeErr: this.state.bk?.codeErr || '',
        busy: this.__busy,
        smsHref: smsUrl(env.contact.smsKeyword),
      }
      v.site.cat = this.__catalogTexts() // DV-CATALOG: the template's static price texts
      if (themeCfg) {
        // the visitor's own choice (header toggle, menu Dark/Light) is remembered on the device (DV-THEME); the design's
        // handlers set state synchronously, so this.theme() already reads the new theme
        const remember =
          (fn: any) =>
          (...args: any[]) => {
            const r = typeof fn === 'function' ? fn(...args) : undefined
            storeTheme(themeCfg, storage(), this.theme())
            return r
          }
        v.toggleTheme = remember(v.toggleTheme)
        v.setDark = remember(v.setDark)
        v.setLight = remember(v.setLight)
      }
      return v
    }

    sheetVals(): Record<string, any> {
      const r = this.__catalogSheet(super.sheetVals())
      const s = this.state
      let sh = r.sh
      if (s.sheet !== 'book') return r
      if (s.step === 'code' && this.__otp) {
        const base = { bWho: false, bSvc: false, bTime: false, bReview: false, bDone: false, hasCta: false, canBack: true, isGuest: false }
        sh = {
          ...base,
          bCode: true,
          back: () => this.setState({ step: 'who' }),
          eyebrow: 'MEMBER BOOKING · ONE-TIME CODE',
          title: 'Check your texts',
          codePhone: this.__otp.phone,
          progress: '30%',
          sumWho: '—',
          sumWhen: sh.sumWhen,
          sumLines: sh.sumLines,
        }
      } else if (sh.bReview) {
        // the labels ("Book", the fee line) come from the logic through the copy map (DV-BOOK); only the submit changes
        sh = { ...sh, cta: () => void this.__submitBooking() }
      } else if (sh.bDone && this.__booking) {
        const orig = sh
        const bk = this.__booking
        const due =
          bk.deposit && bk.deposit.dueCents > 0
            ? ` · ${(bk.deposit.dueCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} ${bk.deposit.how === 'link' ? 'by the link we text you' : 'at the counter'}`
            : ''
        sh = {
          ...orig,
          doneSub: `${String(orig.doneSub).replace(/ · 468 River Drive, Garfield$/, '')} · Ref ${bk.bookingRef}${due}`,
          cta: () => {
            this.__booking = null
            orig.cta()
          },
        }
      }
      r.sh = sh
      r.memberContinue = () => void this.__memberContinue()
      return r
    }

    joinVM(): Record<string, any> {
      const r = this.__catalogJoin(super.joinVM())
      const j = this.state.jn
      const jv = r.jv
      if (!jv || this.state.page !== 'join') return r
      const st = j.step
      const digits = (x: string) => x.replace(/\D/g, '')
      const validate = (): string => {
        if (st === 1 && !j.vehicles.some((v: any) => v.car.trim())) return 'Add at least one vehicle.'
        if (st === 2 && (!j.name.trim() || digits(j.phone).length < 10)) return 'Add your name and a 10-digit mobile number.'
        // the API needs the receipts e-mail to start a membership (live mode; a text to the shop does without)
        if (st === 2 && env.booking === 'live' && !EMAIL.test(String(j.email || '').trim())) return 'Add your email for the receipts.'
        if (st === 3 && !j.agree) return 'Please accept the membership terms.'
        return ''
      }
      jv.next = () => {
        const e = validate()
        if (e) {
          this.setJn({ err: e })
          return
        }
        if (st === 3) {
          void this.__submitJoin()
          return
        }
        this.setJn({ step: st + 1, err: '' })
        window.scrollTo({ top: 0, behavior: 'smooth' })
      }
      if (env.booking === 'live') {
        // the membership is pending until the checkout is paid: no member pricing yet, the sheet opens at the member
        // sign-in with the number prefilled (the code proves it; an active membership then waives the fee)
        jv.bookFirst = () => {
          this.go('home')
          setTimeout(() => this.openBook({ phone: j.phone, who: null }), 200)
        }
      }
      r.jv = jv
      return r
    }

    // ---- DV-OTP: phone -> code -> memberToken ------------------------------------------------------------------------------
    async __memberContinue(): Promise<void> {
      const phone = String(this.state.bk.phone || '')
      if (phone.replace(/\D/g, '').length < 10) {
        this.setBk({ phoneErr: true })
        return
      }
      if (env.booking !== 'live') {
        // the design's own path (sheetVals() of the base class: the bridge's override would call back into this method)
        super.sheetVals().memberContinue()
        return
      }
      await this.__sendCode()
    }

    async __sendCode(): Promise<void> {
      const phone = String(this.state.bk.phone || '')
      const r = await this.__post(env.endpoints.otp, { phone }, null)
      if (!r) return
      this.__otp = { challengeId: String(r.challengeId), phone }
      this.setState({ step: 'code', bk: { ...this.state.bk, code: '', codeErr: '' } })
    }

    async __verifyCode(): Promise<void> {
      const code = String(this.state.bk.code || '')
      if (!this.__otp) return
      if (code.length < 6) {
        this.setBk({ codeErr: 'Enter the 6-digit code we texted you.' })
        return
      }
      const r = await this.__post(env.endpoints.otpVerify, { challengeId: this.__otp.challengeId, code }, null)
      if (!r) return
      const m = (r.member ?? {}) as Partial<Member>
      const member: Member = { firstName: String(m.firstName ?? ''), tier: m.tier ?? null, washesLeft: m.washesLeft ?? null, active: m.active === true }
      this.__member = { token: String(r.memberToken), member }
      if (member.active) {
        this.setState((ss: any) => ({
          tier: member.tier || 'gold',
          step: ss.bk.slot != null ? 'review' : 'svc',
          bk: { ...ss.bk, who: 'member' },
        }))
        return
      }
      // a verified number without an active membership books as a guest: guest prices, the booking fee and its terms
      // (the API charges the fee from the same fact); the token still proves the number
      this.flash('No active membership on this number. You can book as a guest.')
      this.setState((ss: any) => ({ tier: null, step: 'svc', bk: { ...ss.bk, who: 'guest', ack: false } }))
    }

    /** A booking with the member side's terms: only for a verified active member (live mode). */
    __isMemberBooking(): boolean {
      return this.state.bk?.who === 'member' && !!this.__member?.member.active
    }

    // ---- DV-BOOK ----------------------------------------------------------------------------------------------------------
    /** The request body, or why there is none (a message for the visitor). */
    __bookingBody(): { body: Record<string, any> } | { error: string } {
      const b = this.state.bk
      const day = this.__pickedDay()
      if (!day || b.slot == null) return { error: 'Pick a time first' }
      const serviceKey = this.__serviceKey()
      const wash = this.WASH.find((w: any) => w.id === b.svc) || this.WASH[0]
      if (!serviceKey) return { error: `${wash.name} can't be booked online yet. Text ${env.contact.smsKeyword} to ${env.contact.smsDisplay} and we'll book it for you.` }
      const addons = this.__addonKeys()
      if (addons.missing.length)
        return { error: `${addons.missing.join(', ')} can't be booked online yet. Remove it, or text ${env.contact.smsKeyword} to ${env.contact.smsDisplay}.` }
      const vehL = this.VEH.find((v: any) => v[0] === b.vehicle)?.[1] ?? b.vehicle
      return {
        body: {
          // only a name the visitor typed: the API stores a verified member's name as given
          name: String(b.name || '').trim(),
          phone: String(b.phone || ''),
          vehicle: { label: vehL },
          serviceKey,
          addonKeys: addons.keys,
          date: isoDate(day.d),
          startMin: b.slot,
          smsConsent: true,
          ...(this.__member ? { memberToken: this.__member.token } : {}),
          website: '',
        },
      }
    }

    __composeBooking(): string {
      const s = this.state
      const b = s.bk
      const wash = this.WASH.find((w: any) => w.id === b.svc) || this.WASH[0]
      const vehL = this.VEH.find((v: any) => v[0] === b.vehicle)?.[1] ?? b.vehicle
      const day = this.__pickedDay()
      const when = b.slot != null && day ? `${day.word} ${this.fmt(b.slot)}` : 'any open time'
      const ads = this.DURING.filter((a: any) => b.addons.includes(a.id)).map((a: any) => a.name)
      const who = b.who === 'member' ? `Member${b.phone ? ' ' + b.phone : ''}` : 'Guest'
      return `${env.contact.smsKeyword} booking: ${wash.name} · ${vehL} · ${when}${ads.length ? ' · + ' + ads.join(', ') : ''} · ${who}`
    }

    /** The key of one request kind, reused only for a retry of the identical body. */
    __idemFor(kind: 'booking' | 'join', body: unknown): string {
      const sig = JSON.stringify(body)
      const cur = this.__idem[kind]
      if (cur && cur.sig === sig) return cur.key
      const next = { key: randomId(), sig }
      this.__idem[kind] = next
      return next.key
    }

    async __submitBooking(): Promise<void> {
      const b = this.state.bk
      if (env.booking !== 'live') {
        if (b.who === 'guest' && !b.ack) {
          this.flash('Please confirm the booking fee terms')
          return
        }
        navigate(smsUrl(this.__composeBooking()))
        return
      }
      const member = this.__isMemberBooking()
      if (!member && !b.ack) {
        this.flash('Please confirm the booking fee terms')
        return
      }
      if (!String(b.name || '').trim()) {
        this.flash('Add your full name')
        return
      }
      if (!member && String(b.phone || '').replace(/\D/g, '').length < 10) {
        this.flash('Add your name and a 10-digit mobile number')
        return
      }
      if (this.__busy) return
      // the keys come from the live catalog: load it now if it failed earlier (never book a key it does not know)
      if (!this.__catalog) {
        this.__catalogReady = null
        await this.__loadCatalog()
      }
      const r0 = this.__bookingBody()
      if ('error' in r0) {
        this.flash(r0.error)
        return
      }
      const r = await this.__post(env.endpoints.bookings, r0.body, this.__idemFor('booking', r0.body))
      if (!r) return
      this.__idem.booking = null
      this.__booking = { bookingRef: String(r.bookingRef), confirmationBy: String(r.confirmationBy), deposit: r.deposit }
      this.setState({ step: 'done' })
      void this.__refreshAvailability()
    }

    // ---- DV-JOIN ----------------------------------------------------------------------------------------------------------
    __composeJoin(): string {
      const j = this.state.jn
      const cars = j.vehicles.filter((v: any) => v.car.trim()).map((v: any) => v.car.trim() + (v.plate ? ' ' + v.plate.toUpperCase() : ''))
      return `JOIN ${String(j.tier).toUpperCase()}: ${j.name.trim()} · ${j.phone}${j.email ? ' · ' + j.email : ''}${cars.length ? ' · ' + cars.join('; ') : ''}`
    }

    async __submitJoin(): Promise<void> {
      const j = this.state.jn
      if (env.booking !== 'live') {
        navigate(smsUrl(this.__composeJoin()))
        return
      }
      const body = {
        tier: j.tier,
        name: j.name.trim(),
        phone: j.phone,
        email: String(j.email || '').trim(),
        vehicles: j.vehicles.filter((v: any) => v.car.trim()).map((v: any) => ({ car: v.car.trim(), plate: v.plate.trim().toUpperCase() })),
        smsConsent: true,
        agree: true,
        website: '',
      }
      const r = await this.__post(env.endpoints.memberships, body, this.__idemFor('join', body))
      if (!r) {
        // a field the API refused goes back to the step that has it, with the API's words
        const pb = this.__lastProblem
        const field = pb?.errors?.find((e) => /^body\.(email|name|phone)/.test(String(e.path ?? '')))
        if (pb && pb.status === 422 && field) this.setJn({ step: 2, err: String(field.message || pb.detail || pb.title) })
        return
      }
      this.__idem.join = null
      this.__memberRef = String(r.memberRef)
      // pending until the checkout is paid: no member pricing (tier) until a verified sign-in says it is active
      this.setJn({ step: 4, err: '' })
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }

    // ---- transport ----------------------------------------------------------------------------------------------------------
    async __post(endpoint: string, body: unknown, idem: string | null): Promise<Record<string, any> | null> {
      if (this.__busy) return null
      this.__busy = true
      this.__lastProblem = null
      this.forceUpdate()
      try {
        // a retry of the same key while the first request is still being committed answers 409 IDEMPOTENCY_IN_FLIGHT:
        // wait as told and send the identical request again (it replays the stored answer once the first one is done)
        for (let attempt = 0; ; attempt++) {
          const ctl = new AbortController()
          const t = setTimeout(() => ctl.abort(), env.timeouts.api)
          const res = await fetch(api(endpoint), {
            method: 'POST',
            signal: ctl.signal,
            credentials: 'omit',
            headers: { 'content-type': 'application/json', accept: 'application/json', ...(idem ? { 'idempotency-key': idem } : {}) },
            body: JSON.stringify(body),
          })
          clearTimeout(t)
          if (res.ok) return (await res.json()) as Record<string, any>
          let problem: Problem | null = null
          try {
            problem = (await res.json()) as Problem
          } catch {
            problem = null
          }
          this.__lastProblem = problem ? { ...problem, status: res.status } : { status: res.status, title: '' }
          const code = String(problem?.code ?? '')
          if (res.status === 409 && code === 'IDEMPOTENCY_IN_FLIGHT' && attempt < 5) {
            const after = Number(res.headers.get('retry-after'))
            await new Promise((r) => setTimeout(r, (Number.isFinite(after) && after > 0 ? Math.min(after, 5) : 1) * 1000))
            continue
          }
          if (endpoint === env.endpoints.bookings && code.startsWith('PUBLIC_SLOT_')) {
            // the time is gone (taken, held, past, closed): pick another
            this.flash(problem?.title || 'That time is no longer available. Pick another.')
            this.setBk({ slot: null })
            this.setState({ step: 'time' })
            void this.__refreshAvailability()
          } else
            this.flash(
              (res.status === 422 && problem?.detail) ||
                problem?.title ||
                (res.status === 429 ? 'Too many tries. Please wait a minute.' : 'Something went wrong. Try again or text us.'),
            )
          return null
        }
      } catch {
        this.flash(`No connection. Text ${env.contact.smsKeyword} to ${env.contact.smsDisplay} instead.`)
        return null
      } finally {
        this.__busy = false
        this.forceUpdate()
      }
    }
  }
  return SiteComponent as AnyLogic
}

function randomId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : null
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return 'idem-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}
