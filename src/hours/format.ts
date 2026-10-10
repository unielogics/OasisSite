// The public hours contract (GET /api/v1/public/hours) and its presentation strings. Pure and dependency-free: the
// prerender bakes these strings (SITE_HOURS_JSON or the committed fallback) and the browser re-applies them after a
// fetch, so both sides share one formatter. Contract (backend plan, settings module):
//   { tz, today: { date, day, closed, openNow, state: 'open'|'opens_later'|'closed', opensAt, closesAt, reason } | null,
//     next: { ... } | null, week: [7 x { weekday, day, open, from, to }], closures: [...] }
// Times arrive as "HH:MM" (24 h), "H:MM AM/PM" or minutes from midnight; every form renders as "8:00 AM".

export interface HoursDay {
  weekday: number
  day: string
  open: boolean
  from: string | number | null
  to: string | number | null
}

export interface HoursToday {
  date?: string
  day?: string
  weekday?: number
  closed: boolean
  /** minutes from midnight (the backend's publicHoursView) */
  openMin?: number | null
  closeMin?: number | null
  openNow?: boolean
  state?: 'open' | 'opens_later' | 'closed' | string
  opensAt?: string | number | null
  closesAt?: string | number | null
  reason?: string | null
}

export interface HoursClosure {
  date: string
  name?: string
  type?: string
  from?: string | number | null
  to?: string | number | null
}

export interface PublicHours {
  tz?: string
  today?: HoursToday | null
  next?: (HoursToday & { day?: string }) | null
  week: HoursDay[]
  closures?: HoursClosure[]
}

export interface HoursLabels {
  closed: string
  openNow: string
  opensAt: string
  closesAt: string
  rangeSeparator: string
}

export const DEFAULT_LABELS: HoursLabels = {
  closed: 'Closed',
  openNow: 'Open now',
  opensAt: 'Opens at',
  closesAt: 'Closes at',
  rangeSeparator: ' – ',
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Minutes from midnight for "HH:MM", "H:MM AM", "8 PM" or a number; null when unreadable. */
export function toMinutes(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 && v < 1440 ? Math.round(v) : null
  const s = String(v).trim()
  let m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s)
  if (m) {
    const h = Number(m[1])
    const mi = Number(m[2])
    return h < 24 && mi < 60 ? h * 60 + mi : null
  }
  m = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i.exec(s)
  if (m) {
    let h = Number(m[1]) % 12
    if (m[3]!.toLowerCase() === 'p') h += 12
    const mi = Number(m[2] ?? '0')
    return h < 24 && mi < 60 ? h * 60 + mi : null
  }
  return null
}

/** "8:00 AM" style (en-US, no leading zero, no seconds). */
export function fmtTime(v: string | number | null | undefined): string {
  const min = toMinutes(v)
  if (min === null) return ''
  const h = Math.floor(min / 60)
  const mi = min % 60
  const ap = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${String(mi).padStart(2, '0')} ${ap}`
}

export function fmtRange(
  from: string | number | null | undefined,
  to: string | number | null | undefined,
  labels = DEFAULT_LABELS,
): string {
  const a = fmtTime(from)
  const b = fmtTime(to)
  return a && b ? a + labels.rangeSeparator + b : labels.closed
}

export interface FormattedDay {
  weekday: number
  day: string
  short: string
  open: boolean
  from: string
  to: string
  range: string
}

export interface FormattedHours {
  tz: string
  week: FormattedDay[]
  /** Monday first, as a hours table usually reads */
  weekMondayFirst: FormattedDay[]
  today: {
    day: string
    range: string
    status: string
    opensAt: string
    closesAt: string
    reason: string
    closed: boolean
    openNow: boolean
  } | null
  next: { day: string; range: string } | null
  closures: { date: string; name: string; range: string }[]
}

export function validatePublicHours(data: unknown): PublicHours {
  const d = data as Partial<PublicHours> | null
  if (!d || typeof d !== 'object' || !Array.isArray(d.week) || d.week.length !== 7)
    throw new Error('hours: week must have 7 entries')
  const seen = new Set<number>()
  for (const w of d.week) {
    if (
      !w ||
      typeof w !== 'object' ||
      typeof w.weekday !== 'number' ||
      w.weekday < 0 ||
      w.weekday > 6 ||
      seen.has(w.weekday)
    )
      throw new Error('hours: week entries need distinct weekday 0-6')
    seen.add(w.weekday)
    if (typeof w.open !== 'boolean') throw new Error(`hours: weekday ${w.weekday} needs open: boolean`)
    if (w.open && (toMinutes(w.from) === null || toMinutes(w.to) === null))
      throw new Error(`hours: weekday ${w.weekday} is open without readable from/to`)
  }
  return d as PublicHours
}

/** Turns the API payload into the flat strings the page binds (`{{= hours.week.1.range }}`, `[data-hours="today.status"]`). */
export function formatHours(data: PublicHours, labels: Partial<HoursLabels> = {}): FormattedHours {
  const L = { ...DEFAULT_LABELS, ...labels }
  const week = [...data.week]
    .sort((a, b) => a.weekday - b.weekday)
    .map((w) => {
      const day = w.day || DAY_NAMES[w.weekday] || ''
      return {
        weekday: w.weekday,
        day,
        short: day.slice(0, 3),
        open: w.open,
        from: w.open ? fmtTime(w.from) : '',
        to: w.open ? fmtTime(w.to) : '',
        range: w.open ? fmtRange(w.from, w.to, L) : L.closed,
      }
    })
  const t = data.today ?? null
  let today: FormattedHours['today'] = null
  if (t) {
    const closed = !!t.closed
    const openNow = !!t.openNow || t.state === 'open'
    const opensAt = fmtTime(t.opensAt)
    const closesAt = fmtTime(t.closesAt)
    const status = closed
      ? t.reason
        ? `${L.closed} · ${t.reason}`
        : L.closed
      : openNow
        ? closesAt
          ? `${L.openNow} · ${L.closesAt} ${closesAt}`
          : L.openNow
        : opensAt
          ? `${L.opensAt} ${opensAt}`
          : L.closed
    today = {
      day: t.day || '',
      range: closed ? L.closed : fmtRange(t.opensAt, t.closesAt, L),
      status,
      opensAt,
      closesAt,
      reason: t.reason ?? '',
      closed,
      openNow,
    }
  }
  const n = data.next ?? null
  const next = n
    ? { day: n.day || '', range: n.closed ? L.closed : fmtRange(n.opensAt, n.closesAt, L) }
    : null
  const closures = (data.closures ?? []).map((c) => ({
    date: c.date,
    name: c.name ?? '',
    range:
      c.from != null && c.to != null && toMinutes(c.from) !== null ? fmtRange(c.from, c.to, L) : L.closed,
  }))
  return {
    tz: data.tz ?? '',
    week,
    weekMondayFirst: [...week.slice(1), ...week.slice(0, 1)],
    today,
    next,
    closures,
  }
}

/** Reads a dotted path ("week.1.range") from the formatted strings. */
export function hoursValue(formatted: FormattedHours, key: string): string | null {
  let cur: unknown = formatted
  for (const seg of key.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return null
    cur = (cur as Record<string, unknown>)[seg]
  }
  return typeof cur === 'string'
    ? cur
    : typeof cur === 'number'
      ? String(cur)
      : typeof cur === 'boolean'
        ? String(cur)
        : null
}

/**
 * Applies the strings to every `[data-hours="<key>"]` element (text) and `[data-hours-attr="<attr>:<key>"]`
 * element (an attribute). Returns the number of nodes changed. Works on any DOM-like root (browser or jsdom).
 */
export function applyHours(root: ParentNode, formatted: FormattedHours): number {
  let changed = 0
  for (const el of Array.from(root.querySelectorAll('[data-hours]'))) {
    const key = el.getAttribute('data-hours') || ''
    const v = hoursValue(formatted, key)
    if (v !== null && el.textContent !== v) {
      el.textContent = v
      changed++
    }
    if (el.hasAttribute('data-hours-closed')) {
      const closed = /(^|\.)closed$/.test(key) ? v === 'true' : v === DEFAULT_LABELS.closed
      el.setAttribute('data-hours-closed', closed ? 'true' : 'false')
    }
  }
  for (const el of Array.from(root.querySelectorAll('[data-hours-attr]'))) {
    const spec = el.getAttribute('data-hours-attr') || ''
    const i = spec.indexOf(':')
    if (i <= 0) continue
    const v = hoursValue(formatted, spec.slice(i + 1))
    if (v !== null && el.getAttribute(spec.slice(0, i)) !== v) {
      el.setAttribute(spec.slice(0, i), v)
      changed++
    }
  }
  return changed
}
