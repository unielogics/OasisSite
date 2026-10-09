// Hydrates a prerendered page: the static markup inside #dc-root was produced by renderToString(<DCHost .../>) with the
// same compiled template, logic class and user props, so hydrateRoot adopts it without re-creating the DOM. Any
// hydration problem is reported through console.error (the parity harness fails on it) instead of being swallowed.
import { createElement } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { DCHost } from '../dc/DCHost'
import type { DCLogicCtor, DCRender, PageMeta } from '../dc/types'
import { refreshHours } from './hours'
import type { HoursLabels } from '../hours/format'

export interface BootOptions {
  meta: Pick<PageMeta, 'name' | 'slug'>
  render: DCRender
  Logic: DCLogicCtor
  userProps: Record<string, unknown>
  hours: { endpoint: string; timeoutMs: number; labels?: Partial<HoursLabels> } | null
}

export function boot(o: BootOptions): void {
  const container = document.getElementById('dc-root')
  if (!container) {
    console.error('[oasis] #dc-root is missing; nothing to hydrate')
    return
  }
  hydrateRoot(
    container,
    createElement(DCHost, { meta: o.meta, Logic: o.Logic, render: o.render, userProps: o.userProps }),
    {
      onRecoverableError: (err: unknown) => {
        console.error('[oasis] hydration error:', err instanceof Error ? err.message : String(err))
      },
    },
  )
  if (o.hours) void refreshHours(container, o.hours)
}
