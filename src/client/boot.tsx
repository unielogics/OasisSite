// Hydrates a prerendered page: the static markup inside #dc-root was produced by renderToString(<DCHost .../>) with the
// same compiled template, logic class and user props, so hydrateRoot adopts it without re-creating the DOM. Any
// hydration problem is reported through console.error (the parity harness fails on it) instead of being swallowed.
//
// `freeze`: a design whose first render depends on the clock (a clock label, "today", an animation stamp) would not
// match the prerendered markup, so Date.now() and `new Date()` with no arguments are pinned to the build instant from
// here until the host is about to run the logic's componentDidMount; the bridge then re-renders with the real time
// (DEVIATIONS.md DV-CLOCK). Timers, performance.now() and Date with arguments are untouched.
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
  /** the custom element rendered as a static placeholder (site.config.json imageSlots.tag), upgraded on the client */
  imageSlotTag?: string | null
}

/** Pins Date.now() and no-argument `new Date()`; returns the restore function. */
export function pinDate(iso: string): () => void {
  const fixed = new Date(iso).getTime()
  if (Number.isNaN(fixed)) return () => {}
  const RealDate = Date
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const FixedDate = function (this: any, ...args: any[]) {
    if (!new.target) return new RealDate(fixed).toString()
    return args.length ? new RealDate(...(args as [any])) : new RealDate(fixed)
  } as unknown as DateConstructor
  /* eslint-enable @typescript-eslint/no-explicit-any */
  Object.setPrototypeOf(FixedDate, RealDate)
  Object.defineProperty(FixedDate, 'prototype', { value: RealDate.prototype, writable: false })
  ;(FixedDate as { now: () => number }).now = () => fixed
  ;(FixedDate as { parse: typeof Date.parse }).parse = RealDate.parse
  ;(FixedDate as { UTC: typeof Date.UTC }).UTC = RealDate.UTC
  ;(globalThis as { Date: DateConstructor }).Date = FixedDate
  let restored = false
  return () => {
    if (restored) return
    restored = true
    ;(globalThis as { Date: DateConstructor }).Date = RealDate
  }
}

export function boot(o: BootOptions): void {
  const container = document.getElementById('dc-root')
  if (!container) {
    console.error('[oasis] #dc-root is missing; nothing to hydrate')
    return
  }
  const restore = o.freeze ? pinDate(o.freeze.now) : () => {}
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
      userProps: o.userProps,
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
