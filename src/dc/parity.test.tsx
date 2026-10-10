// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const meta = { name: 'Oasis Test', slug: 'payments' } as const

async function load(parity: boolean) {
  vi.resetModules()
  delete (window as any).__oasisParity
  vi.stubEnv('OASIS_PARITY', parity ? '1' : '')
  const { DCHost } = await import('./DCHost')
  const { DCLogic } = await import('./DCLogic')
  return { DCHost, DCLogic }
}

let container: HTMLElement
beforeEach(() => {
  container = document.createElement('div')
  container.id = 'dc-root'
  document.body.appendChild(container)
})
afterEach(() => {
  container.remove()
  vi.unstubAllEnvs()
})

describe('parity hook', () => {
  it('parity build: window.__oasisParity.getVals() serialises renderVals, ready resolves, #dc-root gets data-oasis-ready', async () => {
    const { DCHost, DCLogic } = await load(true)
    class L extends DCLogic {
      renderVals() {
        return {
          label: 'x',
          onClick: () => {},
          icon: createElement('i', { className: 'ic' }),
          style: { zIndex: 1, color: 'red' },
        }
      }
    }
    const hook = (window as any).__oasisParity
    expect(hook).toBeDefined()
    expect(() => hook.getVals()).toThrow(/no page mounted/)
    let resolved = false
    hook.ready.then(() => (resolved = true))
    const root = createRoot(container)
    await act(async () =>
      root.render(
        <DCHost meta={meta as any} Logic={L as any} render={() => createElement('b')} userProps={{ p: 1 }} />,
      ),
    )
    await hook.ready
    expect(resolved).toBe(true)
    expect(container.getAttribute('data-oasis-ready')).toBe('1')
    expect(hook.page).toBe('payments')
    const vals = hook.getVals()
    // renderVals() alone, like the original runtime's logic instance (user props are not part of the record)
    expect(vals).toEqual({
      label: 'x',
      onClick: '[fn]',
      icon: { $el: 'i', key: null, props: { className: 'ic' } },
      style: { zIndex: 1, color: 'red' },
    })
    expect(JSON.stringify(vals.style)).toBe('{"zIndex":1,"color":"red"}')
    act(() => root.unmount())
  })

  it('normal build: no global, no ready attribute', async () => {
    const { DCHost, DCLogic } = await load(false)
    const root = createRoot(container)
    await act(async () =>
      root.render(<DCHost meta={meta as any} Logic={DCLogic as any} render={() => createElement('b')} />),
    )
    expect((window as any).__oasisParity).toBeUndefined()
    expect(container.hasAttribute('data-oasis-ready')).toBe(false)
    act(() => root.unmount())
  })
})
