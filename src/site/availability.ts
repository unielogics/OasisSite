// The public availability contract (GET /api/v1/public/availability?days=5&service=<key>&addons=a,b) and its two
// uses: converting a payload into the `days` structure the design's logic reads (the open-times board, the day cards,
// NEXT OPEN, the hero pill, the booking sheet and the SMS mock all derive from it), and the fixture generator that
// reproduces the design's own mulberry32 pattern for the parity harness (where the port must match the original's
// board slot for slot at the frozen instant). The generator is never part of the public build.
import type { HoursTable } from './hours'

export type SlotState = 'open' | 'last' | 'vip' | 'booked'

export interface AvailabilitySlot {
  startMin: number
  start: string
  state: SlotState
  bays: number
}

export interface AvailabilityDay {
  date: string
  label: string
  dateLabel: string
  weekday: number
  closed: boolean
  openCount: number
  slots: AvailabilitySlot[]
}

export interface Availability {
  tz: string
  generatedAt: string
  serviceKey: string
  durationMin: number
  /** the backend's "N of 3 bays open now": active bays minus the jobs occupying one at this instant */
  now?: { open: boolean; baysFree: number; baysTotal: number } | null
  days: AvailabilityDay[]
}

/** The design's slot shape: minutes from midnight, its own state names, open bays. */
export interface DesignSlot {
  m: number
  st: 'open' | 'last' | 'members' | 'booked'
  bays: number
}

export interface DesignDay {
  d: Date
  i: number
  slots: DesignSlot[]
  word: string
  /** the site only: no slot data is known for this day (fallback build without SITE_AVAILABILITY_JSON) */
  unknown?: boolean
}

const DOWL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

export function validateAvailability(data: unknown): Availability {
  const d = data as Partial<Availability> | null
  if (!d || typeof d !== 'object' || !Array.isArray(d.days)) throw new Error('availability: days must be an array')
  for (const day of d.days) {
    if (!day || typeof day.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.date))
      throw new Error('availability: every day needs a date (YYYY-MM-DD)')
    if (!Array.isArray(day.slots)) throw new Error(`availability: ${day.date} has no slots array`)
    for (const s of day.slots) {
      if (typeof s.startMin !== 'number' || !['open', 'last', 'vip', 'booked'].includes(s.state))
        throw new Error(`availability: ${day.date} has a malformed slot`)
    }
  }
  return d as Availability
}

const localDate = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return new Date(y, m - 1, d)
}

export const isoDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const dayDiff = (a: Date, b: Date): number =>
  Math.round((new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime() - new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime()) / 86400000)

/** The design's `word` for a day offset: Today, Tomorrow, else the weekday name. */
export const dayWord = (i: number, d: Date): string => (i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : DOWL[d.getDay()]!)

/**
 * Payload -> the design's `days` (at most `max` days with slots, like the design's getter). Days whose slots are all
 * gone are dropped the way the design drops them (`if (slots.length) out.push(...)`).
 */
export function daysFromAvailability(a: Availability, now: Date, max = 5): DesignDay[] {
  const out: DesignDay[] = []
  for (const day of a.days) {
    if (day.closed || !day.slots.length) continue
    const d = localDate(day.date)
    const i = dayDiff(d, now)
    if (i < 0) continue
    out.push({
      d,
      i,
      word: dayWord(i, d),
      slots: day.slots.map((s) => ({ m: s.startMin, st: s.state === 'vip' ? 'members' : s.state, bays: s.bays })),
    })
    if (out.length >= max) break
  }
  return out
}

/** Without slot data: the next `max` open days from the hours table, each marked unknown (no slots). */
export function daysFromHours(table: HoursTable, now: Date, max = 5): DesignDay[] {
  const out: DesignDay[] = []
  for (let i = 0; out.length < max && i < 14; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i)
    const h = table[d.getDay()]
    if (!h) continue
    if (i === 0 && now.getHours() * 60 + now.getMinutes() >= h[1] * 60 - 60) continue
    out.push({ d, i, word: dayWord(i, d), slots: [], unknown: true })
  }
  return out
}

/** The design's fmt(): "8:30 AM". */
export function fmtClock(m: number): string {
  let h = Math.floor(m / 60)
  const mm = m % 60
  const ap = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return h + ':' + String(mm).padStart(2, '0') + ' ' + ap
}

/** The design's mulberry32. */
export function rng(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The design's own `days` getter, as a contract payload: the parity build and the harness's fixture endpoint use it
 * so the port renders the exact board the original renders at the frozen instant (with Sunday closed, DV-HOURS).
 * `days` counts days that have slots, like the design (closed days in between are listed as closed).
 */
export function designAvailability(now: Date, table: HoursTable, opts: { days?: number; serviceKey?: string; durationMin?: number; tz?: string } = {}): Availability {
  const max = opts.days ?? 5
  const nm = now.getHours() * 60 + now.getMinutes()
  const days: AvailabilityDay[] = []
  let withSlots = 0
  for (let i = 0; withSlots < max && i < 10; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i)
    const h = table[d.getDay()]
    const base: Omit<AvailabilityDay, 'closed' | 'openCount' | 'slots'> = {
      date: isoDate(d),
      label: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : DOW[d.getDay()]!.charAt(0) + DOW[d.getDay()]!.slice(1).toLowerCase(),
      dateLabel: `${DOWL[d.getDay()]}, ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${d.getDate()}`,
      weekday: d.getDay(),
    }
    if (!h) {
      days.push({ ...base, closed: true, openCount: 0, slots: [] })
      continue
    }
    const [o, c] = h
    const r = rng(d.getFullYear() * 1000 + d.getMonth() * 40 + d.getDate())
    const slots: AvailabilitySlot[] = []
    for (let m = o * 60; m <= c * 60 - 60; m += 30) {
      const x = r()
      const y = r()
      const prime = (d.getDay() === 6 && m < 11 * 60) || m >= 16 * 60
      let st: DesignSlot['st'] = x < 0.38 ? 'booked' : x < (prime ? 0.64 : 0.5) ? 'members' : 'open'
      const bays = st === 'open' ? (y < 0.3 ? 1 : y < 0.75 ? 2 : 3) : st === 'members' ? 1 : 0
      if (st === 'open' && bays === 1) st = 'last'
      if (i === 0 && m < nm + 30) continue
      slots.push({ startMin: m, start: fmtClock(m), state: st === 'members' ? 'vip' : st, bays })
    }
    if (!slots.length) {
      // the design skips such a day entirely; the contract lists it with no slots, which daysFromAvailability drops too
      days.push({ ...base, closed: false, openCount: 0, slots: [] })
      continue
    }
    days.push({
      ...base,
      closed: false,
      openCount: slots.filter((s) => s.state === 'open' || s.state === 'last').length,
      slots,
    })
    withSlots++
  }
  return {
    tz: opts.tz ?? 'America/New_York',
    generatedAt: now.toISOString(),
    serviceKey: opts.serviceKey ?? 'signature-hand-wash',
    durationMin: opts.durationMin ?? 45,
    days,
  }
}
