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
//             /api/v1/public/catalog (build snapshot + the refresh after mount) when it is website-ready (src/site/catalog.ts);
//             only with site.config.json pricing "catalog"
//   DV-PRICE-INTERIM  pricing "interim" (the default): only "from $40" (Signature Hand Wash), "from $129/mo" (Gold) and
//             the booking fee; every other price reads "Priced by vehicle size — ask us" / "Ask us"
//   DV-CATALOG2 pricing "live": prices by vehicle size from GET /api/v1/public/catalog/v2 (build snapshot + the refresh
//             after mount, src/site/catalog2.ts): the sizes as the vehicle chips, "from $X" and per-size tables, the
//             booking sheet priced for the chosen size, the join flow's tiers and size picker; anything the catalog lacks
//             keeps the interim words
//   DV-LINK   personal links (#/c|m|p|pin|v|k/<token>): the token is scrubbed before hydration and exchanged for a session;
//             DV-STEPUP (PIN / texted code / create PIN), DV-LINK-JOIN (with a card when Square bills the membership),
//             DV-LINK-PAY (Square's checkout, the booking deposit, #/paid), DV-LINK-CARD (saved cards), DV-LINK-DEAD: see
//             the "links" section
import type { PublicHours } from '../hours/format'
import { validatePublicHours } from '../hours/format'
import { daysFromAvailability, daysFromHours, isoDate, validateAvailability, type Availability, type DesignDay } from './availability'
import type { SiteEnv } from './env'
import { decideTheme, LIGHT_QUERY, readStoredTheme, storeTheme, type ThemeConfig } from '../client/theme'
import { designTime, hoursRows, hoursTable, withToday, type HoursTable } from './hours'
import {
  catalogMatch,
  catalogFee,
  catalogTexts,
  DESIGN_DETAIL,
  DESIGN_FILMS,
  DESIGN_MORE,
  DESIGN_PLANS,
  designContentOf,
  INTERIM,
  interimTexts,
  priceFacts,
  swapAmount,
  websiteCatalog,
  type DesignContent,
  type SiteCatalog,
} from './catalog'

export { catalogMatch, slugOfName } from './catalog'
// ---- links (W3f): imports ----
import { installLinkCapture, onLink, takeLink, type CapturedLink } from '../client/link'
import {
  liveCatalog,
  liveTexts,
  priceAt,
  tierPriceAt,
  tierUniform,
  websiteReadyV2,
  type DesignTier,
  type LiveCatalog,
  type LiveItem,
  type LiveTier,
  type SizePrice,
} from './catalog2'
import {
  allowedRedirect,
  cardLabel,
  checkoutName,
  consentText,
  DEAD_COPY,
  deadReason,
  listWords,
  money,
  PIN_RE,
  planTier,
  shopDate,
  trustDate,
  validateExchange,
  validateState,
  whoLabel,
  whoText,
  type CardPurpose,
  type Exchanged,
  type LinkDeadReason,
  type StepUpPurpose,
} from './links'
import { CARD_WORDS, CardFormError, loadSquareSdk, mountCard, sdkUrlAllowed, type CardForm } from '../client/square'

// DV-LINK: the token leaves the address bar while this module is evaluated, before boot() hydrates (src/client/link.ts)
installLinkCapture()
// ---- end links imports ----

type AnyLogic = new (props?: any) => any

interface Member {
  firstName: string
  tier: 'gold' | 'vip' | null
  washesLeft: number | null
  /** an active membership: no booking fee, member prices (the API decides the fee from the same fact) */
  active: boolean
  /** DV-CATALOG2: the size the membership is priced at (null: unknown) */
  planClass: string | null
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

// ---- links (W3f): the linked views -----------------------------------------------------------------------------------------
/** What the link sheet (state.sheet 'link') shows. */
type LinkView =
  | { v: 'stepup' }
  | { v: 'pay' }
  | { v: 'card' }
  | {
      v: 'notice'
      tone: 'ok' | 'warn'
      eyebrow: string
      title: string
      text: string
      action?: { label: string; run: () => void } | null
      /** an sms: link to the texting number ("Text us for a new link") */
      sms?: string | null
      /** the sms: link's label (default "Text us for a new link") */
      smsLabel?: string
    }

/** The step-up block (DV-STEPUP): PIN, texted code, or a new PIN; and what runs once it succeeds. */
interface StepUp {
  mode: 'pin' | 'send' | 'code' | 'create'
  purpose: StepUpPurpose
  challengeId: string | null
  value: string
  err: string
  /** the PIN is locked or disabled: no PIN input, only the reset by code */
  locked: boolean
  then: 'book' | 'join' | 'join-start' | 'join-card' | 'pay' | 'pay-review' | 'verified' | 'pinset' | 'card'
  /** a PIN offered after a code ("Skip for now") */
  optional: boolean
}

interface LinkAnswer {
  ok: boolean
  /** 0 = no answer (network) */
  status: number
  body: any
  problem: (Problem & { meta?: Record<string, unknown> }) | null
}

/** A membership or payment needs a PIN or code from this page within 5 minutes (the server's rule); a little less here. */
const STEP_UP_FRESH_MS = 4.5 * 60_000
/** POST /links/pin is allowed within 10 minutes of a code (the server's rule); a little less here. */
const PIN_AFTER_CODE_MS = 9 * 60_000
/** The design's CTA button on (sheetVals ctaStyle(true)). */
const CTA_STYLE = { width: '100%', height: '58px', borderRadius: '17px', fontWeight: 800, fontSize: '16.5px', background: '#1FB6FF', color: '#00131D', boxShadow: '0 10px 30px rgba(31,182,255,.3)' }
/** The design's terms box (joinVM agreeBox), checked or not. */
const checkBox = (on: boolean) => ({
  flex: 'none',
  width: '24px',
  height: '24px',
  borderRadius: '7px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: on ? '#1FB6FF' : 'transparent',
  border: on ? 'none' : '2px solid var(--ink4)',
  marginTop: '1px',
})
/** DV-LINK-CARD: the elements Square's card form is attached to (the card page's, the membership page's). */
const CARD_FORM_ID = 'oasis-card-form'
const JOIN_CARD_ID = 'oasis-join-card'
/** DV-LINK-JOIN: how long the page waits for Square's first membership payment, and how often it asks. */
const MEMBERSHIP_WAIT_MS = 2 * 60_000
// ---- end links types ----

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
  // DV-CATALOG2: prices by vehicle size (catalog v2); without a website-ready catalog the page shows the interim prices
  const liveMode = env.pricing === 'live'
  // DV-PRICE-INTERIM: anything but an explicit "catalog" or "live" is the interim prices (the old catalog never comes back
  // by mistake)
  const interim = env.pricing !== 'catalog' && !liveMode
  // the join flow's plan cards: the template's "/mo" after the price binds each plan's own suffix (t.per, DV-PRICE-INTERIM)
  const tierWith = (t: any, price: string, per: string): any => {
    const { name, price: _price, per: _per, ...rest } = t
    void _price
    void _per
    return { name, price, per, ...rest }
  }
  /** catalog mode: every plan keeps the design's "/mo" (a suffix the plan already carries stays) */
  const withTierPer = (r: Record<string, any>): Record<string, any> =>
    r.jv && Array.isArray(r.jv.tiers) ? { ...r, jv: { ...r.jv, tiers: r.jv.tiers.map((t: any) => ('per' in t ? t : tierWith(t, t.price, '/mo'))) } } : r

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
    // ---- links (W3f): state, all in memory (the token and the session never reach storage, the DOM or a log) ----
    /** the open personal link: its token (for a re-exchange), the session and what the exchange said */
    __lk: (Exchanged & { token: string; stepUpAt: number | null; codeAt: number | null }) | null = null
    /** bumps on every new link: an answer for an earlier link is dropped */
    __lkSeq = 0
    /** the sheet's linked view (sheet 'link'): the step-up block, the payment review or a notice */
    __lkView: LinkView | null = null
    /** the step-up block (PIN / texted code / create PIN) and what happens once it succeeds */
    __su: StepUp | null = null
    /** the linked join: the verify step is showing */
    __lkJoinVerify = false
    /** the linked join was just opened: its fields are set once the design shows the join page */
    __lkJoinInit = false
    /** Idempotency-Key of a linked booking, kept only for a retry of the same body */
    __lkIdem: { key: string; sig: string } | null = null
    /** the per-client board failed (the session ended): the public board again */
    __lkAvailOff = false
    __lkOff: (() => void) | null = null

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
      this.__lkMount() // links (W3f)
      this.__paidMount() // DV-LINK-PAY: back from Square's checkout
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
      this.__lkOff?.() // links (W3f)
      void this.__sqDrop() // DV-LINK-CARD
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
      this.__lkJoinSync() // links (W3f)
      this.__liveJoinSync() // DV-CATALOG2
      this.__sqSync() // DV-LINK-CARD: Square's card form follows the page
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
        const url = liveMode ? env.endpoints.catalogV2 || '/api/v1/public/catalog/v2' : env.endpoints.catalog
        const res = await fetch(api(url), { signal: ctl.signal, credentials: 'omit', headers: { accept: 'application/json' } })
        clearTimeout(t)
        if (!res.ok) return
        const c = (await res.json()) as { services?: unknown; addons?: unknown }
        // the booking keys: only items with a key and a name (DV-CATALOG2: v2's, checked)
        const named = (x: unknown) =>
          Array.isArray(x)
            ? x.filter((i: any) => i && typeof i.key === 'string' && typeof i.name === 'string').map((i: any) => ({ key: i.key, name: i.name, durationMin: i.durationMin }))
            : null
        const sv = named(c.services)
        const ad = named(c.addons)
        if (sv && ad) this.__catalog = { services: sv, addons: ad }
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
      // links (W3f): a calendar link's page reads the client's own board (VIP-aware once verified), never cached
      const lkAuth = this.__lkBoardAuth()
      const q = `?days=${fetchDays}${service ? `&service=${service}` : ''}${lkAuth ? '&linked=1' : ''}`
      if (this.__availFor === q + '|pending') return
      // only the latest query may land: an older answer arriving last would show another wash's times
      const seq = ++this.__availSeq
      this.__availFor = q + '|pending'
      try {
        const ctl = new AbortController()
        const t = setTimeout(() => ctl.abort(), env.timeouts.availability)
        const res = lkAuth
          ? await fetch(api(lkAuth.base + '/availability' + q.replace('&linked=1', '')), { signal: ctl.signal, credentials: 'omit', cache: 'no-store', headers: { accept: 'application/json', authorization: lkAuth.auth } })
          : await fetch(api(env.endpoints.availability + q), { signal: ctl.signal, credentials: 'omit', headers: { accept: 'application/json' } })
        clearTimeout(t)
        if (seq !== this.__availSeq) return
        if (!res.ok) {
          this.__availFor = ''
          // links (W3f): the session ended: back to the public board
          if (lkAuth) {
            this.__lkAvailOff = true
            void this.__refreshAvailability()
          }
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
      // links (W3f): with a calendar link open, every Book button books for that client (no who / phone / code)
      if (this.__lkCalendar()) {
        this.__lkOpenBook(p)
        void this.__refreshAvailability()
        return
      }
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
      if (liveMode) return this.__applyLive(raw) // DV-CATALOG2
      // DV-PRICE-INTERIM: the catalog's content carries the old price model and is not applied (its keys still are); only
      // its guest booking fee is (a Settings value, what the API charges; else the design's)
      const site = raw && !interim ? websiteCatalog(raw, env.catalog, this.__design).site : null
      const fee = interim ? (catalogFee(raw) ?? this.__design.FEE) : null
      const changed = JSON.stringify(site) !== JSON.stringify(this.__site) || (fee !== null && fee !== this.FEE)
      this.__site = site
      Object.assign(this, designContentOf(site, this.__design), fee !== null ? { FEE: fee } : {})
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
      if (liveMode) return this.__live ? liveTexts(this.__live) : interimTexts(this.FEE)
      if (interim) return interimTexts(this.FEE)
      return catalogTexts(priceFacts(this.__site, this.__design!, (m) => this.g(m)))
    }

    homeVM(): Record<string, any> {
      const v = super.homeVM()
      if (liveMode) return this.__live ? this.__liveHome(v) : this.__interimHome(v)
      if (interim) return this.__interimHome(v)
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
      if (liveMode) {
        const lv = this.__withTintVeh(() => super.priceVM())
        return this.__live ? this.__livePrice(lv) : this.__interimPrice(lv)
      }
      const v = super.priceVM()
      if (interim) return this.__interimPrice(v)
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
      if (liveMode) {
        const lv = this.__withTintVeh(() => super.pagesVM())
        return this.__live ? this.__livePages(lv) : this.__interimPages(lv)
      }
      const v = super.pagesVM()
      if (interim) return this.__interimPages(v)
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

    // ==== DV-PRICE-INTERIM (owner, 2026-10-12) ==============================================================================
    // Prices depend on the vehicle size; until the per-size catalog (public catalog v2) is on the site, the page shows only
    // the Signature Hand Wash "from $40", membership "from $129/mo" (Gold) and the booking fee. Each method below takes the
    // design's view model and writes the interim words over its prices, field for field and key order kept; the parity
    // allow-list's DV-PRICE-INTERIM swaps give the original design the same values (src/site/bridge-interim.test.ts holds
    // the two together over every price state). The booking fee is the catalog's (Settings) when it has one: every "$25"
    // the design writes is the fee, and __fee() writes the current one over it.

    /** The design's fee amount ("$25") in a string replaced by the current fee (FEE: the catalog's, else the design's). */
    __fee(x: unknown): unknown {
      return swapAmount(x, this.__design!.FEE, this.FEE)
    }

    /** The Gold savings calculator: the box is hidden (site.cat.calcDisplay) and its numbers are gone. */
    __interimHome(v: Record<string, any>): Record<string, any> {
      return { ...v, calcGuest: '', calcGuestSub: '', calcSave: '', calcSaveSub: '' }
    }

    /** The price lists: "Ask us" for every price but the Signature wash; "what VIP is worth" is not shown. */
    __interimPrice(v: Record<string, any>): Record<string, any> {
      const row = (r: any, group: string): any => {
        if (!r || r.priced !== true) return r
        const incl = r.v === 'Included'
        const out = { ...r, pre: '', g: INTERIM.ask, v: incl ? 'Included' : INTERIM.ask, save: incl ? INTERIM.withVip : INTERIM.byVehicle }
        if (group === '01|Hand wash' && r.name === 'Signature Hand Wash') Object.assign(out, { pre: 'from', g: INTERIM.washFromAmount })
        if (group === '01|Window tint') out.sub = INTERIM.priced
        return out
      }
      return {
        ...v,
        prGroups: (v.prGroups || []).map((gr: any) => ({ ...gr, rows: (gr.rows || []).map((r: any) => row(r, gr.n + '|' + gr.title)) })),
        prShowMonth: false,
        vipMonth: [],
        vipMonthGuest: '',
        vipMonthSave: '',
        faqs: (v.faqs || []).map((f: any) => (typeof f.a === 'string' ? { ...f, a: this.__fee(f.a.replace('to hold a time, on top of guest pricing.', 'to hold a time.')) } : f)),
      }
    }

    /** The membership comparison's fee row, the wash cards and the tint page's price block. */
    __interimPages(v: Record<string, any>): Record<string, any> {
      const cardPrice = [INTERIM.washFrom, INTERIM.priced] // washCards: the Signature wash, then the Exterior wash
      return {
        ...v,
        compRows: (v.compRows || []).map((row: any) =>
          row.f === 'Booking fee' ? { ...row, cells: row.cells.map((c: any) => (c.t === '$0' ? { ...c, t: INTERIM.none } : 't' in c ? { ...c, t: this.__fee(c.t) } : c)) } : row,
        ),
        washCards: (v.washCards || []).map((c: any, i: number) => (cardPrice[i] ? { ...c, g: cardPrice[i] } : c)),
        tintPriceLabel: typeof v.tintPriceLabel === 'string' ? v.tintPriceLabel.replace(/^VIP · /, '') : v.tintPriceLabel,
        tintVip: INTERIM.ask,
        tintGuest: '',
        tintSave: '',
      }
    }

    /** The join flow: Gold "from $129/mo", VIP "Ask us"; the terms and the button carry no amount. */
    __interimJoin(r: Record<string, any>): Record<string, any> {
      const jv = r.jv
      if (!jv || this.state.page !== 'join' || !Array.isArray(jv.tiers)) return r
      const label: Record<string, { label: string; mo: string }> = {
        Gold: { label: INTERIM.goldFrom, mo: INTERIM.goldFromMo },
        VIP: { label: INTERIM.ask, mo: INTERIM.ask },
      }
      const tier = label[jv.tierName] ?? label.VIP!
      return {
        ...r,
        jv: {
          ...jv,
          // the price, then its suffix (the template's "/mo" span binds t.per): Gold "from $129/mo", VIP "Ask us"
          tiers: jv.tiers.map((t: any) => (label[t.name] ? tierWith(t, label[t.name]!.label, t.name === 'Gold' ? INTERIM.tierPerGold : '') : t)),
          agreeText: typeof jv.agreeText === 'string' ? jv.agreeText.replace(/^I agree to be billed \$[\d,]+ a month for /, 'I agree to be billed monthly for ') : jv.agreeText,
          lines: (jv.lines || []).map((l: any, i: number) => (i === 0 ? { ...l, value: tier.mo } : l.label === 'Booking fees' ? { ...l, value: INTERIM.none } : l)),
          due: tier.label,
          ctaLabel: typeof jv.ctaLabel === 'string' ? jv.ctaLabel.replace(/ · \$[\d,]+\/mo$/, '') : jv.ctaLabel,
        },
      }
    }

    /** The booking sheet: the Signature wash "from $40", every other price "Ask us"; the fee stays. */
    __interimSheet(r: Record<string, any>): Record<string, any> {
      const sh = r.sh
      const s = this.state
      if (!sh || s.sheet !== 'book') return r
      const b = s.bk
      const isG = b.who === 'guest'
      const washOf = (w: any): string => (w && w.id === 'signature' ? INTERIM.washFrom : INTERIM.ask)
      const wash = this.WASH.find((w: any) => w.id === b.svc) || this.WASH[0]
      const nAds = this.DURING.filter((a: any) => b.addons.includes(a.id)).length
      const addon = (l: any) => (l && l.value !== 'Included' ? { ...l, value: INTERIM.ask } : l)
      const out: Record<string, any> = { ...sh }
      if (Array.isArray(sh.washes))
        out.washes = sh.washes.map((o: any, i: number) => (isG ? { ...o, price: washOf(this.WASH[i]), note: INTERIM.washNote } : { ...o, price: 'Included' }))
      if (Array.isArray(sh.addons)) out.addons = sh.addons.map((o: any) => (o.price !== 'Included' ? { ...o, price: INTERIM.ask } : o))
      if (Array.isArray(sh.lines))
        out.lines = sh.lines.map((l: any, i: number) => (i === 0 ? (isG ? { ...l, value: washOf(wash) } : l) : i <= nAds ? addon(l) : l))
      if (Array.isArray(sh.sumLines))
        out.sumLines = sh.sumLines.map((l: any, i: number) => (i === 1 ? (b.who === 'guest' ? { ...l, value: washOf(wash) } : l) : i >= 2 && i < 2 + nAds ? addon(l) : l))
      if (sh.bReview) {
        if (!sh.isGuest) out.due = INTERIM.memberDue
        else if (typeof sh.dueSub === 'string') out.dueSub = sh.dueSub.replace(/Pay \$[\d,]+ after your wash\.$/, () => 'Pay ' + INTERIM.payRest)
        out.upsell = INTERIM.upsell
      }
      // the fee amounts (the fee lines, what is due now, its sub-line, the button): the current fee
      const fee = (l: any) => (l && typeof l.value === 'string' ? { ...l, value: this.__fee(l.value) } : l)
      if (Array.isArray(out.lines)) out.lines = out.lines.map(fee)
      if (Array.isArray(out.sumLines)) out.sumLines = out.sumLines.map(fee)
      for (const k of ['due', 'dueSub', 'ctaLabel']) if (typeof out[k] === 'string') out[k] = this.__fee(out[k])
      return { ...r, sh: out }
    }
    // ==== end of DV-PRICE-INTERIM ===========================================================================================

    // ==== DV-CATALOG2 (pricing "live": prices by vehicle size, GET /api/v1/public/catalog/v2) =======================================
    // The catalog v2 (src/site/catalog2.ts) applied over the design's view models. The sizes are the design's VEH (the
    // booking sheet's vehicle chips); the tint page keeps its own list (the sizes priced for both films), swapped in while
    // the design's tint views are computed. Price rows read "from $X" unless the item has one price for every size, with a
    // per-size block when more than one size is priced; the member column is the catalog's memberCents; the booking sheet
    // is priced for the chosen size (a verified member's included wash shows the size difference paid at the shop); the
    // join flow lists the design's tiers the catalog sells with a size picker. Whatever the catalog does not price keeps
    // the interim words (DV-PRICE-INTERIM), never the design's old figures. With designCatalogV2() every value is the
    // design's (src/site/bridge-live.test.ts).
    __live: LiveCatalog | null = null
    /** the join flow's chosen membership size (null: the tier's starting size) */
    __joinClass: string | null = null

    /** Applies a catalog v2 payload (null: none); answers whether the page's content changed. */
    __applyLive(raw: unknown): boolean {
      const d = this.__design!
      const ready = raw ? websiteReadyV2(raw, env.catalog, d.WASH) : null
      const live = ready?.cat ? liveCatalog(ready.cat, env.catalog, d) : null
      // the booking fee is the catalog's (a Settings value) even when the rest is not ready
      const fee = live ? live.fee : (catalogFee(raw) ?? d.FEE)
      const changed = JSON.stringify(live) !== JSON.stringify(this.__live) || fee !== this.FEE
      this.__live = live
      Object.assign(this, {
        WASH: live ? live.wash.map(({ id, name, sub, m }) => ({ id, name, sub, m })) : d.WASH,
        DURING: live?.during ? live.during.map(({ id, name, sub, m, vip }) => ({ id, name, sub, m, ...(vip ? { vip } : {}) })) : d.DURING,
        TINT: live?.tint ? live.tint.member : d.TINT,
        VEH: live ? live.sizes : d.VEH,
        FEE: fee,
      })
      this.__fixPicks()
      return changed
    }

    /** The tint page's vehicle list: the sizes priced for both films, else the design's. */
    __tintVehList(): [string, string][] {
      return this.__live?.tint ? this.__live.tint.veh : (this.__design?.VEH ?? this.VEH)
    }

    /** Runs a design view model with the tint page's vehicle list as VEH (its rows and chips read VEH and TINT). */
    __withTintVeh<T>(fn: () => T): T {
      const veh = this.VEH
      this.VEH = this.__tintVehList()
      try {
        return fn()
      } finally {
        this.VEH = veh
      }
    }

    /** A pick the new lists no longer carry moves to the list's first (vehicle, tint vehicle, wash) or is dropped (add-on). */
    __fixPicks(): void {
      const s = this.state
      if (!s || !s.bk) return
      const tv = this.__tintVehList()
      const inList = (list: [string, string][], k: unknown) => list.some(([v]) => v === k)
      const fix = (ss: any): Record<string, any> => {
        const out: Record<string, any> = {}
        if (ss.tintVeh != null && !inList(tv, ss.tintVeh)) out.tintVeh = tv[0]![0]
        const b = ss.bk
        const addons = Array.isArray(b.addons) ? b.addons.filter((id: string) => this.DURING.some((a: any) => a.id === id)) : b.addons
        const vehicle = inList(this.VEH, b.vehicle) ? b.vehicle : this.VEH[0][0]
        const svc = this.WASH.some((w: any) => w.id === b.svc) ? b.svc : this.WASH[0].id
        if ((Array.isArray(b.addons) && addons.length !== b.addons.length) || vehicle !== b.vehicle || svc !== b.svc) out.bk = { ...b, addons, vehicle, svc }
        return out
      }
      const patch = fix(s)
      if (!Object.keys(patch).length) return
      // before the host is attached (the constructor) setState is a no-op: the state is set directly
      if (this.__host) this.setState((ss: any) => fix(ss))
      else this.state = { ...s, ...patch }
    }

    /** The Gold savings calculator: the Signature wash's starting price and the fee against Gold's starting price. */
    __liveHome(v: Record<string, any>): Record<string, any> {
      const l = this.__live!
      const sig = l.wash.find((w) => w.id === 'signature') ?? null
      const gold = l.tiers.gold
      const out: Record<string, any> = { ...v }
      if (sig && gold) {
        const per = sig.g + l.fee
        const n = this.state.washes
        const save = n * per - gold.price
        const k = Math.floor(gold.price / per) + 1
        Object.assign(out, {
          calcGuest: this.$(n * per),
          calcGuestSub: n + ' × ($' + sig.g + ' wash + $' + l.fee + ' fee)',
          calcSave: save > 0 ? 'Save ' + this.$(save) + '/mo' : 'Pays off at ' + k + ' washes',
          calcSaveSub: save > 0 ? 'with Gold at ' + n + ' wash' + (n > 1 ? 'es' : '') + ' a month' : k + ' guest washes cost ' + this.$(k * per),
        })
      } else Object.assign(out, { calcGuest: '', calcGuestSub: '', calcSave: '', calcSaveSub: '' })
      const w = sig ?? l.wash[0]
      if (w && typeof v.nextSub === 'string') out.nextSub = v.nextSub.replace(/Signature Hand Wash takes about 45 min$/, () => `${w.name} takes about ${w.durationMin} min`)
      return out
    }

    /** The price groups from the catalog, row for row in the design's formulas; a group it does not price keeps the interim rows. */
    __livePrice(v: Record<string, any>): Record<string, any> {
      const l = this.__live!
      const iv = this.__interimPrice(v)
      let i = 0
      const row = (name: string, sub: string, m: number, gp: number, o?: Record<string, any>) => ({
        name,
        sub,
        priced: true,
        quote: false,
        pre: '',
        g: '$' + gp,
        v: '$' + m,
        // one price for members and guests (no % off): no saving to state
        save: m < gp ? 'SAVE $' + (gp - m) : 'SAME PRICE',
        vSize: '20px',
        nameSize: '16px',
        delay: i++ * 60 + 'ms',
        ...(o || {}),
      })
      const incl = (name: string, sub: string, gp: number, o?: Record<string, any>) => row(name, sub, 0, gp, { v: 'Included', vSize: '17px', save: 'SAVE $' + gp, ...(o || {}) })
      // "from" unless one price for every size; the per-size block when more than one size has a price (priced sizes only)
      const sized = (it: LiveItem): Record<string, any> => {
        const o: Record<string, any> = { pre: it.uniform ? '' : 'from' }
        if (it.bySize.length > 1 && !it.uniform) {
          o.sizes = it.bySize.map((x) => ({ t: `${x.label} $${x.p.g}${x.p.gMax !== null && x.p.gMax > x.p.g ? '–$' + x.p.gMax : ''}${x.p.m < x.p.g ? ` · members $${x.p.m}` : ''}` }))
          if (it.bySize.length < l.sizes.length) o.sizesNote = 'Other sizes: priced at the shop'
        }
        return o
      }
      const wash = l.wash.map((w) => (w.includedIn.length ? incl(w.name, w.sub, w.g, sized(w)) : row(w.name, w.sub, w.m, w.g, sized(w)))).map((r) => ({ ...r, nameSize: '18px' }))
      const during = l.during
        ? l.during.map((a) => (a.vip ? incl(a.name, a.vip === 'incl' ? a.sub + ' · included with VIP' : a.sub + ' · ' + a.vip + ' with VIP', a.g, sized(a)) : row(a.name, a.sub, a.m, a.g, sized(a))))
        : null
      const t = l.tint
      const tint = t ? t.veh.map(([k, lab]) => row(lab, 'Carbon or ceramic film · side & rear windows', t.member.carbon![k]![0], t.guest.carbon![k]![0], { pre: 'from' })) : null
      const tintFull = t
        ? t.veh.flatMap(([k, lab]) =>
            Object.keys(DESIGN_FILMS).map((f) => {
              const r = t.member[f]![k]!
              const gr = t.guest[f]![k]!
              const sub = (r[0] < gr[0] ? 'VIP ' + this.$(r[0]) + '–' + this.$(r[1]) + ' · guest ' : '') + this.$(gr[0]) + '–' + this.$(gr[1])
              return row(lab + ' · ' + t.films[f], sub, r[0], gr[0], { pre: 'from' })
            }),
          )
        : null
      const detail = l.detail ? l.detail.map((d) => row(d.name, d.sub, d.m, d.g, sized(d))) : null
      const more = (l.more ?? DESIGN_MORE).map((nm) => ({ name: nm, sub: '', priced: false, nameSize: '15.5px' }))
      const G: Record<string, any[] | null> = { wash, during, tint, tintFull, detail, more }
      const KEY: Record<string, string> = {
        '01|Hand wash': 'wash',
        '02|Add during your wash': 'during',
        '03|Window tint': 'tint',
        '01|Window tint': 'tintFull',
        '04|Detailing': 'detail',
        '05|More services': 'more',
      }
      // "What VIP is worth a month": the design's items and labels at the catalog's prices, those VIP includes
      const vip = l.tiers.vip
      const sig = l.wash.find((w) => w.id === 'signature')
      const month: [string, number][] = []
      if (vip && sig && sig.includedIn.some((r) => r.tier === vip.key)) {
        month.push(['4 Signature washes', 4 * sig.g], ['4 booking fees', 4 * l.fee])
        const items: [string, string, number][] = [
          ['wax', 'Hand wax ×4', 4],
          ['engine', 'Engine bay wash', 1],
          ['leather', 'Leather conditioning ×2', 2],
          ['stain', 'Stain removal', 1],
        ]
        for (const [id, label, n] of items) {
          const a = l.during?.find((x) => x.id === id && x.vip)
          if (a) month.push([label, n * a.g])
        }
      }
      const total = month.reduce((a, x) => a + x[1], 0)
      const showMonth = !!vip && month.length > 0 && total > vip.price
      return {
        ...v,
        prGroups: (v.prGroups || []).map((gr: any, n: number) => {
          const k = KEY[gr.n + '|' + gr.title]
          const rows = k ? G[k] : null
          return rows ? { ...gr, rows } : (iv.prGroups[n] ?? gr)
        }),
        prShowMonth: showMonth ? v.prShowMonth : false,
        vipMonth: showMonth ? month.map(([label, x]) => ({ label, value: this.$(x) })) : [],
        vipMonthGuest: showMonth ? this.$(total) : '',
        vipMonthSave: showMonth ? 'Save ' + this.$(total - vip!.price) + '/mo' : '',
        faqs: (v.faqs || []).map((f: any) => ({ ...f, a: swapAmount(f.a, this.__design!.FEE, l.fee) })),
      }
    }

    /** The comparison's fee row, the wash cards and the tint page's price block. */
    __livePages(v: Record<string, any>): Record<string, any> {
      const l = this.__live!
      const s = this.state
      const from = this.__design!.FEE
      const cardWash = ['signature', 'exterior'] // washCards: the design's two cards, in this order
      const out: Record<string, any> = {
        ...v,
        compRows: (v.compRows || []).map((row: any) =>
          row.f === 'Booking fee' ? { ...row, cells: row.cells.map((c: any) => ('t' in c ? { ...c, t: swapAmount(c.t, from, l.fee) } : c)) } : row,
        ),
        washCards: (v.washCards || []).map((c: any, n: number) => {
          const w = l.wash.find((x) => x.id === cardWash[n])
          return w ? { ...c, name: w.name, g: (w.uniform ? '' : 'from ') + '$' + w.g } : { ...c, g: INTERIM.priced }
        }),
      }
      const t = l.tint
      const r = t?.member[s.film]?.[s.tintVeh]
      const gr = t?.guest[s.film]?.[s.tintVeh]
      if (r && gr) {
        const same = r[0] === gr[0] && r[1] === gr[1]
        Object.assign(out, {
          tintPriceLabel: same && typeof v.tintPriceLabel === 'string' ? v.tintPriceLabel.replace(/^VIP · /, '') : v.tintPriceLabel,
          tintVip: this.$(r[0]) + ' – ' + this.$(r[1]),
          tintGuest: same ? '' : this.$(gr[0]) + ' – ' + this.$(gr[1]),
          tintSave: same ? '' : 'save ' + this.$(gr[0] - r[0]) + '+',
        })
      } else {
        const iv = this.__interimPages(v)
        Object.assign(out, { tintPriceLabel: iv.tintPriceLabel, tintVip: iv.tintVip, tintGuest: '', tintSave: '' })
      }
      return out
    }

    /** The live tier of the join page's tier (null: the catalog does not sell it). */
    __liveTier(): LiveTier | null {
      const id = this.state.jn?.tier as DesignTier
      return this.__live?.tiers[id] ?? null
    }

    /** The membership size of a tier: the size picked, else the tier's starting size. */
    __joinSize(t: LiveTier): string {
      return this.__joinClass && t.prices.some((x) => x.class === this.__joinClass) ? this.__joinClass : t.fromClass
    }

    /** The join flow: the design's tiers the catalog sells, the chosen size's monthly price in the summary, terms and button. */
    __liveJoin(r: Record<string, any>): Record<string, any> {
      const l = this.__live!
      const jv = r.jv
      if (!jv || this.state.page !== 'join' || !Array.isArray(jv.tiers)) return r
      const ID: Record<string, DesignTier> = { Gold: 'gold', VIP: 'vip' }
      const tiers = jv.tiers
        .filter((c: any) => !!l.tiers[ID[c.name] as DesignTier])
        .map((c: any) => {
          const lt = l.tiers[ID[c.name] as DesignTier]!
          return tierWith({ ...c, perks: lt.perks }, (tierUniform(lt) ? '' : 'from ') + '$' + lt.price, '/mo')
        })
      const t = this.__liveTier()
      if (!t) return { ...r, jv: { ...jv, tiers } } // the page moves to a tier the catalog sells (__liveJoinSync)
      const id = this.state.jn.tier as DesignTier
      const cls = this.__joinSize(t)
      const price = tierPriceAt(t, cls) ?? t.price
      const design = DESIGN_PLANS[id].price
      const sigKey = l.wash.find((w) => w.id === 'signature')?.key
      const washes = t.inclusions.find((x) => x.serviceKey === sigKey)
      const lines = (jv.lines || []).map((x: any, n: number) =>
        n === 0 ? { ...x, value: swapAmount(x.value, design, price) } : x.label === 'Washes this month' && washes ? { ...x, value: washes.perCycle ? String(washes.perCycle) : 'Unlimited' } : x,
      )
      if (t.prices.length > 1) lines.splice(1, 0, { label: 'Priced for', value: t.prices.find((x) => x.class === cls)?.label ?? cls, col: 'var(--ink)' })
      return {
        ...r,
        jv: {
          ...jv,
          tiers,
          agreeText: swapAmount(jv.agreeText, design, price),
          lines,
          due: swapAmount(jv.due, design, price),
          ctaLabel: swapAmount(jv.ctaLabel, design, price),
        },
      }
    }

    /** The join page's size picker (site.joinSizes): only when the tier is sold at more than one size. */
    __liveJoinSizes(): Record<string, any> {
      const t = this.state.page === 'join' && this.state.jn?.step === 0 && !this.__lkJoining() ? this.__liveTier() : null
      if (!t || t.prices.length < 2) return { show: false }
      const cls = this.__joinSize(t)
      const missing = (this.__live?.sizes.length ?? 0) > t.prices.length
      return {
        show: true,
        chips: t.prices.map((x) => ({
          label: `${x.label} · $${x.price}/mo`,
          onClick: () => {
            this.__joinClass = x.class
            this.forceUpdate()
          },
          style: this.chip(x.class === cls),
        })),
        note: missing ? 'Other sizes: ask us.' : '',
      }
    }

    /** On a join page the catalog's tiers decide: a tier it does not sell moves to one it does. */
    __liveJoinSync(): void {
      const l = this.__live
      if (!liveMode || !l || this.state.page !== 'join' || !this.state.jn || this.__lkJoining()) return
      if (l.tiers[this.state.jn.tier as DesignTier]) return
      const first = (['gold', 'vip'] as DesignTier[]).find((k) => l.tiers[k])
      if (first) this.setJn({ tier: first })
    }

    /**
     * The booking sheet priced for the chosen size: a guest's price at the size ("At the shop" for a size the catalog does
     * not price), a member's inclusions (the size difference of an included wash, paid at the shop, for a verified member
     * whose plan size is known), the fee lines, what is due and the upsell.
     */
    __liveSheet(r: Record<string, any>): Record<string, any> {
      const l = this.__live!
      const sh = r.sh
      const s = this.state
      if (!sh || s.sheet !== 'book') return r
      const b = s.bk
      const isG = b.who === 'guest'
      const size = String(b.vehicle)
      const tier = !isG && s.tier ? (l.tiers[s.tier as DesignTier] ?? null) : null
      const incl = (key: string | undefined) => (key ? tier?.inclusions.find((x) => x.serviceKey === key) : undefined)
      const washItem = (id: string) => l.wash.find((w) => w.id === id) ?? null
      const addonItem = (id: string) => l.during?.find((a) => a.id === id) ?? null
      const at = (it: LiveItem | null): SizePrice | null => (it ? priceAt(it, size) : null)
      const planClass = this.__member?.member.active ? this.__member.member.planClass : null
      const SHOP = 'At the shop'
      const washOf = (w: any): { included: boolean; amount: number | null; diff: number } => {
        const it = washItem(w.id)
        const p = at(it)
        if (isG) return { included: false, amount: p ? p.g : null, diff: 0 }
        if (it && incl(it.key)) {
          const plan = planClass ? priceAt(it, planClass) : null
          return { included: true, amount: 0, diff: p && plan && p.g > plan.g ? p.g - plan.g : 0 }
        }
        return { included: false, amount: p ? p.m : null, diff: 0 }
      }
      const addonOf = (a: any): { included: boolean; amount: number | null } => {
        const it = addonItem(a.id)
        if (!isG && it && incl(it.key)) return { included: true, amount: 0 }
        const p = at(it)
        return { included: false, amount: p ? (isG ? p.g : p.m) : null }
      }
      const money = (x: number | null) => (x === null ? SHOP : '$' + x)
      const wash = this.WASH.find((w: any) => w.id === b.svc) || this.WASH[0]
      const ads = this.DURING.filter((a: any) => b.addons.includes(a.id))
      const out: Record<string, any> = { ...sh }
      if (Array.isArray(sh.washes))
        out.washes = sh.washes.map((o: any, n: number) => {
          const w = this.WASH[n]
          if (!w) return o
          const x = washOf(w)
          if (isG) return { ...o, price: money(x.amount), note: x.amount === null ? 'by vehicle size' : o.note }
          if (x.included) {
            if (x.diff > 0) return { ...o, price: 'Included', note: `+$${x.diff} size difference at the shop` }
            const n2 = incl(washItem(w.id)?.key)
            return { ...o, price: '$0', note: n2?.perCycle ? `1 of ${n2.perCycle} this month` : 'included every visit' }
          }
          return { ...o, price: money(x.amount), note: x.amount === null ? 'by vehicle size' : 'member price' }
        })
      if (Array.isArray(sh.addons))
        out.addons = sh.addons.map((o: any, n: number) => {
          const a = this.DURING[n]
          if (!a) return o
          const x = addonOf(a)
          return x.included ? { ...o, price: 'Included', priceCol: 'var(--accentText)' } : { ...o, price: x.amount === null ? SHOP : '+$' + x.amount, priceCol: 'var(--ink3)' }
        })
      const w = washOf(wash)
      if (Array.isArray(sh.lines)) {
        const lines: any[] = [
          { ...sh.lines[0], value: isG ? money(w.amount) : w.included ? 'Included' : money(w.amount), vc: isG || !w.included ? 'var(--ink)' : 'var(--accentText)' },
        ]
        if (w.diff > 0) lines.push({ label: 'Size difference · at the shop', value: '+$' + w.diff, lc: 'var(--ink2)', vc: 'var(--ink)' })
        ads.forEach((a: any, k: number) => {
          const x = addonOf(a)
          lines.push({ ...sh.lines[k + 1], value: x.included ? 'Included' : money(x.amount), vc: x.included ? 'var(--accentText)' : 'var(--ink)' })
        })
        for (const o of sh.lines.slice(1 + ads.length)) lines.push(o.label === 'Booking fee · non-refundable' ? { ...o, value: '$' + l.fee } : o)
        out.lines = lines
      }
      if (Array.isArray(sh.sumLines))
        out.sumLines = sh.sumLines.map((o: any, n: number) => {
          if (n === 1 && (b.who === 'guest' || b.who === 'member')) return isG || !w.included ? { ...o, value: money(w.amount), col: '#F2F5F7' } : o
          if (n >= 2 && n < 2 + ads.length) {
            const x = addonOf(ads[n - 2])
            return { ...o, value: x.included ? 'Included' : money(x.amount), col: x.included ? '#7FD6FF' : '#F2F5F7' }
          }
          return o.label === 'Booking fee' ? { ...o, value: '$' + l.fee } : o
        })
      if (sh.bReview) {
        const parts = [w.included ? w.diff : w.amount, ...ads.map((a: any) => addonOf(a).amount)]
        const unknown = parts.some((x) => x === null)
        const sum = parts.reduce((a: number, x) => a + (x ?? 0), 0)
        if (sh.isGuest) {
          out.due = '$' + l.fee
          if (typeof sh.dueSub === 'string')
            out.dueSub = sh.dueSub
              .replace(/^\$\d+(?![0-9])/, () => '$' + l.fee)
              .replace(/Pay \$[\d,]+ after your wash\.$/, () => (unknown ? 'Pay ' + INTERIM.payRest : 'Pay ' + this.$(sum) + ' after your wash.'))
        } else out.due = unknown ? SHOP : this.$(sum)
        if (typeof sh.upsell === 'string') {
          const vip = l.tiers.vip
          if (!vip || unknown) out.upsell = INTERIM.upsell
          else {
            const vipCost = ads.reduce((acc: number, a: any) => {
              const it = addonItem(a.id)
              if (it && vip.inclusions.some((x) => x.serviceKey === it.key)) return acc
              return acc + (at(it)?.m ?? 0)
            }, 0)
            const extras = ['wax', 'engine'].every((id) => {
              const it = addonItem(id)
              return !!it && vip.inclusions.some((x) => x.serviceKey === it.key)
            })
            out.upsell = 'You’d pay ' + this.$(sum + l.fee) + ' as a guest. As VIP: ' + this.$(vipCost) + (extras ? ', with wax and engine bay included.' : '.')
          }
        }
      }
      return { ...r, sh: out }
    }
    // ==== end of DV-CATALOG2 ================================================================================================

    // ---- the view models ------------------------------------------------------------------------------------------------
    renderVals(): Record<string, any> {
      const v = super.renderVals()
      const unknown = this.days.length > 0 && this.days.every((d: DesignDay) => d.unknown)
      v.hoursList = hoursRows(this.__hours)
      const lkName = this.__lkCalendar() ? !this.__lk!.client.firstName : null // links (W3f): a stranger's link asks the name
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
        guestDetails: !!(sh.bReview && (lkName === null ? env.booking === 'live' : lkName)),
        askPhone: !!(sh.bReview && sh.isGuest && env.booking === 'live' && lkName === null),
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
        // links (W3f): the linked blocks' view model; the booking summary column hides on the link sheet
        link: this.__lkVals(),
        sheetSummary: this.state.sheet !== 'link',
      }
      v.site.cat = this.__catalogTexts() // DV-CATALOG: the template's static price texts
      // DV-CATALOG2 (the website's join) and DV-LINK-JOIN (a membership page billed by Square): the size picker
      v.site.joinSizes = this.__lkJoining() && this.__lkSquare() ? this.__lkJoinSizesVals() : liveMode && this.__live ? this.__liveJoinSizes() : { show: false }
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
      const r = liveMode
        ? this.__live
          ? this.__liveSheet(super.sheetVals())
          : this.__interimSheet(super.sheetVals())
        : interim
          ? this.__interimSheet(super.sheetVals())
          : this.__catalogSheet(super.sheetVals())
      const s = this.state
      let sh = r.sh
      // links (W3f): the link sheet (step-up, payment, notices) and the linked booking's own lines
      if (s.sheet === 'link') return { ...r, sh: this.__lkSheet() }
      if (s.sheet === 'book' && this.__lkCalendar()) sh = r.sh = this.__lkBookSh(sh)
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
      const r = liveMode
        ? this.__live
          ? this.__liveJoin(super.joinVM())
          : this.__interimJoin(super.joinVM())
        : interim
          ? this.__interimJoin(super.joinVM())
          : withTierPer(this.__catalogJoin(super.joinVM()))
      const j = this.state.jn
      const jv = r.jv
      if (!jv || this.state.page !== 'join') return r
      if (this.__lkJoining()) return this.__lkJoinVM(r) // links (W3f)
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
      const member: Member = {
        firstName: String(m.firstName ?? ''),
        tier: m.tier === 'gold' || m.tier === 'vip' ? m.tier : null,
        washesLeft: typeof m.washesLeft === 'number' ? m.washesLeft : null,
        active: m.active === true,
        planClass: typeof m.planClass === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(m.planClass) ? m.planClass : null,
      }
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
      // DV-CATALOG2: the size chip is the visit's size (vehicleClass), no made-up vehicle; the design's own vehicle types
      // (interim, catalog) still go as the label the API maps to a size
      const sized = liveMode && !!this.__live && this.__live.sizes.some(([k]) => k === b.vehicle)
      return {
        body: {
          // only a name the visitor typed: the API stores a verified member's name as given
          name: String(b.name || '').trim(),
          phone: String(b.phone || ''),
          ...(sized ? { vehicleClass: String(b.vehicle) } : { vehicle: { label: vehL } }),
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
      if (this.__lkCalendar()) return this.__lkBook() // links (W3f)
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
      // DV-CATALOG2: the membership's size when the catalog sells the tier at more than one
      const t = liveMode ? this.__liveTier() : null
      const size = t && t.prices.length > 1 ? ` (${t.prices.find((x) => x.class === this.__joinSize(t))?.label ?? ''})` : ''
      return `JOIN ${String(j.tier).toUpperCase()}${size}: ${j.name.trim()} · ${j.phone}${j.email ? ' · ' + j.email : ''}${cars.length ? ' · ' + cars.join('; ') : ''}`
    }

    async __submitJoin(): Promise<void> {
      const j = this.state.jn
      if (env.booking !== 'live') {
        navigate(smsUrl(this.__composeJoin()))
        return
      }
      const lt = liveMode ? this.__liveTier() : null
      const body = {
        tier: j.tier,
        // DV-CATALOG2: the size the membership is priced at (the API's cheapest priced size when absent)
        ...(lt ? { planClass: this.__joinSize(lt) } : {}),
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

    // ==== links (W3f) =========================================================================================================
    // DV-LINK, DV-STEPUP, DV-LINK-JOIN, DV-LINK-PAY, DV-LINK-DEAD. A personal link's token (captured and scrubbed by
    // src/client/link.ts) is sent once, in the body of POST {links.base}/exchange, for an in-memory bearer session; the
    // page then opens: the booking sheet in linked mode (calendar, book again: "BOOKING FOR MARIA ••51", no who / phone /
    // code step, the client's own board), the step-up block (verify, PIN links), the join steps (membership: plan ->
    // verify -> e-mail -> terms -> Squarespace), the payment review (pay: review -> verify -> Squarespace) or a dead-link
    // notice. A 404 (PUBLIC_LINKS_ENABLED off) leaves the site exactly as it is without a link.

    __lkMount(): void {
      if (!env.links) return
      this.__lkOff = onLink((l) => void this.__lkOpen(l))
      const first = takeLink()
      if (first) void this.__lkOpen(first)
    }

    __lkBase(): string {
      return (env.links?.base ?? '/api/v1/public/links').replace(/\/+$/, '')
    }

    /** A calendar or book-again link is open: Book books for its client. */
    __lkCalendar(): boolean {
      const k = this.__lk?.kind
      return k === 'calendar' || k === 'book_again'
    }

    /** The membership link's join steps are showing. */
    __lkJoining(): boolean {
      return this.__lk?.kind === 'membership' && this.state.page === 'join' && this.__lkTier() !== null
    }

    /** The per-client board's auth (null: the public board). */
    __lkBoardAuth(): { base: string; auth: string } | null {
      if (!this.__lkCalendar() || this.__lkAvailOff || !this.__lk?.session) return null
      return { base: this.__lkBase(), auth: 'Bearer ' + this.__lk.session }
    }

    /** A PIN or code was entered on this page recently enough for a membership or a payment. */
    __lkFresh(): boolean {
      const t = this.__lk?.stepUpAt
      return t != null && realNow() - t < STEP_UP_FRESH_MS
    }

    __lkWho(): string {
      return this.__lk ? whoLabel(this.__lk.client) : ''
    }

    /** Opens a link: forgets any earlier one (a second link in the same tab), exchanges the token, routes by kind. */
    async __lkOpen(l: CapturedLink): Promise<void> {
      const seq = ++this.__lkSeq
      const was = this.__lk
      this.__lk = null
      this.__su = null
      this.__lkView = null
      this.__lkJoinVerify = false
      this.__lkJoinInit = false
      this.__lkIdem = null
      this.__lkAvailOff = false
      this.__lkDeposit = null
      this.__lkJoinClass = null
      this.__lkJoinWait = null
      this.__cardAgree = false
      this.__cardErr = ''
      this.__cardNote = ''
      if (was) {
        this.__booking = null
        if (this.state.sheet) this.setState({ sheet: null })
      }
      const r = await this.__lkRaw('POST', '/exchange', { token: l.token }, null)
      if (seq !== this.__lkSeq) return
      if (r.status === 404) return // personal links are switched off: the site as without a link
      if (r.status === 401) {
        this.__lkDead(deadReason(r.problem?.meta))
        return
      }
      let x: Exchanged | null = null
      if (r.ok) {
        try {
          x = validateExchange(r.body)
        } catch {
          x = null
        }
      }
      if (!x) {
        this.flash(
          r.status === 0
            ? `No connection. Open the link again, or text ${env.contact.smsKeyword} to ${env.contact.smsDisplay}.`
            : this.__lkProblemText(r, 'We couldn’t open your link. Try again in a minute.'),
        )
        return
      }
      this.__lk = { ...x, token: l.token, stepUpAt: null, codeAt: null }
      if (was?.kind === 'calendar' || was?.kind === 'book_again' || x.kind === 'calendar' || x.kind === 'book_again') void this.__refreshAvailability()
      switch (x.kind) {
        case 'calendar':
        case 'book_again':
          this.__lkOpenBook()
          return
        case 'verify':
          if (x.trust.verified) this.__lkNoticeVerified(false)
          else this.__lkStepUp('verified')
          return
        case 'pin':
          this.__lkStepUp('pinset', { purpose: x.stepUp.method === 'pin' ? 'pin_reset' : 'pin_set', mode: 'send' })
          return
        case 'membership':
          this.__lkOpenJoin()
          return
        case 'pay':
          this.__lkOpenPay()
          return
        case 'card':
          this.__lkOpenCard()
          return
      }
    }

    // ---- transport: every call but the exchange carries the session; a session that ended is exchanged again once ----
    async __lkRaw(method: 'GET' | 'POST' | 'DELETE', path: string, body: unknown, session: string | null, idem?: string): Promise<LinkAnswer> {
      try {
        const ctl = new AbortController()
        const t = setTimeout(() => ctl.abort(), env.timeouts.api)
        const res = await fetch(api(this.__lkBase() + path), {
          method,
          signal: ctl.signal,
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          headers: {
            accept: 'application/json',
            ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
            ...(session ? { authorization: 'Bearer ' + session } : {}),
            ...(idem ? { 'idempotency-key': idem } : {}),
          },
          body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
        })
        clearTimeout(t)
        let data: any = null
        try {
          data = await res.json()
        } catch {
          data = null
        }
        return { ok: res.ok, status: res.status, body: res.ok ? data : null, problem: res.ok ? null : (data as LinkAnswer['problem']) }
      } catch {
        return { ok: false, status: 0, body: null, problem: null }
      }
    }

    /** One call with the session. null = handled here (the link died, no connection, busy). */
    async __lkCall(method: 'GET' | 'POST' | 'DELETE', path: string, body: unknown, idem?: string): Promise<LinkAnswer | null> {
      const lk = this.__lk
      if (!lk || this.__busy) return null
      this.__busy = true
      this.forceUpdate()
      try {
        let r = await this.__lkRaw(method, path, body, lk.session, idem)
        if (r.status === 401 && r.problem?.code === 'IDENTITY_SESSION_INVALID' && this.__lk === lk) {
          // the page timed out (15 min idle, 1 h at most): open the link again with the token still in memory
          const again = await this.__lkRaw('POST', '/exchange', { token: lk.token }, null)
          let x: Exchanged | null = null
          if (again.ok) {
            try {
              x = validateExchange(again.body)
            } catch {
              x = null
            }
          }
          if (!x) {
            this.__lkDead(again.status === 401 ? deadReason(again.problem?.meta) : 'expired')
            return null
          }
          Object.assign(lk, x)
          lk.stepUpAt = null
          r = await this.__lkRaw(method, path, body, lk.session, idem)
        }
        if (this.__lk !== lk) return null
        if (r.status === 0) {
          this.flash(`No connection. Try again, or text ${env.contact.smsKeyword} to ${env.contact.smsDisplay}.`)
          return null
        }
        const code = String(r.problem?.code ?? '')
        if (code === 'IDENTITY_LINK_INVALID' || code === 'IDENTITY_SESSION_INVALID') {
          this.__lkDead(code === 'IDENTITY_LINK_INVALID' ? deadReason(r.problem?.meta) : 'expired')
          return null
        }
        if (code === 'IDENTITY_LINK_USED') {
          this.__lkDead('used')
          return null
        }
        if (code === 'IDENTITY_SESSION_LOCKED') {
          this.__lkDead('locked')
          return null
        }
        return r
      } finally {
        this.__busy = false
        this.forceUpdate()
      }
    }

    /** The API's words for the visitor (the identity problems are written for this page), else `fallback`. */
    __lkProblemText(r: LinkAnswer, fallback = 'Something went wrong. Try again, or text us.'): string {
      const p = r.problem
      const detail = typeof p?.detail === 'string' && !/[{}]/.test(p.detail) ? p.detail : ''
      return detail || (typeof p?.title === 'string' ? p.title : '') || (r.status === 429 ? 'Too many tries. Please wait a minute.' : fallback)
    }

    // ---- DV-LINK-DEAD and the notices ----------------------------------------------------------------------------------------
    __lkNotice(n: Omit<Extract<LinkView, { v: 'notice' }>, 'v'>): void {
      this.__lkView = { v: 'notice', ...n }
      this.setState({ menu: false, sheet: 'link' })
    }

    /** The link can't be used: expired, used, replaced / turned off, unknown, or too many wrong tries on this page. */
    __lkDead(reason: LinkDeadReason | 'locked'): void {
      const c = DEAD_COPY[reason]
      this.__lk = null
      this.__su = null
      this.__lkJoinVerify = false
      this.__lkNotice({ tone: 'warn', eyebrow: 'PERSONAL LINK', title: c.title, text: c.text, sms: env.links?.newLinkText || 'Please send me a new link' })
    }

    __lkNoticeVerified(offerPin = true): void {
      const lk = this.__lk
      if (!lk) return
      const until = trustDate(lk.trust.until, env.tz)
      // the API opens a window to choose a PIN after a code (stepUp.canSetPinUntil); a stranger's link has none
      const canPin = offerPin && lk.stepUp.method !== 'pin' && !!lk.stepUp.canSetPinUntil && lk.codeAt != null && realNow() - lk.codeAt < PIN_AFTER_CODE_MS
      this.__su = null
      this.__lkNotice({
        tone: 'ok',
        eyebrow: 'VERIFIED · ' + this.__lkWho(),
        title: 'You’re verified',
        text: `${lk.client.firstName ? `Thanks, ${lk.client.firstName}. ` : ''}Your number is verified${until ? ` until ${until}` : ' for 30 days'}. Go back to your texts and we’ll take it from there.`,
        action: canPin ? { label: 'Create a PIN for next time', run: () => this.__lkStepUp('pinset', { purpose: 'pin_set', mode: 'create', optional: true }) } : null,
      })
    }

    __lkNoticePinSet(): void {
      this.__su = null
      this.__lkNotice({
        tone: 'ok',
        eyebrow: 'YOUR PIN · ' + this.__lkWho(),
        title: 'Your PIN is set',
        text: 'Use it on our links to confirm it’s you. Never share it, and never text it to us.',
      })
    }

    /** "Back to home" of a notice: close the sheet, leave a join page. */
    __lkHome(): void {
      this.setState({ sheet: null })
      if (this.state.page !== 'home') this.go('home')
    }

    // ---- DV-LINK: the booking sheet in linked mode -----------------------------------------------------------------------------
    __lkOpenBook(p?: any): void {
      const tier = this.__lk!.client.tier
      this.setState((s: any) => ({
        menu: false,
        sheet: 'book',
        step: 'svc',
        tier,
        bk: { ...s.bk, who: tier ? 'member' : 'guest', ack: false, lock: null, phoneErr: false, ...(p || {}) },
      }))
    }

    /** The design's booking steps for the link's client: the eyebrow names them, the wash step has no way back to "who". */
    __lkBookSh(sh: any): any {
      const s = this.state
      const who = 'BOOKING FOR ' + this.__lkWho()
      if (s.step === 'verify') {
        return {
          bWho: false,
          bSvc: false,
          bTime: false,
          bReview: false,
          bDone: false,
          hasCta: false,
          isGuest: false,
          canBack: true,
          back: () => {
            this.__su = null
            this.setState({ step: 'review' })
          },
          eyebrow: who,
          title: 'Confirm it’s you',
          progress: '95%',
          sumWho: sh.sumWho,
          sumWhen: sh.sumWhen,
          sumLines: sh.sumLines,
        }
      }
      const out = { ...sh }
      if (typeof out.eyebrow === 'string') out.eyebrow = out.eyebrow.replace(/^(GUEST|MEMBER) BOOKING/, who)
      if (s.step === 'svc') out.canBack = false
      return out
    }

    /** Book on a linked page: POST {base}/bookings for the session's client (verified or trusted first). */
    async __lkBook(): Promise<void> {
      const lk = this.__lk
      if (!lk) return
      const b = this.state.bk
      const member = !!lk.client.tier && b.who === 'member'
      if (!member && !b.ack) {
        this.flash('Please confirm the booking fee terms')
        return
      }
      if (this.__busy) return
      if (!this.__catalog) {
        this.__catalogReady = null
        await this.__loadCatalog()
      }
      const r0 = this.__bookingBody()
      if ('error' in r0) {
        this.flash(r0.error)
        return
      }
      if (!lk.trust.verified) {
        this.__lkStepUp('book')
        return
      }
      // after the step-up: a record the stale-record rule hid until now has its name back, only a stranger types one
      if (!lk.client.firstName && !String(b.name || '').trim()) {
        this.flash('Add your full name')
        return
      }
      const x = r0.body
      const body: Record<string, unknown> = {
        serviceKey: x.serviceKey,
        addonKeys: x.addonKeys,
        date: x.date,
        startMin: x.startMin,
        ...(x.vehicleClass ? { vehicleClass: x.vehicleClass } : { vehicle: x.vehicle }),
        ...(lk.client.firstName ? {} : { name: x.name }),
      }
      const sig = JSON.stringify(body)
      if (!this.__lkIdem || this.__lkIdem.sig !== sig) this.__lkIdem = { key: randomId(), sig }
      const r = await this.__lkCall('POST', '/bookings', body, this.__lkIdem.key)
      if (!r) return
      if (r.ok) {
        this.__lkIdem = null
        this.__booking = { bookingRef: String(r.body?.bookingRef ?? ''), confirmationBy: String(r.body?.confirmationBy ?? 'sms'), deposit: r.body?.deposit }
        // DV-LINK-PAY: a deposit the shop takes by link can be paid from here (Square's checkout)
        const dep = r.body?.deposit
        const ref = String(r.body?.bookingRef ?? '')
        this.__lkDeposit = dep && dep.how === 'link' && Number.isInteger(dep.dueCents) && dep.dueCents > 0 && /^OAS-\d{1,9}$/.test(ref) ? { bookingRef: ref, cents: dep.dueCents } : null
        this.setState({ step: 'done' })
        void this.__refreshAvailability()
        return
      }
      const code = String(r.problem?.code ?? '')
      if (code === 'IDENTITY_STEP_UP_REQUIRED' || code === 'IDENTITY_NOT_TRUSTED' || code === 'IDENTITY_NOT_VERIFIED') {
        lk.trust = { verified: false, until: null }
        lk.stepUpAt = null
        this.__lkStepUp('book')
        return
      }
      if (code.startsWith('PUBLIC_SLOT_')) {
        this.flash(r.problem?.title || 'That time is no longer available. Pick another.')
        this.setBk({ slot: null })
        this.setState({ step: 'time' })
        void this.__refreshAvailability()
        return
      }
      this.flash(this.__lkProblemText(r))
    }

    // ---- DV-STEPUP: PIN / texted code / create PIN ----------------------------------------------------------------------------
    __lkStepUp(then: StepUp['then'], o: { purpose?: StepUpPurpose; optional?: boolean; mode?: StepUp['mode'] } = {}): void {
      const lk = this.__lk
      if (!lk) return
      const purpose = o.purpose ?? 'verify'
      // a PIN outranks a texted code once set (stepUp.method 'pin'; the server refuses the code then: IDENTITY_PIN_REQUIRED)
      const mode = o.mode ?? (purpose === 'verify' && lk.stepUp.method === 'pin' ? 'pin' : 'send')
      this.__su = { mode, purpose, challengeId: null, value: '', err: '', locked: false, then, optional: !!o.optional }
      if (then === 'book') this.setState({ step: 'verify' })
      else if (then === 'join' || then === 'join-start' || then === 'join-card') {
        this.__lkJoinVerify = true
        this.forceUpdate()
        if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') window.scrollTo({ top: 0, behavior: 'smooth' })
      } else {
        this.__lkView = { v: 'stepup' }
        this.setState({ menu: false, sheet: 'link' })
      }
    }

    __suSwitch(mode: StepUp['mode'], purpose: StepUpPurpose): void {
      const su = this.__su
      if (!su) return
      Object.assign(su, { mode, purpose, challengeId: null, value: '', err: '', locked: false })
      this.forceUpdate()
    }

    /** "Text me a code": POST {base}/verify/code {purpose}; the code goes to the link's number only. */
    async __suSend(): Promise<void> {
      const su = this.__su
      if (!su) return
      const r = await this.__lkCall('POST', '/verify/code', { purpose: su.purpose })
      if (!r || this.__su !== su) return
      const lk = this.__lk!
      if (r.ok) {
        Object.assign(su, { mode: 'code', challengeId: String(r.body?.challengeId ?? ''), value: '', err: '' })
      } else {
        const code = String(r.problem?.code ?? '')
        if (code === 'IDENTITY_PIN_REQUIRED') {
          lk.stepUp.method = 'pin'
          Object.assign(su, { mode: 'pin', purpose: 'verify', value: '', err: '' })
        } else if (code === 'IDENTITY_PIN_EXISTS') {
          lk.stepUp.method = 'pin'
          Object.assign(su, { mode: 'send', purpose: 'pin_reset', err: 'You already have a PIN. We can text you a code to choose a new one.' })
        } else if (code === 'IDENTITY_PIN_NOT_SET') {
          lk.stepUp.method = 'code'
          Object.assign(su, { mode: 'send', purpose: su.then === 'pinset' ? 'pin_set' : 'verify', err: '' })
        } else su.err = this.__lkProblemText(r)
      }
      this.forceUpdate()
    }

    /** Verify / Save of the block: the code, the PIN, or the new PIN. */
    async __suSubmit(): Promise<void> {
      const su = this.__su
      if (!su || su.locked) return
      const v = su.value
      const lk = this.__lk!
      const fail = (err: string, more: Partial<StepUp> = {}) => {
        Object.assign(su, { err, ...more })
        this.forceUpdate()
      }
      if (su.mode === 'code') {
        if (!/^\d{6}$/.test(v)) return fail('Enter the 6-digit code we texted you.')
        const r = await this.__lkCall('POST', '/verify/code/confirm', { challengeId: su.challengeId, code: v })
        if (!r || this.__su !== su) return
        if (r.ok) {
          lk.codeAt = realNow()
          if (su.purpose !== 'pin_reset') this.__lkVerified(r.body)
          else this.__lkState(r.body)
          if (su.purpose === 'verify') return this.__suDone()
          // a PIN link (set or reset): the new PIN next
          Object.assign(su, { mode: 'create', value: '', err: '', optional: false })
          this.forceUpdate()
          return
        }
        const code = String(r.problem?.code ?? '')
        if (code === 'IDENTITY_PIN_REQUIRED') {
          lk.stepUp.method = 'pin'
          return fail('', { mode: 'pin', purpose: 'verify', value: '' })
        }
        if (code === 'PUBLIC_OTP_LOCKED' || code === 'PUBLIC_OTP_EXPIRED') return fail(this.__lkProblemText(r), { mode: 'send', challengeId: null, value: '' })
        return fail(this.__lkProblemText(r), { value: '' })
      }
      if (su.mode === 'pin') {
        if (!PIN_RE.test(v)) return fail('Enter your 4 to 6 digit PIN.')
        const r = await this.__lkCall('POST', '/verify/pin', { pin: v })
        if (!r || this.__su !== su) return
        if (r.ok) {
          this.__lkVerified(r.body)
          return this.__suDone()
        }
        const code = String(r.problem?.code ?? '')
        // locked for a while (or for good until a reset): the PIN field goes, the reset by code stays
        if (code === 'IDENTITY_PIN_LOCKED' || code === 'IDENTITY_PIN_DISABLED') return fail(this.__lkProblemText(r), { locked: true, value: '' })
        return fail(this.__lkProblemText(r), { value: '' })
      }
      if (su.mode === 'create') {
        if (!PIN_RE.test(v)) return fail('Choose 4 to 6 digits.')
        const reset = su.purpose === 'pin_reset'
        const r = await this.__lkCall('POST', reset ? '/pin/reset' : '/pin', { pin: v })
        if (!r || this.__su !== su) return
        if (r.ok) {
          this.__lkVerified(r.body)
          lk.stepUp.method = 'pin'
          return this.__suDone()
        }
        const code = String(r.problem?.code ?? '')
        if (code === 'IDENTITY_CODE_REQUIRED') return fail(this.__lkProblemText(r), { mode: 'send', value: '', optional: false })
        if (code === 'IDENTITY_PIN_EXISTS') {
          lk.stepUp.method = 'pin'
          return fail(this.__lkProblemText(r), { mode: su.then === 'pinset' ? 'send' : 'pin', purpose: su.then === 'pinset' ? 'pin_reset' : 'verify', value: '' })
        }
        return fail(this.__lkProblemText(r), { value: '' })
      }
    }

    /**
     * A step's answer (`{verified, ...LinkState}`): the page takes the state it carries (the trust, the PIN state, a
     * name or an invoice the stale-record rule hid until now). false when the answer has no usable state.
     */
    __lkState(body: any): boolean {
      const lk = this.__lk
      if (!lk) return false
      let x
      try {
        x = validateState(body)
      } catch {
        return false
      }
      if (x.kind !== lk.kind) return false
      Object.assign(lk, { client: x.client, trust: x.trust, stepUp: x.stepUp, invoice: x.invoice, plan: x.plan, cards: x.cards, cardSetup: x.cardSetup, expiresAt: x.expiresAt })
      return true
    }

    /** GET me: the page's state again (the saved cards after a change, a new consent wording). */
    async __lkRefresh(): Promise<void> {
      const r = await this.__lkCall('GET', '/me', undefined)
      if (r?.ok) this.__lkState(r.body)
    }

    /** The page is verified (PIN or code): the number is trusted (30 days) and a fresh step-up is on record. */
    __lkVerified(body: any): void {
      const lk = this.__lk
      if (!lk) return
      const full = this.__lkState(body)
      const until = typeof body?.trust?.until === 'string' ? body.trust.until : lk.trust.until
      lk.trust = { verified: true, until }
      // fresh from now (the page's own clock), unless the API's answer says nothing entered here counts as fresh
      lk.stepUpAt = full && !lk.stepUp.freshUntil ? null : realNow()
    }

    __suDone(): void {
      const su = this.__su
      if (!su) return
      this.__su = null
      switch (su.then) {
        case 'book':
          this.setState({ step: 'review' })
          void this.__lkBook()
          return
        case 'join':
          this.__lkJoinVerify = false
          this.setJn({ step: 2, err: '' })
          return
        case 'join-start':
          this.__lkJoinVerify = false
          this.setJn({ step: 3, err: '' })
          void this.__lkJoinStart()
          return
        case 'join-card':
          // Square's card form is on the next step: the client enters the card after the step-up (never before it)
          this.__lkJoinVerify = false
          this.setJn({ step: 3, err: '' })
          return
        case 'card':
          this.__lkOpenCard()
          return
        case 'pay':
          void this.__lkPayStart()
          return
        case 'pay-review':
          this.__lkOpenPay()
          return
        case 'verified':
          this.__lkNoticeVerified()
          return
        case 'pinset':
          this.__lkNoticePinSet()
          return
      }
    }

    __suVals(su: StepUp): Record<string, any> {
      const lk = this.__lk
      const to = lk?.client.last2 ? `••${lk.client.last2}` : 'your number'
      const common = {
        value: su.value,
        setValue: (e: any) => {
          su.value = String(e?.target?.value ?? '').replace(/\D/g, '').slice(0, 6)
          su.err = ''
          this.forceUpdate()
        },
        submit: () => void this.__suSubmit(),
        sendCode: () => void this.__suSend(),
        err: su.err,
        note: 'We only ask for your PIN or a code on this page, never by text.',
        pin: false,
        code: false,
        create: false,
        send: false,
        alt: '',
        altClick: () => {},
      }
      switch (su.mode) {
        case 'pin':
          return {
            ...common,
            title: su.locked ? 'Your PIN is locked' : 'Enter your PIN',
            sub: su.locked ? `We can text a code to ${to} so you can choose a new PIN.` : 'The 4 to 6 digit PIN you made for Oasis.',
            pin: !su.locked,
            submitLabel: 'Verify',
            alt: 'Forgot your PIN? Text me a code',
            altClick: () => this.__suSwitch('send', 'pin_reset'),
          }
        case 'send':
          return {
            ...common,
            title: su.purpose === 'pin_reset' ? 'Reset your PIN' : su.purpose === 'pin_set' ? 'Create your PIN' : 'Confirm it’s you',
            sub: `We’ll text a 6-digit code to ${to}.`,
            send: true,
            sendLabel: 'Text me a code',
            alt: su.purpose === 'pin_reset' && su.then !== 'pinset' ? 'Use my PIN instead' : '',
            altClick: () => this.__suSwitch('pin', 'verify'),
          }
        case 'code':
          return {
            ...common,
            title: 'Enter the code we texted',
            sub: `Sent to ${to} · 6 digits, 3 tries`,
            code: true,
            submitLabel: 'Verify',
            alt: 'Send a new code',
            altClick: () => void this.__suSend(),
          }
        case 'create':
          return {
            ...common,
            title: su.purpose === 'pin_reset' ? 'Choose a new PIN' : 'Create your PIN',
            sub: '4 to 6 digits. Skip easy ones like 1234 or a birth year.',
            create: true,
            submitLabel: 'Save',
            alt: su.optional ? 'Skip for now' : '',
            altClick: () => this.__lkNoticeVerified(false),
          }
      }
    }

    // ---- DV-LINK-PAY: review -> verify -> Squarespace --------------------------------------------------------------------------
    __lkOpenPay(): void {
      const lk = this.__lk!
      const inv = lk.invoice
      if (!inv) {
        // the API hides the invoice of a record the stale-record rule hides until the page is verified
        if (!lk.trust.verified) return this.__lkStepUp('pay-review')
        this.__lkNotice({
          tone: 'warn',
          eyebrow: 'PAYMENT · ' + this.__lkWho(),
          title: 'We couldn’t load your invoice',
          text: `Text us at ${env.contact.smsDisplay} and we’ll help you pay.`,
          sms: 'Hi, my payment link didn’t show my invoice. Can you help?',
          smsLabel: 'Text us',
        })
        return
      }
      if (inv.balanceCents <= 0) {
        this.__lkNotice({ tone: 'ok', eyebrow: 'PAYMENT · ' + this.__lkWho(), title: 'Nothing to pay', text: 'This invoice is paid. Thank you!' })
        return
      }
      this.__lkView = { v: 'pay' }
      this.setState({ menu: false, sheet: 'link' })
    }

    __lkPay(): void {
      if (!this.__lkFresh()) this.__lkStepUp('pay')
      else void this.__lkPayStart()
    }

    async __lkPayStart(): Promise<void> {
      const r = await this.__lkCall('POST', '/pay/start', {})
      if (!r) return
      const eyebrow = 'PAYMENT · ' + this.__lkWho()
      if (r.ok) {
        if (r.body?.status === 'link_pending') {
          this.__lkNotice({ tone: 'ok', eyebrow, title: 'We’ll text you a link', text: 'This invoice doesn’t have an online payment link yet. We’ll text you one shortly.' })
          return
        }
        const url = r.body?.redirectUrl
        if (allowedRedirect(url, env.links?.redirectHosts ?? [])) {
          this.__lkNotice({ tone: 'ok', eyebrow, title: 'Opening checkout', text: `Taking you to ${checkoutName(url) || 'a'} secure checkout to pay.` })
          navigate(String(url))
          return
        }
        this.__lkNotice({ tone: 'warn', eyebrow, title: 'We couldn’t open the payment page', text: `Text us at ${env.contact.smsDisplay} and we’ll send you a new payment link.`, sms: 'Hi, my payment link didn’t open. Can you send a new one?' })
        return
      }
      if (String(r.problem?.code ?? '') === 'IDENTITY_STEP_UP_REQUIRED') {
        this.__lk!.stepUpAt = null
        this.__lkStepUp('pay')
        return
      }
      this.flash(this.__lkProblemText(r))
    }

    // ---- DV-LINK-JOIN: plan -> verify -> e-mail -> terms -> Squarespace --------------------------------------------------------
    /** The design's tier for the link's plan (site.config.json catalog.plans maps the design's ids to plan keys). */
    __lkTier(): 'gold' | 'vip' | null {
      return this.__lk?.kind === 'membership' ? planTier(this.__lk.plan, env.catalog?.plans ?? {}) : null
    }

    __lkOpenJoin(): void {
      const tier = this.__lkTier()
      if (!tier) {
        // a plan the website does not show (or none): never guess one; joining goes by text
        const name = this.__lk?.plan?.name
        this.__lkNotice({
          tone: 'warn',
          eyebrow: 'MEMBERSHIP · ' + this.__lkWho(),
          title: 'Let’s finish this by text',
          text: `We can’t show ${name ? `the ${name} plan` : 'this plan'} on the website. Text us and we’ll help you join.`,
          sms: `Hi, I’d like to join ${name ? `the ${name} plan` : 'a membership'}.`,
          smsLabel: 'Text us',
        })
        return
      }
      this.__lkJoinInit = true
      this.__lkJoinVerify = false
      if (this.state.sheet || this.state.menu) this.setState({ sheet: null, menu: false })
      if (this.state.page === 'join') this.__lkJoinSync()
      else this.go('join', tier)
    }

    /** After the design has shown the join page (its hashchange handler resets the steps): the link's plan and name. */
    __lkJoinSync(): void {
      const tier = this.__lkTier()
      if (this.state.page !== 'join' || !tier || !this.__lk) return
      if (this.__lkJoinInit) {
        this.__lkJoinInit = false
        this.setJn({ tier, name: this.__lk.client.firstName ?? '', step: 0, err: '', agree: false })
        return
      }
      // the join page reopened through another button (Join VIP, …): still this link's plan
      if (this.state.jn?.tier !== tier) this.setJn({ tier })
    }

    __lkJoinVM(r: any): any {
      const jv = { ...r.jv }
      const j = this.state.jn
      const tier = this.__lkTier()
      const plan = this.__lk?.plan?.name || (tier === 'vip' ? 'VIP' : 'Gold')
      jv.tiers = (jv.tiers || []).map((t: any) =>
        String(t.name).toLowerCase() === tier ? t : { ...t, onClick: () => this.flash(`This link is for ${plan}. Text us to switch plans.`) },
      )
      const toPlan = () => {
        this.__lkJoinVerify = false
        this.__su = null
        this.setJn({ step: 0, err: '' })
      }
      const top = () => {
        if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') window.scrollTo({ top: 0, behavior: 'smooth' })
      }
      if (this.__lkJoinVerify) {
        return {
          ...r,
          jv: { ...jv, s0: false, s1: false, s2: false, s3: false, s4: false, eyebrow: 'STEP 2 OF 4 · CONFIRM IT’S YOU', t1: 'Confirm', t2: 'it’s you.', sub: 'Memberships always need your PIN or a code we text you.', progress: '40%', canBack: true, back: toPlan, hasCta: false, err: '' },
        }
      }
      const st = j.step
      if (this.__lkSquare()) return this.__lkSquareJoinVM(r, jv, toPlan, top)
      if (st <= 1) {
        jv.next = () => {
          if (this.__lkFresh()) {
            this.setJn({ step: 2, err: '' })
            top()
          } else this.__lkStepUp('join')
        }
      } else if (st === 2) {
        Object.assign(jv, { s2: false, eyebrow: 'STEP 3 OF 4 · EMAIL', t1: 'Your', t2: 'email.', sub: 'Use the email you’ll pay with on Squarespace. Your receipts go there.', progress: '60%', canBack: true, back: toPlan })
        jv.next = () => {
          if (!EMAIL.test(String(j.email || '').trim())) {
            this.setJn({ err: 'Add your email for the receipts.' })
            return
          }
          this.setJn({ step: 3, err: '' })
          top()
        }
      } else if (st === 3) {
        Object.assign(jv, { sub: 'You’ll finish on Squarespace’s secure checkout. Your membership starts once it’s paid.', progress: '80%', ctaLabel: 'Continue to checkout', back: () => this.setJn({ step: 2, err: '' }) })
        jv.next = () => {
          if (!j.agree) {
            this.setJn({ err: 'Please accept the membership terms.' })
            return
          }
          void this.__lkJoinStart()
        }
      }
      return { ...r, jv }
    }

    async __lkJoinStart(): Promise<void> {
      if (!this.__lkFresh()) {
        this.__lkStepUp('join-start')
        return
      }
      const email = String(this.state.jn.email || '').trim()
      const r = await this.__lkCall('POST', '/membership/start', { email })
      if (!r) return
      if (r.ok) {
        const url = r.body?.redirectUrl
        if (allowedRedirect(url, env.links?.redirectHosts ?? [])) {
          this.flash(`Opening ${checkoutName(url) || 'the'} secure checkout…`)
          navigate(String(url))
          return
        }
        this.setJn({ err: `We couldn’t open the checkout. Text us at ${env.contact.smsDisplay} and we’ll help you finish.` })
        return
      }
      const code = String(r.problem?.code ?? '')
      if (code === 'IDENTITY_STEP_UP_REQUIRED') {
        this.__lk!.stepUpAt = null
        this.__lkStepUp('join-start')
        return
      }
      const field = r.problem?.errors?.find((e) => /email/.test(String(e.path ?? '')))
      if (r.status === 422 && field) {
        this.setJn({ step: 2, err: String(field.message || r.problem?.detail || r.problem?.title) })
        return
      }
      this.setJn({ err: this.__lkProblemText(r) })
    }

    // ---- the view models of the linked blocks (site.link; the design's own keys stay the design's) --------------------------
    /** The sheet's linked views (state.sheet 'link'): the header lines and the CTA; the blocks read site.link. */
    __lkSheet(): Record<string, any> {
      const base = { bWho: false, bSvc: false, bTime: false, bReview: false, bDone: false, hasCta: false, canBack: false, isGuest: false }
      const v = this.__lkView
      const lk = this.__lk
      if (!v) return { ...base, eyebrow: '', title: '', progress: '20%' }
      if (v.v === 'notice') return { ...base, eyebrow: v.eyebrow, title: v.title, progress: '100%' }
      if (v.v === 'card') {
        const form = !!lk?.cardSetup?.square
        return {
          ...base,
          eyebrow: 'SAVED CARDS · ' + this.__lkWho(),
          title: 'Your cards',
          progress: '60%',
          hasCta: form,
          ctaLabel: this.__busy ? 'Saving…' : 'Save card',
          ctaStyle: CTA_STYLE,
          cta: () => void this.__cardSave(),
        }
      }
      if (v.v === 'stepup') {
        const kind = lk?.kind
        const who = this.__lkWho()
        const eyebrow = kind === 'pay' ? 'PAYMENT FOR ' + who : kind === 'pin' ? 'YOUR PIN · ' + who : 'VERIFY · ' + who
        const back = kind === 'pay' && lk?.invoice ? () => this.__lkOpenPay() : undefined
        return { ...base, canBack: !!back, back, eyebrow, title: this.__su?.mode === 'create' ? 'Your PIN' : 'Confirm it’s you', progress: '60%' }
      }
      const inv = lk?.invoice
      const due = money(inv?.balanceCents ?? 0)
      return {
        ...base,
        eyebrow: 'PAYMENT FOR ' + this.__lkWho(),
        title: 'Review & pay',
        progress: '40%',
        hasCta: true,
        ctaLabel: (this.__lkFresh() ? 'Pay ' : 'Verify & pay ') + due,
        ctaStyle: CTA_STYLE,
        cta: () => this.__lkPay(),
      }
    }

    __lkVals(): Record<string, any> {
      const s = this.state
      const lk = this.__lk
      const su = this.__su
      const view = this.__lkView
      const linkSheet = s.sheet === 'link'
      const notice = linkSheet && view?.v === 'notice' ? view : null
      const inv = lk?.invoice
      const joining = this.__lkJoining()
      return {
        on: !!lk,
        sheetStepUp: !!su && ((linkSheet && view?.v === 'stepup') || (s.sheet === 'book' && s.step === 'verify' && this.__lkCalendar())),
        joinStepUp: !!su && joining && this.__lkJoinVerify,
        su: su ? this.__suVals(su) : {},
        notice: notice
          ? {
              show: true,
              ok: notice.tone === 'ok',
              text: notice.text,
              action: notice.action?.label ?? '',
              actionClick: () => notice.action?.run(),
              smsHref: notice.sms ? smsUrl(notice.sms) : '',
              smsLabel: notice.smsLabel || 'Text us for a new link',
              home: () => this.__lkHome(),
            }
          : { show: false },
        pay:
          linkSheet && view?.v === 'pay' && inv
            ? {
                show: true,
                title: inv.number != null ? `Invoice #${inv.number}` : 'Your invoice',
                sub: shopDate(inv.date) || `${env.contact.addressShort}`,
                lines: [
                  ...inv.items.map((l) => ({ label: l.name, value: money(l.priceCents) })),
                  ...(inv.taxCents > 0 ? [{ label: 'Tax', value: money(inv.taxCents) }] : []),
                  ...(inv.tipCents > 0 ? [{ label: 'Tip', value: money(inv.tipCents) }] : []),
                ].map((l) => ({ ...l, lc: 'var(--ink2)', vc: 'var(--ink)' })),
                dueLabel: 'Balance due',
                due: money(inv.balanceCents),
                dueSub: inv.paidCents > 0 ? `${money(inv.paidCents)} already paid. You’ll pay the rest on a secure checkout page.` : 'You’ll pay on a secure checkout page.',
              }
            : { show: false },
        joinEmail: joining && !this.__lkJoinVerify && s.jn?.step === 2,
        // DV-LINK-CARD: the card page and the membership page's card step (Square)
        card: linkSheet && view?.v === 'card' && lk ? this.__cardVals() : { show: false },
        joinCard: joining && !this.__lkJoinVerify && s.jn?.step === 3 && this.__lkSquare() ? this.__joinCardVals() : { show: false },
        // DV-LINK-PAY: the deposit of the visit just booked, payable on Square's checkout
        deposit:
          s.sheet === 'book' && s.step === 'done' && this.__lkDeposit
            ? { show: true, label: `Pay the ${money(this.__lkDeposit.cents)} deposit now`, pay: () => void this.__lkPayDeposit() }
            : { show: false },
        joinAs: lk ? whoLabel(lk.client) : '',
        whoText: lk ? whoText(lk.client) : '',
      }
    }
    // ---- DV-LINK-CARD and DV-LINK-JOIN with Square: the card form (src/client/square.ts) --------------------------------------
    // Square's Web Payments SDK is loaded the first time a card form shows (never in the build, never on another page), its
    // card form is attached to the block's own element after the render that shows it, and destroyed when it goes. The
    // consent box starts unchecked and carries the API's wording (cardSetup.consent) with the purposes the page asks for.
    /** the visit just booked on a calendar link whose deposit can be paid by link (Square's checkout) */
    __lkDeposit: { bookingRef: string; cents: number } | null = null
    /** the membership page's size (Square billing; null: the first size open online) */
    __lkJoinClass: string | null = null
    /** the membership page waits for Square's first payment (the enrollment's reference) */
    __lkJoinWait: { ref: string; failed: boolean } | null = null
    /** how often the membership page asks whether Square took the first payment (tests set it lower) */
    __pollMs = 2000
    /** the consent box (unchecked until the client ticks it), the card block's error and its last note */
    __cardAgree = false
    __cardErr = ''
    __cardNote = ''
    /** Square's card form on the page: the element it is attached to, the form once attached, a load error */
    __sq: { id: string; el: HTMLElement; form: CardForm | null; err: string; seq: number } | null = null
    __sqSeq = 0

    /** The membership page joins with a card here (the API's plan.billing square), not on Squarespace's checkout. */
    __lkSquare(): boolean {
      return this.__lk?.kind === 'membership' && this.__lk.plan?.billing === 'square'
    }

    /** Where Square's card form belongs now: the card page's block, the membership page's card step, or nowhere. */
    __sqWant(): string | null {
      const lk = this.__lk
      if (!lk?.cardSetup?.square) return null
      if (this.state.sheet === 'link' && this.__lkView?.v === 'card') return CARD_FORM_ID
      if (this.__lkJoining() && !this.__lkJoinVerify && this.state.jn?.step === 3 && this.__lkSquare() && !this.__lkJoinWait) return JOIN_CARD_ID
      return null
    }

    /** After each update: attach the card form where it belongs (lazily loading the SDK), drop it where it went. */
    __sqSync(): void {
      if (typeof document === 'undefined') return
      const want = this.__sqWant()
      const cur = this.__sq
      const el = want ? document.getElementById(want) : null
      if (cur && (cur.id !== want || cur.el !== el || !cur.el.isConnected)) void this.__sqDrop()
      if (!want || !el || this.__sq) return
      const setup = this.__lk!.cardSetup!.square!
      const seq = ++this.__sqSeq
      const sq = { id: want, el, form: null as CardForm | null, err: '', seq }
      this.__sq = sq
      const origin = typeof location !== 'undefined' ? location.origin : ''
      if (!sdkUrlAllowed(setup.sdkUrl, env.links?.squareSdkHosts ?? [], origin)) {
        sq.err = CARD_WORDS.blocked
        this.forceUpdate()
        return
      }
      void (async () => {
        try {
          const sdk = await loadSquareSdk(setup.sdkUrl)
          if (this.__sq !== sq) return
          const form = await mountCard(sdk, setup, el)
          if (this.__sq !== sq) {
            await form.destroy()
            return
          }
          sq.form = form
        } catch (e) {
          if (this.__sq === sq) sq.err = e instanceof CardFormError ? e.message : CARD_WORDS.load
        }
        this.forceUpdate()
      })()
    }

    /** Destroys the card form (a new one is attached the next time a form shows). */
    async __sqDrop(): Promise<void> {
      const cur = this.__sq
      this.__sq = null
      if (cur?.form) await cur.form.destroy()
    }

    /** What Square gets as the billing contact: the name the page knows (nothing else is sent). */
    __billingContact(): { givenName?: string } {
      const n = this.__lk?.client.firstName
      return n ? { givenName: n } : {}
    }

    /** The card page's purposes: the shop's fees and a balance, and membership billing for a member. */
    __cardPurposes(): CardPurpose[] {
      const lk = this.__lk
      const set = lk?.cardSetup
      if (!lk || !set) return []
      const want: CardPurpose[] = lk.kind === 'membership' ? ['membership_billing'] : [...(lk.client.tier ? (['membership_billing'] as CardPurpose[]) : []), 'no_show_fee', 'late_cancel_fee', 'balance']
      return set.consent.purposes.map((p) => p.key).filter((k) => want.includes(k))
    }

    /** The card page (#/k): a fresh PIN or code first (saving and removing a card need one), then the cards and the form. */
    __lkOpenCard(): void {
      if (!this.__lkFresh()) {
        this.__lkStepUp('card')
        return
      }
      this.__cardErr = ''
      this.__lkView = { v: 'card' }
      this.setState({ menu: false, sheet: 'link' })
    }

    /** Tokenizes the card in Square's form; null (and the block's error) when it cannot. */
    async __cardToken(): Promise<{ sourceId: string; verificationToken?: string } | null> {
      const form = this.__sq?.form
      if (!form) {
        this.__cardErr = this.__sq?.err || 'The card form is still loading. Try again in a moment.'
        this.forceUpdate()
        return null
      }
      try {
        return await form.tokenize(this.__billingContact())
      } catch (e) {
        this.__cardErr = e instanceof CardFormError ? e.message : CARD_WORDS.input
        this.forceUpdate()
        return null
      }
    }

    /** Save card: the consent ticked, a fresh step-up, Square's one-time token, then POST /cards (Idempotency-Key). */
    async __cardSave(): Promise<void> {
      const lk = this.__lk
      const set = lk?.cardSetup
      if (!lk || !set || this.__busy) return
      if (!this.__cardAgree) {
        this.__cardErr = 'Tick the box to agree, then save the card.'
        this.forceUpdate()
        return
      }
      if (!this.__lkFresh()) {
        this.__lkStepUp('card')
        return
      }
      this.__cardErr = ''
      this.__cardNote = ''
      const tok = await this.__cardToken()
      if (!tok) return
      const body = { sourceId: tok.sourceId, ...(tok.verificationToken ? { verificationToken: tok.verificationToken } : {}), consentVersion: set.consent.version, purposes: this.__cardPurposes() }
      const r = await this.__lkCall('POST', '/cards', body, randomId())
      if (!r) return
      if (r.ok) {
        this.__cardAgree = false
        const c = r.body?.card
        this.__cardNote = `${cardLabel({ brand: typeof c?.brand === 'string' ? c.brand : null, last4: typeof c?.last4 === 'string' ? c.last4 : null })} is saved. You can remove it here any time.`
        await this.__sqDrop() // a clean form for another card
        await this.__lkRefresh()
        this.forceUpdate()
        return
      }
      this.__cardProblem(r, 'card')
    }

    /** Remove: DELETE /cards/:id (a fresh step-up), then the list again. */
    async __cardRemove(id: string): Promise<void> {
      if (!this.__lkFresh()) {
        this.__lkStepUp('card')
        return
      }
      this.__cardErr = ''
      this.__cardNote = ''
      const r = await this.__lkCall('DELETE', '/cards/' + encodeURIComponent(id), undefined)
      if (!r) return
      if (r.ok) {
        this.__cardNote = 'The card is removed.'
        await this.__lkRefresh()
        this.forceUpdate()
        return
      }
      this.__cardProblem(r, 'card')
    }

    /** A refused card action in the client's words; a stale step-up asks again, a new consent wording is loaded. */
    __cardProblem(r: LinkAnswer, then: 'card' | 'join-card'): void {
      const code = String(r.problem?.code ?? '')
      if (code === 'IDENTITY_STEP_UP_REQUIRED') {
        this.__lk!.stepUpAt = null
        this.__lkStepUp(then)
        return
      }
      if (code === 'CARD_CONSENT_OUTDATED') {
        this.__cardAgree = false
        void this.__lkRefresh()
      }
      this.__cardErr =
        r.status === 503 ? 'Square didn’t answer. Try again in a minute.' : code === 'SQUARE_WRITES_OFF' ? 'Saving a card isn’t open right now. Text us and we’ll help.' : this.__lkProblemText(r)
      this.forceUpdate()
    }

    __cardVals(): Record<string, any> {
      const lk = this.__lk!
      const set = lk.cardSetup
      const words = (p: CardPurpose) => set?.consent.purposes.find((x) => x.key === p)?.words ?? p.replace(/_/g, ' ')
      const cards = (lk.cards ?? []).map((c) => ({
        label: cardLabel(c),
        sub: [
          c.expMonth && c.expYear ? `Expires ${String(c.expMonth).padStart(2, '0')}/${String(c.expYear).slice(-2)}` : '',
          c.purposes.length ? 'For ' + listWords(c.purposes.map(words)) : '',
        ]
          .filter(Boolean)
          .join(' · '),
        remove: () => void this.__cardRemove(c.id),
      }))
      const form = !!set?.square
      return {
        show: true,
        cards,
        empty: cards.length ? '' : 'No saved cards yet.',
        note: this.__cardNote,
        form,
        formSub: 'Square keeps your card details. Oasis never sees the card number.',
        consent: set ? consentText(set, this.__cardPurposes()) : '',
        agree: this.__cardAgree,
        box: checkBox(this.__cardAgree),
        toggle: () => {
          this.__cardAgree = !this.__cardAgree
          this.__cardErr = ''
          this.forceUpdate()
        },
        err: this.__cardErr || this.__sq?.err || '',
        closed: form ? '' : `Saving a card online isn’t open yet. Text us at ${env.contact.smsDisplay} and we’ll help.`,
      }
    }

    // ---- DV-LINK-JOIN billed by Square: plan and size -> verify -> e-mail -> card + consent -> subscribe -> wait --------------
    /** The membership page's price rows open online (joinable) and the one chosen. */
    __lkJoinPrice(): { class: string; label: string; monthlyCents: number } | null {
      const prices = this.__lk?.plan?.prices.filter((p) => p.joinable) ?? []
      return prices.find((p) => p.class === this.__lkJoinClass) ?? prices[0] ?? null
    }

    /** The size picker of a membership page billed by Square (site.joinSizes): every size the tier is sold at. */
    __lkJoinSizesVals(): Record<string, any> {
      const plan = this.__lk?.plan
      if (!plan || this.state.jn?.step !== 0 || this.__lkJoinVerify || plan.prices.length < 2) return { show: false }
      const cur = this.__lkJoinPrice()
      return {
        show: true,
        chips: plan.prices.map((p) => ({
          label: p.joinable ? `${p.label} · ${money(p.monthlyCents)}/mo` : `${p.label} · ask us`,
          onClick: () => {
            if (!p.joinable) {
              this.flash(`${p.label} isn’t open online yet. Text us and we’ll help you join.`)
              return
            }
            this.__lkJoinClass = p.class
            this.forceUpdate()
          },
          style: this.chip(!!cur && p.class === cur.class),
        })),
        note: '',
      }
    }

    __joinCardVals(): Record<string, any> {
      const lk = this.__lk!
      const set = lk.cardSetup
      const price = this.__lkJoinPrice()
      const waiting = this.__lkJoinWait && !this.__lkJoinWait.failed
      return {
        show: true,
        form: !!set?.square && !waiting,
        sub: price ? `Saved with Square for your membership’s monthly payment of ${money(price.monthlyCents)}.` : 'Saved with Square for your membership’s monthly payment.',
        consent: set ? consentText(set, ['membership_billing']) : '',
        agree: this.__cardAgree,
        box: checkBox(this.__cardAgree),
        toggle: () => {
          this.__cardAgree = !this.__cardAgree
          this.__cardErr = ''
          this.forceUpdate()
        },
        err: this.__cardErr || this.__sq?.err || '',
        wait: waiting ? 'Setting up your membership with Square. This takes a few seconds…' : '',
        closed: set?.square ? '' : `Joining with a card online isn’t open yet. Text us at ${env.contact.smsDisplay} and we’ll help.`,
      }
    }

    /** The join steps when Square bills the membership: the chosen size's price everywhere, the card step, the wait. */
    __lkSquareJoinVM(r: any, jv: any, toPlan: () => void, top: () => void): any {
      const j = this.state.jn
      const st = j.step
      const lk = this.__lk!
      const price = this.__lkJoinPrice()
      const amount = price ? money(price.monthlyCents) : ''
      const name = lk.plan?.name || 'your plan'
      if (price) {
        jv.tiers = (jv.tiers || []).map((t: any) => (String(t.name).toLowerCase() === this.__lkTier() ? tierWith(t, amount, '/mo') : t))
        jv.lines = (jv.lines || []).map((l: any, n: number) => (n === 0 ? { ...l, value: amount + '/mo' } : l))
        if ((lk.plan?.prices.length ?? 0) > 1) jv.lines.splice(1, 0, { label: 'Priced for', value: price.label, col: 'var(--ink)' })
        jv.due = amount
        jv.agreeText = `I agree to be billed ${amount} a month for ${name} until I cancel. Unused washes don’t roll over.`
      }
      if (st <= 1) {
        jv.next = () => {
          if (!price) {
            this.setJn({ err: 'Joining online isn’t open for this plan yet. Text us and we’ll help you join.' })
            return
          }
          if (this.__lkFresh()) {
            this.setJn({ step: 2, err: '' })
            top()
          } else this.__lkStepUp('join')
        }
      } else if (st === 2) {
        Object.assign(jv, { s2: false, eyebrow: 'STEP 3 OF 4 · EMAIL', t1: 'Your', t2: 'email.', sub: 'Square emails your receipts there every month. Use an email you check.', progress: '60%', canBack: true, back: toPlan })
        jv.next = () => {
          if (!EMAIL.test(String(j.email || '').trim())) {
            this.setJn({ err: 'Add your email for the receipts.' })
            return
          }
          // the card goes in after a fresh PIN or code: the form is never shown to a page that may not use it
          if (!this.__lkFresh()) {
            this.__lkStepUp('join-card')
            return
          }
          this.setJn({ step: 3, err: '' })
          top()
        }
      } else if (st === 3) {
        const waiting = !!this.__lkJoinWait && !this.__lkJoinWait.failed
        Object.assign(jv, {
          eyebrow: 'STEP 4 OF 4 · CARD',
          sub: `Your card is saved with Square and charged ${amount || 'the monthly price'} now, then every month. Your membership starts once the first payment goes through.`,
          progress: '80%',
          ctaLabel: waiting ? 'Waiting for Square…' : `Join · ${amount}/mo`,
          back: () => this.setJn({ step: 2, err: '' }),
        })
        jv.next = () => {
          if (waiting) return
          if (!j.agree) {
            this.setJn({ err: 'Please accept the membership terms.' })
            return
          }
          void this.__lkJoinSubscribe()
        }
      } else if (st === 4) {
        Object.assign(jv, { sub: `Your ${name} membership is active. Square emails your receipts every month.` })
      }
      return { ...r, jv }
    }

    /** POST membership/subscribe with the card's one-time token, then wait for Square's first payment. */
    async __lkJoinSubscribe(): Promise<void> {
      const lk = this.__lk
      const set = lk?.cardSetup
      const price = this.__lkJoinPrice()
      if (!lk || !set || !price || this.__busy) return
      if (!this.__cardAgree) {
        this.__cardErr = 'Tick the box to agree to the card being saved, then join.'
        this.forceUpdate()
        return
      }
      if (!this.__lkFresh()) {
        this.__lkStepUp('join-card')
        return
      }
      this.__cardErr = ''
      const tok = await this.__cardToken()
      if (!tok) return
      const body = {
        email: String(this.state.jn.email || '').trim(),
        planClass: price.class,
        sourceId: tok.sourceId,
        ...(tok.verificationToken ? { verificationToken: tok.verificationToken } : {}),
        consentVersion: set.consent.version,
      }
      const r = await this.__lkCall('POST', '/membership/subscribe', body, randomId())
      if (!r) return
      if (r.ok) {
        this.__lkJoinWait = { ref: String(r.body?.membershipRef ?? ''), failed: false }
        await this.__sqDrop()
        this.forceUpdate()
        void this.__lkJoinPoll(lk)
        return
      }
      const code = String(r.problem?.code ?? '')
      const field = r.problem?.errors?.find((e) => /email/.test(String(e.path ?? '')))
      if (r.status === 422 && field) {
        this.setJn({ step: 2, err: String(field.message || r.problem?.detail || r.problem?.title) })
        return
      }
      if (code === 'TIER_CLASS_UNPRICED' || code === 'LINK_CHECKOUT_UNAVAILABLE') {
        this.setJn({ step: 0, err: `${price.label} isn’t open online right now. Pick another size, or text us and we’ll help you join.` })
        return
      }
      this.__cardProblem(r, 'join-card')
    }

    /** Asks GET membership/status until Square took the first payment (active), refused it (failed), or the wait ran out. */
    async __lkJoinPoll(lk: NonNullable<SiteComponent['__lk']>): Promise<void> {
      const until = realNow() + MEMBERSHIP_WAIT_MS
      while (this.__lk === lk && this.__lkJoinWait && !this.__lkJoinWait.failed) {
        if (realNow() > until) {
          this.__lkJoinWait = null
          this.__lkNotice({
            tone: 'ok',
            eyebrow: 'MEMBERSHIP · ' + this.__lkWho(),
            title: 'Almost there',
            text: 'Square is still taking your first payment. We’ll text you as soon as your membership is active.',
          })
          return
        }
        await new Promise((res) => setTimeout(res, this.__pollMs))
        if (this.__lk !== lk) return
        const r = await this.__lkCall('GET', '/membership/status', undefined)
        if (!r) {
          if (this.__lk !== lk) return
          continue
        }
        const status = r.ok ? String(r.body?.status ?? '') : ''
        if (status === 'active') {
          this.__lkJoinWait = null
          this.__cardAgree = false
          this.setJn({ step: 4, err: '' })
          if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') window.scrollTo({ top: 0, behavior: 'smooth' })
          return
        }
        if (status === 'failed') {
          this.__lkJoinWait = null
          this.__cardAgree = false
          this.__cardErr = 'Square couldn’t take the first payment. Check the card or use another one, then try again.'
          this.forceUpdate()
          return
        }
      }
    }

    // ---- DV-LINK-PAY: the booking deposit on Square's checkout, and the way back from it ----------------------------------------
    async __lkPayDeposit(): Promise<void> {
      const dep = this.__lkDeposit
      if (!dep) return
      const r = await this.__lkCall('POST', '/deposit/start', { bookingRef: dep.bookingRef })
      if (!r) return
      if (!r.ok) {
        this.flash(this.__lkProblemText(r))
        return
      }
      const status = String(r.body?.status ?? '')
      const url = r.body?.redirectUrl
      if (status === 'redirect' && allowedRedirect(url, env.links?.redirectHosts ?? [])) {
        this.flash(`Opening ${checkoutName(url) || 'the'} secure checkout…`)
        navigate(String(url))
        return
      }
      if (status === 'paid') {
        this.__lkDeposit = null
        this.flash('Your deposit is paid. Thank you!')
        return
      }
      if (status === 'link_pending') {
        this.flash('We’ll text you a payment link shortly.')
        return
      }
      this.__lkDeposit = null
      this.flash(status === 'none' ? 'There’s no deposit to pay online for this visit. Pay at the counter.' : `We couldn’t open the payment page. Text us at ${env.contact.smsDisplay}.`)
    }

    /** #/paid: Square's checkout sends the client back here after paying (the payment link's redirect_url). */
    __paidMount(): void {
      if (typeof location === 'undefined' || !/^#\/?paid(?:$|[?&/])/.test(location.hash)) return
      try {
        history.replaceState(history.state, '', location.pathname + location.search)
      } catch {
        /* the notice shows anyway */
      }
      this.__lkNotice({ tone: 'ok', eyebrow: 'PAYMENT', title: 'Thank you', text: 'Square is confirming your payment now. Your receipt comes by email or text.' })
    }

    // ==== end links (W3f) =====================================================================================================

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
