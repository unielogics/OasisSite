// Hydrates a prerendered page: the static markup inside #dc-root was produced by renderToString(<DCHost .../>) with the
// same compiled template, logic class and user props, so hydrateRoot adopts it without re-creating the DOM. Any
// hydration problem is reported through console.error (the parity harness fails on it) instead of being swallowed.
//
// `freeze`: a design whose first render depends on the clock (a clock label, "today", an animation stamp) would not
// match the prerendered markup, so Date.now() and `new Date()` with no arguments are pinned to the build instant from
// here until the host is about to run the logic's componentDidMount; the bridge then re-renders with the real time
// (DEVIATIONS.md DV-CLOCK). Timers, performance.now() and Date with arguments are untouched.
//
// `timeZone`: the design (and the bridge) read the clock through local getters (getHours, getDay, …), and the page
// is prerendered in the shop's zone. For a visitor in another zone the first client render would differ from the
// markup (React then discards it and renders again on the client) and the page would show the visitor's wall clock
// for the shop's "today" and opening times. So the clock the page sees is the shop's wall clock in every zone: Date.now()
// and `new Date()` are shifted by the difference between the visitor's and the shop's UTC offsets (zero for a visitor
// in the shop's zone), from the first render on and for the life of the page (DEVIATIONS.md DV-CLOCK).
import { createElement } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { DCHost } from '../dc/DCHost'
import { defineImageSlotElement, imageSlotClientMode } from '../dc/image-slot'
import type { DCLogicCtor, DCRender, PageMeta } from '../dc/types'
import { refreshHours } from './hours'
import type { HoursLabels } from '../hours/format'

export interface BootOptions {
  meta: Pick<PageMeta, 'name' | 'slug'>
  render: DCRender
  Logic: DCLogicCtor
  userProps: Record<string, unknown>
  hours: { endpoint: string; timeoutMs: number; labels?: Partial<HoursLabels> } | null
  /** ISO instant of the prerender; the first client render is pinned to it */
  freeze?: { now: string } | null
  /** the shop's IANA zone: the page's clock shows its wall time for every visitor */
  timeZone?: string | null
  /** the custom element rendered as a static placeholder (site.config.json imageSlots.tag), upgraded on the client */
  imageSlotTag?: string | null
  /**
   * The design's theme prop and its values: the pre-hydration theme script (src/client/theme.entry.ts) decided the
   * theme from the visitor's stored choice or device setting and patched the markup; the logic gets that decision as
   * this prop so its first client render equals the patched DOM (DEVIATIONS.md DV-THEME).
   */
  theme?: { prop: string; values: string[] } | null
}

/** The user props with the pre-hydration theme decision (window.__oasisTheme) in the design's theme prop. */
export function withThemeDecision(
  userProps: Record<string, unknown>,
  theme: BootOptions['theme'],
  decision: { theme?: unknown } | null | undefined,
): Record<string, unknown> {
  if (!theme || !decision || typeof decision.theme !== 'string' || !theme.values.includes(decision.theme))
    return userProps
  return { ...userProps, [theme.prop]: decision.theme }
}

/** UTC offset (ms, east positive) of `timeZone` at instant `t`, through Intl; null when the zone is unknown. */
export function zoneOffsetMs(timeZone: string, t: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(t)
    const n = (type: string) => Number(parts.find((p) => p.type === type)?.value)
    const wall = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'))
    const offset = wall - Math.floor(t / 1000) * 1000
    return Number.isFinite(offset) ? offset : null
  } catch {
    return null
  }
}

/**
 * The instant whose LOCAL wall clock equals the shop's wall clock at real instant `t` (local getters then read shop
 * time). `localOffsetMs` is the runtime's own offset at an instant (east positive).
 */
export function shopShifted(t: number, timeZone: string, localOffsetMs: (t: number) => number): number {
  const shop = zoneOffsetMs(timeZone, t)
  if (shop === null) return t
  const first = t + shop - localOffsetMs(t)
  return t + shop - localOffsetMs(first) // once more, for a local DST change between t and the shifted instant
}

/**
 * Replaces the global Date so that Date.now() and argument-less `new Date()` / `Date()` return the shop's wall clock
 * (`timeZone`, through local getters) and, until `unpin()`, the pinned instant `pinIso`. Date with arguments,
 * Date.parse/UTC, timers and performance.now() are untouched. Returns `unpin` (switch from the pinned instant to the
 * running clock; the zone shift stays) and `restore` (put the real Date back; tests).
 */
export function installShopClock(o: { timeZone?: string | null; pinIso?: string | null }): {
  unpin: () => void
  restore: () => void
} {
  const RealDate = Date
  const realNow = RealDate.now.bind(RealDate)
  const pinned = o.pinIso ? new RealDate(o.pinIso).getTime() : NaN
  let pin = Number.isNaN(pinned) ? null : pinned
  const localOffset = (t: number) => -new RealDate(t).getTimezoneOffset() * 60000
  const tz = o.timeZone || null
  const now = (): number => {
    const t = pin ?? realNow()
    return tz ? shopShifted(t, tz, localOffset) : t
  }
  const zoneShift = (): boolean => {
    const t = realNow()
    return !!tz && shopShifted(t, tz, localOffset) !== t
  }
  if (pin === null && !zoneShift()) {
    // nothing to pin and the visitor is in the shop's zone: leave Date alone
    return { unpin: () => {}, restore: () => {} }
  }
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const ShopDate = function (this: any, ...args: any[]) {
    if (!new.target) return new RealDate(now()).toString()
    return args.length ? new RealDate(...(args as [any])) : new RealDate(now())
  } as unknown as DateConstructor
  /* eslint-enable @typescript-eslint/no-explicit-any */
  Object.setPrototypeOf(ShopDate, RealDate)
  Object.defineProperty(ShopDate, 'prototype', { value: RealDate.prototype, writable: false })
  ;(ShopDate as { now: () => number }).now = now
  ;(ShopDate as { parse: typeof Date.parse }).parse = RealDate.parse
  ;(ShopDate as { UTC: typeof Date.UTC }).UTC = RealDate.UTC
  ;(globalThis as { Date: DateConstructor }).Date = ShopDate
  let restored = false
  return {
    unpin: () => {
      pin = null
      // with no zone shift left to apply, the real Date can come back
      if (!zoneShift()) {
        if (!restored) (globalThis as { Date: DateConstructor }).Date = RealDate
        restored = true
      }
    },
    restore: () => {
      if (restored) return
      restored = true
      ;(globalThis as { Date: DateConstructor }).Date = RealDate
    },
  }
}

export function boot(o: BootOptions): void {
  const container = document.getElementById('dc-root')
  if (!container) {
    console.error('[oasis] #dc-root is missing; nothing to hydrate')
    return
  }
  const clock = installShopClock({ timeZone: o.timeZone, pinIso: o.freeze?.now })
  const restore = clock.unpin
  if (o.imageSlotTag) {
    imageSlotClientMode()
    defineImageSlotElement(o.imageSlotTag)
  }
  hydrateRoot(
    container,
    createElement(DCHost, {
      meta: o.meta,
      Logic: o.Logic,
      render: o.render,
      userProps: withThemeDecision(
        o.userProps,
        o.theme,
        (window as unknown as { __oasisTheme?: { theme?: unknown } }).__oasisTheme,
      ),
      beforeMount: restore,
    }),
    {
      onRecoverableError: (err: unknown) => {
        restore()
        console.error('[oasis] hydration error:', err instanceof Error ? err.message : String(err))
      },
    },
  )
  if (o.hours) void refreshHours(container, o.hours)
}
