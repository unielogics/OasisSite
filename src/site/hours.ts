// Opening hours the way the design presents them. The design hard-codes
//   hoursList: [{ d:'Monday – Friday', t:'8 AM – 6 PM' }, { d:'Saturday', t:'8 AM – 5 PM' }, { d:'Sunday', t:'9 AM – 3 PM' }]
//   HOURS = [[9,15],[8,18],[8,18],[8,18],[8,18],[8,18],[8,17]]   (Sunday first, hours of the day)
// and the site replaces both with the public hours payload (GET /api/v1/public/hours; Sunday is CLOSED, DV-HOURS):
// consecutive days with the same hours collapse into one row ("Monday – Friday"), times read "8 AM" when they fall on
// the hour and "8:30 AM" otherwise, a closed day reads "Closed".
import type { PublicHours } from '../hours/format'
import { toMinutes } from '../hours/format'

export interface HoursRow {
  d: string
  t: string
}

/** [openHour, closeHour] in fractional hours per weekday (Sunday first), or null when closed. The design's HOURS shape. */
export type HoursTable = ([number, number] | null)[]

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** "8 AM", "8:30 AM", "12 PM" — the design's own format (its fmt() with ":00" stripped). */
export function designTime(min: number): string {
  let h = Math.floor(min / 60)
  const mm = min % 60
  const ap = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return mm ? `${h}:${String(mm).padStart(2, '0')} ${ap}` : `${h} ${ap}`
}

export function designRange(from: number, to: number): string {
  return `${designTime(from)} – ${designTime(to)}`
}

/** The design's HOURS table from the payload (minutes -> fractional hours; closed -> null). */
export function hoursTable(h: PublicHours | null): HoursTable {
  const out: HoursTable = [null, null, null, null, null, null, null]
  if (!h) return out
  for (const w of h.week) {
    const from = toMinutes(w.from)
    const to = toMinutes(w.to)
    if (w.open && from !== null && to !== null) out[w.weekday] = [from / 60, to / 60]
  }
  return out
}

const isoOf = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/**
 * `today` and `next` for the clock `now` (the shop's wall clock, DV-CLOCK). The payload's `today` is a snapshot of the
 * moment it was generated (the deploy bakes the API's answer into the page, a tab stays open for hours): its hours for
 * the day (exceptions included) are used only while its `date` is today's, and its state is always worked out again
 * from `now`; a `today` of another day is ignored and today comes from the regular week (and the payload's closures).
 * `next` is kept while it is still after today. The committed fallback file has no `today` at all and takes the same
 * path.
 */
export function withToday(h: PublicHours | null, now: Date): PublicHours | null {
  if (!h) return h
  const table = hoursTable(h)
  const nm = now.getHours() * 60 + now.getMinutes()
  const todayIso = isoOf(now)
  const stateAt = (closed: boolean, from: number | null, to: number | null): string =>
    closed || from === null || to === null ? 'closed' : nm < from ? 'opens_later' : nm < to ? 'open' : 'closed'
  const dayOf = (d: Date): NonNullable<PublicHours['today']> => {
    const iso = isoOf(d)
    const t = table[d.getDay()]
    const closure = (h.closures ?? []).find((c) => c.date === iso)
    let from = t ? t[0] * 60 : null
    let to = t ? t[1] * 60 : null
    let reason: string | null = t ? null : 'Regular day off'
    if (closure) {
      const cf = toMinutes(closure.from ?? null)
      const ct = toMinutes(closure.to ?? null)
      if (cf !== null && ct !== null) {
        from = cf
        to = ct
      } else {
        from = null
        to = null
      }
      reason = closure.name ?? 'Closed'
    }
    const closed = from === null || to === null
    const state = iso === todayIso ? stateAt(closed, from, to) : closed ? 'closed' : 'opens_later'
    return {
      date: iso,
      day: DAYS[d.getDay()],
      weekday: d.getDay(),
      closed,
      openMin: from,
      closeMin: to,
      openNow: state === 'open',
      state,
      reason: closed ? reason : null,
    }
  }
  let today: NonNullable<PublicHours['today']>
  const t = h.today
  if (t && t.date === todayIso) {
    const from = typeof t.openMin === 'number' ? t.openMin : null
    const to = typeof t.closeMin === 'number' ? t.closeMin : null
    const state = stateAt(!!t.closed, from, to)
    today = { ...t, openNow: state === 'open', state }
  } else today = dayOf(now)
  let next: PublicHours['next'] = h.next && typeof h.next.date === 'string' && h.next.date > todayIso ? h.next : null
  for (let i = 1; i < 8 && !next; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i)
    const n = dayOf(d)
    if (!n.closed) next = n
  }
  return { ...h, today, next }
}

/** The rows of the HOURS block (visit page and footer), grouped like the design groups Monday – Friday. */
export function hoursRows(h: PublicHours | null, closedLabel = 'Closed'): HoursRow[] {
  if (!h) return []
  const week = [...h.week].sort((a, b) => a.weekday - b.weekday)
  // Monday first, Sunday last (how the design reads)
  const order = [1, 2, 3, 4, 5, 6, 0]
  const label = (weekday: number): string => {
    const w = week.find((x) => x.weekday === weekday)
    if (!w || !w.open) return closedLabel
    const from = toMinutes(w.from)
    const to = toMinutes(w.to)
    return from === null || to === null ? closedLabel : designRange(from, to)
  }
  const rows: HoursRow[] = []
  let i = 0
  while (i < order.length) {
    const t = label(order[i]!)
    let j = i
    while (j + 1 < order.length && label(order[j + 1]!) === t) j++
    const first = DAYS[order[i]!]!
    const last = DAYS[order[j]!]!
    rows.push({ d: j > i ? `${first} – ${last}` : first, t })
    i = j + 1
  }
  return rows
}
