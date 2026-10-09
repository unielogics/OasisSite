// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyHours,
  fmtRange,
  fmtTime,
  formatHours,
  hoursValue,
  toMinutes,
  validatePublicHours,
} from './format'
import type { PublicHours } from './format'

const root = path.resolve(__dirname, '..', '..')
const fallback = JSON.parse(
  fs.readFileSync(path.join(root, 'src/data/hours.fallback.json'), 'utf8'),
) as PublicHours
const alt = JSON.parse(
  fs.readFileSync(path.join(root, 'tools/parity/fixtures/hours.alt.json'), 'utf8'),
) as PublicHours

describe('time parsing and formatting', () => {
  it('reads 24 h, 12 h and minute forms and prints en-US without leading zeros', () => {
    expect(toMinutes('08:00')).toBe(480)
    expect(toMinutes('18:30')).toBe(1110)
    expect(toMinutes('8:00 AM')).toBe(480)
    expect(toMinutes('12:00 PM')).toBe(720)
    expect(toMinutes('12:15 am')).toBe(15)
    expect(toMinutes('6 pm')).toBe(1080)
    expect(toMinutes(600)).toBe(600)
    for (const bad of ['', null, undefined, 'noon', '25:00', '8:60', -1, 1440, 'x'])
      expect(toMinutes(bad)).toBeNull()
    expect(fmtTime('08:00')).toBe('8:00 AM')
    expect(fmtTime('00:05')).toBe('12:05 AM')
    expect(fmtTime('12:00')).toBe('12:00 PM')
    expect(fmtTime('17:00')).toBe('5:00 PM')
    expect(fmtTime('bad')).toBe('')
    expect(fmtRange('08:00', '18:00')).toBe('8:00 AM – 6:00 PM')
    expect(fmtRange(null, '18:00')).toBe('Closed')
  })
})

describe('formatHours on the committed fallback (Sunday closed)', () => {
  it('validates the shape and formats the week, Monday first', () => {
    const f = formatHours(validatePublicHours(fallback))
    expect(f.week.map((d) => d.range)).toEqual([
      'Closed',
      '8:00 AM – 6:00 PM',
      '8:00 AM – 6:00 PM',
      '8:00 AM – 6:00 PM',
      '8:00 AM – 6:00 PM',
      '8:00 AM – 6:00 PM',
      '8:00 AM – 5:00 PM',
    ])
    expect(f.week[0]).toMatchObject({
      day: 'Sunday',
      short: 'Sun',
      open: false,
      from: '',
      to: '',
      range: 'Closed',
    })
    expect(f.weekMondayFirst.map((d) => d.short)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
    expect(f.today).toBeNull()
    expect(f.next).toBeNull()
    expect(f.closures).toEqual([])
    expect(hoursValue(f, 'week.0.range')).toBe('Closed')
    expect(hoursValue(f, 'weekMondayFirst.5.range')).toBe('8:00 AM – 5:00 PM')
    expect(hoursValue(f, 'nope.x')).toBeNull()
  })

  it('rejects malformed payloads', () => {
    expect(() => validatePublicHours(null)).toThrow(/7 entries/)
    expect(() => validatePublicHours({ week: fallback.week.slice(1) })).toThrow(/7 entries/)
    expect(() => validatePublicHours({ week: fallback.week.map((w) => ({ ...w, weekday: 1 })) })).toThrow(
      /distinct/,
    )
    expect(() =>
      validatePublicHours({ week: fallback.week.map((w) => ({ ...w, open: true, from: null })) }),
    ).toThrow(/readable/)
  })
})

describe('formatHours on the alternate fixture (today open, a closure, Sunday closed)', () => {
  it('formats today, next and closures with the state rules', () => {
    const f = formatHours(validatePublicHours(alt))
    expect(f.today).toMatchObject({
      day: 'Saturday',
      range: '9:00 AM – 4:00 PM',
      status: 'Open now · Closes at 4:00 PM',
      closed: false,
      openNow: true,
    })
    expect(f.next).toEqual({ day: 'Monday', range: '7:30 AM – 7:00 PM' })
    expect(f.closures).toEqual([{ date: '2026-07-04', name: 'Independence Day', range: 'Closed' }])
    expect(f.week[0]!.range).toBe('Closed')
    const later = formatHours({
      ...alt,
      today: { closed: false, openNow: false, state: 'opens_later', opensAt: '09:00', closesAt: '16:00' },
    })
    expect(later.today!.status).toBe('Opens at 9:00 AM')
    const closedToday = formatHours({ ...alt, today: { closed: true, reason: 'Regular day off' } })
    expect(closedToday.today!.status).toBe('Closed · Regular day off')
    expect(closedToday.today!.range).toBe('Closed')
  })
})

describe('applyHours', () => {
  it('writes the strings into [data-hours] text and [data-hours-attr] attributes, reporting changes', () => {
    document.body.innerHTML =
      '<p data-hours="week.1.range">old</p><p data-hours="today.status">x</p><p data-hours="week.0.open" data-hours-closed="">?</p>' +
      '<time data-hours-attr="datetime:week.1.from">t</time><p data-hours="nope">keep</p>'
    const f = formatHours(validatePublicHours(alt))
    expect(applyHours(document.body, f)).toBe(4)
    expect(document.querySelector('[data-hours="week.1.range"]')!.textContent).toBe('7:30 AM – 7:00 PM')
    expect(document.querySelector('[data-hours="today.status"]')!.textContent).toBe(
      'Open now · Closes at 4:00 PM',
    )
    expect(document.querySelector('time')!.getAttribute('datetime')).toBe('7:30 AM')
    expect(document.querySelector('[data-hours="nope"]')!.textContent).toBe('keep')
    expect(document.querySelector('[data-hours-closed]')!.getAttribute('data-hours-closed')).toBe('false')
    expect(applyHours(document.body, f)).toBe(0)
  })
})
