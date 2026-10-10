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
import type { PublicHours } from '../hours/format'
import { validatePublicHours } from '../hours/format'
import { daysFromAvailability, daysFromHours, validateAvailability, type Availability, type DesignDay } from './availability'
import type { SiteEnv } from './env'
import { decideTheme, LIGHT_QUERY, readStoredTheme, storeTheme, type ThemeConfig } from '../client/theme'
import { designTime, hoursRows, hoursTable, withToday, type HoursTable } from './hours'

type AnyLogic = new (props?: any) => any

interface Member {
  firstName: string
  tier: 'gold' | 'vip' | null
  washesLeft: number
}

interface Problem {
  status: number
  title: string
  detail?: string
  code?: string
}

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
    __idem: string | null = null
    __member: { token: string; member: Member } | null = null
    __otp: { challengeId: string; phone: string } | null = null
    __booking: { bookingRef: string; confirmationBy: string; deposit?: { dueCents: number; how: string } } | null = null
    __memberRef: string | null = null
    __busy = false
    __catalog: { services: { key: string; name: string; kind?: string; durationMin?: number }[]; addons: { key: string; name: string }[] } | null = null
    __catalogReady: Promise<void> | null = null
    __schemeMq: MediaQueryList | null = null
    __onScheme: ((e: { matches: boolean }) => void) | null = null

    constructor(props?: any) {
      super(props)
      this.HOURS = this.__table()
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
      void this.__refreshHours()
      void this.__refreshAvailability()
    }

    componentWillUnmount(): void {
      const mq = this.__schemeMq as any
      if (mq && this.__onScheme) {
        if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', this.__onScheme)
        else if (typeof mq.removeListener === 'function') mq.removeListener(this.__onScheme)
      }
      super.componentWillUnmount()
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
        const live = this.__avail?.now
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
     * The design's service and add-on ids -> the backend's catalog keys. Configured keys (site.config.json) win; when the
     * live catalog (GET /api/v1/public/catalog, fetched once in live mode) does not carry a configured key, the service
     * is matched by name (the design's "Signature Hand Wash" -> the catalog's closest package), else the first package;
     * an add-on without a match is left out of the booking rather than refused.
     */
    __serviceKey(): string {
      const svc = this.state.bk?.svc || 'signature'
      const cfg = env.catalog.services[svc]
      const wanted = cfg?.key ?? svc
      const cat = this.__catalog
      if (!cat) return wanted
      if (cat.services.some((s) => s.key === wanted)) return wanted
      const name = (cfg?.name || svc).toLowerCase()
      const words: string[] = name.split(/[^a-z]+/).filter((w: string) => w.length > 3)
      const scored = cat.services
        .filter((s) => !s.kind || s.kind === 'package')
        .map((s) => ({ s, score: words.filter((w: string) => s.name.toLowerCase().includes(w)).length }))
        .sort((a, b) => b.score - a.score)
      return (scored[0]?.score ? scored[0].s.key : cat.services[0]?.key) ?? wanted
    }

    __addonKeys(): string[] {
      const cat = this.__catalog
      return (this.state.bk?.addons || []).flatMap((id: string) => {
        const wanted = env.catalog.addons[id] ?? id
        if (!cat) return [wanted]
        if (cat.addons.some((a) => a.key === wanted)) return [wanted]
        const name = (this.DURING.find((a: any) => a.id === id)?.name || id).toLowerCase()
        const words: string[] = name.split(/[^a-z]+/).filter((w: string) => w.length > 3)
        const hit = cat.addons.find((a) => words.some((w: string) => a.name.toLowerCase().includes(w)))
        return hit ? [hit.key] : []
      })
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
      } catch {
        /* the configured keys stay */
      }
    }

    // in every booking mode (the launch default sms included): the board shows real times as soon as the API answers,
    // queried with a catalog key the API knows (the catalog is loaded first)
    async __refreshAvailability(): Promise<void> {
      await this.__loadCatalog()
      const q = `?days=${fetchDays}&service=${encodeURIComponent(this.__serviceKey())}&addons=${encodeURIComponent(this.__addonKeys().join(','))}`
      if (this.__availFor === q + '|pending') return
      const key = q
      this.__availFor = q + '|pending'
      try {
        const ctl = new AbortController()
        const t = setTimeout(() => ctl.abort(), env.timeouts.availability)
        const res = await fetch(api(env.endpoints.availability + q), { signal: ctl.signal, credentials: 'omit', headers: { accept: 'application/json' } })
        clearTimeout(t)
        if (!res.ok) {
          this.__availFor = ''
          return
        }
        this.__avail = validateAvailability(await res.json())
        this.__availFor = key
        this.forceUpdate()
      } catch {
        this.__availFor = ''
      }
    }

    openBook(p?: any): void {
      super.openBook(p)
      if (!this.__idem) this.__idem = randomId()
      void this.__refreshAvailability()
    }

    setBk(p: any): void {
      super.setBk(p)
      if (p && ('svc' in p || 'addons' in p)) void this.__refreshAvailability()
    }

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
        guestDetails: !!(sh.bReview && sh.isGuest && env.booking === 'live'),
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
      const r = super.sheetVals()
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
            this.__idem = null
            orig.cta()
          },
        }
      }
      r.sh = sh
      r.memberContinue = () => void this.__memberContinue()
      return r
    }

    joinVM(): Record<string, any> {
      const r = super.joinVM()
      const j = this.state.jn
      const jv = r.jv
      if (!jv || this.state.page !== 'join') return r
      const st = j.step
      const digits = (x: string) => x.replace(/\D/g, '')
      const validate = (): string => {
        if (st === 1 && !j.vehicles.some((v: any) => v.car.trim())) return 'Add at least one vehicle.'
        if (st === 2 && (!j.name.trim() || digits(j.phone).length < 10)) return 'Add your name and a 10-digit mobile number.'
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
        jv.bookFirst = () => {
          this.setState({ tier: j.tier })
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
      const member = r.member as Member
      this.__member = { token: String(r.memberToken), member }
      this.setState((ss: any) => ({
        tier: member.tier || 'gold',
        step: ss.bk.slot != null ? 'review' : 'svc',
        bk: { ...ss.bk, who: 'member', name: member.firstName || ss.bk.name },
      }))
    }

    // ---- DV-BOOK ----------------------------------------------------------------------------------------------------------
    __bookingBody(): Record<string, any> | null {
      const s = this.state
      const b = s.bk
      const day = this.days[Math.min(b.day, this.days.length - 1)]
      if (!day || b.slot == null) return null
      const vehL = this.VEH.find((v: any) => v[0] === b.vehicle)?.[1] ?? b.vehicle
      return {
        name: String(b.name || this.__member?.member.firstName || ''),
        phone: String(b.phone || ''),
        vehicle: { label: vehL },
        serviceKey: this.__serviceKey(),
        addonKeys: this.__addonKeys(),
        date: `${day.d.getFullYear()}-${String(day.d.getMonth() + 1).padStart(2, '0')}-${String(day.d.getDate()).padStart(2, '0')}`,
        startMin: b.slot,
        smsConsent: true,
        ...(this.__member ? { memberToken: this.__member.token } : {}),
        website: '',
      }
    }

    __composeBooking(): string {
      const s = this.state
      const b = s.bk
      const wash = this.WASH.find((w: any) => w.id === b.svc) || this.WASH[0]
      const vehL = this.VEH.find((v: any) => v[0] === b.vehicle)?.[1] ?? b.vehicle
      const day = this.days[Math.min(b.day, this.days.length - 1)]
      const when = b.slot != null && day ? `${day.word} ${this.fmt(b.slot)}` : 'any open time'
      const ads = this.DURING.filter((a: any) => b.addons.includes(a.id)).map((a: any) => a.name)
      const who = b.who === 'member' ? `Member${b.phone ? ' ' + b.phone : ''}` : 'Guest'
      return `${env.contact.smsKeyword} booking: ${wash.name} · ${vehL} · ${when}${ads.length ? ' · + ' + ads.join(', ') : ''} · ${who}`
    }

    async __submitBooking(): Promise<void> {
      const b = this.state.bk
      const guest = b.who === 'guest'
      if (guest && !b.ack) {
        this.flash('Please confirm the booking fee terms')
        return
      }
      if (env.booking !== 'live') {
        navigate(smsUrl(this.__composeBooking()))
        return
      }
      if (guest && (!String(b.name || '').trim() || String(b.phone || '').replace(/\D/g, '').length < 10)) {
        this.flash('Add your name and a 10-digit mobile number')
        return
      }
      const body = this.__bookingBody()
      if (!body) {
        this.flash('Pick a time first')
        return
      }
      const r = await this.__post(env.endpoints.bookings, body, this.__idem)
      if (!r) return
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
        email: j.email,
        vehicles: j.vehicles.filter((v: any) => v.car.trim()).map((v: any) => ({ car: v.car.trim(), plate: v.plate.trim().toUpperCase() })),
        smsConsent: true,
        agree: true,
        website: '',
      }
      if (!this.__idem) this.__idem = randomId()
      const r = await this.__post(env.endpoints.memberships, body, this.__idem)
      if (!r) return
      this.__memberRef = String(r.memberRef)
      this.__idem = null
      this.setJn({ step: 4, err: '' })
      this.setState({ tier: j.tier })
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }

    // ---- transport ----------------------------------------------------------------------------------------------------------
    async __post(endpoint: string, body: unknown, idem: string | null): Promise<Record<string, any> | null> {
      if (this.__busy) return null
      this.__busy = true
      this.forceUpdate()
      try {
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
        if (res.status === 409 && problem?.title) {
          this.flash(problem.title)
          this.setBk({ slot: null })
          this.setState({ step: 'time' })
          void this.__refreshAvailability()
        } else this.flash(problem?.title || (res.status === 429 ? 'Too many tries. Please wait a minute.' : 'Something went wrong. Try again or text us.'))
        return null
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
