// The page's clock (src/client/boot.tsx installShopClock, DEVIATIONS.md DV-CLOCK): the shop's wall clock through local
// getters for a visitor in any zone, pinned to the build instant until the host mounts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installShopClock, shopShifted, zoneOffsetMs } from './boot'

const SHOP = 'America/New_York'
const wall = (t: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit', day: '2-digit' }).format(t)
const localWall = (d: Date) =>
  new Intl.DateTimeFormat('en-US', { hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit', day: '2-digit' }).format(d)

let tz: string | undefined
const RealDate = Date
beforeEach(() => {
  tz = process.env.TZ
})
afterEach(() => {
  ;(globalThis as { Date: DateConstructor }).Date = RealDate
  if (tz === undefined) delete process.env.TZ
  else process.env.TZ = tz
})

describe('zoneOffsetMs / shopShifted', () => {
  it('reads the shop offset across daylight saving time', () => {
    expect(zoneOffsetMs(SHOP, Date.UTC(2026, 9, 10, 15, 0))).toBe(-4 * 3600_000) // EDT
    expect(zoneOffsetMs(SHOP, Date.UTC(2026, 0, 10, 15, 0))).toBe(-5 * 3600_000) // EST
    expect(zoneOffsetMs('Not/AZone', Date.UTC(2026, 0, 10))).toBeNull()
  })

  it('shifts an instant so that local getters read the shop wall clock', () => {
    const t = Date.UTC(2026, 9, 10, 15, 20) // 11:20 AM in New Jersey, 8:20 AM in Los Angeles
    const la = () => -7 * 3600_000
    expect(shopShifted(t, SHOP, la) - t).toBe(3 * 3600_000)
    expect(shopShifted(t, SHOP, () => -4 * 3600_000)).toBe(t)
    expect(shopShifted(t, 'Not/AZone', la)).toBe(t)
  })
})

describe('installShopClock', () => {
  it('gives a visitor in Los Angeles the shop wall clock, pinned until unpin', () => {
    process.env.TZ = 'America/Los_Angeles'
    const pinIso = '2026-10-10T15:20:00.000Z'
    const clock = installShopClock({ timeZone: SHOP, pinIso })
    expect(Date).not.toBe(RealDate)
    expect(localWall(new Date())).toBe(wall(Date.parse(pinIso), SHOP)) // "Sat 10, 11:20" as in New Jersey
    expect(new Date().getHours()).toBe(11)
    expect(new Date(2026, 9, 10).getDate()).toBe(10) // Date with arguments is untouched
    expect(new Date() instanceof RealDate).toBe(true)
    clock.unpin()
    expect(Date).not.toBe(RealDate) // the zone shift stays
    const real = RealDate.now()
    expect(localWall(new Date())).toBe(wall(real, SHOP))
    expect(Math.abs(Date.now() - (real + 3 * 3600_000))).toBeLessThan(2 * 3600_000 + 1000) // shifted by the offset gap
    clock.restore()
    expect(Date).toBe(RealDate)
  })

  it('leaves Date alone for a visitor in the shop zone once unpinned', () => {
    process.env.TZ = SHOP
    const clock = installShopClock({ timeZone: SHOP, pinIso: '2026-10-10T15:20:00.000Z' })
    expect(new Date().getHours()).toBe(11)
    clock.unpin()
    expect(Date).toBe(RealDate)
    expect(installShopClock({ timeZone: SHOP }).unpin).toBeTypeOf('function')
    expect(Date).toBe(RealDate) // nothing to pin, no shift: not replaced at all
  })

  it('pins without a zone (the previous behaviour) and restores on unpin', () => {
    const clock = installShopClock({ timeZone: null, pinIso: '2026-10-10T15:20:00.000Z' })
    expect(Date.now()).toBe(Date.parse('2026-10-10T15:20:00.000Z'))
    clock.unpin()
    expect(Date).toBe(RealDate)
  })
})
